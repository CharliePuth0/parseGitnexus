/**
 * Report assembly + schema validation — the pure core of the engine.
 *
 * Everything here takes already-fetched tool payloads and returns a plain object that
 * matches REPORT_SCHEMA.md v1. No I/O, so the whole builder is unit-testable.
 */
// Relative path, not the bare `gitnexus-shared` specifier: the engine ships no
// node_modules of its own, while the dependency-free compiled predicate is right next
// door. This keeps the test-file classification to a single source of truth.
import { isTestFilePath } from '../../gitnexus-shared/dist/index.js';
import { CHANGE_TYPES, resolveChangeType } from './git-status.mjs';

import {
  compareRiskDesc,
  dedupeStrings,
  kindFromUid,
  mergeEpistemic,
  normalizeConfidence,
  normalizeIndexStatus,
  normalizeRisk,
  toLowerRiskLevel,
  worstRisk,
} from './util.mjs';

/** Schema version emitted in `meta.version`. */
export const REPORT_VERSION = 1;

const RISK_LEVELS = ['critical', 'high', 'medium', 'low', 'unknown'];
const EPISTEMIC_LEVELS = ['exact', 'lower-bound', 'unknown'];

/**
 * Normalize one symbol as reported by `detect_changes`.
 *
 * Returns null for nodes we must drop:
 *   - entries with no `filePath` — aggregate/community nodes the frontend cannot render
 *     against a file;
 *   - anything without a uid.
 */
export function normalizeChangedSymbol(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const filePath = typeof raw.filePath === 'string' ? raw.filePath : '';
  if (filePath.length === 0) return null;
  const uid = raw.id ?? raw.uid;
  if (typeof uid !== 'string' || uid.length === 0) return null;
  return {
    uid,
    name: raw.name ?? uid,
    kind: raw.type ?? raw.kind ?? kindFromUid(uid) ?? 'Unknown',
    filePath,
    isTestFile: isTestFilePath(filePath),
    // Carried, not yet resolved: the git file status is applied in buildChangeEntry, which
    // is also where the tool's own (currently always `touched`) value is preferred.
    toolChangeType: raw.change_type ?? raw.changeType ?? null,
  };
}

/**
 * Rank/filter the changed-symbol set down to the symbols we spend `impact` calls on.
 *
 * Order is the tool's own (detect_changes emits changed symbols grouped by file, which
 * is the order a reviewer reads); we only drop and cap, never re-order here. The final
 * `changes` array IS re-sorted by risk, per the schema.
 */
export function selectAnalysisTargets(changedSymbols, limit) {
  const seen = new Set();
  const dropped = { noFilePath: 0, testFile: 0, duplicate: 0 };
  const candidates = [];

  for (const raw of changedSymbols ?? []) {
    const symbol = normalizeChangedSymbol(raw);
    if (!symbol) {
      dropped.noFilePath += 1;
      continue;
    }
    if (seen.has(symbol.uid)) {
      dropped.duplicate += 1;
      continue;
    }
    seen.add(symbol.uid);
    if (symbol.isTestFile) {
      dropped.testFile += 1;
      continue;
    }
    candidates.push(symbol);
  }

  const targets = candidates.slice(0, Math.max(0, limit));
  return {
    targets,
    dropped,
    eligible: candidates.length,
    overLimit: Math.max(0, candidates.length - targets.length),
  };
}

/** Index `detect_changes.affected_processes` by the symbol name each flow changed. */
export function buildProcessIndex(affectedProcesses) {
  const bySymbol = new Map();
  for (const process of affectedProcesses ?? []) {
    const id = process?.id;
    if (typeof id !== 'string') continue;
    for (const step of process.changed_steps ?? []) {
      const symbolName = step?.symbol;
      if (typeof symbolName !== 'string') continue;
      if (!bySymbol.has(symbolName)) bySymbol.set(symbolName, []);
      bySymbol.get(symbolName).push(id);
    }
  }
  return bySymbol;
}

