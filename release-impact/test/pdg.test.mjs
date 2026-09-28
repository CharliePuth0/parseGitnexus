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

function stubCall(behavior) {
  const calls = [];
  const fn = async (mode, target, limit) => {
    calls.push({ mode, target, limit });
    return behavior({ mode, target, limit }, calls.length);
  };
  return { fn, calls };
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

test('querySymbolPdg uses the unique-name path and cleans rows', async () => {
  const { fn, calls } = stubCall(({ mode }) => {
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

  assert.equal(result.resolution, 'name');
  assert.equal(result.guards.length, 1);
  assert.equal(result.guards[0].guard, true);
  assert.equal(result.flows.length, 1);
  assert.match(result.note, /1 exception-flow row/);
  assert.deepEqual(calls.map((c) => c.target), ['m', 'm']);
});

test('querySymbolPdg falls back to file+functionLine when the name is ambiguous', async () => {
  const { fn, calls } = stubCall(({ mode, target }) => {
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
    // File-path queries: multiple functions in the file, filter by functionLine 10.
    return {
      results: [
        { functionLine: 10, controller: { line: 12 }, dependent: { line: 14, text: 'return x;' }, label: 'T', guard: true },
        { functionLine: 99, controller: { line: 2 }, dependent: { line: 3, text: 'other();' }, label: 'T' },
      ],
      total: 2,
    };
  });

  const result = await querySymbolPdg({}, symbol, { pdgQuery: fn });

  assert.equal(result.resolution, 'file+functionLine');
  assert.equal(result.guards.length, 1);
  assert.equal(result.guards[0].controllerLine, 12);
  assert.deepEqual(
    calls.map((c) => c.target),
    ['m', 'a/b/C.java', 'a/b/C.java'],
  );
});

test('querySymbolPdg treats an unresolvable symbol as UNKNOWN, never empty-dependence', async () => {
  const { fn } = stubCall(() => ({ status: 'ambiguous', totalCandidates: 4, candidates: [] }));

  const result = await querySymbolPdg({}, symbol, { pdgQuery: fn });

  assert.equal(result.guards.length, 0);
  assert.match(result.note, /could not resolve/);
});

test('querySymbolPdg treats empty name results as UNKNOWN', async () => {
  const { fn } = stubCall(() => ({ results: [], total: 0 }));

  const result = await querySymbolPdg({}, symbol, { pdgQuery: fn });

  assert.equal(result.pdgLayer, true);
  assert.match(result.note, /UNKNOWN/);
});
