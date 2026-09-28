#!/usr/bin/env node
/**
 * Go PDG real-code gate — Prometheus guard-edge spot check.
 *
 * Mirrors ../spotcheck-killshop.mjs for Java. Five Prometheus functions with dense
 * `if err != nil { return ... }` guards. For each method the EXPECTED GUARD EDGES were
 * hand-derived from the source and written into EXPECTATIONS below BEFORE any
 * pdg_query was issued (integrity rule); this script only reads them.
 *
 * Guard edge = a classical control-dependence edge whose dependent is an early
 * `return` inside `if <cond> { ... }`, reported as {ifLine -> returnLine : T}.
 *
 * Targeting: name first; on `status: ambiguous` fall back to the repo-relative file
 * path filtered by `functionLine == entryLine` (the consumer workaround established by
 * the Java Phase A run).
 *
 * Usage: node spotcheck-prometheus.mjs [--json <path>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcpServer } from '../../src/mcp-http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = process.env.GITNEXUS_CLI ?? path.resolve(HERE, '..', '..', '..', 'gitnexus', 'dist', 'cli', 'index.js');
const REPO = process.env.PROMETHEUS_REPO ?? '/Users/sugerdaddy/AI/shop/prometheus';
const QUERY_LIMIT = 200;
const QUERY_TIMEOUT_MS = 180_000;

const argv = process.argv.slice(2);
const jsonFlag = argv.indexOf('--json');
const JSON_OUT = jsonFlag >= 0 ? path.resolve(argv[jsonFlag + 1]) : path.join(HERE, 'results', 'prometheus-spotcheck.json');

/**
 * HAND-DERIVED EXPECTATIONS — written from the source before the first query.
 * `guards`: {controllerLine -> dependentLine} for every early-return guard edge (label T).
 * `other`:  additional classical edges that are crisp (branch arms / fall-through).
 * `functionLine`: the declaration line used to scope a file-path anchor.
 */
const EXPECTATIONS = [
  {
    id: 'readHistogramChunkLayout',
    name: 'readHistogramChunkLayout',
    file: 'tsdb/chunkenc/histogram_meta.go',
    declLine: 35,
    functionLine: 35,
    shape: 'straight-line chain of 5 `if err != nil { return … }` guards + a nested guarded if',
    guards: [[42, 43], [47, 48], [53, 54], [58, 59], [64, 65]],
    other: [[42, 46, 'F'], [47, 50, 'F'], [53, 57, 'F'], [58, 62, 'F'], [62, 63, 'T'], [62, 64, 'T'], [62, 69, 'F'], [64, 69, 'F']],
    notes: 'Line 47/48 and 53/54 and 58/59 are identical guard shapes; line 62 nested if is itself a dependent of the outer if at 58 (branch-to-branch, classical) and line 64 is a dependent of 62.',
  },
  {
    id: 'readCheckpoint',
    name: 'readCheckpoint',
    file: 'tsdb/wlog/watcher.go',
    declLine: 715,
    functionLine: 715,
    shape: 'guard chain with a for-range loop whose body returns, plus a compound `err != nil && !errors.Is(err, io.EOF)` predicate',
    guards: [[718, 719], [724, 725], [729, 730], [734, 735], [741, 742], [745, 746]],
    other: [[718, 723, 'F'], [724, 727, 'F'], [729, 733, 'F'], [734, 738, 'F'], [741, 745, 'F']],
    notes: 'The loop body returns, so the post-loop code does NOT post-dominate the loop header — unlike the Java loop fixtures, a loop-exit dependence {727 -> 750/751} is therefore a genuine classical edge and is annotated as informational rather than as a gate clause. Line 741 is a COMPOUND && predicate and must be ONE predicate. Line 746 is a return on the F arm of 741, so {741 -> 746 : F} is a real guard-class edge.',
  },
  {
    id: 'Visit (durationVisitor)',
    name: 'Visit',
    file: 'promql/durations.go',
    declLine: 39,
    functionLine: 39,
    shape: 'TYPE SWITCH with a guarded return in each of the five arms; the method name `Visit` is almost certainly ambiguous repo-wide',
    guards: [[44, 45], [52, 53], [60, 61], [67, 68], [74, 75]],
    other: [[40, 42, 'T'], [40, 50, 'T'], [40, 58, 'T'], [42, 43, 'T'], [50, 51, 'T'], [58, 59, 'T'], [65, 66, 'T'], [72, 73, 'T']],
    notes: 'Go-only construct: a type switch. Every case arm is a guarded return; the annotated F arms are the next statement inside the same case body. Case dispatch is expected to be labelled T for every arm.',
  },
  {
    id: 'OpenBlock',
    name: 'OpenBlock',
    file: 'tsdb/block.go',
    declLine: 355,
    functionLine: 355,
    shape: 'guard chain in a function with a NAMED return `err` and a `defer func(){ if err != nil {…} }()` that both READS and WRITES the named return',
    guards: [[366, 367], [381, 382], [387, 388]],
    other: [[377, 378, 'T'], [366, 370, 'F'], [377, 380, 'F'], [381, 384, 'F'], [387, 390, 'F']],
    notes: 'The `postingsDecoderFactory != nil` predicate at 377 is NOT a guard (its T arm is an assignment). THE DEFER PROBE: the deferred closure is a func_literal with its own unit keyed to line 360; if its blocks leak into the enclosing unit the enclosing CDG gains spurious rows, and if the tool follows the named-return write at 362 the closing `return pb, nil` at 405 may acquire false dependences.',
  },
  {
    id: 'labelNames',
    name: 'labelNames',
    file: 'web/api/v1/api.go',
    declLine: 884,
    functionLine: 884,
    shape: 'seven guarded returns, a `defer q.Close()` (the defer probe on real code), a nested if/else and two loops',
    guards: [[886, 887], [891, 892], [895, 896], [900, 901], [909, 910], [923, 924], [945, 946]],
    other: [[918, 919, 'T'], [918, 940, 'F'], [921, 922, 'T'], [923, 927, 'F'], [941, 942, 'T'], [950, 951, 'T'], [954, 955, 'T']],
    notes: 'Annotated `apiFuncResult` is a STRUCT literal return, not a named return, so no return-value write-back path exists — the defer at 912 must NOT create a dependence into the closing return at 958. Line 923 guard sits inside a for-range loop; line 945 guard is inside the else arm.',
  },
];