/** Flatten `byDepth` (an object keyed by depth level, or an array) into ImpactNode[]. */
export function flattenByDepth(byDepth) {
  const nodes = [];
  if (byDepth && typeof byDepth === 'object' && !Array.isArray(byDepth)) {
    for (const [level, entries] of Object.entries(byDepth)) {
      for (const entry of entries ?? []) nodes.push({ entry, level });
    }
  } else if (Array.isArray(byDepth)) {
    for (const entry of byDepth) nodes.push({ entry, level: entry?.depth });
  }

  return nodes.map(({ entry, level }) => ({
    depth: typeof entry?.depth === 'number' ? entry.depth : Number(level) || 1,
    uid: entry?.id ?? entry?.uid ?? '',
    name: entry?.name ?? '?',
    kind: entry?.type ?? kindFromUid(entry?.id ?? entry?.uid) ?? 'Unknown',
    filePath: entry?.filePath ?? '',
    relationType: entry?.relationType ?? 'UNKNOWN',
    confidence: normalizeConfidence(entry?.confidence),
  }));
}

/**
 * Collect `{id, summary, stepFloor, minDepth}` for every flow referenced by an impact
 * result, keyed by process id.
 *
 * `minDepth` is the shallowest traversal depth at which the flow was seen, which is what
 * makes the per-change flow list orderable: a flow seen through a direct dependent is far
 * more likely to be genuinely affected than one seen through a d=3 transitive node.
 */
function processesFromImpact(result) {
  const found = new Map();
  const collect = (byDepth) => {
    const entries = Array.isArray(byDepth)
      ? byDepth
      : Object.entries(byDepth && typeof byDepth === 'object' ? byDepth : {});
    for (const [level, bucket] of entries) {
      for (const node of bucket ?? []) {
        const depth = typeof node?.depth === 'number' ? node.depth : Number(level) || 1;
        for (const process of node?.processes ?? []) {
          if (typeof process?.id !== 'string') continue;
          const previous = found.get(process.id);
          const step = typeof process.step === 'number' ? process.step : 0;
          found.set(process.id, {
            id: process.id,
            summary: process.label ?? previous?.summary ?? process.id,
            // `step` is this symbol's index INSIDE the flow, not the flow length. It is
            // the only number the impact surface offers, so it becomes a lower bound on
            // stepCount and is flagged in the README.
            stepFloor: Math.max(previous?.stepFloor ?? 0, step),
            minDepth: Math.min(previous?.minDepth ?? Number.POSITIVE_INFINITY, depth),
          });
        }
      }
    }
  };
  collect(result?.byDepth);
  collect(result?.interproceduralByDepth);
  return found;
}

/**
 * Flows listed on one ChangeEntry before the rest are folded into a boundary note.
 *
 * A hub symbol (a response wrapper like `R`, a shared `Query` helper) sits inside
 * hundreds of flows in a repo this size, and the transitive d=2/d=3 flows are the least
 * likely to be genuinely affected. The full deduplicated union is always available in the
 * report's top-level `processes` array, so nothing is lost.
 */
export const PER_CHANGE_PROCESS_CAP = 50;

/**
 * Normalize one direction's `impact` payload into a verdict the merge step can use.
 *
 * `hardFailure: true` means the walk did not complete (transport error, ambiguous target,
 * tool-level error) — as opposed to `risk: UNKNOWN` from a walk that DID run and declined
 * to rank (the tool's zero-caller rule). The distinction decides the symbol's merged risk:
 * an incomplete walk makes the whole symbol UNKNOWN, a withheld verdict does not.
 */
