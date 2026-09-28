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
  const call = pdgQuery ?? ((mode, target, limit) => client.pdgQuery({ mode, target, limit }));
  const filePath = symbol.filePath ?? '';
  const name = symbol.name ?? '';

  const unknown = (note) => ({
    pdgLayer: true,
    guards: [],
    flows: [],
    note,
  });

  let controls;
  try {
    controls = await call('controls', name, PDG_ROW_CAP);
  } catch {
    return unknown(`pdg_query(controls) failed for ${name}`);
  }

  const matchingCandidate = (controls?.candidates ?? []).find((c) => c?.filePath === filePath);
  let rows = controls?.results ?? [];
  let resolution = 'name';

  if (controls?.status === 'ambiguous' || rows.length === 0) {
    if (matchingCandidate && typeof matchingCandidate.line === 'number') {
      // File anchor is not function-scoped (FINDINGS.md D6): filter by functionLine.
      const fileResult = await call('controls', filePath, PDG_ROW_CAP).catch(() => null);
      rows = (fileResult?.results ?? []).filter(
        (row) => row?.functionLine === matchingCandidate.line,
      );
      resolution = 'file+functionLine';
    } else {
      return unknown(
        `could not resolve ${name} to a function anchor (ambiguous: ${controls?.totalCandidates ?? '?'} candidates, none matching ${filePath}) — treated as UNKNOWN, never as "no dependence"`,
      );
    }
  }

  if (rows.length === 0) {
    return unknown(
      `no PDG rows for ${name} (empty results can mean an unresolvable target — treated as UNKNOWN)`,
    );
  }

  // Flows go through the same two-step when the name was ambiguous.
  const flowsResult =
    resolution === 'name'
      ? await call('flows', name, PDG_ROW_CAP).catch(() => null)
      : await call('flows', filePath, PDG_ROW_CAP).catch(() => null);
  const flowsRows =
    resolution === 'name'
      ? (flowsResult?.results ?? [])
      : (flowsResult?.results ?? []).filter((row) => row?.functionLine === matchingCandidate.line);

  const cleanedControls = cleanControls(rows);
  const cleanedFlows = cleanFlows(flowsRows);

  return {
    pdgLayer: true,
    resolution,
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
