# KILLSHOP-SPOTCHECK — real-code guard-edge validation

Repo: `/Users/sugerdaddy/AI/shop/killshop` (branch `master`, HEAD `db16845dd918361e2fef9a687ff893c61b4df166`)
Layer: `node gitnexus/dist/cli/index.js analyze --pdg --index-only` (run from the repo root)
Log: `logs/killshop-analyze.log`
Probe script: `spotcheck-killshop.mjs` → raw rows in `results/killshop-spotcheck.json`

## Index run

| fact | value |
| --- | --- |
| pdg flip | `pdg mode changed (index built without --pdg, this run is with --pdg); forcing a full rebuild` |
| duration | 20.1 s |
| graph | 16,338 nodes / 26,114 edges / 168 clusters / 483 flows |
| `[cfg]` per-function edge-cap warnings | **0** |
| `[cdg]` skip / cap / ceiling warnings | **0** |
| `[reaching-defs]` skip / cap warnings | **0** |

The skip counters are trustworthy negatives: every cap/skip path in `gitnexus/src/core/ingestion/cfg/emit.ts`
routes through `onWarn?.(...)`, and the pipeline wires that to `logger.warn` with the explicit comments
"unconditional — R7, both layers" and "unconditional — R6, no silent truncation"
(`src/core/ingestion/scope-resolution/pipeline/run.ts:1592,1606`). Warn-level lines do appear in this log
(128 `callable-value-flow: candidate set exceeded the cap` warnings), so **no CDG or REACHING_DEF emit
skips occurred anywhere in killshop** — the documented "deep nesting skipped" gap did not fire here.

Unrelated but Phase-B-relevant (non-PDG) truncation in the same log: `[processes] 483 flows reported, but
whole flows are MISSING: 402 of 602 candidate entry point(s) never ranked in … 123 callee(s) skipped at
maxBranching`.

## Expectations were hand-derived from source BEFORE any query

For each method: read the file, apply classical control dependence (Y is control dependent on X iff Y
post-dominates some successor of X but does not post-dominate X — the Ferrante/post-dominance-frontier
definition), and list the edges. Only then run `pdg_query`.

## Target-form resolution (the Phase B question)

Every one of the four required methods is **ambiguous by bare name** in this monorepo:

| method | `target=<name>` | `target=<UID>` | `target=<bare id>` | `target=<file path>` |
| --- | --- | --- | --- | --- |
| `loginController.sendCode` | `status: ambiguous` | **0 rows** | **0 rows** | 27 rows (4 functions) |
| `loginController.register` | `status: ambiguous` | **0 rows** | **0 rows** | 27 rows (4 functions) |
| `SeckillServiceImpl.kill` | `status: ambiguous` | **0 rows** | **0 rows** | 48 rows (6 functions) |
| `OrderServiceImpl.closeOrder` | `status: ambiguous` | **0 rows** | **0 rows** | 20 rows (5 functions) |
| `OrderServiceImpl.builderOrderItems` | 1 row | **0 rows** | **0 rows** | 20 rows (5 functions) |

* **UID targeting does not work.** `pdg_query` classifies any target containing `/` as a file path
  (`looksLikeFilePath`, `src/mcp/local/local-backend.ts:282`) and the UID form
  (`Method:<relpath>:<Class>.<member>#<n>`) contains slashes, so it takes the file branch with
  `anchor.file = "<the uid>"` and matches nothing. Confirmed 7/7 times (5 killshop methods + 2 fixtures),
  for both the full UID and the kind-stripped id. It fails **silently with an empty result**, not an error.
* **File-path targeting works but is NOT function-scoped.** The file branch of `resolveBlockAnchor` applies
  no line window (`a.id STARTS WITH …/a.filePath = …/a.filePath ENDS WITH …`), so it returns the blocks of
  every function in the file — 27 rows for a file whose target method owns 7.