export function directionVerdict(result, direction = 'this') {
  if (!result) {
    return { risk: 'UNKNOWN', epistemic: 'unknown', boundaries: [`${direction} impact was not run`], nodes: [], processIds: [], processes: new Map(), modules: [], ok: false, hardFailure: true };
  }
  if (result.__error) {
    return {
      risk: 'UNKNOWN',
      epistemic: 'unknown',
      boundaries: [`${direction} impact call failed: ${result.__error}`],
      nodes: [],
      processIds: [],
      processes: new Map(),
      modules: [],
      ok: false,
      hardFailure: true,
    };
  }
  if (result.status === 'ambiguous' || result.status === 'error' || result.status === 'not_found') {
    const detail =
      result.status === 'ambiguous'
        ? `${direction} target is ambiguous (${result.totalCandidates ?? '?'} candidates); re-run with an explicit uid`
        : `${direction} impact reported status "${result.status}": ${String(result.message ?? '').slice(0, 200)}`;
    return {
      risk: 'UNKNOWN',
      epistemic: 'unknown',
      boundaries: [detail, ...(result.boundaries ?? [])],
      nodes: [],
      processIds: [],
      processes: new Map(),
      modules: [],
      ok: false,
      hardFailure: true,
    };
  }

  const nodes = flattenByDepth(result.byDepth);
  const processes = processesFromImpact(result);
  const boundaries = [...(result.boundaries ?? [])];

  // Honest truncation note: byDepthCounts counts every dependent the walk found, while
  // byDepth holds at most `limit` per level.
  const counts = result.byDepthCounts ?? {};
  const returned = Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  if (returned > nodes.length) {
    boundaries.push(
      `node list capped at ${nodes.length} of ${returned} dependent symbols (impact limit)`,
    );
  }
  if (result.truncated) boundaries.push(`${direction} impact reported truncated: true`);
  if (result.partial) boundaries.push(`${direction} impact reported partial: true — counts are a lower bound`);

  const risk = normalizeRisk(result.risk);
  if (risk === 'UNKNOWN') {
    // Never let a withheld verdict dissolve into the boundary list unread: the tool's own
    // rule is that a zero-caller upstream is unresolved, not safe.
    boundaries.push(
      `${direction} verdict is UNKNOWN — unresolved, not an all-clear${result.riskNote ? `: ${result.riskNote}` : ''}`,
    );
  }

  return {
    risk,
    epistemic: result.epistemic ?? (nodes.length === 0 ? 'unknown' : 'exact'),
    boundaries,
    nodes,
    // Nearest dependents first: the flows most likely to be genuinely affected lead.
    processIds: [...processes.values()]
      .sort((a, b) => a.minDepth - b.minDepth || a.id.localeCompare(b.id))
      .map((process) => process.id),
    processes,
    modules: dedupeStrings((result.affected_modules ?? []).map((module) => module?.name)),
    ok: true,
    hardFailure: false,
  };
}

/**
 * Merged risk for one changed symbol.
 *
 * The two directions are ranked by the schema's own severity order
 * (CRITICAL > HIGH > MEDIUM > LOW > UNKNOWN), so an UNKNOWN never outranks a concrete
 * verdict — a Spring controller nobody calls still reads LOW when its callees are LOW.
 * What UNKNOWN does do is leave a boundary note, so the unresolved walk is visible.
 *
 * A HARD failure in either direction is different in kind: the walk did not complete, so
 * no direction can be trusted and the symbol is reported UNKNOWN outright.
 */
export function mergedRisk(upstream, downstream) {
  const up = directionVerdict(upstream, 'upstream');
  const down = directionVerdict(downstream, 'downstream');
  if (up.hardFailure || down.hardFailure) return 'UNKNOWN';
  return worstRisk([up.risk, down.risk]);
}

/**
 * Merge the two direction verdicts for one symbol into a single ChangeEntry.
 *
 * `fileStatus` is the `Map<path, changeType>` from `readChangedFileStatus`; without it every
 * entry falls back to `modified`.
 */
