/**
 * PDG (statement-level) consumption for the engine — guards-first, per the Phase A
 * precision findings (see precision/FINDINGS.md):
 *
 *   - the CONTROL layer (which predicate guards which statement) is trustworthy on
 *     real Java: 11/11 hand-derived guard edges on killshop, 0 false guards;
 *   - FLOWS (def→use) are block-granular, duplicated, and noisy on exception edges —
 *     consumed with compensations (dedupe, drop empty-text rows, text as truth);
 *   - `pdg_query` does NOT resolve UIDs (they contain `/` → treated as file paths →
 *     silent empty result) and bare names are ambiguous in a monorepo — resolution is
 *     two-step: name (unique) → else candidate-by-filePath → else filePath +
 *     functionLine filter;
 *   - `results: []` means UNKNOWN (an unresolvable target also yields it), never
 *     "no dependence".
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const PDG_QUERY_TIMEOUT_MS = 30_000;
const PDG_ROW_CAP = 50;
/** Safety cap on file-anchor keyset pages (200 rows/page ⇒ up to 10k rows walked). */
const MAX_FILE_PAGES = 20;

/** True when the repo's index carries a PDG layer (the `analyze --pdg` stamp). */
export function readPdgStamp(repoPath) {
  try {
    const meta = JSON.parse(readFileSync(path.join(repoPath, '.gitnexus', 'meta.json'), 'utf8'));
    return { pdgLayer: Boolean(meta?.pdg), error: null };
  } catch (error) {
    return { pdgLayer: false, error: error.message };
  }
}

/** Dedupe byte-identical rows; drop exception-family rows with empty dependent text. */
function cleanControls(rows) {
  const seen = new Set();
  const kept = [];
  let droppedEmptyText = 0;
  for (const row of rows) {
    const dependent = row?.dependent ?? {};
    if (typeof dependent.text !== 'string' || dependent.text.trim() === '') {
      droppedEmptyText += 1; // exception-flow over-approximation (FINDINGS.md D4)
      continue;
    }
    const key = `${row?.controller?.line ?? '?'}->${dependent.line ?? '?'}:${row?.label ?? '?'}:${dependent.text}`;
    if (seen.has(key)) continue; // duplicate rows (FINDINGS.md D3)
    seen.add(key);
    kept.push({
      line: dependent.line,
      text: dependent.text,
      label: row?.label ?? null,
      controllerLine: row?.controller?.line ?? null,
      ...(row?.guard === true ? { guard: true } : {}),
    });
  }
  return { rows: kept, droppedEmptyText };
}

function cleanFlows(rows) {
  const seen = new Set();
  const kept = [];
  for (const row of rows) {
    const use = row?.use ?? {};
    if (typeof use.text !== 'string' || use.text.trim() === '') continue;
    const key = `${row?.variable ?? '?'}:${row?.def?.line ?? '?'}->${use.line ?? '?'}`;
    if (seen.has(key)) continue; // duplicate rows (FINDINGS.md D3)
    seen.add(key);
    kept.push({
      variable: row?.variable ?? null,
      defLine: row?.def?.line ?? null,
      useLine: use.line ?? null,
      useText: use.text,
    });
  }
  return { rows: kept, droppedEmptyText: 0 };
}

/**
 * Resolve the pdg_query anchor for one changed symbol.
 *
 * Step 1: query by NAME — when unique, the tool anchors on the symbol's own line
 * range (function-scoped results).
 * Step 2: ambiguous → pick the candidate whose filePath matches the symbol, take its
 * `line` (the index's start line — may be an annotation line, which is exactly what
 * `functionLine` is keyed on), then query by FILE PATH and filter by that functionLine.
 * Step 3: still nothing → UNKNOWN note (never "no dependence").
 */