* **Scoping workaround (Phase B):** filter the file-anchor rows by `functionLine`, which is the start line of
  the declaration *unit*: the first annotation line when annotated (`@Override` at 260 for the method at
  261; `@ResponseBody` at 52 for the method at 54), otherwise the declaration line. Lambda bodies are
  emitted as their own units keyed to the lambda header line (`functionLine: 119` for the
  `session.getRelationSkus().stream().forEach(…` lambda inside `saveSessionSkuInfo`).

## Per-method results

`guard` = the tool's `guard: true` flag. "hand" = hand-derived before the run.

### 1. `loginController.sendCode` — `.../authserver/controller/loginController.java:54-79`

Hand-derived: `58->60:T`, `58->61:T`, `58->68:F`, **`61->63:T` (guard: `return R.error(…)`)**, `61->68:F`.

| hand | tool | verdict |
| --- | --- | --- |
| 58->60:T | 58->60:T `long currentTime = Long.parseLong(…)` | match |
| 58->61:T | 58->61:T `System.currentTimeMillis() - currentTime < 60000` | match (branch-to-branch) |
| 58->68:F | 58->68:F `int code = (int) ((Math.random() * 9 + 1) * 100000);…` | match |
| **61->63:T guard** | **61->63:T GUARD** `return R.error(BizCodeEnume.SMS_CODE_EXCEPTION…)` | **match — the rate-limit guard** |
| 61->68:F | 61->68:F `int code = …` | match |
| — | 58->78:F GUARD `return R.ok();`, 61->78:F GUARD `return R.ok();` | extra, but classical (line 78 post-dominates the fall-through block and does not post-dominate 58/61 because the opposite arm returns) |

**Verdict: PASS — 5/5 hand-derived edges, guard edge present with the correct `T` sense, no misses.**
Both "extra" rows are the long-range escape edges to the method's final return, i.e. exactly the
"what must be true for the happy path" information release-impact wants; they are correct, not noise.

### 2. `loginController.register` — `loginController.java:84-137`

Hand-derived guard returns: `88->95:T`, `111->113:T`, `111->119:F`, `106->128:F`, `104->135:F`
(plus non-guard `88->89:T`, `88->100:F`, `88->104:F`, `104->106:T`, `106->108:T`, `106->111:T`, `111->116:F`).

Tool returned 14 rows; **all five guard returns are present with `guard: true` and the correct `T`/`F` sense**:
`88->95:T GUARD`, `111->113:T GUARD`, `111->119:F GUARD`, `106->128:F GUARD`, `104->135:F GUARD`;
all seven non-guard edges also present. Three extras (`88->89:T`, `104->132:F`, `106->125:F`) are the
else-branch bodies — valid classical edges I simply had not listed.

**Verdict: PASS — 12/12 hand-derived edges, 5/5 guard returns, zero misses.**

### 3. `SeckillServiceImpl.kill` — `killshop-seckill/.../service/impl/SeckillServiceImpl.java:261-323`

Hand-derived guards: `269->270:T` (empty sku → `return null`), and the F-arm escapes to the method's
final `return null` from four nested predicates: `278->322:F`, `283->322:F`, `291->322:F`, `298->322:F`.

| hand | tool | verdict |
| --- | --- | --- |
| 269->270:T guard | 269->270:T GUARD `return null;` | match |
| 278->322:F guard | 278->322:F GUARD `return null;` | match |
| 283->322:F guard | 283->322:F GUARD `return null;` | match |
| 291->322:F guard | 291->322:F GUARD `return null;` | match |
| 298->322:F guard | 298->322:F GUARD `return null;` | match |
| — | 304->322:F GUARD, 304->316:T GUARD `return timeId;` | extra (both classical; `304->316` is the success-return edge I judged non-classical — the tool emits it, and for a consumer it is useful) |

Non-guard edges all present too (`278->281:T`, `278->283:T`, `283->285:T`, `283->291:T`, `291->294:T`,
`291->298:T`, `298->300:T`, `298->304:T`, `304->307:T`).

**Verdict: PASS — 5/5 hand-derived guard edges, zero misses.** Note that the compound conditions
`currentTime >= startTime && currentTime <= endTime` (278), `randomCode.equals(key) && killId.equals(skuId)`
(283) and `count > 0 && num <= seckillLimit && count > num` (291) are each modelled as **one predicate at
the `if` line**, so the `&&`/`||` short-circuits do not fragment the guard edge — good news for guard
discovery (see FINDINGS: expression-level short-circuits in *value* positions produce no CDG, which is
classically correct but is a real difference in blast-radius coverage).