export function buildChangeEntry({
  symbol,
  upstream,
  downstream,
  intraProcedural,
  source,
  processIndex = new Map(),
  fileStatus = new Map(),
}) {
  const up = directionVerdict(upstream, 'upstream');
  const down = directionVerdict(downstream, 'downstream');

  const boundaries = dedupeStrings([...up.boundaries, ...down.boundaries]);

  // detect_changes knows which flows a changed symbol participates in even when the
  // symbol has no resolvable callers, so its attribution leads, then the nearest
  // dependents' flows, then the transitive ones.
  const fromDetect = processIndex.get(symbol.name) ?? [];
  const merged = dedupeStrings([...fromDetect, ...up.processIds, ...down.processIds]);
  const affectedProcesses = merged.slice(0, PER_CHANGE_PROCESS_CAP);
  if (merged.length > affectedProcesses.length) {
    boundaries.push(
      `affectedProcesses capped at ${affectedProcesses.length} of ${merged.length} reachable flows (full union in report.processes)`,
    );
  }

  const changeType = resolveChangeType(symbol.filePath, symbol.toolChangeType, fileStatus);
  if (changeType === 'removed') {
    // A removal has no caller set left to break, so the walk can only describe the graph as
    // it was indexed. Say that instead of letting a LOW verdict read as "nothing to check".
    boundaries.push(
      'changeType is "removed": the file is gone from the working tree, so this impact walk describes the last indexed revision of the symbol',
    );
  }

  // Statement-level guards (guards-first per precision/FINDINGS.md): carried verbatim
  // from the pdg_query walk, or an honest absence when the index has no PDG layer.
  const ip = intraProcedural && typeof intraProcedural === 'object' ? intraProcedural : {};
  if (ip.note) boundaries.push(`statement-level: ${ip.note}`);

  return {
    uid: symbol.uid,
    name: symbol.name,
    kind: symbol.kind,
    filePath: symbol.filePath,
    isTestFile: symbol.isTestFile,
    changeType,
    ...(source && typeof source === 'object' && typeof source.content === 'string'
      ? {
          source: {
            startLine: source.startLine,
            endLine: source.endLine,
            content: source.content,
            symbolStartLine: source.symbolStartLine,
            symbolEndLine: source.symbolEndLine,
            approximate: source.approximate === true,
          },
        }
      : {}),
    impact: {
      risk: mergedRisk(upstream, downstream),
      epistemic: mergeEpistemic([up.ok ? up.epistemic : 'unknown', down.ok ? down.epistemic : 'unknown']),
      boundaries,
      upstream: up.nodes,
      downstream: down.nodes,
      affectedProcesses,
      affectedModules: dedupeStrings([...up.modules, ...down.modules]),
      ...(Object.keys(ip).length > 0
        ? {
            intraProcedural: {
              pdgLayer: ip.pdgLayer === true,
              guards: Array.isArray(ip.guards) ? ip.guards : [],
              flows: Array.isArray(ip.flows) ? ip.flows : [],
              ...(ip.truncated && Object.keys(ip.truncated).length > 0 ? { truncated: ip.truncated } : {}),
              ...(ip.resolution ? { resolution: ip.resolution } : {}),
            },
          }
        : {}),
    },
  };
}

/**
 * Assemble the full report.
 *
 * @param {object} input
 * @param {object} input.meta         meta block (already resolved paths/refs/timestamps)
 * @param {object} input.detect       `detect_changes` payload
 * @param {Array}  input.analyses     `[{symbol, upstream, downstream, intraProcedural?}]`
 * @param {Map}    [input.fileStatus] `Map<path, changeType>` for `ChangeEntry.changeType`
 * @param {object} [input.taint]      taint findings (changed files only)
 * @param {object} [input.options]    `{limit, depth, source, pdgLayer}`
 */
