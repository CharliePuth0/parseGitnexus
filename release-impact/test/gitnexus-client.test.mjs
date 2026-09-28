/**
 * Unit tests for the GitNexus client's detect_changes pagination walk and page merge.
 *
 *   node --test release-impact/test/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GitNexusClient, mergeDetectChangesPages, CHANGED_SYMBOL_CAP } from '../src/gitnexus-client.mjs';

function page({ offset = 0, count = 100, truncated = true, partial = false, name = 'p' } = {}) {
  return {
    summary: { changed_count: 250, affected_count: 3, risk_level: 'high' },
    changed_symbols: Array.from({ length: count }, (_, i) => ({ name: `${name}${offset + i}` })),
    affected_processes: [{ id: 'proc_1', summary: 'A → B', stepCount: 4 }],
    truncated,
    ...(partial ? { partial: true } : {}),
  };
}

test('mergeDetectChangesPages concatenates pages in order and keeps page-1 totals', () => {
  const merged = mergeDetectChangesPages([
    page({ offset: 0, count: 2, truncated: true }),
    page({ offset: 2, count: 2, truncated: false, name: 'q' }),
  ]);

  assert.equal(merged.changed_symbols.length, 4);
  assert.deepEqual(
    merged.changed_symbols.map((s) => s.name),
    ['p0', 'p1', 'q2', 'q3'],
  );
  // The server computes summary/processes from the FULL set on every page.
  assert.equal(merged.summary.changed_count, 250);
  assert.equal(merged.affected_processes.length, 1);
  assert.equal(merged.truncated, false);
});

test('mergeDetectChangesPages takes truncated from the last page and ORs partial', () => {
  const merged = mergeDetectChangesPages([
    page({ offset: 0, truncated: true }),
    page({ offset: 100, truncated: true, partial: true }),
    page({ offset: 200, truncated: true }),
  ]);

  assert.equal(merged.truncated, true);
  assert.equal(merged.partial, true);
});

test('mergeDetectChangesPages tolerates a failed mid-loop page', () => {
  const merged = mergeDetectChangesPages([
    page({ offset: 0, count: 100, truncated: true }),
    { __error: 'boom' },
  ]);

  assert.equal(merged.changed_symbols.length, 100);
  assert.equal(merged.__error, 'boom');
});

test('mergeDetectChangesPages survives an empty page list', () => {
  const merged = mergeDetectChangesPages([]);
  assert.deepEqual(merged.changed_symbols, []);
  assert.equal(merged.truncated, false);
});

test('detectChanges walks pages while truncated, then stops', async () => {
  const calls = [];
  const client = new GitNexusClient({ repoPath: '/tmp/none', cliPath: '/tmp/none', log: () => {} });
  client.mode = 'mcp';
  client.mcp = {
    callTool: async (_name, args) => {
      calls.push(args);
      const { offset } = args;
      // 2500 symbols total: two full pages, one 500-symbol tail.
      const count = offset < 2000 ? CHANGED_SYMBOL_CAP : 500;
      return page({ offset, count, truncated: offset + count < 2500 });
    },
  };

  const payload = await client.detectChanges({ baseRef: 'HEAD~5', headRef: 'HEAD' });

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => c.offset),
    [0, CHANGED_SYMBOL_CAP, 2 * CHANGED_SYMBOL_CAP],
  );
  // Every page carries the exact range and the page-size limit.
  for (const call of calls) {
    assert.equal(call.scope, 'compare');
    assert.equal(call.base_ref, 'HEAD~5');
    assert.equal(call.head_ref, 'HEAD');
    assert.equal(call.limit, CHANGED_SYMBOL_CAP);
  }
  assert.equal(payload.changed_symbols.length, 2500);
  assert.equal(payload.truncated, false);
  assert.equal(payload.summary.changed_count, 250);
});

test('detectChanges stops early when a page comes back truncated with an empty listing', async () => {
  const calls = [];
  const client = new GitNexusClient({ repoPath: '/tmp/none', cliPath: '/tmp/none', log: () => {} });
  client.mode = 'mcp';
  client.mcp = {
    callTool: async (_name, args) => {
      calls.push(args);
      // Broken server: claims more data but returns nothing — must not loop.
      return page({ offset: args.offset, count: 0, truncated: true });
    },
  };

  const payload = await client.detectChanges({ baseRef: 'main', headRef: 'HEAD' });

  assert.equal(calls.length, 1);
  assert.equal(payload.changed_symbols.length, 0);
});
