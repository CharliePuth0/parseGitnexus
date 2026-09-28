#!/usr/bin/env node
/**
 * KILLSHOP-SPOTCHECK driver — real-code `pdg_query` probes for Phase A.
 *
 * Runs against the already-reindexed /Users/sugerdaddy/AI/shop/killshop (read-only:
 * it only starts an MCP server rooted there and issues tool calls).
 *
 * For every probe it exercises the three target forms Phase B has to choose between:
 *   1. target = symbol name   (documented: resolved like context(), line-range granular)
 *   2. target = full UID      (undocumented; Phase B dependency)
 *   3. target = file path     (documented suffix match)
 * and dumps the raw rows to results/killshop-spotcheck.json for hand scoring.
 *
 * Expectations for these probes were hand-derived from the source BEFORE this script ran
 * (see KILLSHOP-SPOTCHECK.md).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcpServer } from '../src/mcp-http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = process.env.GITNEXUS_CLI ?? path.resolve(HERE, '..', '..', 'gitnexus', 'dist', 'cli', 'index.js');
const REPO = '/Users/sugerdaddy/AI/shop/killshop';

const PROBES = [
  {
    label: 'loginController.sendCode',
    symbol: 'sendCode',
    file: 'killshop-auth-server/src/main/java/com/wang/killshop/authserver/controller/loginController.java',
    classHint: 'loginController',
  },
  {
    label: 'loginController.register',
    symbol: 'register',
    file: 'killshop-auth-server/src/main/java/com/wang/killshop/authserver/controller/loginController.java',
    classHint: 'loginController',
  },
  {
    label: 'SeckillServiceImpl.kill',
    symbol: 'kill',
    file: 'killshop-seckill/src/main/java/com/wang/killshop/seckill/service/impl/SeckillServiceImpl.java',
    classHint: 'SeckillServiceImpl',
  },
  {
    label: 'OrderServiceImpl.closeOrder',
    symbol: 'closeOrder',
    file: 'killshop-order/src/main/java/com/wang/killshop/order/service/impl/OrderServiceImpl.java',
    classHint: 'OrderServiceImpl',
  },
  {
    label: 'OrderServiceImpl.builderOrderItems (bonus: lambda + compound guard)',
    symbol: 'builderOrderItems',
    file: 'killshop-order/src/main/java/com/wang/killshop/order/service/impl/OrderServiceImpl.java',
    classHint: 'OrderServiceImpl',
  },
];

const log = (message) => process.stdout.write(`${message}\n`);

async function main() {
  const session = await startMcpServer({ cliPath: CLI_PATH, cwd: REPO, log });
  const call = async (name, args) => {
    try {
      return { ok: true, payload: await session.client.callTool(name, args, { timeoutMs: 120_000 }) };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  };

  const out = { repo: REPO, generatedAt: new Date().toISOString(), probes: [] };
  try {
    for (const probe of PROBES) {
      const byName = await call('pdg_query', { mode: 'controls', target: probe.symbol, limit: 200 });
      const flows = await call('pdg_query', { mode: 'flows', target: probe.symbol, limit: 200 });
      const byFile = await call('pdg_query', { mode: 'controls', target: probe.file, limit: 200 });
      // Flows are only reachable for these methods through the FILE anchor (the bare name is
      // ambiguous), so the file-scoped flow rows are the ones a Phase B consumer would use.
      const flowsByFile = await call('pdg_query', { mode: 'flows', target: probe.file, limit: 200 });

      // UID: prefer the candidate surfaced by an ambiguous answer, else look it up.
      let uid = byName.payload?.candidates?.[0]?.uid ?? null;
      let uidSource = uid ? 'pdg_query candidates[0]' : null;
      if (!uid) {
        const cypher = await call('cypher', {
          statement: `MATCH (n) WHERE n.name = '${probe.symbol}' RETURN n.id AS id, n.filePath AS f LIMIT 20`,
        });
        const lines = String(cypher.payload?.markdown ?? '').split('\n');
        const row = lines.find((line) => line.includes(probe.classHint) && line.includes(`.${probe.symbol}#`));
        const match = /(Method|Function|Constructor):[^|\s]+/.exec(row ?? '');
        uid = match?.[0] ?? null;
        uidSource = uid ? 'cypher id lookup (class-scoped row)' : null;
      }
      const byUid = uid ? await call('pdg_query', { mode: 'controls', target: uid, limit: 200 }) : { ok: false, error: 'no uid resolved' };
      // Same UID, but with the leading kind stripped — a last-ditch "maybe it wants the bare id" probe.
      const bareId = uid ? uid.slice(uid.indexOf(':') + 1).replace('#', '#') : null;
      const byBareId = bareId && bareId !== uid
        ? await call('pdg_query', { mode: 'controls', target: bareId, limit: 200 })
        : { ok: false, error: 'n/a' };

      out.probes.push({ ...probe, uid, uidSource, byName, flows, byUid, byBareId, byFile, flowsByFile });
      const rows = (r) => (r?.payload?.results ? r.payload.results.length : `ERR(${r?.payload?.status ?? r?.error ?? '?'})`);
      log(`--- ${probe.label}`);
      log(`    target=name     rows=${rows(byName)}${byName.payload?.status ? ` status=${byName.payload.status}` : ''}${byName.payload?.error ? ` error=${byName.payload.error}` : ''}`);
      log(`    target=uid      rows=${rows(byUid)}  (${uid ?? 'no uid'})`);
      log(`    target=bareId   rows=${rows(byBareId)}`);
      log(`    target=filePath rows=${rows(byFile)}`);
      log(`    flows rows=${rows(flows)}  | flows via file anchor rows=${rows(flowsByFile)}`);
    }
  } finally {
    await session.stop();
  }

  mkdirSync(path.join(HERE, 'results'), { recursive: true });
  const outPath = path.join(HERE, 'results', 'killshop-spotcheck.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  log(`raw spot-check results: ${outPath}`);
}

main().catch((error) => {
  process.stderr.write(`spot-check failed: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
});