export function buildReport({ meta, detect, analyses, taint, options = {}, fileStatus = new Map() }) {
  const processIndex = buildProcessIndex(detect?.affected_processes);
  const entryByUid = new Map();

  for (const analysis of analyses ?? []) {
    const entry = buildChangeEntry({
      symbol: analysis.symbol,
      upstream: analysis.upstream,
      downstream: analysis.downstream,
      intraProcedural: analysis.intraProcedural,
      source: analysis.source,
      processIndex,
      fileStatus,
    });
    entryByUid.set(entry.uid, entry);
  }

  // Stable sort: equal-risk symbols keep the tool's incoming order.
  const changes = [...entryByUid.values()].sort((a, b) => compareRiskDesc(a.impact.risk, b.impact.risk));

  // Processes: detect_changes entries win (they carry the true step_count); any flow seen
  // only through impact is appended with its step floor.
  const processesById = new Map();
  for (const process of detect?.affected_processes ?? []) {
    if (typeof process?.id !== 'string') continue;
    processesById.set(process.id, {
      id: process.id,
      summary: process.name ?? process.id,
      stepCount: Number(process.step_count ?? 0) || 0,
    });
  }
  // Flows seen only through `impact` have no detect_changes entry, so their label and
  // step floor come from the byDepth process annotations instead.
  const impactProcessMeta = new Map();
  for (const analysis of analyses ?? []) {
    for (const result of [analysis.upstream, analysis.downstream]) {
      for (const [id, value] of processesFromImpact(result)) {
        const previous = impactProcessMeta.get(id);
        impactProcessMeta.set(id, {
          summary: value.summary,
          stepFloor: Math.max(previous?.stepFloor ?? 0, value.stepFloor),
        });
      }
    }
  }
  for (const [id, derived] of impactProcessMeta) {
    if (processesById.has(id)) continue;
    processesById.set(id, { id, summary: derived.summary, stepCount: derived.stepFloor });
  }

  const summary = {
    changedFiles: Number(detect?.summary?.changed_files ?? 0) || 0,
    changedSymbols: Number(detect?.summary?.changed_count ?? 0) || 0,
    analyzedSymbols: changes.length,
    affectedProcesses: processesById.size,
    riskLevel: resolveRiskLevel(detect, changes),
    truncated: Boolean(detect?.truncated),
  };

  return {
    meta: {
      version: REPORT_VERSION,
      repo: meta.repo,
      repoPath: meta.repoPath,
      baseRef: meta.baseRef,
      headRef: meta.headRef,
      generatedAt: meta.generatedAt,
      indexStatus: normalizeIndexStatus(meta.indexStatus),
      ...(meta.baseSha ? { baseSha: meta.baseSha } : {}),
      ...(meta.headSha ? { headSha: meta.headSha } : {}),
      ...(typeof meta.worktreeDirty === 'boolean'
        ? { worktreeDirty: meta.worktreeDirty, dirtyCount: Number(meta.dirtyCount ?? 0) }
        : {}),
      ...(typeof options.pdgLayer === 'boolean' ? { pdgLayer: options.pdgLayer } : {}),
    },
    summary,
    changes,
    processes: [...processesById.values()],
    taint: taint ?? { findings: [], note: null },
    llm: { prompt: '' },
    __engine: {
      source: options.source ?? 'mcp',
      depth: options.depth ?? 3,
      limit: options.limit ?? 30,
      partial: Boolean(detect?.partial),
      notes: options.notes ?? [],
    },
  };
}

/**
 * `summary.riskLevel` prefers `detect_changes`'s own verdict: it covers EVERY changed
 * symbol, not just the `--limit`-capped slice that got an impact walk. The per-symbol
 * worst risk is only used when the tool reported nothing usable, or when it disagrees
 * upward (a CRITICAL symbol the tool rated lower must not be averaged away).
 */
export function resolveRiskLevel(detect, changes) {
  const toolLevel = String(detect?.summary?.risk_level ?? '').trim().toLowerCase();
  const fromTool = RISK_LEVELS.includes(toolLevel) ? toolLevel : null;
  const fromChanges = changes.length > 0 ? toLowerRiskLevel(worstRisk(changes.map((c) => c.impact.risk))) : null;
  if (!fromTool) return fromChanges ?? 'unknown';
  if (!fromChanges) return fromTool;
  return compareRiskDesc(fromTool, fromChanges) <= 0 ? fromTool : fromChanges;
}

/** Strip engine-only fields before the report is written or validated. */
export function toPublicReport(report) {
  const { __engine, ...rest } = report;
  return rest;
}