export async function querySymbolPdg(client, symbol, { pdgQuery } = {}) {
  const call =
    pdgQuery ?? ((mode, target, limit, afterLine, targetUid) => client.pdgQuery({ mode, target, afterLine, targetUid, limit }));
  const filePath = symbol.filePath ?? '';
  const name = symbol.name ?? '';

  const unknown = (note) => ({
    pdgLayer: true,
    guards: [],
    flows: [],
    note,
  });

  // Keyset-paged file query: rows are ordered by source line, `after_line` is an
  // exclusive cursor. Walks pages until the function's rows are found or the set
  // is exhausted (safety cap), then filters by functionLine.
  const pagedFileQuery = async (mode, fnLine) => {
    let afterLine = 0;
    let pages = 0;
    const collected = [];
    while (pages < MAX_FILE_PAGES) {
      const page = await call(mode, filePath, PDG_ROW_CAP, afterLine).catch(() => null);
      if (!page || page.__error) return { rows: collected, note: page?.__error ?? 'file query failed' };
      collected.push(...(page.results ?? []));
      const lastLine = collected.length > 0 ? Math.max(...collected.map((r) => r?.controller?.line ?? 0)) : 0;
      if (!page.truncated) break;
      // Advance past the max source line seen so far (rows include dependents'
      // lines, which can exceed the source cursor).
      afterLine = Math.max(afterLine, lastLine);
      pages += 1;
    }
    const rows = collected.filter((row) => row?.functionLine === fnLine);
    if (rows.length === 0 && pages >= MAX_FILE_PAGES) {
      return { rows, note: `file paging capped at ${MAX_FILE_PAGES} pages without finding function ${fnLine}` };
    }
    return { rows, note: null };
  };

  // Resolution order: exact UID (zero-ambiguity, function-scoped) → unique name →
  // file + functionLine keyset paging. UIDs used to resolve to silent empty
  // results — fixed on the local GitNexus build via target_uid (precision G-findings).
  let resolution = null;
  let controls = null;
  let rows = [];
  let matchingLine = null;

  if (symbol.uid) {
    controls = await call('controls', null, PDG_ROW_CAP, undefined, symbol.uid).catch(() => null);
    const uidRows = controls?.results ?? [];
    if (!controls?.__error && !controls?.error && uidRows.length > 0) {
      resolution = 'uid';
      rows = uidRows;
    }
  }

  if (!resolution) {
    resolution = 'name';
    controls = await call('controls', name, PDG_ROW_CAP).catch(() => null);
    rows = controls?.results ?? [];
  }

  const matchingCandidate = (controls?.candidates ?? []).find((c) => c?.filePath === filePath);
  if (rows.length === 0 && (controls?.status === 'ambiguous' || !controls)) {
    if (matchingCandidate && typeof matchingCandidate.line === 'number') {
      matchingLine = matchingCandidate.line;
      const paged = await pagedFileQuery('controls', matchingLine);
      rows = paged.rows;
      resolution = 'file+functionLine';
      if (rows.length === 0 && paged.note) {
        return unknown(paged.note);
      }
    }
  }

  if (rows.length === 0) {
    return unknown(
      `no PDG rows for ${name} (empty results can mean an unresolvable target — treated as UNKNOWN)`,
    );
  }

  // Flows follow the same resolution path.
  let flowsRows = [];
  if (resolution === 'uid' && symbol.uid) {
    const flowsResult = await call('flows', null, PDG_ROW_CAP, undefined, symbol.uid).catch(() => null);
    flowsRows = flowsResult?.results ?? [];
  } else if (resolution === 'name') {
    const flowsResult = await call('flows', name, PDG_ROW_CAP).catch(() => null);
    flowsRows = flowsResult?.results ?? [];
  } else if (matchingLine !== null) {
    const paged = await pagedFileQuery('flows', matchingLine);
    flowsRows = paged.rows;
  }

  const cleanedControls = cleanControls(rows);
  const cleanedFlows = cleanFlows(flowsRows);

  // Symbol span for the source-code snippet (uid/name anchors carry the exact
  // window; the file+functionLine fallback gets a start-only approximation).
  const anchorSpan = controls?.anchor ?? null;
  const span =
    anchorSpan && typeof anchorSpan.startLine === 'number' && typeof anchorSpan.endLine === 'number'
      ? { startLine: anchorSpan.startLine, endLine: anchorSpan.endLine, approximate: false }
      : matchingLine !== null
        ? { startLine: matchingLine, endLine: matchingLine + 40, approximate: true }
        : null;

  return {
    pdgLayer: true,
    resolution,
    ...(span ? { span } : {}),
    guards: cleanedControls.rows.slice(0, PDG_ROW_CAP),
    flows: cleanedFlows.rows.slice(0, PDG_ROW_CAP),
    truncated: {
      ...(cleanedControls.rows.length > PDG_ROW_CAP ? { guards: true } : {}),
      ...(cleanedFlows.rows.length > PDG_ROW_CAP ? { flows: true } : {}),
      ...(controls?.truncated ? { guards: true } : {}),
    },
    ...(cleanedControls.droppedEmptyText > 0
      ? { note: `${cleanedControls.droppedEmptyText} exception-flow row(s) with empty text dropped` }
      : {}),
  };
}
