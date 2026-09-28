#!/usr/bin/env node
/**
 * Go PDG precision verification runner (mirror of ../runner.mjs for Java).
 *
 * Builds a throwaway git repo from `fixtures/*.go`, indexes it with
 * `gitnexus analyze --pdg --index-only`, then scores `pdg_query` (CDG + REACHING_DEF)
 * edge by edge against the hand-annotated `fixtures/ground-truth.json`.
 *
 * Integrity rule: the ground truth was written BEFORE any pdg_query was issued and is
 * never rewritten by this script (read-only). Fixtures with `expectedGap: true` are
 * reported but excluded from the gate.
 *
 * GATE: exit 0 iff CONTROL recall is 100 % on the symbol-name anchor over the
 * non-expectedGap fixtures. Flow recall and all precision numbers are reported
 * alongside (they are the D2/D3/D4 evidence, not the gate).
 *
 * Usage: node runner.mjs [--keep] [--json <path>]
 * Zero npm dependencies; reuses ../../src/mcp-http.mjs.
 */
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcpServer } from '../../src/mcp-http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixtures');
const GROUND_TRUTH_PATH = path.join(FIXTURE_DIR, 'ground-truth.json');
const CLI_PATH = process.env.GITNEXUS_CLI ?? path.resolve(HERE, '..', '..', '..', 'gitnexus', 'dist', 'cli', 'index.js');
const QUERY_LIMIT = 200; // schema max
const ANALYZE_TIMEOUT_MS = 900_000;
const QUERY_TIMEOUT_MS = 120_000;

/** Stage directory INSIDE the fixture repo. NOT `fixtures/...` — that segment is a
 *  hardcoded analyzer ignore (gitnexus/src/config/ignore-service.ts:129). */
const STAGE_DIR = 'src';

/** Fixtures probed with a full UID target (the D6/D7 target-form question). */
const UID_PROBE = ['earlyguard.go', 'forbreak.go'];

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const jsonFlagIndex = argv.indexOf('--json');
const JSON_OUT = jsonFlagIndex >= 0
  ? path.resolve(argv[jsonFlagIndex + 1])
  : path.join(HERE, 'results', 'latest.json');

// ---------------------------------------------------------------- helpers ----

const log = (message) => process.stdout.write(`${message}\n`);

/** Run a child process, capturing output to FILES (a piped CLI drops buffered output). */
function runCapture(command, args, { cwd, timeoutMs }) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'go-pdg-cli-'));
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
    return {
      kind: 'results', rows: payload.results, note: payload.note,
      total: payload.total, truncated: payload.truncated, raw: payload,
    };
  }
  return { kind: 'empty', note: payload.note, message: payload.message, raw: payload };
}

const flatten = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** `{functionLine, controllerLine, dependentLine, label, guard, text}` for every CDG row. */
function controlRows(payload) {
  const { kind, rows } = readPayload(payload);
  if (kind !== 'results') return [];
  return rows.map((row) => ({
    functionLine: row?.functionLine ?? null,
    controllerLine: row?.controller?.line ?? row?.controllerLine ?? null,
    dependentLine: row?.dependent?.line ?? row?.dependentLine ?? null,
    label: row?.label ?? null,
    guard: row?.guard === true,
    text: flatten(row?.dependent?.text ?? row?.dependentText),
    raw: row,
  }));
}

/** `{functionLine, variable, defLine, useLine, text}` for every REACHING_DEF row. */
function flowRows(payload) {
  const { kind, rows } = readPayload(payload);
  if (kind !== 'results') return [];
  return rows.map((row) => ({
    functionLine: row?.functionLine ?? row?.def?.functionLine ?? null,
    variable: row?.variable ?? row?.def?.variable ?? row?.name ?? null,
    defLine: row?.def?.line ?? row?.defLine ?? null,
    useLine: row?.use?.line ?? row?.useLine ?? null,
    text: flatten(row?.use?.text ?? row?.useText),
    raw: row,
  }));
}

const controlKey = (e) => `${e.controllerLine}->${e.dependentLine}:${e.label}`;
const controlKeyNoLabel = (e) => `${e.controllerLine}->${e.dependentLine}`;
const flowKey = (e) => `${e.variable}:${e.defLine}->${e.useLine}`;

/** Multiset match of expected against returned edges. */
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

const ratio = (n, d) => (d === 0 ? 1 : n / d);
const pct = (v) => `${(v * 100).toFixed(1)}%`;

