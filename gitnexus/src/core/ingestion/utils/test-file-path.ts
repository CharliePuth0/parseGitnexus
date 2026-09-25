/**
 * Test-file path classification — re-export.
 *
 * WHY THIS MODULE IS A RE-EXPORT
 *
 * Two independent copies of this predicate once existed (entry-point scoring
 * and MCP `includeTests`) and drifted apart. They were unified here as a
 * dependency-free module, then the web UI's "hide unit test files" graph
 * filter and the web LLM impact tool needed the same classification — so the
 * single source of truth moved to `gitnexus-shared/src/test-file-path.ts`.
 * This module re-exports it so the existing importers (entry-point scoring,
 * MCP local-backend) and the unit test `test/unit/test-file-path.test.ts`
 * keep working unchanged.
 *
 * Import through the package ROOT specifier (`gitnexus-shared`) — the build
 * step's specifier rewrite only handles the bare root, not subpath imports.
 * `gitnexus-shared` is a leaf package with zero runtime dependencies, so the
 * #2802 MCP-startup constraint (nothing heavy lands in startup) is preserved.
 */
export { isTestFilePath } from 'gitnexus-shared';
