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

/**
 * `head-ref` is accepted for CLI symmetry, but the underlying tool compares the base ref
 * against the WORKING TREE (`git diff <base_ref> -U0`), so a head ref other than HEAD
 * cannot be honored. Say so instead of silently assessing a different range.
 */
function headRefCaveat(headRef) {
  if (headRef === 'HEAD') return null;
  return `--head-ref "${headRef}" cannot be honored: detect_changes compares the base ref against the working tree, so the assessed range is <base-ref>..worktree (HEAD plus uncommitted edits).`;
}

function formatBytes(text) {
  return `${(Buffer.byteLength(text, 'utf8') / 1024).toFixed(1)} KiB`;
}

/** Full run. Returns `{ report, reportPath, promptPath, errors }`. */
export async function run(config, log = () => {}) {
  const started = Date.now();
  const notes = [];
  const headCaveat = headRefCaveat(config.headRef);
  if (headCaveat) {
    notes.push(headCaveat);
    log(`WARNING ${headCaveat}`);
  }
  if (!existsSync(config.cliPath)) {
    notes.push(`GitNexus CLI not found at ${config.cliPath}; set --cli or GITNEXUS_CLI.`);
  }

  const client = new GitNexusClient({ repoPath: config.repoPath, cliPath: config.cliPath, log });
  let detect;
  try {
    const mode = await client.connect({ mcpUrl: config.mcpUrl });
    log(`analysis source: ${mode}`);

    log(`detect-changes scope=compare base-ref=${config.baseRef} (this walks the git diff)`);
    detect = await client.detectChanges({ baseRef: config.baseRef });
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

      analyses.push({ symbol, upstream, downstream });

      // Same merge the report uses, so the progress line never disagrees with report.json.
      log(`[${i + 1}/${selection.targets.length}] ${symbol.name} → ${mergedRisk(upstream, downstream)}`);
    }

    if (indexStatus === null) notes.push('index staleness could not be read (no impact call succeeded).');
    if (errors.length > 0) notes.push(`${errors.length} impact call(s) failed; those symbols are recorded as UNKNOWN.`);

    const report = buildReport({
      meta: {
        repo: config.repoName,
        repoPath: config.repoPath,
        baseRef: config.baseRef,
        headRef: config.headRef,
        generatedAt: new Date().toISOString(),
        indexStatus: indexStatus ?? 'unknown',
      },
      detect,
      analyses,
      options: { source: client.mode, depth: config.depth, limit: config.limit, notes },
    });

    // No extra notes here: buildReport already carried them into report.__engine.notes.
    const prompt = buildLlmPrompt(report);
    report.llm.prompt = prompt;

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

    log(
      `done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${publicReport.changes.length} changes, ` +
        `${publicReport.processes.length} processes, risk ${publicReport.summary.riskLevel}`,
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
