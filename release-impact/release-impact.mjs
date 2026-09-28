#!/usr/bin/env node
/**
 * release-impact — pre-release code change impact assessment engine.
 *
 * Turns "what changed between <baseRef> and HEAD in repo R" into a structured impact
 * report (`report.json`, contract: REPORT_SCHEMA.md) plus a markdown prompt
 * (`llm-prompt.md`) an LLM can turn into a release narrative.
 *
 * Pipeline
 *   1. detect_changes (compare scope)  -> full changed-symbol set
 *   2. filter                          -> drop test-file symbols and path-less aggregates
 *   3. rank + cap                      -> first N symbols (default 30)
 *   4. impact upstream + downstream    -> per symbol, depth 3, sequentially
 *   5. merge                           -> report.json, changes sorted by risk desc
 *   6. prompt                          -> llm-prompt.md (llm.prompt in the report)
 *
 * Zero npm dependencies: node:child_process, node:fs, node:path, fetch, plus the plain-JS
 * `isTestFilePath` predicate from the built gitnexus-shared package.
 *
 * Usage:
 *   node release-impact.mjs --repo <path> --base-ref <ref> [--head-ref <ref>]
 *                           [--limit N] [--out dir] [--depth N] [--mcp-url URL] [--quiet]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readChangedFileStatus, readRangeInfo } from './src/git-status.mjs';
import { generateNarrative } from './src/llm.mjs';
import { querySymbolPdg, readPdgStamp } from './src/pdg.mjs';
import { GitNexusClient } from './src/gitnexus-client.mjs';
import { buildLlmPrompt } from './src/prompt.mjs';
import { buildReport, mergedRisk, selectAnalysisTargets, toPublicReport, validateReport } from './src/report.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  headRef: 'HEAD',
  limit: 30,
  depth: 3,
  /** Nodes requested per depth level per direction — keeps report.json and the prompt small. */
  impactLimit: 50,
  out: path.join(SCRIPT_DIR, 'out'),
  cliPath: process.env.GITNEXUS_CLI ?? path.resolve(SCRIPT_DIR, '..', 'gitnexus', 'dist', 'cli', 'index.js'),
};

const USAGE = `release-impact — pre-release code change impact assessment

Usage:
  node release-impact.mjs --repo <path> --base-ref <ref> [options]

Required:
  --repo <path>          Path to the indexed git repository to assess
  --base-ref <ref>       Release baseline (e.g. HEAD~20, v9.7.0, main)

Options:
  --head-ref <ref>       Reference the change set ends at (default: ${DEFAULTS.headRef})
  --limit <n>            Symbols to analyze with impact walks (default: ${DEFAULTS.limit})
  --depth <n>            Impact traversal depth per direction (default: ${DEFAULTS.depth})
  --impact-limit <n>     Max nodes per depth level per direction (default: ${DEFAULTS.impactLimit})
  --out <dir>            Output directory (default: <engine>/out)
  --mcp-url <url>        Reuse an already-running GitNexus MCP HTTP server
  --cli <path>           Path to the built GitNexus CLI (default: ${DEFAULTS.cliPath})
  --llm                  Call the LLM (Anthropic-Messages-compatible endpoint) and
                         backfill llm.narrative automatically. Credentials/model come
                         from ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY), ANTHROPIC_MODEL,
                         ANTHROPIC_BASE_URL — same env the Anthropic SDK reads.
  --quiet                Only log errors to stderr
  -h, --help             Show this help

Outputs (in <out>):
  report.json            Structured impact report (REPORT_SCHEMA.md v1)
  llm-prompt.md          Prompt for the LLM scenario assessment (llm.narrative)
`;

/** Minimal argv parser — `--flag value` and `--flag=value`, no dependencies. */
export function parseArgs(argv) {
  const options = {};
  const unknown = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      unknown.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const key = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
    const value = inlineValue ?? argv[i + 1];
    if (inlineValue === undefined && (value === undefined || value.startsWith('--'))) {
      options[key] = true;
      continue;
    }
    if (inlineValue === undefined) i += 1;
    options[key] = value;
  }
  return { options, unknown };
}

