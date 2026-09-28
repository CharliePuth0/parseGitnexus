/**
 * `buildDetectChangesDiffArgs` argv contract — the exact git command that runs
 * behind `detect_changes`, including the engineering-facing `head_ref`
 * commit-to-commit range. `compare` without a base ref stays null (asserted on
 * the real function here; `diffArgsFor` refuses the null for shelling tests).
 */
import { describe, it, expect } from 'vitest';
import { buildDetectChangesDiffArgs } from '../../src/mcp/local/local-backend.js';

const PINNED_PREFIX = [
  '-c',
  'core.quotePath=false',
  'diff',
  '--ignore-cr-at-eol',
  '--no-ext-diff',
  '--color=never',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

describe('buildDetectChangesDiffArgs — head_ref commit-to-commit range', () => {
  it('compare with base_ref and head_ref emits base head -U0 (exclusive range)', () => {
    expect(buildDetectChangesDiffArgs('compare', 'main', 'HEAD~3')).toEqual([
      ...PINNED_PREFIX,
      'main',
      'HEAD~3',
      '-U0',
    ]);
  });

  it('compare with base_ref only is unchanged (base vs worktree)', () => {
    expect(buildDetectChangesDiffArgs('compare', 'main')).toEqual([...PINNED_PREFIX, 'main', '-U0']);
  });

  it('compare without base_ref still returns null', () => {
    expect(buildDetectChangesDiffArgs('compare')).toBeNull();
    expect(buildDetectChangesDiffArgs('compare', undefined, 'HEAD')).toBeNull();
  });

  it('head_ref is ignored by unstaged/staged/all scopes', () => {
    expect(buildDetectChangesDiffArgs('unstaged', undefined, 'HEAD')).toEqual([
      ...PINNED_PREFIX,
      '-U0',
    ]);
    expect(buildDetectChangesDiffArgs('staged', undefined, 'HEAD')).toEqual([
      ...PINNED_PREFIX,
      '--staged',
      '-U0',
    ]);
    expect(buildDetectChangesDiffArgs('all', undefined, 'HEAD')).toEqual([
      ...PINNED_PREFIX,
      'HEAD',
      '-U0',
    ]);
  });
});