// ─── Schema validation ────────────────────────────────────────────────────────
// A tiny declarative checker run BEFORE the report is written, so a shape regression
// fails loudly in the engine instead of silently in the frontend.

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkString(errors, path, value, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (!optional) errors.push(`${path}: expected string, got ${value === null ? 'null' : 'undefined'}`);
    return;
  }
  if (typeof value !== 'string') errors.push(`${path}: expected string, got ${typeof value}`);
}

function checkNumber(errors, path, value, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (!optional) errors.push(`${path}: expected number, got ${value === null ? 'null' : 'undefined'}`);
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path}: expected finite number, got ${typeof value}`);
}

function checkEnum(errors, path, value, allowed) {
  if (!allowed.includes(value)) errors.push(`${path}: expected one of ${allowed.join('|')}, got ${JSON.stringify(value)}`);
}

function checkStringArray(errors, path, value) {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected array, got ${typeof value}`);
    return;
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string') errors.push(`${path}[${index}]: expected string, got ${typeof item}`);
  });
}

function validateImpactNode(errors, path, node) {
  if (!isPlainObject(node)) {
    errors.push(`${path}: expected object`);
    return;
  }
  checkNumber(errors, `${path}.depth`, node.depth);
  checkString(errors, `${path}.uid`, node.uid);
  checkString(errors, `${path}.name`, node.name);
  checkString(errors, `${path}.kind`, node.kind);
  checkString(errors, `${path}.filePath`, node.filePath);
  checkString(errors, `${path}.relationType`, node.relationType);
  if (node.confidence !== null && (typeof node.confidence !== 'number' || !Number.isFinite(node.confidence))) {
    errors.push(`${path}.confidence: expected number|null, got ${typeof node.confidence}`);
  }
}

function validateChangeEntry(errors, path, entry) {
  if (!isPlainObject(entry)) {
    errors.push(`${path}: expected object`);
    return;
  }
  checkString(errors, `${path}.uid`, entry.uid);
  checkString(errors, `${path}.name`, entry.name);
  checkString(errors, `${path}.kind`, entry.kind);
  checkString(errors, `${path}.filePath`, entry.filePath);
  if (typeof entry.isTestFile !== 'boolean') errors.push(`${path}.isTestFile: expected boolean, got ${typeof entry.isTestFile}`);
  // Optional in v1.1, but when present it must be one of the three literals.
  if (entry.changeType !== undefined) checkEnum(errors, `${path}.changeType`, entry.changeType, CHANGE_TYPES);

  // v1.4 optional source snippet.
  if (entry.source !== undefined) {
    const src = entry.source;
    if (!isPlainObject(src)) {
      errors.push(`${path}.source: expected object`);
    } else {
      checkNumber(errors, `${path}.source.startLine`, src.startLine);
      checkNumber(errors, `${path}.source.endLine`, src.endLine);
      checkString(errors, `${path}.source.content`, src.content);
    }
  }

  const impact = entry.impact;
  if (!isPlainObject(impact)) {
    errors.push(`${path}.impact: expected object`);
    return;
  }
  checkEnum(errors, `${path}.impact.risk`, impact.risk, ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);
  checkEnum(errors, `${path}.impact.epistemic`, impact.epistemic, EPISTEMIC_LEVELS);
  checkStringArray(errors, `${path}.impact.boundaries`, impact.boundaries);
  checkStringArray(errors, `${path}.impact.affectedProcesses`, impact.affectedProcesses);
  checkStringArray(errors, `${path}.impact.affectedModules`, impact.affectedModules);
  for (const direction of ['upstream', 'downstream']) {
    if (!Array.isArray(impact[direction])) {
      errors.push(`${path}.impact.${direction}: expected array, got ${typeof impact[direction]}`);
      continue;
    }
    impact[direction].forEach((node, index) => validateImpactNode(errors, `${path}.impact.${direction}[${index}]`, node));
  }

  // v1.3 statement-level block (optional).
  if (impact.intraProcedural !== undefined) {
    const ip = impact.intraProcedural;
    if (!isPlainObject(ip)) {
      errors.push(`${path}.impact.intraProcedural: expected object`);
    } else {
      if (typeof ip.pdgLayer !== 'boolean')
        errors.push(`${path}.impact.intraProcedural.pdgLayer: expected boolean`);
      if (!Array.isArray(ip.guards)) errors.push(`${path}.impact.intraProcedural.guards: expected array`);
      if (!Array.isArray(ip.flows)) errors.push(`${path}.impact.intraProcedural.flows: expected array`);
    }
  }
}

