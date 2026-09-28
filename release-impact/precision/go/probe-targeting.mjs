#!/usr/bin/env node
/**
 * Target-form probe for `pdg_query` on Go (the Java Phase A D6/D7 questions).
 *
 * Prints the pdg_query input schema, then probes, for one Prometheus symbol:
 *   - target = bare name (ambiguous?)
 *   - target = full UID from the ambiguity candidates / cypher (D7 silent-empty check)
 *   - target = kind-stripped id
 *   - target = repo-relative file path (row count, functionLine spread, truncation)
 *   - every extra argument the schema accepts, to see whether any of them scopes a large file
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRpcBody, startMcpServer } from '../../src/mcp-http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = process.env.GITNEXUS_CLI ?? path.resolve(HERE, '..', '..', '..', 'gitnexus', 'dist', 'cli', 'index.js');
const REPO = '/Users/sugerdaddy/AI/shop/prometheus';

const s = await startMcpServer({ cliPath: CLI_PATH, cwd: REPO, log: (m) => console.log('[mcp]', m) });
const call = async (name, args) => {
  try {
    return await s.client.callTool(name, args, { timeoutMs: 180_000 });
  } catch (e) {
    return { __error: String(e?.message ?? e) };
  }
};
try {
  const r = await fetch(s.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': s.client.sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
  });
  const tools = parseRpcBody(await r.text()).find((m) => m.id === 99)?.result?.tools ?? [];
  const t = tools.find((x) => x.name === 'pdg_query');
  console.log('=== pdg_query description ===');
  console.log(t?.description);
  console.log('=== pdg_query inputSchema ===');
  console.log(JSON.stringify(t?.inputSchema, null, 1));

  const summarize = (label, payload) => {
    if (payload?.__error) return console.log(`${label} -> ERROR ${payload.__error.slice(0, 120)}`);
    const rows = Array.isArray(payload?.results) ? payload.results : null;
    const fnLines = rows ? [...new Set(rows.map((x) => x.functionLine))] : [];
    console.log(`${label} -> status=${payload?.status ?? '-'} rows=${rows ? rows.length : 'none'} `
      + `total=${payload?.total ?? '-'} truncated=${payload?.truncated ?? '-'} `
      + `distinctFunctionLines=${fnLines.length}${rows ? ` [${fnLines.slice(0, 12).join(',')}${fnLines.length > 12 ? '…' : ''}]` : ''}`
      + `${payload?.message ? ` msg="${String(payload.message).slice(0, 120)}"` : ''}`);
    return payload;
  };

  console.log('');
  console.log('=== target-form probes (symbol: labelNames in web/api/v1/api.go) ===');
  const name = await call('pdg_query', { mode: 'controls', target: 'labelNames', limit: 200 });
  summarize('t1 name', name);
  const uid = name?.candidates?.find((c) => c.filePath === 'web/api/v1/api.go')?.uid;
  console.log(`   uid for the Go method: ${uid}`);
  if (uid) summarize('t2 full UID', await call('pdg_query', { mode: 'controls', target: uid, limit: 200 }));
  const stripped = uid?.replace(/^[A-Za-z]+:/, '');
  if (stripped) summarize('t3 kind-stripped id', await call('pdg_query', { mode: 'controls', target: stripped, limit: 200 }));
  summarize('t4 relpath', await call('pdg_query', { mode: 'controls', target: 'web/api/v1/api.go', limit: 200 }));
  summarize('t5 relpath+mode=flows', await call('pdg_query', { mode: 'flows', target: 'web/api/v1/api.go', limit: 200 }));

  console.log('');
  console.log('=== schema-arg probes on the relpath anchor ===');
  for (const extra of [
    { line: 884 }, { functionLine: 884 }, { symbol: 'labelNames' },
    { target: 'web/api/v1/api.go', line: 884 },
  ]) {
    summarize(`args=${JSON.stringify(extra)}`, await call('pdg_query', { mode: 'controls', target: 'web/api/v1/api.go', limit: 200, ...extra }));
  }

  console.log('');
  console.log('=== unified impact line-mode probe (does it carry PDG rows for a Go line?) ===');
  summarize('impact pdg line 886', await call('impact', { target: 'labelNames', direction: 'upstream', mode: 'pdg', line: 886 }));
} finally {
  await s.stop();
}
