/** 纯展示用格式化工具,无副作用。 */

export interface PathParts {
  dir: string;
  base: string;
}

/** 拆出目录与文件名,便于列表里「目录弱化 + 文件名强调」。 */
export function splitPath(filePath: string | null | undefined): PathParts {
  const value = (filePath ?? '').trim();
  if (value === '') return { dir: '', base: '' };
  const normalized = value.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx < 0) return { dir: '', base: normalized };
  return { dir: normalized.slice(0, idx + 1), base: normalized.slice(idx + 1) };
}

/** 超过 maxSegments 段时折叠中间部分:`…/core/ingestion/test-file-path.ts`。 */
export function shortenPath(filePath: string | null | undefined, maxSegments = 3): string {
  const value = (filePath ?? '').trim();
  if (value === '') return '';
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((s) => s !== '');
  if (segments.length <= maxSegments) return normalized;
  return `…/${segments.slice(-maxSegments).join('/')}`;
}

/** `文件:行` — 无行号时只返回文件名。 */
export function formatLocation(filePath: string | null | undefined, startLine?: number): string {
  const { base } = splitPath(filePath);
  if (typeof startLine === 'number' && Number.isFinite(startLine)) return `${base}:${startLine}`;
  return base;
}

/** ISO → `2026-09-25 23:51`;解析失败时原样返回(不隐藏引擎的脏数据)。 */
export function formatDateTime(iso: string | null | undefined): string {
  const value = (iso ?? '').trim();
  if (value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatConfidence(confidence: number | null | undefined): string {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return '—';
  const clamped = Math.max(0, Math.min(1, confidence));
  return `${Math.round(clamped * 100)}%`;
}

/** 置信度 → 0-1 的宽度比例,用于条形图;null 表示未知。 */
export function confidenceRatio(confidence: number | null | undefined): number | null {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  return Math.max(0, Math.min(1, confidence));
}

/** 数字千分位(纯手写,避免 locale 差异影响快照)。 */
export function formatNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function orDash(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? '—' : trimmed;
}