### 4. `OrderServiceImpl.closeOrder` — `killshop-order/.../service/impl/OrderServiceImpl.java:278-302`

Hand-derived: `284->286:T` (the guarded action); **no** `284-><after>` edge, because the method ends
immediately after the `if`, so the F arm has no dependent statement.

| hand | tool | verdict |
| --- | --- | --- |
| 284->286:T | 284->286:T `OrderEntity orderUpdate = new OrderEntity();…` | match |
| — | 284->297:T `rabbitTemplate.convertAndSend(…)` | extra, classical (inside the same arm) |
| — | 297->298:F **×2 (duplicated rows)** | noise: try→catch edge, emitted twice with identical fields |

**Verdict: PASS on the hand-derived edge (1/1); two defects recorded, neither a miss:** (a) duplicate
emission of `297->298:F`, (b) the try→catch control-dependence edge is the documented
"exception flow over-approximated" behaviour (the catch clause is reported as control-dependent on the try
body; harmless here because both dependents are in the same guarded region, but it inflates edge counts).

### 5. `OrderServiceImpl.builderOrderItems` (bonus: lambda + compound guard) — `OrderServiceImpl.java:480-497`

Hand-derived: `486->487:T` only. `486->496:F` is **not** a classical edge (the plain `return
orderItemEntityList` post-dominates 486, because both arms of the compound condition reach it), so a tool
that emitted it would be adding a false "guard" for an empty-cart shortcut.

Tool: exactly one row, `486->487:T orderItemEntityList = currentCartItems.stream().map((items) -> {…`.
The lambda body (`return orderItemEntity` at 492) produces no CDG row of its own here.

**Verdict: PASS — the tool matched the classical minimum and did not invent the tempting-but-wrong
`486->496:F` guard.**

## Spot-check summary

| method | hand-derived guard edges | found | missed | extras | verdict |
| --- | --- | --- | --- | --- | --- |
| `loginController.sendCode` | 1 | 1 | 0 | 2 (classical long-range) | PASS |
| `loginController.register` | 5 | 5 | 0 | 3 (else bodies) | PASS |
| `SeckillServiceImpl.kill` | 5 | 5 | 0 | 2 (classical) | PASS |
| `OrderServiceImpl.closeOrder` | 0 (1 non-guard) | 1 | 0 | 1 + 1 duplicate | PASS |
| `OrderServiceImpl.builderOrderItems` | 0 (1 non-guard) | 1 | 0 | 0 | PASS |
| **total** | **11 guard edges** | **11** | **0** | 8, all classical except 1 duplicate (`304->316:T` is an extra guard-flagged edge — see §3) | **PASS** |

**Zero missed guard edges on real killshop code.** The gate clause "any missed guard edge here is a gate
failure too" is therefore **not** triggered by the spot check.

### Real-code data-flow (informational; `flows` was unreachable by name for 4/5 methods)

Flows were obtainable only through the file anchor, scoped by `functionLine`. Rows are substantively
correct but **line numbers are block-granular**: every straight-line run of statements collapses into one
basic block and every def/use inside it is reported at the block's START line:

* `kill`: `skuInfoValue` is defined at 268 but reported as `264 -> 269 / 264 -> 273`; `count` is defined at
  289 but reported as `285 -> 291`; `skuId` is defined at 282 but reported as `281 -> 283`. The `use.text`
  field still carries the real statement text, including merged statements joined by `\n`.
* `sendCode`: the parameter `phone` is reported as `52 -> 57 / 52 -> 68` — its "def line" is `functionLine`
  52, which here is the **annotation** line, not even a statement.

Accurate rows (exact def and use lines) exist wherever both statements start their own block, e.g.
`redisCode 57 -> 58, 57 -> 60`, `aBoolean 294 -> 298`, `count 285 -> 291`, `timeId 307 -> 316`.
