/**
 * Tool facade over GitNexus: prefers MCP, falls back to the built CLI.
 *
 * WHY MCP IS THE PRIMARY PATH
 *   `detect_changes` is the only source of the full changed-symbol set. Over MCP it
 *   returns structured JSON (`summary`, `changed_symbols[]`, `affected_processes[]`,
 *   `truncated`). The CLI's `detect-changes` command has NO `--json` flag: it prints a
 *   localized human banner and then only the FIRST 15 changed symbols and the FIRST 10
 *   processes (`src/cli/detect-changes-format.ts`). A CLI-only run therefore cannot see
 *   past 15 symbols, which is fewer than the default `--limit 30` we are asked to
 *   analyze. The CLI path is kept as an explicit DEGRADED fallback: it still produces a
 *   schema-valid report, but it says so in `summary`/`boundaries` rather than pretending
 *   the list is complete.
 *
 * `impact` fares better on the CLI — it prints `  GitNexus Impact (1.6.12)` followed by
 * a pure JSON object, so the fallback recovers a full result. It cannot address a symbol
 * by uid the way MCP's `target_uid` can, so an ambiguous name yields the tool's own
 * `status: "ambiguous"` payload, which the report records as UNKNOWN risk.
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { connectToMcp, startMcpServer } from './mcp-http.mjs';
import { extractFirstJsonObject } from './util.mjs';

/** Per-call budgets. `detect_changes` walks a git diff; `impact` walks the graph. */
const DETECT_TIMEOUT_MS = 180_000;
const IMPACT_TIMEOUT_MS = 120_000;
const CLI_TIMEOUT_MS = 240_000;

/** ~2 MB of response text, well above any real blast-radius payload. */
const IMPACT_MAX_TOKENS = 500_000;

/**
 * Page size passed as `limit` when walking the `detect_changes` listing. The
 * server caps one page at 1000 (its own `DETECT_CHANGES_MAX_LISTED_SYMBOLS`);
 * the walk continues with `offset += page length` while `truncated` is true.
 */
export const CHANGED_SYMBOL_CAP = 1000;

/** Hard ceiling on detect_changes pages — a pathological diff must terminate the loop. */
const MAX_DETECT_PAGES = 50;

/** Locale-tolerant regexes for the CLI's human-formatted `detect-changes` banner. */
const CLI_SUMMARY_PATTERNS = {
  counts: [/变更：(\d+) 个文件，(\d+) 个符号/, /Changes:\s*(\d+)\s*files?,?\s*(\d+)\s*symbols?/],
  processes: [/受影响流程：(\d+)/, /Affected processes:\s*(\d+)/],
  risk: [/风险等级：(\S+)/, /Risk level:\s*(\S+)/],
  symbolLine: /^\s{2}(\S+)\s+(.+?)\s+→\s+(.+?)\s*$/,
  truncated: [/列表已截断/, /LISTING CAPPED/],
  partial: [/结果不完整/, /PARTIAL RESULT/],
};

function firstMatch(patterns, text) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match;
  }
  return null;
}

/** Parse the human-readable `detect-changes` CLI output into the MCP payload shape. */
export function parseDetectChangesCliOutput(stdout) {
  const counts = firstMatch(CLI_SUMMARY_PATTERNS.counts, stdout);
  const processes = firstMatch(CLI_SUMMARY_PATTERNS.processes, stdout);
  const risk = firstMatch(CLI_SUMMARY_PATTERNS.risk, stdout);

  const changedSymbols = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(CLI_SUMMARY_PATTERNS.symbolLine);
    if (!match) continue;
    const [, type, name, filePath] = match;
    if (filePath === '?') continue;
    changedSymbols.push({
      // The CLI omits uids; rebuild the documented `<Kind>:<path>:<name>` shape so the
      // rest of the pipeline (and the frontend keying on uid) keeps working.
      id: `${type}:${filePath}:${name}`,
      name,
      type,
      filePath,
      // The banner carries no classification either, so `changeType` is derived from git.
      change_type: null,
    });
  }

  const overflow = stdout.match(/\.\.\.\s*(?:以及另外\s*)?(\d+)\s*(?:个|more)/);
  const observed = overflow
    ? changedSymbols.length + Number(overflow[1])
    : Number(counts?.[2] ?? changedSymbols.length);

  return {
    summary: {
      changed_files: counts ? Number(counts[1]) : 0,
      changed_count: observed,
      affected_count: processes ? Number(processes[1]) : 0,
      risk_level: risk ? risk[1] : 'unknown',
    },
    changed_symbols: changedSymbols,
    // The CLI banner renders the first 10 flows only, and without ids — so the report
    // gets no process ids from this path. Recorded as a boundary on every change entry.
    affected_processes: [],
    truncated: CLI_SUMMARY_PATTERNS.truncated.some((pattern) => pattern.test(stdout)) || true,
    partial: CLI_SUMMARY_PATTERNS.partial.some((pattern) => pattern.test(stdout)) || undefined,
    __source: 'cli',
  };
}