function toInt(value, fallback) {
  if (value === undefined || value === true) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Resolve and sanity-check the CLI options into a run config. */
export function resolveConfig(argv, cwd = process.cwd()) {
  const { options, unknown } = parseArgs(argv);
  if (options.help || options.h) return { help: true };
  if (unknown.length > 0) throw new Error(`unexpected argument(s): ${unknown.join(' ')}`);

  if (typeof options.repo !== 'string' || options.repo.length === 0) throw new Error('--repo is required');
  if (typeof options['base-ref'] !== 'string' || options['base-ref'].length === 0) throw new Error('--base-ref is required');

  const repoPath = path.resolve(cwd, options.repo);
  if (!existsSync(repoPath)) throw new Error(`--repo path does not exist: ${repoPath}`);

  const outDir = options.out ? path.resolve(cwd, String(options.out)) : DEFAULTS.out;
  const cliPath = typeof options.cli === 'string' ? path.resolve(cwd, options.cli) : DEFAULTS.cliPath;

  return {
    help: false,
    repoPath,
    repoName: path.basename(repoPath),
    baseRef: options['base-ref'],
    headRef: typeof options['head-ref'] === 'string' ? options['head-ref'] : DEFAULTS.headRef,
    limit: toInt(options.limit, DEFAULTS.limit),
    depth: toInt(options.depth, DEFAULTS.depth),
    impactLimit: toInt(options['impact-limit'], DEFAULTS.impactLimit),
    llm: options.llm === true,
    outDir,
    cliPath,
    mcpUrl: typeof options['mcp-url'] === 'string' ? options['mcp-url'] : null,
    quiet: Boolean(options.quiet),
  };
}

/** Write a file, creating the parent directory when needed. */
function writeOutput(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, 'utf8');
}

function formatBytes(text) {
  return `${(Buffer.byteLength(text, 'utf8') / 1024).toFixed(1)} KiB`;
}

