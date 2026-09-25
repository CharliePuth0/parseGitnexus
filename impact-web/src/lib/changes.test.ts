import { describe, expect, it } from 'vitest';
import { changeTypeSignal, hasCapBoundary, isCapBoundary, orderBoundaries } from './changes';

describe('changeTypeSignal', () => {
  it('treats removed as the high-signal case and modified as no badge at all', () => {
    expect(changeTypeSignal('removed')).toBe('high');
    expect(changeTypeSignal('added')).toBe('low');
    expect(changeTypeSignal('modified')).toBe('none');
    expect(changeTypeSignal(undefined)).toBe('none');
  });
});

describe('boundary caps', () => {
  it('recognises the engine’s cap phrasing in both languages', () => {
    expect(isCapBoundary('affectedProcesses capped at 50 of 177')).toBe(true);
    expect(isCapBoundary('upstream truncated at depth 3')).toBe(true);
    expect(isCapBoundary('Cypher 查询结果分页上限 200,超出部分按 total 计数。')).toBe(true);
    expect(isCapBoundary('列表仅统计已索引文件。')).toBe(false);
  });

  it('does not fire on ordinary boundary prose', () => {
    expect(isCapBoundary('接口消费者未追踪:结构类型按形状匹配,索引无法枚举全部实现方。')).toBe(false);
    expect(isCapBoundary('跨仓库消费者(插件 / 下游 npm 包)不在本索引内。')).toBe(false);
    expect(isCapBoundary('')).toBe(false);
  });

  it('sorts cap statements first and keeps the engine order for the rest', () => {
    const ordered = orderBoundaries([
      '动态分派(接口 / 反射)的调用边无法静态解析。',
      'affectedProcesses capped at 50 of 177',
      '空调用集不等于未被使用。',
      'upstream capped at 200 of 1,204',
    ]);
    expect(ordered.map((item) => item.cap)).toEqual([true, true, false, false]);
    // 稳定排序:非截断条目保持引擎给的相对顺序
    expect(ordered[2]?.text).toBe('动态分派(接口 / 反射)的调用边无法静态解析。');
    expect(ordered[3]?.text).toBe('空调用集不等于未被使用。');
    expect(hasCapBoundary(ordered.map((item) => item.text))).toBe(true);
    expect(hasCapBoundary(['只有普通提示。'])).toBe(false);
  });
});