/** Byte-identical duplicate rows in a returned row set (Java D3). */
function duplicateRows(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = JSON.stringify(row.raw ?? row);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.values()].filter((n) => n > 1).reduce((sum, n) => sum + n - 1, 0);
}

/** First UID found in a cypher markdown cell. */
function firstUidFromMarkdown(markdown) {
  if (typeof markdown !== 'string') return null;
  for (const line of markdown.split('\n')) {
    const match = /(Method|Function|Constructor|Class|BasicBlock):[^|\s]+/.exec(line);
    if (match) return match[0];
  }
  return null;
}

function analyzeCounters(logText) {
  const lines = logText.split('\n');
  const count = (predicate) => lines.filter(predicate).length;
  return {
    cdgSkippedFunctions: count((line) => line.includes('CDG skipped for this function')),
    reachingDefSkippedFunctions: count((line) => line.includes('REACHING_DEF skipped for this function')),
    unsoundFunctions: count((line) => line.includes('EXIT was not reachable')),
    callableValueFlowCaps: count((line) => line.includes('candidate set exceeded the cap')),
    summaryLine: lines.find((line) => line.includes('Repository indexed successfully')) ?? null,
    warnLines: lines.filter((line) => line.includes('"level":40')).length,
  };
}

// --------------------------------------------------------------- main flow ---

