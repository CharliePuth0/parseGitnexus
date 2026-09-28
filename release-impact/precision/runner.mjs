#!/usr/bin/env node
/**
 * Phase A — Java PDG precision verification runner.
 *
 * Builds a throwaway git repo from `fixtures/java/*.java`, indexes it with
 * `gitnexus analyze --pdg --index-only`, then scores `pdg_query` (CDG + REACHING_DEF)
 * against the hand-annotated `fixtures/java/ground-truth.json`.
 *
 * Integrity rule: the ground truth was written BEFORE any pdg_query was issued and is
 * never rewritten by this script (it is only read). Two exception classes are scored
 * separately from the gate and named in the output:
 *   - fixtures with `expectedGap: true` (documented blind spots)
 *   - fixtures whose anchor is ambiguous (identical sibling `break`/`continue` rows)
 *
 * Exit 0 only when controls recall AND flows recall are 100% over the full fixture set.
 *
 * Usage: node runner.mjs [--keep] [--json <path>]
 *   --keep      keep the temporary fixture-repo (for post-mortem)
 *   --json <p>  write the raw result document here (default: results/latest.json)
 *
 * Zero npm dependencies; reuses release-impact/src/mcp-http.mjs.
 */
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcpServer } from '../src/mcp-http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'java');
const GROUND_TRUTH_PATH = path.join(FIXTURE_DIR, 'ground-truth.json');
const CLI_PATH = process.env.GITNEXUS_CLI ?? path.resolve(HERE, '..', '..', 'gitnexus', 'dist', 'cli', 'index.js');
const QUERY_LIMIT = 200; // schema max
const ANALYZE_TIMEOUT_MS = 900_000;
const QUERY_TIMEOUT_MS = 120_000;

/** Fixtures whose anchor name is ambiguous (identified in ground-truth notes). */
const AMBIGUOUS_ANCHOR = new Set(['SwitchColon.java']);
/** Fixtures probed with a full UID target (Phase B needs to know if this form resolves). */
const UID_PROBE = ['PlainIfElse.java', 'WhileBreak.java'];

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const jsonFlagIndex = argv.indexOf('--json');
const JSON_OUT = jsonFlagIndex >= 0
  ? path.resolve(argv[jsonFlagIndex + 1])
  : path.join(HERE, 'results', 'latest.json');

// ---------------------------------------------------------------- helpers ----

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** Run a child process, capturing stdout/stderr to FILES (a piped CLI drops buffered output). */
function runCapture(command, args, { cwd, timeoutMs }) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'pdg-precision-cli-'));
  const outPath = path.join(scratch, 'stdout.txt');
  const errPath = path.join(scratch, 'stderr.txt');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', outFd, errFd] });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, timedOut: true, stdout: '', stderr: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut: false,
        stdout: readFileSync(outPath, 'utf8'),
        stderr: readFileSync(errPath, 'utf8'),
      });
    });
  }).finally(() => {
    closeSync(outFd);
    closeSync(errFd);
  });
}

/** Score-relevant slice of a `pdg_query` payload, tolerant of the documented shapes. */
function readPayload(payload) {
  if (!payload || typeof payload !== 'object') return { kind: 'empty', raw: payload };
  if (payload.status === 'ambiguous') return { kind: 'ambiguous', raw: payload };
  if (payload.error) return { kind: 'error', raw: payload };
  if (Array.isArray(payload.results)) {
    return { kind: 'results', rows: payload.results, note: payload.note, total: payload.total, truncated: payload.truncated, raw: payload };
  }
  return { kind: 'empty', note: payload.note, raw: payload };
}

