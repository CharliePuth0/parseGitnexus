import type { ChangeType } from '../types/report';

/**
 * 变更类型的视觉权重。
 * 删除是高信号(调用方可能直接编译失败 / 运行时缺符号),列表里必须一眼看到;
 * 新增次之;修改是常态 —— 给常态也加角标,列表就变成噪声墙了。
 */
export type ChangeSignal = 'high' | 'low' | 'none';

export function changeTypeSignal(type: ChangeType | undefined): ChangeSignal {
  if (type === 'removed') return 'high';
  if (type === 'added') return 'low';
  return 'none';
}

/**
 * `impact.boundaries` 里混着两类完全不同的句子:
 *   1. 风险提示 —— 「跨仓库消费者未纳入本索引」这类影响面的性质;
 *   2. 诚实的上限 —— 「affectedProcesses capped at 50 of 177」这类**数据被截断**的声明。
 * 第 2 类必须排在前面并单独标记:它改变的是「下面的数字该怎么读」(下界,不是全量),
 * 而不是影响面本身。前端不能把它折叠进普通提示里。
 */
const CAP_PATTERN = /\bcaps?\b|\bcapped\b|truncat|limited to|上限|截断/i;

export function isCapBoundary(text: string): boolean {
  return CAP_PATTERN.test(text);
}

export interface BoundaryItem {
  text: string;
  /** true = 该条是「数据被截断」的声明 */
  cap: boolean;
}

/** 截断声明排在前,其余保持引擎给的顺序(sort 稳定)。 */
export function orderBoundaries(list: readonly string[]): BoundaryItem[] {
  return list
    .map((text) => ({ text, cap: isCapBoundary(text) }))
    .sort((a, b) => Number(b.cap) - Number(a.cap));
}

export function hasCapBoundary(list: readonly string[]): boolean {
  return list.some(isCapBoundary);
}
