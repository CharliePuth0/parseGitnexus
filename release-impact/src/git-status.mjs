/**
 * File-level change classification, read straight from git.
 *
 * WHY THIS IS NOT READ FROM GITNEXUS
 *   `detect_changes` emits `change_type: 'touched'` for EVERY changed symbol — the literal
 *   is hardcoded in the backend, so the tool does not tell added from removed. The
 *   information exists only in the diff, and the report contract wants it (`changeType`,
 *   v1.1), so it is derived here from `git diff --name-status` with the same range and the
 *   same semantics the tool's own diff uses (`git diff <baseRef>` = base ref vs the WORKING
 *   TREE, no `--cached`), so the two views cannot disagree about which files changed.
 *
 * GRANULARITY: this is FILE-level, which is the finest classification the tool allows —
 * `detect_changes` reports no line ranges for changed symbols, so a symbol added inside an
 * already-tracked file is indistinguishable from an edited one. See README § Deviations.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

/** The `changeType` values REPORT_SCHEMA.md v1.1 allows. */
export const CHANGE_TYPES = ['added', 'modified', 'removed'];

/** Git name-status codes → report change types. */
const STATUS_TO_CHANGE_TYPE = {
  A: 'added',
  M: 'modified',
  D: 'removed',
  T: 'modified', // type change (file ↔ symlink): the path survives, its content class changed
  R: 'modified', // rename: the file still exists, so neither endpoint is an add or a remove
  C: 'modified', // copy: the original survives; the new path is reported as added below
};

/** Run git in the repository and return stdout, or throw with git's stderr. */
function runGit(repoPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

/**
 * Parse `git diff --name-status -z` output into a `Map<path, changeType>`.
 *
 * The `-z` form is NUL-delimited — `STATUS \0 path \0 [path \0]` — with TWO paths for
 * rename/copy records. Parsing it positionally (rather than by line) is what keeps paths
 * that contain spaces, tabs or newlines intact.
 */
export function parseNameStatusZ(stdout) {
  const status = new Map();
  const tokens = String(stdout ?? '').split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i];
    if (code.length === 0) continue;
    const kind = STATUS_TO_CHANGE_TYPE[code[0]];
    if (!kind) continue;
    const first = tokens[i + 1];
    if (first === undefined) break;
    const second = tokens[i + 2];
    const twoPaths = code[0] === 'R' || code[0] === 'C';
    if (twoPaths) {
      if (second === undefined) break;
      i += 2;
      // Both endpoints of a rename stay 'modified'; a copy's destination is genuinely new.
      status.set(first, 'modified');
      status.set(second, code[0] === 'C' ? 'added' : kind);
      continue;
    }
    i += 1;
    status.set(first, kind);
  }
  return status;
}

/**
 * Classify every file changed between `baseRef` and the working tree.
 *
 * Never throws: a missing git binary, a non-repository path or an unknown ref yields an
 * empty map, which makes every symbol fall back to `modified` and lets the run finish with
 * a note rather than fail. Paths are keyed both as git reports them (relative to the git
 * top level) and relative to `repoPath`, so the lookup works when `--repo` points below the
 * repository root.
 *
 * @returns {Promise<{status: Map<string, string>, error: string|null}>}
 */
export async function readChangedFileStatus(repoPath, baseRef, headRef) {
  try {
    const [raw, topLevelRaw] = await Promise.all([
      // Same range the tool walks: baseRef..headRef (exclusive end, worktree
      // edits excluded) — keeps the changeType view aligned with the symbol set.
      runGit(repoPath, ['diff', '--name-status', '-z', '--no-ext-diff', baseRef, headRef]),
      runGit(repoPath, ['rev-parse', '--show-toplevel']).catch(() => ''),
    ]);

    const status = parseNameStatusZ(raw);
    const topLevel = topLevelRaw.trim();
    if (topLevel.length > 0 && path.resolve(topLevel) !== path.resolve(repoPath)) {
      const prefix = `${path.relative(topLevel, repoPath).split(path.sep).join('/')}/`;
      for (const [filePath, kind] of status) {
        if (filePath.startsWith(prefix)) status.set(filePath.slice(prefix.length), kind);
      }
    }
    return { status, error: null };
  } catch (error) {
    return { status: new Map(), error: error.message };
  }
}

/**
 * Resolve the EXACT assessed range to commits.
 *
 * The tool now diffs `baseRef..headRef` (exclusive commit-to-commit range; worktree
 * edits EXCLUDED). The dirty flag is still surfaced: dirty files are outside the
 * assessed range, but the INDEX may have been built from uncommitted work, which
 * can shift the symbol line mapping.
 */
export async function readRangeInfo(repoPath, baseRef, headRef) {
  try {
    const [baseShaRaw, headShaRaw, porcelainRaw] = await Promise.all([
      runGit(repoPath, ['rev-parse', '--verify', baseRef]),
      runGit(repoPath, ['rev-parse', '--verify', headRef]),
      runGit(repoPath, ['status', '--porcelain']),
    ]);
    const dirtyCount = porcelainRaw.split('\n').filter((line) => line.trim() !== '').length;
    return {
      baseSha: baseShaRaw.trim(),
      headSha: headShaRaw.trim(),
      worktreeDirty: dirtyCount > 0,
      dirtyCount,
      error: null,
    };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Change type for one changed symbol.
 *
 * Precedence: the tool's own `change_type` when it is a real classification (it is
 * hardcoded to `touched` in GitNexus 1.6.12, so today this never fires — it is here so a
 * future analyzer that does classify symbols is used verbatim), then the git file status,
 * then `modified` as the default.
 */
export function resolveChangeType(filePath, toolChangeType, fileStatus) {
  const fromTool = String(toolChangeType ?? '').trim().toLowerCase();
  if (CHANGE_TYPES.includes(fromTool)) return fromTool;
  return fileStatus?.get(filePath) ?? 'modified';
}