/** `{controllerLine, dependentLine, label, guard, text}` for every CDG row. */
function controlRows(payload) {
  const { kind, rows } = readPayload(payload);
  if (kind !== 'results') return [];
  return rows.map((row) => ({
    controllerLine: row?.controller?.line ?? row?.controllerLine ?? null,
    dependentLine: row?.dependent?.line ?? row?.dependentLine ?? null,
    label: row?.label ?? null,
    guard: row?.guard === true,
    text: String(row?.dependent?.text ?? row?.dependentText ?? '').replace(/\s+/g, ' ').trim(),
  }));
}

/** `{variable, defLine, useLine, text}` for every REACHING_DEF row. */
function flowRows(payload) {
  const { kind, rows } = readPayload(payload);
  if (kind !== 'results') return [];
  return rows.map((row) => ({
    variable: row?.variable ?? row?.def?.variable ?? null,
    defLine: row?.def?.line ?? row?.defLine ?? null,
    useLine: row?.use?.line ?? row?.useLine ?? null,
    text: String(row?.use?.text ?? row?.useText ?? '').replace(/\s+/g, ' ').trim(),
  }));
}

const controlKey = (e) => `${e.controllerLine}->${e.dependentLine}:${e.label}`;
const controlKeyNoLabel = (e) => `${e.controllerLine}->${e.dependentLine}`;
const flowKey = (e) => `${e.variable}:${e.defLine}->${e.useLine}`;

/**
 * Multiset match of expected edges against returned edges.
 * Returns the matched count plus the unmatched rows on both sides (with multiplicity).
 */
function scoreEdges(expected, returned, keyOf) {
  const pool = new Map();
  for (const row of returned) {
    const key = keyOf(row);
    pool.set(key, (pool.get(key) ?? 0) + 1);
  }
  let matched = 0;
  const missed = [];
  for (const row of expected) {
    const key = keyOf(row);
    const remaining = pool.get(key) ?? 0;
    if (remaining > 0) {
      pool.set(key, remaining - 1);
      matched += 1;
    } else {
      missed.push(row);
    }
  }
  const extra = [];
  for (const [key, remaining] of pool) {
    if (remaining <= 0) continue;
    const source = returned.find((row) => keyOf(row) === key);
    for (let i = 0; i < remaining; i += 1) extra.push(source ?? { key });
  }
  return { matched, missed, extra };
}

function ratio(numerator, denominator) {
  if (denominator === 0) return 1;
  return numerator / denominator;
}

const pct = (value) => `${(value * 100).toFixed(1)}%`;

/** `Method:env/store/...:Class.member#1` -> first match in a cypher markdown cell. */
function firstUidFromMarkdown(markdown) {
  if (typeof markdown !== 'string') return null;
  for (const line of markdown.split('\n')) {
    const match = /(Method|Function|Constructor|Class|BasicBlock):[^|\s]+/.exec(line);
    if (match) return match[0];
  }
  return null;
}

/** The skip/truncation counters that matter for PDG soundness, scraped from the analyze log. */
function analyzeCounters(logText) {
  const lines = logText.split('\n');
  const count = (predicate) => lines.filter(predicate).length;
  return {
    cdgSkippedFunctions: count((line) => line.includes('CDG skipped for this function')),
    reachingDefSkippedFunctions: count((line) => line.includes('REACHING_DEF skipped for this function')),
    unsoundFunctions: count((line) => line.includes('EXIT was not reachable')),
    callableValueFlowCaps: count((line) => line.includes('candidate set exceeded the cap')),
    processTruncation: lines.find((line) => line.includes('flows reported, but whole flows are MISSING')) ?? null,
    summaryLine: lines.find((line) => line.includes('Repository indexed successfully')) ?? null,
  };
}

// --------------------------------------------------------------- main flow ---