/** Full run. Returns `{ report, reportPath, promptPath, errors }`. */
export async function run(config, log = () => {}) {
  const started = Date.now();
  const notes = [];
  if (!existsSync(config.cliPath)) {
    notes.push(`GitNexus CLI not found at ${config.cliPath}; set --cli or GITNEXUS_CLI.`);
  }

  const client = new GitNexusClient({ repoPath: config.repoPath, cliPath: config.cliPath, log });
  let detect;
  try {
    const mode = await client.connect({ mcpUrl: config.mcpUrl });
    log(`analysis source: ${mode}`);

    log(
      `detect-changes scope=compare base-ref=${config.baseRef} head-ref=${config.headRef} (exact commit range, worktree edits excluded)`,
    );
    detect = await client.detectChanges({ baseRef: config.baseRef, headRef: config.headRef });
    log(
      `detect-changes: ${detect.summary?.changed_files ?? 0} files, ${detect.summary?.changed_count ?? 0} symbols, ` +
        `${detect.summary?.affected_count ?? 0} affected processes, risk ${detect.summary?.risk_level ?? 'unknown'}` +
        `${detect.truncated ? ' (listing TRUNCATED)' : ''}${detect.partial ? ' (PARTIAL — counts are a lower bound)' : ''}`,
    );
    if (detect.partial) notes.push('detect_changes reported partial: true — the changed-symbol counts are a lower bound.');
    if (detect.__source === 'cli') {
      notes.push(
        'CLI fallback: detect-changes printed a human banner, so at most the first 15 changed symbols are recoverable and no process ids were available.',
      );
      log('DEGRADED run: changed symbols recovered from the CLI banner, not the full set.');
    }

    // File-level change classification for `changeType`. The tool hardcodes
    // `change_type: 'touched'`, so the added/modified/removed split comes from git itself,
    // over the SAME range the tool walks (base_ref..head_ref, worktree edits excluded).
    const { status: fileStatus, error: gitStatusError } = await readChangedFileStatus(
      config.repoPath,
      config.baseRef,
      config.headRef,
    );
    if (gitStatusError) {
      notes.push(
        `could not read file change status from git (${gitStatusError}); every changeType falls back to "modified".`,
      );
      log(`WARNING git name-status unavailable: ${gitStatusError}`);
    } else {
      const counts = { added: 0, modified: 0, removed: 0 };
      for (const kind of fileStatus.values()) counts[kind] = (counts[kind] ?? 0) + 1;
      log(
        `git name-status: ${counts.added} added, ${counts.modified} modified, ${counts.removed} removed file(s) in range`,
      );
    }

    // Exact range: resolve both endpoints to commits. The tool now diffs
    // base..headRef (worktree edits EXCLUDED), so a dirty tree no longer leaks
    // into the symbol set — but the INDEX may have been built from uncommitted
    // work, which can shift line mapping. Say so.
    const rangeInfo = await readRangeInfo(config.repoPath, config.baseRef, config.headRef);
    if (rangeInfo.error) {
      notes.push(`could not resolve the exact commit range (${rangeInfo.error}).`);
      log(`WARNING commit range unresolvable: ${rangeInfo.error}`);
    } else if (rangeInfo.worktreeDirty) {
      const shortBase = rangeInfo.baseSha.slice(0, 7);
      const shortHead = rangeInfo.headSha.slice(0, 7);
      notes.push(
        `working tree has ${rangeInfo.dirtyCount} uncommitted file change(s), EXCLUDED from the assessed ${config.baseRef} (${shortBase})..${config.headRef} (${shortHead}) range — if the index was built from uncommitted work, symbol line mapping may shift.`,
      );
      log(
        `range: ${shortBase}..${shortHead} (worktree DIRTY — ${rangeInfo.dirtyCount} uncommitted file change(s) EXCLUDED from the range)`,
      );
    } else {
      log(
        `range: ${rangeInfo.baseSha.slice(0, 7)}..${rangeInfo.headSha.slice(0, 7)} (clean worktree — exact commit range)`,
      );
    }

    const selection = selectAnalysisTargets(detect.changed_symbols, config.limit);
    if (selection.dropped.testFile > 0) {
      notes.push(`${selection.dropped.testFile} changed symbol(s) in test files were excluded from analysis.`);
    }
    if (selection.dropped.noFilePath > 0) {
      notes.push(`${selection.dropped.noFilePath} changed node(s) without a filePath (aggregates) were excluded.`);
    }
    if (selection.overLimit > 0) {
      notes.push(
        `${selection.overLimit} eligible changed symbol(s) beyond --limit ${config.limit} were not analyzed (summary.analyzedSymbols < summary.changedSymbols).`,
      );
    }
    log(
      `analysis targets: ${selection.targets.length} of ${selection.eligible} eligible symbols (limit ${config.limit}); ` +
        `excluded ${selection.dropped.testFile} test-file, ${selection.dropped.noFilePath} path-less, ${selection.dropped.duplicate} duplicate; ` +
        `${selection.overLimit} left unanalyzed by --limit`,
    );

    const analyses = [];
    const errors = [];
    let indexStatus = null;

    // PDG preflight: the statement-level layer only exists when the index was built
    // with `analyze --pdg` (pinned by `.gitnexusrc` `pdg: true`). Without it we skip
    // the per-symbol pdg_query calls and say so in the report — never a silent gap.
    const pdgStamp = readPdgStamp(config.repoPath);
    if (pdgStamp.error) {
      notes.push(`could not read the index PDG stamp (${pdgStamp.error}); statement-level analysis skipped.`);
    } else if (!pdgStamp.pdgLayer) {
      notes.push('index has no PDG layer — run `gitnexus analyze --pdg` (or pin `pdg: true` in .gitnexusrc) for statement-level guard analysis.');
    }

    for (let i = 0; i < selection.targets.length; i += 1) {
      const symbol = selection.targets[i];
      // Sequential on purpose: one MCP call at a time keeps the HTTP transport simple and
      // the per-symbol progress line accurate. Each call is ~0.1s on a warm index.
      const upstream = await client.impact({
        uid: symbol.uid,
        name: symbol.name,
        filePath: symbol.filePath,
        direction: 'upstream',
        depth: config.depth,
        limit: config.impactLimit,
      });
      const downstream = await client.impact({
        uid: symbol.uid,
        name: symbol.name,
        filePath: symbol.filePath,
        direction: 'downstream',
        depth: config.depth,
        limit: config.impactLimit,
      });

      indexStatus = indexStatus ?? client.indexStatusFrom(upstream) ?? client.indexStatusFrom(downstream);
      if (upstream.__error) errors.push(`${symbol.name} upstream: ${upstream.__error}`);
      if (downstream.__error) errors.push(`${symbol.name} downstream: ${downstream.__error}`);

      // Statement-level guards (guards-first per precision/FINDINGS.md): one name
      // resolution + at most two pdg_query calls per symbol, with compensations
      // (dedupe, empty-text exception rows dropped, UNKNOWN on empty results).
      let intraProcedural = { pdgLayer: false };
      if (pdgStamp.pdgLayer) {
        intraProcedural = await querySymbolPdg(client, symbol);
      }

      analyses.push({ symbol, upstream, downstream, intraProcedural });

      // Same merge the report uses, so the progress line never disagrees with report.json.
      log(`[${i + 1}/${selection.targets.length}] ${symbol.name} → ${mergedRisk(upstream, downstream)}`);
    }

    if (indexStatus === null) notes.push('index staleness could not be read (no impact call succeeded).');
    if (errors.length > 0) notes.push(`${errors.length} impact call(s) failed; those symbols are recorded as UNKNOWN.`);

    // Taint (one call, filtered to changed files): findings carry category + source→sink path.
    let taint = { findings: [], note: null };
    if (pdgStamp.pdgLayer) {
      const changedPaths = new Set((detect.changed_symbols ?? []).map((s) => s.filePath).filter(Boolean));
      const taintResult = await client.explain({ limit: 200 }).catch(() => ({ __error: 'explain failed' }));
      if (taintResult?.__error) {
        taint = { findings: [], note: taintResult.__error };
      } else if (Array.isArray(taintResult?.findings)) {
        taint = {
          findings: taintResult.findings
            .filter((f) => changedPaths.has(f?.filePath ?? f?.anchor?.file))
            .slice(0, 50)
            .map((f) => ({
              category: f?.category ?? null,
              sourceLine: f?.source?.line ?? f?.sourceLine ?? null,
              sinkLine: f?.sink?.line ?? f?.sinkLine ?? null,
              filePath: f?.filePath ?? f?.anchor?.file ?? null,
              path: f?.path ?? [],
              interprocedural: f?.interprocedural === true,
            })),
          truncated: taintResult.truncated === true,
          note: taintResult?.note ?? null,
        };
      }
    }

    const report = buildReport({
      meta: {
        repo: config.repoName,
        repoPath: config.repoPath,
        baseRef: config.baseRef,
        headRef: config.headRef,
        generatedAt: new Date().toISOString(),
        indexStatus: indexStatus ?? 'unknown',
        ...(rangeInfo?.baseSha ? { baseSha: rangeInfo.baseSha } : {}),
        ...(rangeInfo?.headSha ? { headSha: rangeInfo.headSha } : {}),
        ...(typeof rangeInfo?.worktreeDirty === 'boolean'
          ? { worktreeDirty: rangeInfo.worktreeDirty, dirtyCount: rangeInfo.dirtyCount ?? 0 }
          : {}),
      },
      detect,
      analyses,
      fileStatus,
      taint,
      options: {
        source: client.mode,
        depth: config.depth,
        limit: config.limit,
        pdgLayer: pdgStamp.pdgLayer && !pdgStamp.error,
        notes,
      },
    });

    // No extra notes here: buildReport already carried them into report.__engine.notes.
    const prompt = buildLlmPrompt(report);
    report.llm.prompt = prompt;

    if (config.llm) {
      log('calling LLM for the scenario narrative (ANTHROPIC_BASE_URL/ANTHROPIC_MODEL env)…');
      const result = await generateNarrative(prompt);
      if (result.error) {
        notes.push(`LLM narrative step failed (${result.error}); report.json is written without llm.narrative.`);
        log(`WARNING LLM step failed: ${result.error}`);
      } else {
        report.llm.narrative = result.text;
        log(
          `LLM narrative: ${result.text.length} chars (model ${result.model}, stop ${result.stopReason}, ` +
            `in ${result.usage?.input_tokens ?? '?'} / out ${result.usage?.output_tokens ?? '?'} tokens)`,
        );
      }
    }

    const publicReport = toPublicReport(report);
    const validation = validateReport(publicReport);
    if (!validation.ok) {
      throw new Error(`report failed schema validation:\n  - ${validation.errors.join('\n  - ')}`);
    }

    const reportPath = path.join(config.outDir, 'report.json');
    const promptPath = path.join(config.outDir, 'llm-prompt.md');
    const reportText = `${JSON.stringify(publicReport, null, 2)}\n`;
    const promptText = prompt.endsWith('\n') ? prompt : `${prompt}\n`;
    writeOutput(reportPath, reportText);
    writeOutput(promptPath, promptText);

    const changeTypeCounts = publicReport.changes.reduce((counts, change) => {
      counts[change.changeType] = (counts[change.changeType] ?? 0) + 1;
      return counts;
    }, {});
    log(
      `done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${publicReport.changes.length} changes ` +
        `(${Object.entries(changeTypeCounts)
          .map(([kind, count]) => `${count} ${kind}`)
          .join(', ')}), ${publicReport.processes.length} processes, risk ${publicReport.summary.riskLevel}`,
    );
    log(`wrote ${reportPath} (${formatBytes(reportText)})`);
    log(`wrote ${promptPath} (${formatBytes(promptText)})`);

    return { report: publicReport, reportPath, promptPath, errors, notes };
  } finally {
    await client.close();
  }
}

async function main() {
  let config;
  try {
    config = resolveConfig(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (config.help) {
    process.stdout.write(USAGE);
    return;
  }

  const log = config.quiet ? () => {} : (message) => process.stderr.write(`${message}\n`);
  try {
    await run(config, log);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export { main, USAGE, DEFAULTS };

// `import.meta.main` is not available on all supported runtimes; compare realpaths instead
// so the module can be imported by tests without executing a run.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