async function main() {
  if (!existsSync(CLI_PATH)) throw new Error(`Built CLI not found: ${CLI_PATH}`);
  const groundTruth = JSON.parse(readFileSync(GROUND_TRUTH_PATH, 'utf8'));
  const fixtures = groundTruth.fixtures;

  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-go-pdg-precision-'));
  log(`fixture repo: ${repoRoot}`);
  const srcDir = path.join(repoRoot, STAGE_DIR);
  mkdirSync(srcDir, { recursive: true });
  const goFiles = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.go')).sort();
  for (const name of goFiles) copyFileSync(path.join(FIXTURE_DIR, name), path.join(srcDir, name));
  log(`copied ${goFiles.length} fixture file(s) to ${STAGE_DIR}/`);

  const sourceLines = new Map(
    goFiles.map((name) => [name, readFileSync(path.join(FIXTURE_DIR, name), 'utf8').split('\n')]),
  );
  const lineText = (fileName, line) => flatten(sourceLines.get(fileName)?.[line - 1] ?? '');
  const annotationLines = new Set(
    fixtures.map((f) => lineText(f.file, f.entryLine)).filter((t) => t.startsWith('//')),
  );

  const git = (args) => runCapture('git', args, { cwd: repoRoot, timeoutMs: 60_000 });
  await git(['init', '-q']);
  await git(['add', '-A']);
  await git(['-c', 'user.email=precision@example.invalid', '-c', 'user.name=precision',
    'commit', '-q', '-m', 'go pdg precision fixtures']);

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
  log(`analyze counters: ${JSON.stringify(counters)}`);

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
      const relPath = `${STAGE_DIR}/${fixture.file}`;
      results.push({
        file: fixture.file,
        relPath,
        construct: fixture.construct,
        symbol: fixture.symbol,
        entryLine: fixture.entryLine,
        expectedGap: fixture.expectedGap === true,
        symbolControls: await query('controls', fixture.symbol),
        symbolFlows: await query('flows', fixture.symbol),
        fileControls: await query('controls', relPath),
        fileFlows: await query('flows', relPath),
        basenameControls: await query('controls', fixture.file),
        notes: fixture.notes ?? '',
      });
    }

    // UID targeting probe (D6/D7).
    const uidProbes = [];
    for (const fileName of UID_PROBE) {
      const fixture = fixtures.find((entry) => entry.file === fileName);
      if (!fixture) continue;
      let uid = null;
      let cypherError = null;
      try {
        const cypher = await session.client.callTool(
          'cypher',
          { statement: `MATCH (n) WHERE n.name = '${fixture.symbol}' RETURN n.id AS id LIMIT 3` },
          { timeoutMs: QUERY_TIMEOUT_MS },
        );
        uid = firstUidFromMarkdown(cypher?.markdown);
      } catch (error) {
        cypherError = String(error?.message ?? error);
      }
      const viaUid = uid ? await query('controls', uid) : { ok: false, error: 'no uid resolved from cypher' };
      uidProbes.push({
        file: fileName,
        symbol: fixture.symbol,
        uid,
        cypherError,
        viaUid,
        viaRelPath: await query('controls', `${STAGE_DIR}/${fileName}`),
      });
    }

    // ----------------------------------------------------------- scoring ----
    const table = [];
    for (const result of results) {
      const fixture = fixtures.find((entry) => entry.file === result.file);
      const expectedControls = fixture.expectedControls ?? [];
      const expectedFlows = fixture.expectedFlows ?? [];

      const symControls = result.symbolControls.ok ? controlRows(result.symbolControls.payload) : [];
      const symFlows = result.symbolFlows.ok ? flowRows(result.symbolFlows.payload) : [];
      const fileControlsAll = result.fileControls.ok ? controlRows(result.fileControls.payload) : [];
      // Consumer workaround: filter the file anchor's rows to the target unit by functionLine.
      const fileControlsScoped = fileControlsAll.filter((row) => row.functionLine === fixture.entryLine);
      const fileFlowsAll = result.fileFlows.ok ? flowRows(result.fileFlows.payload) : [];

      const controls = scoreEdges(expectedControls, symControls, controlKey);
      const controlsRelaxed = scoreEdges(expectedControls, symControls, controlKeyNoLabel);
      const flows = scoreEdges(expectedFlows, symFlows, flowKey);
      const fileScopedControls = scoreEdges(expectedControls, fileControlsScoped, controlKey);

      // Guard sense: expected rows carry an explicit `guard` flag; compare with the tool's.
      const returnedByPair = new Map();
      for (const row of symControls) returnedByPair.set(`${row.controllerLine}->${row.dependentLine}`, row);
      const guardExpectedRows = expectedControls.filter((row) => row.guard === true);
      const guardFoundRows = guardExpectedRows.filter((row) => returnedByPair.get(`${row.controllerLine}->${row.dependentLine}`)?.guard === true);
      const guardMissedRows = guardExpectedRows.filter((row) => !returnedByPair.has(`${row.controllerLine}->${row.dependentLine}`));
      const guardFlagRows = symControls.filter((row) => row.guard === true);

      table.push({
        file: result.file,
        construct: result.construct,
        symbol: result.symbol,
        entryLine: fixture.entryLine,
        expectedGap: result.expectedGap,
        anchorKind: result.symbolControls.ok ? readPayload(result.symbolControls.payload).kind : 'transport-error',
        transportError: result.symbolControls.ok ? null : result.symbolControls.error,
        expectedControls: expectedControls.length,
        returnedControls: symControls.length,
        matchedControls: controls.matched,
        missedControls: controls.missed,
        extraControls: controls.extra,
        missedControlsIgnoringLabel: controlsRelaxed.missed.length,
        expectedFlows: expectedFlows.length,
        returnedFlows: symFlows.length,
        matchedFlows: flows.matched,
        missedFlows: flows.missed,
        extraFlows: flows.extra,
        duplicateControlRows: duplicateRows(symControls),
        emptyTextControlRows: symControls.filter((row) => row.text === '').length,
        // file-anchor diagnostics (D6)
        fileAnchorRows: fileControlsAll.length,
        fileAnchorScopedRows: fileControlsScoped.length,
        fileAnchorScopedMatched: fileScopedControls.matched,
        fileAnchorOtherFunctions: [...new Set(fileControlsAll.map((row) => row.functionLine))].sort((a, b) => a - b),
        fileAnchorSameAsSymbol: result.fileControls.ok && result.symbolControls.ok
          ? JSON.stringify(symControls.map((r) => controlKey(r))) === JSON.stringify(fileControlsScoped.map((r) => controlKey(r)))
          : null,
        basenameAnchorRows: result.basenameControls.ok ? controlRows(result.basenameControls.payload).length : null,
        // guards
        guardExpected: guardExpectedRows.length,
        guardFound: guardFoundRows.length,
        guardMissing: guardMissedRows.length,
        guardRowsReturned: guardFlagRows.length,
        // any returned guard-flagged row not annotated as a guard (false guard)
        falseGuardRows: guardFlagRows.filter((row) => !guardExpectedRows.some(
          (e) => e.controllerLine === row.controllerLine && e.dependentLine === row.dependentLine,
        )),
        falseGuardCount: guardFlagRows.filter((row) => !guardExpectedRows.some(
          (e) => e.controllerLine === row.controllerLine && e.dependentLine === row.dependentLine,
        )).length,
        payloadNote: result.symbolControls.ok ? readPayload(result.symbolControls.payload).note ?? null : null,
        truncated: result.symbolControls.ok ? readPayload(result.symbolControls.payload).truncated === true : null,
      });
    }

    // ------------------------------------------------------------ output ----
    const gated = table.filter((row) => !row.expectedGap);
    const sum = (rows, key) => rows.reduce((acc, row) => acc + row[key], 0);
    const totals = {
      controls: {
        expected: sum(gated, 'expectedControls'),
        matched: sum(gated, 'matchedControls'),
        returned: sum(gated, 'returnedControls'),
      },
      flows: {
        expected: sum(gated, 'expectedFlows'),
        matched: sum(gated, 'matchedFlows'),
        returned: sum(gated, 'returnedFlows'),
      },
      missedGuardEdges: sum(gated, 'guardMissing'),
      guardEdgesExpected: sum(gated, 'guardExpected'),
      falseGuardEdges: sum(gated, 'falseGuardCount'),
      relaxedControlMisses: sum(gated, 'missedControlsIgnoringLabel'),
      duplicateControlRows: sum(gated, 'duplicateControlRows'),
      emptyTextControlRows: sum(gated, 'emptyTextControlRows'),
    };

    const nameWidth = Math.max(...table.map((row) => row.file.length), 8);
    log('');
    log('=== per-fixture (target = symbol name) ===');
    log(['file'.padEnd(nameWidth), 'ctrl e/r/m'.padEnd(11), 'miss'.padEnd(5), 'x'.padEnd(4), 'P'.padEnd(7), 'R'.padEnd(7),
      'flow e/r/m'.padEnd(11), 'fM'.padEnd(4), 'fX'.padEnd(4), 'note'].join(' '));
    for (const row of table) {
      const flags = [
        row.expectedGap ? 'EXPECTED-GAP' : null,
        row.transportError ? `ERR:${row.transportError.slice(0, 30)}` : null,
        row.anchorKind !== 'results' ? `anchor=${row.anchorKind}` : null,
        row.truncated ? 'TRUNCATED' : null,
      ].filter(Boolean).join(',');
      log([
        row.file.padEnd(nameWidth),
        `${row.expectedControls}/${row.returnedControls}/${row.matchedControls}`.padEnd(11),
        String(row.missedControls.length).padEnd(5),
        String(row.extraControls.length).padEnd(4),
        pct(ratio(row.matchedControls, row.returnedControls)).padEnd(7),
        pct(ratio(row.matchedControls, row.expectedControls)).padEnd(7),
        `${row.expectedFlows}/${row.returnedFlows}/${row.matchedFlows}`.padEnd(11),
        String(row.missedFlows.length).padEnd(4),
        String(row.extraFlows.length).padEnd(4),
        flags,
      ].join(' '));
    }

    log('');
    log('=== GATE (symbol-name anchor, expectedGap fixtures excluded) ===');
    log(`controls: expected=${totals.controls.expected} matched=${totals.controls.matched} returned=${totals.controls.returned} `
      + `recall=${pct(ratio(totals.controls.matched, totals.controls.expected))} precision=${pct(ratio(totals.controls.matched, totals.controls.returned))}`);
    log(`flows:    expected=${totals.flows.expected} matched=${totals.flows.matched} returned=${totals.flows.returned} `
      + `recall=${pct(ratio(totals.flows.matched, totals.flows.expected))} precision=${pct(ratio(totals.flows.matched, totals.flows.returned))}`);
    log(`guard edges: expected=${totals.guardEdgesExpected} found=${totals.guardEdgesExpected - totals.missedGuardEdges} `
      + `missed=${totals.missedGuardEdges} false-guard-flagged=${totals.falseGuardEdges}`);
    log(`control misses ignoring the T/F label (edge-level): ${totals.relaxedControlMisses}`);
    log(`duplicate control rows: ${totals.duplicateControlRows}; control rows with EMPTY dependent text: ${totals.emptyTextControlRows}`);

    log('');
    log('=== misses ===');
    for (const row of table) {
      if (row.missedControls.length === 0 && row.missedFlows.length === 0) continue;
      log(`${row.file}:`);
      for (const missed of row.missedControls) {
        log(`  MISSED control ${missed.controllerLine}->${missed.dependentLine} [${missed.label}]`
          + ` expected=${lineText(row.file, missed.dependentLine).slice(0, 60)}`);
      }
      for (const missed of row.missedFlows) {
        log(`  MISSED flow ${missed.variable} ${missed.defLine}->${missed.useLine}`);
      }
    }

    log('');
    log('=== extras (returned but not annotated) ===');
    for (const row of table) {
      if (row.extraControls.length === 0 && row.extraFlows.length === 0) continue;
      log(`${row.file}:`);
      for (const extra of row.extraControls) {
        log(`  EXTRA control ${extra.controllerLine}->${extra.dependentLine} [${extra.label}]`
          + `${extra.guard ? ' GUARD-FLAG' : ''}${extra.text ? ` "${extra.text.slice(0, 55)}"` : ' <EMPTY>'}`);
      }
      for (const extra of row.extraFlows) {
        log(`  EXTRA flow ${extra.variable} ${extra.defLine}->${extra.useLine}`
          + `${extra.text ? ` "${extra.text.slice(0, 55)}"` : ''}`);
      }
    }

    log('');
    log('=== anchors: symbol vs file path vs basename ===');
    for (const row of table) {
      log(`${row.file.padEnd(nameWidth)} fileRows=${String(row.fileAnchorRows).padEnd(3)} `
        + `scopedByFunctionLine(${row.entryLine})=${String(row.fileAnchorScopedRows).padEnd(3)} `
        + `scopedMatched=${row.fileAnchorScopedMatched} identicalToSymbol=${row.fileAnchorSameAsSymbol} `
        + `otherFunctionLines=[${row.fileAnchorOtherFunctions.join(',')}] basenameRows=${row.basenameAnchorRows}`);
    }

    log('');
    log('=== UID targeting probe ===');
    for (const probe of uidProbes) {
      const rows = probe.viaUid.ok ? controlRows(probe.viaUid.payload) : [];
      log(`${probe.file} symbol=${probe.symbol}`);
      const uidDetail = probe.cypherError ? ` (cypherError=${probe.cypherError.slice(0, 60)})` : '';
      log(`  uid from cypher: ${probe.uid ?? '(none)'}${uidDetail}`);
      log(`  target=UID      -> ${probe.viaUid.ok ? `kind=${readPayload(probe.viaUid.payload).kind} rows=${rows.length}` : `ERROR ${probe.viaUid.error}`}`);
      log(`  target=relpath  -> ${probe.viaRelPath.ok ? `kind=${readPayload(probe.viaRelPath.payload).kind}` : `ERROR ${probe.viaRelPath.error}`}`);
    }

    const controlsRecall = ratio(totals.controls.matched, totals.controls.expected);
    const verdict = controlsRecall === 1 ? 'PASS' : 'FAIL';
    log('');
    log(`GATE: ${verdict} (control recall ${pct(controlsRecall)} on the symbol-name anchor; `
      + `flow recall ${pct(ratio(totals.flows.matched, totals.flows.expected))}; missed guard edges ${totals.missedGuardEdges})`);
    if (annotationLines.size > 0) log(`NOTE: fixtures declaring annotation lines: ${[...annotationLines].join(' | ')}`);

    const document = {
      generatedAt: new Date().toISOString(),
      language: 'go',
      cliPath: CLI_PATH,
      repoRoot,
      analyzeCounters: counters,
      analyzeLogPath,
      gate: {
        verdict,
        basis: 'control recall on the symbol-name anchor over non-expectedGap fixtures',
        controls: {
          expected: totals.controls.expected, matched: totals.controls.matched, returned: totals.controls.returned,
          recall: ratio(totals.controls.matched, totals.controls.expected),
          precision: ratio(totals.controls.matched, totals.controls.returned),
        },
        flows: {
          expected: totals.flows.expected, matched: totals.flows.matched, returned: totals.flows.returned,
          recall: ratio(totals.flows.matched, totals.flows.expected),
          precision: ratio(totals.flows.matched, totals.flows.returned),
        },
        missedGuardEdges: totals.missedGuardEdges,
        guardEdgesExpected: totals.guardEdgesExpected,
        falseGuardEdges: totals.falseGuardEdges,
        relaxedControlMisses: totals.relaxedControlMisses,
        duplicateControlRows: totals.duplicateControlRows,
        emptyTextControlRows: totals.emptyTextControlRows,
      },
      table,
      uidProbes,
      raw: results.map((r) => ({
        file: r.file,
        symbol: r.symbol,
        symbolControls: r.symbolControls,
        symbolFlows: r.symbolFlows,
        fileControls: r.fileControls,
        fileFlows: r.fileFlows,
      })),
    };
    mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify(document, null, 2));
    log(`raw results: ${JSON_OUT}`);

    process.exitCode = verdict === 'PASS' ? 0 : 1;
  } finally {
    await session.stop();
    if (!KEEP) {
      let removalTarget = repoRoot;
      try {
        removalTarget = realpathSync.native(repoRoot);
      } catch { /* fall through */ }
      await runCapture(process.execPath, [CLI_PATH, 'remove', removalTarget, '-f'], {
        cwd: os.tmpdir(), timeoutMs: 60_000,
      }).catch(() => {});
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