// ---------------------------------------------------------------- helpers ----

const log = (m) => process.stdout.write(`${m}\n`);

function readPayload(payload) {
  if (!payload || typeof payload !== 'object') return { kind: 'empty', raw: payload };
  if (payload.status === 'ambiguous') return { kind: 'ambiguous', raw: payload };
  if (payload.error) return { kind: 'error', raw: payload };
  if (Array.isArray(payload.results)) return { kind: 'results', rows: payload.results, raw: payload };
  return { kind: 'empty', raw: payload };
}

const controlRows = (payload) => {
  const { kind, rows } = readPayload(payload);
  if (kind !== 'results') return [];
  return rows.map((row) => ({
    functionLine: row?.functionLine ?? null,
    controllerLine: row?.controller?.line ?? null,
    dependentLine: row?.dependent?.line ?? null,
    label: row?.label ?? null,
    guard: row?.guard === true,
    text: String(row?.dependent?.text ?? '').replace(/\s+/g, ' ').trim(),
  }));
};

// ------------------------------------------------------------------- main ----

async function main() {
  if (!existsSync(CLI_PATH)) throw new Error(`CLI not found: ${CLI_PATH}`);
  if (!existsSync(path.join(REPO, '.gitnexus', 'meta.json'))) throw new Error(`No index at ${REPO}`);
  const meta = JSON.parse(readFileSync(path.join(REPO, '.gitnexus', 'meta.json'), 'utf8'));
  log(`repo: ${REPO} (HEAD ${meta.lastCommit?.slice(0, 12)}, indexedAt ${meta.indexedAt}, pdg=${meta.pdg ? 'present' : 'MISSING'})`);

  const session = await startMcpServer({ cliPath: CLI_PATH, cwd: REPO, log });
  const query = async (mode, target, extra = {}) => {
    try {
      const payload = await session.client.callTool('pdg_query', { mode, target, limit: QUERY_LIMIT, ...extra }, { timeoutMs: QUERY_TIMEOUT_MS });
      return { ok: true, payload };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  };

  const report = [];
  try {
    for (const spec of EXPECTATIONS) {
      const byName = await query('controls', spec.name);
      const nameKind = byName.ok ? readPayload(byName.payload).kind : 'transport-error';
      const nameRows = byName.ok ? controlRows(byName.payload) : [];

      const byFile = await query('controls', spec.file);
      const fileRowsAll = byFile.ok ? controlRows(byFile.payload) : [];
      const fileRowsScoped = fileRowsAll.filter((row) => row.functionLine === spec.functionLine);

      // Which anchor supplied the rows we score: name unless ambiguous/empty.
      const usedName = nameKind === 'results' && nameRows.length > 0;
      const scored = usedName ? nameRows : fileRowsScoped;
      const anchorUsed = usedName ? 'name' : 'file+functionLine';

      const pairKey = (c, d) => `${c}->${d}`;
      const pool = new Map();
      for (const row of scored) {
        const k = pairKey(row.controllerLine, row.dependentLine);
        if (!pool.has(k)) pool.set(k, []);
        pool.get(k).push(row);
      }
      const guardsFound = spec.guards.filter(([c, d]) => pool.has(pairKey(c, d)));
      const guardsMissed = spec.guards.filter(([c, d]) => !pool.has(pairKey(c, d)));
      const guardsWrongSense = spec.guards
        .filter(([c, d]) => pool.has(pairKey(c, d)))
        .filter(([c, d]) => !pool.get(pairKey(c, d)).some((r) => r.label === 'T'));
      const guardsFlagged = spec.guards.filter(([c, d]) => pool.get(pairKey(c, d))?.some((r) => r.guard === true));

      const otherFound = spec.other.filter(([c, d]) => pool.has(pairKey(c, d)));
      const otherMissed = spec.other.filter(([c, d]) => !pool.has(pairKey(c, d)));

      const expectedAll = new Set([...spec.guards.map(([c, d]) => pairKey(c, d)), ...spec.other.map(([c, d]) => pairKey(c, d))]);
      const extras = [...pool.keys()].filter((k) => !expectedAll.has(k)).map((k) => pool.get(k)[0]);

      report.push({
        id: spec.id, name: spec.name, file: spec.file, functionLine: spec.functionLine,
        shape: spec.shape, notes: spec.notes,
        anchorUsed, byName: { kind: nameKind, rows: nameRows.length, raw: byName.ok ? byName.payload : byName },
        byFile: { rowsAll: fileRowsAll.length, rowsScoped: fileRowsScoped.length, distinctFunctionLines: [...new Set(fileRowsAll.map((r) => r.functionLine))] },
        guards: { expected: spec.guards.length, found: guardsFound.length, missed: guardsMissed, wrongSense: guardsWrongSense, guardFlagged: guardsFlagged.length },
        other: { expected: spec.other.length, found: otherFound.length, missed: otherMissed },
        returnedRows: scored.length,
        extras,
        scoredRows: scored,
      });
    }
  } finally {
    await session.stop();
  }

  // ------------------------------------------------------------- output ----
  let totalGuards = 0; let totalFound = 0; let totalMissed = 0; let totalWrongSense = 0; let totalFlagged = 0;
  log('');
  log('=== Prometheus guard-edge spot check (hand-derived BEFORE the run) ===');
  for (const r of report) {
    totalGuards += r.guards.expected;
    totalFound += r.guards.found;
    totalMissed += r.guards.missed.length;
    totalWrongSense += r.guards.wrongSense.length;
    totalFlagged += r.guards.guardFlagged;
    log('');
    log(`${r.id}  [${r.file}:${r.functionLine}]`);
    log(`  shape: ${r.shape}`);
    log(`  anchors: target=name -> ${r.byName.kind} ${r.byName.rows} rows | target=file -> ${r.byFile.rowsAll} rows `
      + `(${r.byFile.rowsScoped} at functionLine=${r.functionLine}; other units in file: [${r.byFile.distinctFunctionLines.join(',')}])`);
    log(`  scored anchor: ${r.anchorUsed}`);
    log(`  guards: ${r.guards.found}/${r.guards.expected} found, ${r.guards.missed.length} MISSED, `
      + `${r.guards.wrongSense.length} wrong-sense, ${r.guards.guardFlagged} guard-flagged by the tool`);
    if (r.guards.missed.length) log(`    MISSED GUARDS: ${r.guards.missed.map(([c, d]) => `${c}->${d}`).join(', ')}`);
    if (r.guards.wrongSense.length) log(`    WRONG SENSE:   ${r.guards.wrongSense.map(([c, d]) => `${c}->${d}`).join(', ')}`);
    log(`  other classical: ${r.other.found}/${r.other.expected} found`);
    if (r.other.missed.length) log(`    not returned: ${r.other.missed.map(([c, d, l]) => `${c}->${d}[${l}]`).join(', ')}`);
    log(`  rows returned (scored anchor): ${r.returnedRows}, extras: ${r.extras.length}`);
    for (const e of r.extras) log(`    EXTRA ${e.controllerLine}->${e.dependentLine} [${e.label}]${e.guard ? ' GUARD' : ''} "${e.text.slice(0, 60)}"`);
  }

  const verdict = totalMissed === 0 ? 'PASS' : 'FAIL';
  log('');
  log('=== summary ===');
  log(`hand-derived guard edges: ${totalGuards}; found ${totalFound}; MISSED ${totalMissed}; wrong-sense ${totalWrongSense}; tool guard-flagged ${totalFlagged}`);
  log(`SPOT-CHECK GATE: ${verdict}${totalMissed ? ' — any missed guard edge is a gate failure' : ' — zero missed guard edges on real Prometheus code'}`);

  mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, JSON.stringify({
    generatedAt: new Date().toISOString(), repo: REPO, head: meta.lastCommit, indexedAt: meta.indexedAt,
    verdict, totals: { guardsExpected: totalGuards, found: totalFound, missed: totalMissed, wrongSense: totalWrongSense, toolGuardFlagged: totalFlagged },
    methods: report,
  }, null, 2));
  log(`raw rows: ${JSON_OUT}`);
  process.exitCode = verdict === 'PASS' ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`spotcheck failed: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
});