async function main() {
  if (!existsSync(CLI_PATH)) throw new Error(`Built CLI not found: ${CLI_PATH}`);
  const groundTruth = JSON.parse(readFileSync(GROUND_TRUTH_PATH, 'utf8'));
  const fixtures = groundTruth.fixtures;

  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-pdg-precision-'));
  log(`fixture repo: ${repoRoot}`);
  // NOTE: NOT `src/fixtures/java`. `fixtures` is a hardcoded entry in the analyzer's
  // default ignore list (gitnexus/src/config/ignore-service.ts:129), so a repo whose
  // sources live under a `fixtures/` segment indexes as 0 nodes / 0 edges — verified by
  // probe. The staging path is therefore `src/main/java`; the fixture FILE names (and
  // every line number in ground-truth.json) are unchanged.
  const srcDir = path.join(repoRoot, 'src', 'main', 'java');
  mkdirSync(srcDir, { recursive: true });
  const javaFiles = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.java')).sort();
  for (const name of javaFiles) copyFileSync(path.join(FIXTURE_DIR, name), path.join(srcDir, name));
  log(`copied ${javaFiles.length} fixture file(s)`);

  // Fixture source lines, used only to decide whether a dependent line is a
  // guard statement (return/throw/continue/break) — the annotated set never changes.
  const sourceLines = new Map(
    javaFiles.map((name) => [name, readFileSync(path.join(FIXTURE_DIR, name), 'utf8').split('\n')]),
  );
  const isGuardDependent = (fileName, line) =>
    /^(return|throw|continue|break)\b/.test((sourceLines.get(fileName)?.[line - 1] ?? '').trim());

  const git = (args) => runCapture('git', args, { cwd: repoRoot, timeoutMs: 60_000 });
  await git(['init', '-q']);
  await git(['add', '-A']);
  await git([
    '-c', 'user.email=precision@example.invalid', '-c', 'user.name=precision',
    'commit', '-q', '-m', 'java pdg precision fixtures',
  ]);

  log('running analyze --pdg --index-only ...');
  const analyzed = await runCapture(
    process.execPath,
    [CLI_PATH, 'analyze', '--pdg', '--index-only'],
    { cwd: repoRoot, timeoutMs: ANALYZE_TIMEOUT_MS },
  );
  const analyzeLog = `${analyzed.stdout}\n${analyzed.stderr}`;
  const analyzeLogPath = path.join(HERE, 'logs', `fixture-analyze-${Date.now()}.log`);
  mkdirSync(path.dirname(analyzeLogPath), { recursive: true });
  writeFileSync(analyzeLogPath, analyzeLog);
  if (analyzed.code !== 0) {
    throw new Error(`analyze failed (code=${analyzed.code}, timedOut=${analyzed.timedOut}); log: ${analyzeLogPath}`);
  }
  const counters = analyzeCounters(analyzeLog);
  log(`analyze log: ${analyzeLogPath}`);
  log(`analyze counters: ${JSON.stringify({
    cdgSkippedFunctions: counters.cdgSkippedFunctions,
    reachingDefSkippedFunctions: counters.reachingDefSkippedFunctions,
    unsoundFunctions: counters.unsoundFunctions,
  })}`);

  const session = await startMcpServer({ cliPath: CLI_PATH, cwd: repoRoot, log });
  const results = [];
  try {
    const query = async (mode, target, extra = {}) => {
      try {
        const payload = await session.client.callTool(
          'pdg_query',
          { mode, target, limit: QUERY_LIMIT, ...extra },
          { timeoutMs: QUERY_TIMEOUT_MS },
        );
        return { ok: true, payload };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    };

    for (const fixture of fixtures) {
      const symbolQuery = await query('controls', fixture.symbol);
      const flowsQuery = await query('flows', fixture.symbol);
      const fileQuery = await query('controls', fixture.file);
      results.push({
        file: fixture.file,
        construct: fixture.construct ?? null,
        symbol: fixture.symbol,
        expectedGap: fixture.expectedGap === true,
        ambiguousAnchor: AMBIGUOUS_ANCHOR.has(fixture.file),
        symbolQuery,
        flowsQuery,
        fileQuery,
        notes: fixture.notes ?? '',
      });
    }

    // UID targeting probe (Phase B dependency).
    const uidProbes = [];
    for (const fileName of UID_PROBE) {
      const fixture = fixtures.find((entry) => entry.file === fileName);
      if (!fixture) continue;
      const cypher = await (async () => {
        try {
          return await session.client.callTool(
            'cypher',
            { statement: `MATCH (n) WHERE n.name = '${fixture.symbol}' RETURN n.id AS id LIMIT 3` },
            { timeoutMs: QUERY_TIMEOUT_MS },
          );
        } catch (error) {
          return { __error: String(error?.message ?? error) };
        }
      })();
      const uid = firstUidFromMarkdown(cypher?.markdown);
      const viaUid = uid ? await query('controls', uid) : { ok: false, error: 'no uid resolved from cypher' };
      const relativePath = `src/main/java/${fixture.file}`;
      const viaRelPath = await query('controls', relativePath);
      uidProbes.push({ file: fileName, symbol: fixture.symbol, uid, cypherOk: !cypher?.__error, viaUid, viaRelPath });
    }

    // ----------------------------------------------------------- scoring ----
    const table = [];
    for (const result of results) {
      const fixture = fixtures.find((entry) => entry.file === result.file);
      const expectedControls = fixture.expectedControls ?? [];
      const expectedFlows = fixture.expectedFlows ?? [];
      const gotControls = result.symbolQuery.ok ? controlRows(result.symbolQuery.payload) : [];
      const gotFlows = result.flowsQuery.ok ? flowRows(result.flowsQuery.payload) : [];

      const controls = scoreEdges(expectedControls, gotControls, controlKey);
      const controlsRelaxed = scoreEdges(expectedControls, gotControls, controlKeyNoLabel);
      const flows = scoreEdges(expectedFlows, gotFlows, flowKey);
      const anchorKind = result.symbolQuery.ok ? readPayload(result.symbolQuery.payload).kind : 'transport-error';

      // A MISSED GUARD EDGE is an expected control edge into a return/throw/continue/break
      // whose (controller, dependent) line pair does not appear in the tool output AT ALL.
      // A row that is present with the other label is a LABEL DEFECT, reported separately:
      // the edge was found, its T/F sense may still be wrong (that is a soundness problem
      // for consumers, but it is not a missing edge).
      const guardExpected = expectedControls.filter((row) => isGuardDependent(result.file, row.dependentLine));
      const missedGuardRows = controls.missed.filter((row) => isGuardDependent(result.file, row.dependentLine));
      const labelMismatchRows = controls.missed.filter((row) => !missedGuardRows.includes(row));
      const missedSameLineNoLabel = controlsRelaxed.missed.length;

      table.push({
        file: result.file,
        construct: result.construct,
        symbol: result.symbol,
        expectedGap: result.expectedGap,
        ambiguousAnchor: result.ambiguousAnchor,
        anchorKind,
        transportError: result.symbolQuery.ok ? null : result.symbolQuery.error,
        expectedControls: expectedControls.length,
        returnedControls: gotControls.length,
        matchedControls: controls.matched,
        missedControls: controls.missed,
        extraControls: controls.extra,
        missedControlsIgnoringLabel: missedSameLineNoLabel,
        expectedFlows: expectedFlows.length,
        returnedFlows: gotFlows.length,
        matchedFlows: flows.matched,
        missedFlows: flows.missed,
        extraFlows: flows.extra,
        fileAnchorReturned: result.fileQuery.ok ? controlRows(result.fileQuery.payload).length : null,
        fileAnchorSameAsSymbol: result.fileQuery.ok && result.symbolQuery.ok
          ? JSON.stringify(controlRows(result.fileQuery.payload)) === JSON.stringify(gotControls)
          : null,
        payloadNotes: [
          result.symbolQuery.ok ? readPayload(result.symbolQuery.payload).note : null,
          result.symbolQuery.ok ? readPayload(result.symbolQuery.payload).raw?.message : null,
        ].filter(Boolean).join(' | ') || null,
        truncated: result.symbolQuery.ok ? readPayload(result.symbolQuery.payload).truncated === true : null,
        guardExpected: guardExpected.length,
        guardMissedCount: missedGuardRows.length,
        labelMismatchCount: labelMismatchRows.length,
      });
    }

    // ------------------------------------------------------------ output ----
    const gated = table.filter((row) => !row.ambiguousAnchor);
    const strictExpectedControls = gated.reduce((sum, row) => sum + row.expectedControls, 0);
    const strictMatchedControls = gated.reduce((sum, row) => sum + row.matchedControls, 0);
    const strictReturnedControls = gated.reduce((sum, row) => sum + row.returnedControls, 0);
    const strictExpectedFlows = gated.reduce((sum, row) => sum + row.expectedFlows, 0);
    const strictMatchedFlows = gated.reduce((sum, row) => sum + row.matchedFlows, 0);
    const strictReturnedFlows = gated.reduce((sum, row) => sum + row.returnedFlows, 0);
    const missedGuardTotal = table.reduce((sum, row) => sum + row.guardMissedCount, 0);
    const labelMismatchTotal = table.reduce((sum, row) => sum + row.labelMismatchCount, 0);
    // Second, weaker reading of the same data: match on the (controller, dependent) line
    // pair only, ignoring the T/F sense. Tells a missed EDGE apart from a bad LABEL.
    const relaxedMisses = table.reduce((sum, row) => sum + row.missedControlsIgnoringLabel, 0);

    const nameWidth = Math.max(...table.map((row) => row.file.length), 8);
    log('');
    log('=== per-fixture (target = symbol name) ===');
    log([
      'file'.padEnd(nameWidth), 'exp/ret'.padEnd(9), 'miss'.padEnd(5), 'extra'.padEnd(6),
      'P'.padEnd(7), 'R'.padEnd(7), 'flows exp/ret'.padEnd(14), 'fM'.padEnd(4), 'fX'.padEnd(4), 'note',
    ].join(' '));
    for (const row of table) {
      const controlPrecision = ratio(row.matchedControls, row.returnedControls);
      const controlRecall = ratio(row.matchedControls, row.expectedControls);
      const flags = [
        row.ambiguousAnchor ? 'AMBIG-ANCHOR' : null,
        row.expectedGap ? 'EXPECTED-GAP' : null,
        row.transportError ? `ERROR:${row.transportError.slice(0, 40)}` : null,
        row.anchorKind !== 'results' ? `anchor=${row.anchorKind}` : null,
        row.truncated ? 'TRUNCATED' : null,
      ].filter(Boolean).join(',');
      log([
        row.file.padEnd(nameWidth),
        `${row.expectedControls}/${row.returnedControls}`.padEnd(9),
        String(row.missedControls.length).padEnd(5),
        String(row.extraControls.length).padEnd(6),
        pct(controlPrecision).padEnd(7),
        pct(controlRecall).padEnd(7),
        `${row.expectedFlows}/${row.returnedFlows}`.padEnd(14),
        String(row.missedFlows.length).padEnd(4),
        String(row.extraFlows.length).padEnd(4),
        flags,
      ].join(' '));
    }

    log('');
    log('=== gate (excluding ambiguous-anchor fixture) ===');
    log(`controls: expected=${strictExpectedControls} matched=${strictMatchedControls} returned=${strictReturnedControls} `
      + `recall=${pct(ratio(strictMatchedControls, strictExpectedControls))} `
      + `precision=${pct(ratio(strictMatchedControls, strictReturnedControls))}`);
    log(`flows:    expected=${strictExpectedFlows} matched=${strictMatchedFlows} returned=${strictReturnedFlows} `
      + `recall=${pct(ratio(strictMatchedFlows, strictExpectedFlows))} `
      + `precision=${pct(ratio(strictMatchedFlows, strictReturnedFlows))}`);
    log(`missed guard edges (return/throw/continue/break dependent absent entirely): ${missedGuardTotal}`);
    log(`label-only mismatches (edge present, T/F sense differs): ${labelMismatchTotal}`);
    log(`control misses when the T/F label is IGNORED (edge-level recall): ${relaxedMisses}`);

    // The same gate with the documented blind spots removed (ambiguous anchor + the
    // lambda fixture). Reported for the decision, NOT used for the exit code.
    const gapFree = table.filter((row) => !row.ambiguousAnchor && !row.expectedGap);
    const gapFreeControlsExpected = gapFree.reduce((sum, row) => sum + row.expectedControls, 0);
    const gapFreeControlsMatched = gapFree.reduce((sum, row) => sum + row.matchedControls, 0);
    const gapFreeControlsRelaxed = gapFreeControlsExpected - gapFree.reduce((sum, row) => sum + row.missedControlsIgnoringLabel, 0);
    const gapFreeFlowsExpected = gapFree.reduce((sum, row) => sum + row.expectedFlows, 0);
    const gapFreeFlowsMatched = gapFree.reduce((sum, row) => sum + row.matchedFlows, 0);
    log('=== same gate, documented blind spots removed (informational, not the exit code) ===');
    log(`controls recall(label-strict)=${pct(ratio(gapFreeControlsMatched, gapFreeControlsExpected))} `
      + `recall(edge-level)=${pct(ratio(gapFreeControlsRelaxed, gapFreeControlsExpected))} `
      + `flows recall=${pct(ratio(gapFreeFlowsMatched, gapFreeFlowsExpected))}`);

    log('');
    log('=== misses ===');
    for (const row of table) {
      if (row.missedControls.length === 0 && row.missedFlows.length === 0) continue;
      log(`${row.file}:`);
      for (const missed of row.missedControls) {
        const kind = isGuardDependent(row.file, missed.dependentLine) ? 'MISSED GUARD EDGE' : 'MISSED control';
        log(`  ${kind} ${missed.controllerLine}->${missed.dependentLine} [${missed.label}]`
          + `${isGuardDependent(row.file, missed.dependentLine) ? '' : ' (label mismatch)'}`);
      }
      for (const missed of row.missedFlows) {
        log(`  MISSED flow ${missed.variable} ${missed.defLine}->${missed.useLine}`);
      }
    }

    log('');
    log('=== extras (returned but not annotated; leading candidates for noise) ===');
    for (const row of table) {
      if (row.extraControls.length === 0 && row.extraFlows.length === 0) continue;
      log(`${row.file}:`);
      for (const extra of row.extraControls) {
        log(`  EXTRA control ${extra.controllerLine}->${extra.dependentLine} [${extra.label}]`
          + `${extra.guard ? ' guard' : ''}${extra.text ? ` "${extra.text.slice(0, 60)}"` : ''}`);
      }
      for (const extra of row.extraFlows) {
        log(`  EXTRA flow ${extra.variable} ${extra.defLine}->${extra.useLine}`
          + `${extra.text ? ` "${extra.text.slice(0, 60)}"` : ''}`);
      }
    }

    log('');
    log('=== UID targeting probe ===');
    for (const probe of uidProbes) {
      const uidRows = probe.viaUid.ok ? controlRows(probe.viaUid.payload) : null;
      const uidKind = probe.viaUid.ok ? readPayload(probe.viaUid.payload).kind : 'transport-error';
      const relRows = probe.viaRelPath.ok ? controlRows(probe.viaRelPath.payload) : [];
      log(`${probe.file} symbol=${probe.symbol}`);
      log(`  uid from cypher: ${probe.uid ?? '(none)'}`);
      log(`  target=UID       -> ${probe.viaUid.ok ? `kind=${uidKind} rows=${uidRows.length}` : `ERROR ${probe.viaUid.error}`}`);
      log(`  target=relpath   -> ${probe.viaRelPath.ok ? `kind=${readPayload(probe.viaRelPath.payload).kind} rows=${relRows.length}` : `ERROR ${probe.viaRelPath.error}`}`);
      log(`  target=basename  -> see per-fixture "file anchor" column`);
    }

    log('');
    log('=== file-anchor vs symbol-anchor ===');
    for (const row of table) {
      log(`${row.file}: fileAnchorRows=${row.fileAnchorReturned} identicalToSymbolAnchor=${row.fileAnchorSameAsSymbol}`);
    }

    const okControls = strictMatchedControls === strictExpectedControls;
    const okFlows = strictMatchedFlows === strictExpectedFlows;
    const verdict = okControls && okFlows && missedGuardTotal === 0 ? 'PASS' : 'FAIL';
    log('');
    log(`GATE: ${verdict} (controls recall ${pct(ratio(strictMatchedControls, strictExpectedControls))}, `
      + `flows recall ${pct(ratio(strictMatchedFlows, strictExpectedFlows))}, missed guard rows ${missedGuardTotal})`);

    const document = {
      generatedAt: new Date().toISOString(),
      cliPath: CLI_PATH,
      repoRoot,
      analyzeCounters: counters,
      analyzeLogPath,
      gate: {
        verdict,
        controls: {
          expected: strictExpectedControls, matched: strictMatchedControls, returned: strictReturnedControls,
          recall: ratio(strictMatchedControls, strictExpectedControls),
          precision: ratio(strictMatchedControls, strictReturnedControls),
        },
        flows: {
          expected: strictExpectedFlows, matched: strictMatchedFlows, returned: strictReturnedFlows,
          recall: ratio(strictMatchedFlows, strictExpectedFlows),
          precision: ratio(strictMatchedFlows, strictReturnedFlows),
        },
        missedGuardRows: missedGuardTotal,
        labelMismatchRows: labelMismatchTotal,
        relaxedControlMisses: relaxedMisses,
        withoutDocumentedGaps: {
          controlsRecallLabelStrict: ratio(gapFreeControlsMatched, gapFreeControlsExpected),
          controlsRecallEdgeLevel: ratio(gapFreeControlsRelaxed, gapFreeControlsExpected),
          flowsRecall: ratio(gapFreeFlowsMatched, gapFreeFlowsExpected),
        },
      },
      table,
      uidProbes,
      raw: results.map((result) => ({
        file: result.file,
        symbol: result.symbol,
        controls: result.symbolQuery,
        flows: result.flowsQuery,
        fileAnchor: result.fileQuery,
      })),
    };
    mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify(document, null, 2));
    log(`raw results: ${JSON_OUT}`);

    process.exitCode = verdict === 'PASS' ? 0 : 1;
  } finally {
    await session.stop();
    if (!KEEP) {
      // Drop the temp index from the global registry before deleting the tree.
      // The registry stores the REAL path (on macOS `mkdtemp` hands back /var/... while
      // the registry records /private/var/...), so the removal target is the realpath.
      let removalTarget = repoRoot;
      try {
        removalTarget = realpathSync.native(repoRoot);
      } catch {
        // Fall through with the unresolved path; the name lookup below still covers it.
      }
      await runCapture(process.execPath, [CLI_PATH, 'remove', removalTarget, '-f'], {
        cwd: os.tmpdir(), timeoutMs: 60_000,
      }).catch(() => {});
      // Belt and braces: `remove` matches by path OR alias, and the alias is the basename.
      await runCapture(process.execPath, [CLI_PATH, 'remove', path.basename(repoRoot), '-f'], {
        cwd: os.tmpdir(), timeoutMs: 60_000,
      }).catch(() => {});
      rmSync(repoRoot, { recursive: true, force: true });
    } else {
      log(`kept fixture repo at ${repoRoot}`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`runner failed: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
});