/**
 * Merge consecutive `detect_changes` pages into one payload.
 *
 * The server computes `summary`, `affected_processes` and `risk_level` from the
 * FULL symbol set on every page, so page 1 carries the true totals; only the
 * `changed_symbols` listing is a window (stable order, disjoint offsets). A
 * page that failed mid-loop carries `__error` — tolerated so the merged set
 * keeps everything before the failure.
 */
export function mergeDetectChangesPages(pages) {
  const first = pages[0] ?? {};
  const merged = { ...first };
  merged.changed_symbols = pages.flatMap((page) =>
    Array.isArray(page.changed_symbols) ? page.changed_symbols : [],
  );
  merged.affected_processes = Array.isArray(first.affected_processes) ? first.affected_processes : [];
  merged.truncated = pages.at(-1)?.truncated === true;
  merged.partial = first.partial || pages.some((page) => page?.partial);
  const failed = pages.find((page) => page?.__error);
  if (failed) merged.__error = failed.__error;
  return merged;
}

export class GitNexusClient {
  /**
   * @param {object} options
   * @param {string} options.repoPath absolute path to the indexed repository
   * @param {string} options.cliPath  absolute path to the built GitNexus CLI
   * @param {(message: string) => void} [options.log]
   */
  constructor({ repoPath, cliPath, log = () => {} }) {
    this.repoPath = repoPath;
    this.cliPath = cliPath;
    this.log = log;
    this.mode = 'mcp';
    this.session = null;
    this.mcp = null;
  }

  /** Bring up (or attach to) an MCP server. Falls back to CLI-only on failure. */
  async connect({ mcpUrl = null } = {}) {
    try {
      if (mcpUrl) {
        const url = mcpUrl.replace(/\/$/, '').endsWith('/mcp') ? mcpUrl : `${mcpUrl.replace(/\/$/, '')}/mcp`;
        this.mcp = await connectToMcp(url);
        this.log(`using existing MCP server at ${url}`);
      } else {
        this.session = await startMcpServer({ cliPath: this.cliPath, cwd: this.repoPath, log: this.log });
        this.mcp = this.session.client;
      }
      this.mode = 'mcp';
    } catch (error) {
      this.mode = 'cli';
      this.log(`MCP unavailable (${error.message}) — falling back to the CLI (DEGRADED: at most 15 changed symbols)`);
    }
    return this.mode;
  }

  async close() {
    if (this.session) await this.session.stop();
    this.session = null;
  }

