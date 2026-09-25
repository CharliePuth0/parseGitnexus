import { describe, expect, it } from 'vitest';
import type { ChangeEntry, RiskCode } from '../types/report';
import { DEFAULT_FILTER, countByRisk, filterChanges, isTestEntry, toggleRisk } from './filter';

function change(
  uid: string,
  over: Partial<ChangeEntry> & { risk?: RiskCode } = {},
): ChangeEntry {
  return {
    uid,
    name: over.name ?? uid,
    kind: over.kind ?? 'Function',
    filePath: over.filePath ?? 'src/core/a.ts',
    isTestFile: over.isTestFile ?? false,
    impact: {
      risk: over.risk ?? 'LOW',
      epistemic: 'exact',
      boundaries: [],
      upstream: [],
      downstream: [],
      affectedProcesses: [],
      affectedModules: [],
    },
  };
}

describe('isTestEntry', () => {
  it('trusts the report flag', () => {
    expect(isTestEntry(change('a', { isTestFile: true }))).toBe(true);
  });

  it('falls back to the shared isTestFilePath predicate', () => {
    // 引擎漏标时,路径判定仍然要生效(gitnexus-shared 的单一实现)
    for (const filePath of [
      'src/__tests__/a.ts',
      'pkg/foo_test.go',
      'app/src/test/java/A.java',
      'ios/MyAppUITests/Case.swift',
      'gitnexus/test/unit/x.test.ts',
      'conftest.py',
      'lib/spec/thing_spec.rb',
    ]) {
      expect(isTestEntry(change('x', { filePath })), filePath).toBe(true);
    }
  });

  it('does not treat production paths as tests', () => {
    for (const filePath of ['src/latest/Contest.swift', 'src/core/contest.ts', 'src/mcp/tools.ts']) {
      expect(isTestEntry(change('x', { filePath })), filePath).toBe(false);
    }
  });
});

describe('filterChanges', () => {
  const changes: ChangeEntry[] = [
    change('crit', { risk: 'CRITICAL', name: 'isTestFilePath', filePath: 'gitnexus-shared/src/test-file-path.ts' }),
    change('high', { risk: 'HIGH', name: 'impact', filePath: 'gitnexus/src/mcp/tools.ts' }),
    change('test', { risk: 'LOW', name: 'suite', filePath: 'gitnexus/test/unit/impact.test.ts' }),
  ];

  it('hides test files by default', () => {
    expect(DEFAULT_FILTER.hideTests).toBe(true);
    expect(filterChanges(changes, DEFAULT_FILTER).map((c) => c.uid)).toEqual(['crit', 'high']);
  });

  it('shows test files when the toggle is off', () => {
    const visible = filterChanges(changes, { ...DEFAULT_FILTER, hideTests: false });
    expect(visible.map((c) => c.uid)).toEqual(['crit', 'high', 'test']);
  });

  it('filters by risk chips', () => {
    const visible = filterChanges(changes, { ...DEFAULT_FILTER, risks: ['HIGH'] });
    expect(visible.map((c) => c.uid)).toEqual(['high']);
  });

  it('searches name and path case-insensitively', () => {
    expect(filterChanges(changes, { ...DEFAULT_FILTER, query: 'IMPACT' }).map((c) => c.uid)).toEqual([
      'high',
    ]);
    expect(
      filterChanges(changes, { ...DEFAULT_FILTER, query: 'shared/src' }).map((c) => c.uid),
    ).toEqual(['crit']);
    expect(filterChanges(changes, { ...DEFAULT_FILTER, query: '   ' })).toHaveLength(2);
  });

  it('combines risk + search + test filter', () => {
    const visible = filterChanges(changes, { risks: ['LOW', 'CRITICAL'], query: 'test', hideTests: false });
    expect(visible.map((c) => c.uid)).toEqual(['crit', 'test']);
  });
});

describe('countByRisk / toggleRisk', () => {
  it('counts per level', () => {
    const counts = countByRisk([
      change('a', { risk: 'CRITICAL' }),
      change('b', { risk: 'CRITICAL' }),
      change('c', { risk: 'LOW' }),
    ]);
    expect(counts.CRITICAL).toBe(2);
    expect(counts.LOW).toBe(1);
    expect(counts.UNKNOWN).toBe(0);
  });

  it('toggles membership without mutating', () => {
    const start: RiskCode[] = ['HIGH'];
    expect(toggleRisk(start, 'LOW')).toEqual(['HIGH', 'LOW']);
    expect(toggleRisk(start, 'HIGH')).toEqual([]);
    expect(start).toEqual(['HIGH']);
  });
});
