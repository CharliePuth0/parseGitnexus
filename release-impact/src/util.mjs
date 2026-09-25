/**
 * Pure, dependency-free helpers shared by the report builder, the prompt builder
 * and the unit tests. Nothing in this file touches the filesystem, the network or
 * a clock, so every function here is deterministic and directly testable.
 */

/**
 * Risk levels ordered worst -> best.
 *
 * UNKNOWN sorts LAST even though it is not a "good" verdict: the report's job is
 * to surface what will break, and an unresolved walk is not evidence of safety
 * (see the GitNexus impact contract). It is emitted in `changes` so the caller can
 * see it, but it never outranks a concrete HIGH/CRITICAL.
 */
export const RISK_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

/** Coerce anything the tools hand back into a member of RISK_ORDER. */
export function normalizeRisk(risk) {
  const value = String(risk ?? '').trim().toUpperCase();
  return RISK_ORDER.includes(value) ? value : 'UNKNOWN';
}

/** Index in RISK_ORDER; lower rank == worse. Unknown values collapse to UNKNOWN. */
export function riskRank(risk) {
  return RISK_ORDER.indexOf(normalizeRisk(risk));
}

/** Worst-first comparator for Array#sort. Equal ranks keep their incoming order (stable). */
export function compareRiskDesc(a, b) {
  return riskRank(a) - riskRank(b);
}

/** Worst risk of a list; UNKNOWN when the list is empty (nothing was proven). */
export function worstRisk(risks) {
  if (!risks || risks.length === 0) return 'UNKNOWN';
  return risks.map(normalizeRisk).sort(compareRiskDesc)[0];
}

/** `summary.riskLevel` in REPORT_SCHEMA.md is lowercase; ChangeEntry.impact.risk is uppercase. */
export function toLowerRiskLevel(risk) {
  return normalizeRisk(risk).toLowerCase();
}

/**
 * Extract the first balanced JSON object from a string that may carry human
 * banners before or after it.
 *
 * Both GitNexus surfaces litter their answers: the MCP tool `text` content is
 * `<json>\n\n---\n**Next:** ...` and the CLI prints a `  GitNexus Impact (1.6.12)`
 * banner line before its JSON. Scanning for the first `{` and balancing braces
 * (string- and escape-aware) recovers the payload from either.
 *
 * Returns null when no balanced object is found.
 */
export function extractFirstJsonObject(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Node uids are `<Kind>:<path>:<name>` (e.g. `Method:src/A.java:A.foo#1`).
 * `impact`'s byDepth entries carry no `kind` field, so it is recovered from the
 * uid prefix — the one place the kind is always present.
 */
export function kindFromUid(uid) {
  if (typeof uid !== 'string') return null;
  const separator = uid.indexOf(':');
  if (separator <= 0) return null;
  const kind = uid.slice(0, separator).trim();
  return kind.length > 0 ? kind : null;
}

/** Edge confidence is a 0..1 number, or null when the tool did not report one. */
export function normalizeConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

/** Order-preserving de-duplication for string arrays. */
export function dedupeStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values ?? []) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Merge per-direction `epistemic` verdicts and per-direction failures into one.
 *
 * Rules, in priority order:
 *   - a failed leg reports at least one `unknown` -> 'unknown'
 *   - otherwise the weaker of the two verdicts wins ('lower-bound' beats 'exact')
 * The result is exactly one of the three literals REPORT_SCHEMA.md allows.
 */
export function mergeEpistemic(levels) {
  const known = (levels ?? []).filter((level) => level !== undefined && level !== null);
  if (known.length === 0) return 'unknown';
  if (known.includes('unknown')) return 'unknown';
  if (known.includes('lower-bound')) return 'lower-bound';
  return 'exact';
}

/** `staleness.status` as reported by GitNexus; anything unexpected reads as unknown. */
export function normalizeIndexStatus(status) {
  const value = String(status ?? '').trim().toLowerCase();
  return ['current', 'behind', 'diverged'].includes(value) ? value : 'unknown';
}

/** Shorten a symbol list for the prompt while telling the reader it was cut. */
export function truncateList(items, max) {
  const list = items ?? [];
  if (list.length <= max) return { items: list, omitted: 0 };
  return { items: list.slice(0, max), omitted: list.length - max };
}
