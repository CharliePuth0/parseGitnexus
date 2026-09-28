/**
 * Unit tests for the PDG consumption strategy (guards-first, precision/FINDINGS.md).
 *
 *   node --test 'release-impact/test/*.test.mjs'
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readPdgStamp, querySymbolPdg } from '../src/pdg.mjs';

const symbol = {
  uid: 'Method:a/b/C.java:C.m#1',
  name: 'm',
  kind: 'Method',
  filePath: 'a/b/C.java',
  isTestFile: false,
};

/**
 * Stub matching the client call shape:
 * (mode, target|null, limit, afterLine?, targetUid?)
 */
function stubCall(behavior) {
  const calls = [];
  const fn = async (mode, target, limit, afterLine, targetUid) => {
    calls.push({ mode, target, limit, afterLine, targetUid });
    return behavior({ mode, target, limit, afterLine, targetUid }, calls.length);
  };
  return { fn, calls };
}

/** Fail the UID path so the resolution falls through to name/file. */
function uidFails() {
  return { __error: 'symbol not found' };
}

test('readPdgStamp reports the analyze --pdg stamp presence', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gnx-pdg-'));
  mkdirSync(path.join(dir, '.gitnexus'), { recursive: true });
  writeFileSync(path.join(dir, '.gitnexus', 'meta.json'), '{"pdg":{"hasCallSummary":true}}');
  assert.equal(readPdgStamp(dir).pdgLayer, true);

  writeFileSync(path.join(dir, '.gitnexus', 'meta.json'), '{"stats":{}}');
  assert.equal(readPdgStamp(dir).pdgLayer, false);
  rmSync(dir, { recursive: true, force: true });

  assert.equal(readPdgStamp('/nonexistent').pdgLayer, false);
  assert.ok(readPdgStamp('/nonexistent').error);
});

test('querySymbolPdg prefers the UID path and cleans rows', async () => {
  const { fn, calls } = stubCall(({ mode, targetUid }) => {
    if (targetUid !== symbol.uid) return uidFails();
    if (mode === 'controls') {
      return {
        results: [
          { functionLine: 10, controller: { line: 12 }, dependent: { line: 14, text: 'return x;' }, label: 'T', guard: true },
          { functionLine: 10, controller: { line: 12 }, dependent: { line: 14, text: 'return x;' }, label: 'T', guard: true }, // dup
          { functionLine: 10, controller: { line: 12 }, dependent: { line: 16, text: '' }, label: 'F' }, // empty text → dropped
        ],
        total: 3,
      };
    }
    return {
      results: [
        { functionLine: 10, variable: 'x', def: { line: 12 }, use: { line: 14, text: 'return x;' } },
        { functionLine: 10, variable: 'x', def: { line: 12 }, use: { line: 14, text: 'return x;' } }, // dup
      ],
      total: 2,
    };
  });

  const result = await querySymbolPdg({}, symbol, { pdgQuery: fn });

  assert.equal(result.resolution, 'uid');
  assert.equal(result.guards.length, 1);
  assert.equal(result.guards[0].guard, true);
  assert.equal(result.flows.length, 1);
  assert.match(result.note, /1 exception-flow row/);
  // Both modes queried by UID, never by name.
  assert.deepEqual(calls.map((c) => c.targetUid), [symbol.uid, symbol.uid]);
  assert.deepEqual(calls.map((c) => c.target), [null, null]);
});

test('querySymbolPdg falls back to the unique name when the UID fails', async () => {
  const { fn, calls } = stubCall(({ mode, target, targetUid }) => {
    if (targetUid) return uidFails();
    if (mode === 'controls') {
      return {
        results: [{ functionLine: 10, controller: { line: 12 }, dependent: { line: 14, text: 'return x;' }, label: 'T', guard: true }],
        total: 1,
      };
    }
    return { results: [], total: 0 };
  });

  const result = await querySymbolPdg({}, symbol, { pdgQuery: fn });

  assert.equal(result.resolution, 'name');
  assert.equal(result.guards.length, 1);
  assert.deepEqual(calls.map((c) => c.target), [null, 'm', 'm']);
});

test('querySymbolPdg falls back to file+functionLine keyset paging when the name is ambiguous', async () => {
  const { fn, calls } = stubCall(({ mode, target, targetUid, afterLine }) => {
    if (targetUid) return uidFails();
    if (target === 'm') {
      return {
        status: 'ambiguous',
        totalCandidates: 2,
        candidates: [
          { name: 'm', filePath: 'other/C.java', line: 5 },
          { name: 'm', filePath: 'a/b/C.java', line: 10 },
        ],
      };
    }
    // File path paged query: first page truncated with one matching row, second page the rest.
    if (afterLine === 0) {
      return {
        results: [
          { functionLine: 10, controller: { line: 12 }, dependent: { line: 14, text: 'return x;' }, label: 'T', guard: true },
          { functionLine: 99, controller: { line: 2 }, dependent: { line: 3, text: 'other();' }, label: 'T' },
        ],
        total: 3,
        truncated: true,
      };
    }
    return {
      results: [
        { functionLine: 10, controller: { line: 20 }, dependent: { line: 21, text: 'more();' }, label: 'F' },
        { functionLine: 99, controller: { line: 30 }, dependent: { line: 31, text: 'other2();' }, label: 'T' },
      ],
      total: 3,
    };
  });

  const result = await querySymbolPdg({}, symbol, { pdgQuery: fn });

  assert.equal(result.resolution, 'file+functionLine');
  // Both pages' functionLine-10 rows are present.
  assert.equal(result.guards.length, 2);
  assert.equal(result.guards[0].controllerLine, 12);
  assert.equal(result.guards[1].controllerLine, 20);
  // The controls file query paged twice (after_line 0, then >0).
  const controlsFileCalls = calls.filter((c) => c.target === 'a/b/C.java' && c.mode === 'controls');
  assert.equal(controlsFileCalls.length, 2);
  assert.equal(controlsFileCalls[1].afterLine > 0, true);
});

test('querySymbolPdg treats an unresolvable symbol as UNKNOWN, never empty-dependence', async () => {
  const { fn } = stubCall(({ targetUid, target }) => {
    if (targetUid) return uidFails();
    return { status: 'ambiguous', totalCandidates: 4, candidates: [] };
  });

  const result = await querySymbolPdg({}, symbol, { pdgQuery: fn });

  assert.equal(result.guards.length, 0);
  assert.match(result.note, /could not resolve|UNKNOWN/);
});

test('querySymbolPdg treats empty name results as UNKNOWN', async () => {
  const { fn } = stubCall(({ targetUid }) => {
    if (targetUid) return uidFails();
    return { results: [], total: 0 };
  });

  const result = await querySymbolPdg({}, symbol, { pdgQuery: fn });

  assert.equal(result.pdgLayer, true);
  assert.match(result.note, /UNKNOWN/);
});
