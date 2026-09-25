import { describe, expect, it } from 'vitest';
import type { ChangeEntry, RiskCode } from '../types/report';
import { normalizeRisk, reportRiskCode, riskRank, sortChangesByRisk } from './risk';
import { emptyReport } from './report';

function change(uid: string, risk: RiskCode, filePath = 'src/a.ts', startLine = 1): ChangeEntry {
  return {
    uid,
    name: uid,
    kind: 'Function',
    filePath,
    startLine,
    isTestFile: false,
    impact: {
      risk,
      epistemic: 'exact',
      boundaries: [],
      upstream: [],
      downstream: [],
      affectedProcesses: [],
      affectedModules: [],
    },
  };
}

describe('riskRank / normalizeRisk', () => {
  it('orders CRITICAL > HIGH > MEDIUM > LOW > UNKNOWN', () => {
    expect(riskRank('CRITICAL')).toBeGreaterThan(riskRank('HIGH'));
    expect(riskRank('HIGH')).toBeGreaterThan(riskRank('MEDIUM'));
    expect(riskRank('MEDIUM')).toBeGreaterThan(riskRank('LOW'));
    expect(riskRank('LOW')).toBeGreaterThan(riskRank('UNKNOWN'));
  });

  it('ranks unparseable values below UNKNOWN', () => {
    expect(riskRank('BOGUS')).toBeLessThan(riskRank('UNKNOWN'));
    expect(riskRank(undefined)).toBeLessThan(riskRank('UNKNOWN'));
  });

  it('normalizes case and unknown input', () => {
    expect(normalizeRisk('high')).toBe('HIGH');
    expect(normalizeRisk(' high ')).toBe('HIGH');
    expect(normalizeRisk('bogus')).toBe('UNKNOWN');
    expect(normalizeRisk(undefined)).toBe('UNKNOWN');
  });
});

describe('sortChangesByRisk', () => {
  it('sorts by risk descending and does not mutate the input', () => {
    const input = [change('low', 'LOW'), change('crit', 'CRITICAL'), change('med', 'MEDIUM')];
    const snapshot = [...input];
    const sorted = sortChangesByRisk(input);
    expect(sorted.map((c) => c.uid)).toEqual(['crit', 'med', 'low']);
    expect(input).toEqual(snapshot);
  });

  it('breaks ties by filePath then startLine, deterministically', () => {
    const sorted = sortChangesByRisk([
      change('b', 'HIGH', 'src/b.ts', 1),
      change('a2', 'HIGH', 'src/a.ts', 40),
      change('a1', 'HIGH', 'src/a.ts', 10),
    ]);
    expect(sorted.map((c) => c.uid)).toEqual(['a1', 'a2', 'b']);
  });

  it('keeps UNKNOWN last and treats malformed risk as lowest', () => {
    const broken = { ...change('broken', 'UNKNOWN'), impact: { ...change('broken', 'UNKNOWN').impact, risk: 'NOPE' as RiskCode } };
    const sorted = sortChangesByRisk([broken, change('unknown', 'UNKNOWN'), change('low', 'LOW')]);
    expect(sorted.map((c) => c.uid)).toEqual(['low', 'unknown', 'broken']);
  });
});

describe('reportRiskCode', () => {
  it('prefers summary.riskLevel', () => {
    const report = emptyReport();
    report.summary.riskLevel = 'high';
    report.changes = [change('a', 'CRITICAL')];
    expect(reportRiskCode(report)).toBe('HIGH');
  });

  it('falls back to the highest change risk when summary is missing', () => {
    const report = emptyReport();
    report.summary.riskLevel = undefined as unknown as 'unknown';
    report.changes = [change('a', 'LOW'), change('b', 'MEDIUM')];
    expect(reportRiskCode(report)).toBe('MEDIUM');
  });
});
