import { describe, expect, it } from 'vitest';
import { PAGE_SIZE, pageSlice } from './paging';

const items = Array.from({ length: 26 }, (_, index) => `p${index}`);

describe('pageSlice', () => {
  it('asks for one screen at a time and reports what is left', () => {
    const first = pageSlice(items, PAGE_SIZE);
    expect(first.visible).toHaveLength(PAGE_SIZE);
    expect(first.visible[0]).toBe('p0');
    expect(first.remaining).toBe(6);
    expect(first.hasMore).toBe(true);
  });

  it('stops growing past the end without ever hiding the total', () => {
    const all = pageSlice(items, 100);
    expect(all.visible).toHaveLength(items.length);
    expect(all.remaining).toBe(0);
    expect(all.hasMore).toBe(false);
  });

  it('degrades safely on a nonsense limit or an empty list', () => {
    expect(pageSlice(items, 0).visible).toHaveLength(1);
    expect(pageSlice(items, -5).visible).toHaveLength(1);
    // 非法 limit 回落到默认页大小,而不是把列表清空
    expect(pageSlice(items, Number.NaN).visible).toHaveLength(PAGE_SIZE);
    const empty = pageSlice([], PAGE_SIZE);
    expect(empty.visible).toEqual([]);
    expect(empty.hasMore).toBe(false);
  });
});
