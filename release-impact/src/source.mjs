/**
 * Source-code snippets embedded in the report.
 *
 * The report is consumed by a frontend that cannot reach the analyzed repo, so the
 * engine reads the file locally (the repo lives next to the engine) and embeds a
 * bounded window around each changed symbol. Lines are 1-based; the span comes
 * from the pdg anchor (exact) or the functionLine fallback (approximate).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Context lines above/below the symbol span. */
export const SOURCE_CONTEXT_LINES = 6;

/**
 * Read a bounded source window. Never throws: a missing/unreadable file (deleted
 * symbol, permission) returns `{ error }` and the report just omits the snippet.
 */
export function readSourceSnippet(repoPath, filePath, span, contextLines = SOURCE_CONTEXT_LINES) {
  if (!span || typeof span.startLine !== 'number') return { error: 'no span for source snippet' };
  try {
    const absolute = path.resolve(repoPath, filePath);
    if (!absolute.startsWith(path.resolve(repoPath) + path.sep) && absolute !== path.resolve(repoPath)) {
      return { error: 'file path escapes the repo root' };
    }
    const lines = readFileSync(absolute, 'utf8').split('\n');
    const startLine = Math.max(1, span.startLine - contextLines);
    const endLine = Math.min(lines.length, span.endLine + contextLines);
    const content = lines.slice(startLine - 1, endLine).join('\n');
    return {
      startLine,
      endLine,
      content,
      symbolStartLine: span.startLine,
      symbolEndLine: span.endLine,
      approximate: span.approximate === true,
    };
  } catch (error) {
    return { error: error.message };
  }
}