  /**
   * Run the built CLI and return its stdout.
   *
   * stdout is captured through a FILE descriptor, not a pipe. Node writes to a pipe
   * asynchronously, and the CLI calls `process.exit()` once it has printed — which drops
   * whatever is still buffered. Measured on killshop: the same `impact` invocation emits
   * 100_413 bytes when redirected to a file and 65_296 bytes (mid-JSON, unparseable) when
   * piped through `execFile`. Writing to a file makes the child's stdio synchronous and
   * the payload whole.
   */
  async #runCli(argv) {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'release-impact-cli-'));
    const outPath = path.join(scratch, 'stdout.txt');
    const fd = openSync(outPath, 'w');
    try {
      const stderr = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [this.cliPath, ...argv], {
          cwd: this.repoPath,
          stdio: ['ignore', fd, 'pipe'],
        });
        let buffer = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`CLI timed out after ${CLI_TIMEOUT_MS}ms: ${argv.join(' ')}`));
        }, CLI_TIMEOUT_MS);
        child.stderr?.on('data', (chunk) => {
          buffer += String(chunk);
        });
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
        child.on('exit', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // The banner and diagnostics land on stderr; keep the tail for error messages.
          resolve({ code, stderr: buffer.slice(-2000) });
        });
      });

      const stdout = readFileSync(outPath, 'utf8');
      if (stderr.code !== 0 && stdout.trim().length === 0) {
        throw new Error(`CLI exited with code ${stderr.code}: ${stderr.stderr.trim().slice(0, 300)}`);
      }
      return stdout;
    } finally {
      closeSync(fd);
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Changed symbols between `baseRef` and `headRef` (exclusive commit-to-commit
   * range; worktree edits EXCLUDED). The MCP path walks the paginated listing
   * until the server's `truncated` says the set is complete; the CLI fallback
   * gets one banner call (at most 15 symbols — pagination can't help a banner).
   */
  async detectChanges({ baseRef, headRef }) {
    if (this.mode === 'mcp') {
      const call = (offset) =>
        this.mcp.callTool(
          'detect_changes',
          {
            scope: 'compare',
            base_ref: baseRef,
            head_ref: headRef,
            limit: CHANGED_SYMBOL_CAP,
            offset,
            repo: this.repoPath,
          },
          { timeoutMs: DETECT_TIMEOUT_MS },
        );

      const pages = [];
      let offset = 0;
      let page = await call(offset);
      pages.push(page);
      // `truncated` is server-authoritative now. Guarded on a non-empty page so
      // a mid-run failure or an empty page terminates instead of looping.
      while (page.truncated === true && Array.isArray(page.changed_symbols) && page.changed_symbols.length > 0) {
        if (pages.length >= MAX_DETECT_PAGES) break;
        offset += page.changed_symbols.length;
        page = await call(offset);
        pages.push(page);
      }

      const payload = mergeDetectChangesPages(pages);
      payload.__source = 'mcp';
      return payload;
    }

    const stdout = await this.#runCli([
      'detect-changes',
      '--scope',
      'compare',
      '--base-ref',
      baseRef,
      '--head-ref',
      headRef,
      '--repo',
      this.repoPath,
    ]);
    return parseDetectChangesCliOutput(stdout);
  }

  /**
   * Blast radius of one changed symbol in one direction.
   * Always resolves: a tool-level failure is returned as `{ __error }` so the caller can
   * record UNKNOWN risk for that symbol instead of aborting the whole run.
   */
  async impact({ uid, name, filePath, direction, depth, limit }) {
    try {
      if (this.mode === 'mcp') {
        return await this.mcp.callTool(
          'impact',
          {
            // `target_uid` skips name resolution entirely; a bare name is ambiguous for
            // common Java methods (two `unLockStock` overloads in killshop) and would
            // make the tool return a candidate list instead of a blast radius.
            target_uid: uid,
            direction,
            maxDepth: depth,
            limit,
            // `impact` is one of the MCP server's budgeted tools: an inherited
            // GITNEXUS_MCP_DEFAULT_MAX_TOKENS would silently cut the payload mid-JSON and
            // turn a real blast radius into an UNKNOWN. Ask for a budget far above any
            // real payload so the answer is always whole.
            maxTokens: IMPACT_MAX_TOKENS,
            repo: this.repoPath,
          },
          { timeoutMs: IMPACT_TIMEOUT_MS },
        );
      }

      // Resolve by NAME plus a `--file` hint, not by `--uid`: the uids on this path were
      // reconstructed from the CLI banner (`<Kind>:<path>:<name>`) and lack the `#N`
      // variant suffix the index actually keys on, so `--uid` would resolve to nothing.
      // An ambiguous name still yields the tool's own `status: "ambiguous"` payload,
      // which the report records as UNKNOWN rather than guessing.
      const stdout = await this.#runCli([
        'impact',
        name,
        '--direction',
        direction,
        '--depth',
        String(depth),
        '--limit',
        String(limit),
        '--repo',
        this.repoPath,
        ...(filePath ? ['--file', filePath] : []),
      ]);
      // The CLI prints a banner line, then pure JSON.
      const payload = extractFirstJsonObject(stdout);
      if (!payload) throw new Error('CLI impact printed no JSON object');
      return payload;
    } catch (error) {
      return { __error: error.message };
    }
  }

  /** Index staleness as reported by the tool (`staleness.status` on `impact` results). */
  indexStatusFrom(result) {
    return result?.staleness?.status ?? null;
  }
}