/**
 * Validate a report against the REPORT_SCHEMA.md v1 shape.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateReport(report) {
  const errors = [];
  if (!isPlainObject(report)) return { ok: false, errors: ['report: expected object'] };

  const { meta, summary, changes, processes, llm } = report;

  if (!isPlainObject(meta)) errors.push('meta: expected object');
  else {
    if (meta.version !== REPORT_VERSION) errors.push(`meta.version: expected ${REPORT_VERSION}, got ${JSON.stringify(meta.version)}`);
    checkString(errors, 'meta.repo', meta.repo);
    checkString(errors, 'meta.repoPath', meta.repoPath);
    checkString(errors, 'meta.baseRef', meta.baseRef);
    checkString(errors, 'meta.headRef', meta.headRef);
    checkString(errors, 'meta.generatedAt', meta.generatedAt);
    checkEnum(errors, 'meta.indexStatus', meta.indexStatus, ['current', 'behind', 'diverged', 'unknown']);
    if (typeof meta.generatedAt === 'string' && Number.isNaN(Date.parse(meta.generatedAt))) {
      errors.push(`meta.generatedAt: not a parseable ISO timestamp (${meta.generatedAt})`);
    }
    if (meta.pdgLayer !== undefined && typeof meta.pdgLayer !== 'boolean') {
      errors.push(`meta.pdgLayer: expected boolean, got ${typeof meta.pdgLayer}`);
    }
  }

  if (!isPlainObject(summary)) errors.push('summary: expected object');
  else {
    checkNumber(errors, 'summary.changedFiles', summary.changedFiles);
    checkNumber(errors, 'summary.changedSymbols', summary.changedSymbols);
    checkNumber(errors, 'summary.analyzedSymbols', summary.analyzedSymbols);
    checkNumber(errors, 'summary.affectedProcesses', summary.affectedProcesses);
    checkEnum(errors, 'summary.riskLevel', summary.riskLevel, RISK_LEVELS);
    if (typeof summary.truncated !== 'boolean') errors.push(`summary.truncated: expected boolean, got ${typeof summary.truncated}`);
  }

  if (!Array.isArray(changes)) errors.push('changes: expected array');
  else {
    changes.forEach((entry, index) => validateChangeEntry(errors, `changes[${index}]`, entry));
    for (let i = 1; i < changes.length; i += 1) {
      if (compareRiskDesc(changes[i - 1]?.impact?.risk, changes[i]?.impact?.risk) > 0) {
        errors.push(`changes: not sorted by risk desc at index ${i} (${changes[i - 1]?.impact?.risk} before ${changes[i]?.impact?.risk})`);
        break;
      }
    }
  }

  if (!Array.isArray(processes)) errors.push('processes: expected array');
  else {
    processes.forEach((process, index) => {
      if (!isPlainObject(process)) {
        errors.push(`processes[${index}]: expected object`);
        return;
      }
      checkString(errors, `processes[${index}].id`, process.id);
      checkString(errors, `processes[${index}].summary`, process.summary);
      checkNumber(errors, `processes[${index}].stepCount`, process.stepCount);
    });
  }

  if (!isPlainObject(llm)) errors.push('llm: expected object');
  else {
    checkString(errors, 'llm.prompt', llm.prompt);
    checkString(errors, 'llm.narrative', llm.narrative, { optional: true });
  }

  return { ok: errors.length === 0, errors };
}
