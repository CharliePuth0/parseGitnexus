#!/usr/bin/env node
/**
 * Cypher fallback probe — does the persisted CDG actually contain the labelNames
 * guard edges that `pdg_query` could not return?
 *
 * `pdg_query` has no line/symbol scope arg (schema confirmed by probe-targeting.mjs),
 * the file anchor pages `ORDER BY srcId ... LIMIT 200` where srcId is
 * `BasicBlock:<path>:<fnLine>:...` — a STRING sort, so fnLine 1003 sorts before 884.
 * This reconciles the answer by hitting the raw edges directly.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcpServer } from '../../src/mcp-http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = process.env.GITNEXUS_CLI ?? path.resolve(HERE, '..', '..', '..', 'gitnexus', 'dist', 'cli', 'index.js');
const REPO = '/Users/sugerdaddy/AI/shop/prometheus';

const FILE = 'web/api/v1/api.go';
const FN = 884;

const s = await startMcpServer({ cliPath: CLI_PATH, cwd: REPO, log: (m) => console.log('[mcp]', m) });
const cypher = async (statement) => {
  const r = await s.client.callTool('cypher', { statement, repo: REPO }, { timeoutMs: 300_000 });
  if (r?.error) return { __error: r.error };
  // `cypher` returns a MARKDOWN table (not a JSON array) — parse it.
  const lines = String(r?.markdown ?? '').split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 3) return { __rows: [] };
  const cols = lines[0].split('|').slice(1, -1).map((c) => c.trim());
  const out = lines.slice(2).map((line) => {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
  return { __rows: out };
};
const rows = (r) => (r?.__rows ?? []);

try {
  const prefix = `BasicBlock:${FILE}:${FN}:`;
  console.log(`=== raw CDG for ${prefix} (bypassing the pdg_query anchor) ===`);
  const r1 = await cypher(
    `MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)
     WHERE r.type = 'CDG' AND a.id STARTS WITH '${prefix}'
     RETURN a.startLine AS c, b.startLine AS d, r.reason AS label, b.text AS text
     ORDER BY c, d`,
  );
  const cdg = rows(r1);
  if (r1?.error) console.log('ERROR:', r1.error);
  console.log(`raw CDG rows at fnLine=${FN}: ${cdg.length}`);
  for (const row of cdg) {
    const text = String(row.text ?? row.b_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 52);
    console.log(`  ${row.c}->${row.d} [${row.label}] "${text}"`);
  }

  console.log('');
  console.log('=== guard-class rows only (dependent text starts return/throw/break/continue) ===');
  const guards = cdg.filter((x) => /^\s*(return|throw|continue|break)\b/.test(String(x.text ?? '')));
  console.log(`guard rows: ${guards.length} -> ${guards.map((x) => `${x.c}->${x.d}[${x.label}]`).join(', ')}`);

  console.log('');
  console.log('=== ordering hypothesis: lexicographic srcId == first page of the file anchor ===');
  const r2 = await cypher(
    `MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)
     WHERE r.type = 'CDG' AND (a.id STARTS WITH 'BasicBlock:${FILE}:' OR a.filePath = '${FILE}' OR a.filePath ENDS WITH '/${FILE}')
     RETURN a.id AS srcId, a.startLine AS c
     ORDER BY srcId, c
     LIMIT 200`,
  );
  const page = rows(r2);
  const fnLines = [...new Set(page.map((x) => x.c))];
  console.log(`page size ${page.length}; first srcId = ${page[0]?.srcId}`);
  console.log(`page-1 distinct startLines (${fnLines.length}): [${fnLines.join(',')}]`);
  console.log(`does page 1 contain fnLine ${FN}? ${fnLines.includes(FN) ? 'YES' : 'NO'}`);

  console.log('');
  console.log('=== repo-wide totals for the pdg_query anchor ===');
  const r3 = await cypher(
    `MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)
     WHERE r.type = 'CDG' AND (a.id STARTS WITH 'BasicBlock:${FILE}:' OR a.filePath = '${FILE}' OR a.filePath ENDS WITH '/${FILE}')
     RETURN COUNT(*) AS total`,
  );
  console.log('file-anchor CDG total:', JSON.stringify(rows(r3)));
  const r4 = await cypher(
    `MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)
     WHERE r.type = 'CDG' AND a.id STARTS WITH '${prefix}' RETURN COUNT(*) AS total`,
  );
  console.log('fnLine=884 CDG total:', JSON.stringify(rows(r4)));

  // REACHING_DEF for the same unit, for the flows half of the report.
  const r5 = await cypher(
    `MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)
     WHERE r.type = 'REACHING_DEF' AND a.id STARTS WITH '${prefix}'
     RETURN a.startLine AS def, b.startLine AS use, r.reason AS reason ORDER BY def, use`,
  );
  const flows = rows(r5);
  console.log('');
  console.log(`=== raw REACHING_DEF at fnLine=${FN}: ${flows.length} rows ===`);
  for (const row of flows) console.log(`  ${row.def}->${row.use} [${row.reason}]`);
} finally {
  await s.stop();
}
