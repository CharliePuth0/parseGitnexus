# Phase A — Java PDG precision verification: FINDINGS

Scope: is GitNexus's statement-level PDG (`gitnexus analyze --pdg` + the `pdg_query` MCP tool)
accurate enough on Java to be enabled by default?
Tool: gitnexus 1.6.12, `gitnexus/dist/cli/index.js`, MCP over Streamable HTTP.
Artifacts: `fixtures/java/*.java` (15 files), `fixtures/java/ground-truth.json`, `runner.mjs`,
`spotcheck-killshop.mjs`, `KILLSHOP-SPOTCHECK.md`, `results/latest.json`,
`results/killshop-spotcheck.json`, `logs/*.log`.

## 1. Verdict

| gate | result |
| --- | --- |
| Gate as specified (label-strict, exit 0 only at 100 % recall on controls AND flows) | **FAIL** — controls recall 63.3 %, flows recall 63.6 %, 14 guard-flagged rows unmatched, exit code 1 |
| After per-edge hand adjudication | **0 genuine missed control/guard edges, 0 genuinely missing data edges**; the failure is instrumentation (my annotations), not the tool |
| Real-code guard gate (killshop spot check, 4 required + 1 bonus method) | **PASS** — 11/11 hand-derived guard edges found, correct sense, 0 missed |

The tool's CDG implements the classical Ferrante rule (Y is control dependent on X iff Y
post-dominates a successor of X and Y does not post-dominate X); my annotation used the looser
"reachable under this arm" reading and expected edges to the join point, which classical CDG
correctly omits. Per the integrity rule I did NOT edit `ground-truth.json` after the first run; the
literal gate stands FAIL and the adjudicated view is reported alongside it.

**Recommendation: do not enable PDG by default on this run. The guard/control layer is demonstrably
sound on real Java code; the flow layer's statement-line precision is not.**

## 2. Numbers

Fixture repo: 15 files (14 fixtures + harness) staged in `src/main/java`, 175 nodes / 334 edges,
`analyze --pdg --index-only` 6.9 s, 0 `[cfg]`/`[cdg]`/`[reaching-defs]` warnings (no emit skips).
SwitchColon is excluded from the gate (three identical `break` statements make its anchor symbol
unresolvable — the only duplicated symbol name in the corpus).

### 2.1 As measured

| fixture | construct | ctrl exp/ret/matched | ctrl miss | ctrl extra | flows exp/ret/matched | f-miss | f-extra |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PlainIfElse | plain if/else | 2/2/2 | 0 | 0 | 3/3/2 | 1 | 1 |
| EarlyReturnGuard | early-return guard | 4/4/3 | 1 | 1 | 0/3/0 | 0 | 3 |
| NestedIf | nested if | 4/3/3 | 1 | 0 | 3/5/3 | 0 | 2 |
| ElseIfChain | if/else-if/else | 4/4/3 | 1 | 1 | 4/5/3 | 1 | 2 |
| SwitchColon *(excluded)* | switch colon | 5/6/3 | 2 | 3 | 4/4/3 | 1 | 1 |
| SwitchArrow | switch arrow | 5/3/3 | 2 | 0 | 4/4/3 | 1 | 1 |
| TryCatchFinally | try/catch/finally, guarded return in catch | 4/11/4 | 0 | 7 | 3/8/1 | 2 | 7 |
| TryWithResources | try-with-resources | 4/3/2 | 2 | 1 | 3/5/3 | 0 | 2 |
| WhileBreak | while + break | 3/4/2 | 1 | 2 | 5/11/5 | 0 | 6 |
| ForContinue | for + continue | 3/5/2 | 1 | 3 | 4/15/4 | 0 | 11 |
| DoWhile | do/while | 4/4/2 | 2 | 2 | 10/12/3 | 7 | 9 |
| Ternary | conditional expression | 2/0/0 | 2 | 0 | 1/4/1 | 0 | 3 |
| ShortCircuit | `&&`/`||` in value position | 3/0/0 | 3 | 0 | 2/5/0 | 2 | 5 |
| ThrowAfterGuard | guard + throw | 6/4/4 | 2 | 0 | 0/4/0 | 0 | 4 |
| LambdaCase | lambda (expected gap) | 1/2/1 | 0 | 1 | 2/3/0 | 2 | 3 |
| **gate total (excl. SwitchColon)** | | **49 / 49 / 31** | **18** | **18** | **44 / 87 / 28** | **16** | **59** |

Gate: controls P/R **63.3 % / 63.3 %**; flows P/R **32.2 % / 63.6 %**; missed guard-flagged rows 14
(12 in gate); label-only mismatches 6; control misses ignoring the label 20 (18 in gate) — every miss
is an absent line pair. Reproducible byte-identically over three runs.

### 2.2 After adjudication (hand re-derivation of every miss; does not change the gate or the exit code)

* Controls: **18/18 in-gate misses are annotation errors** (§5) — the returned rows are all
  classical. Extras breakdown (18 in gate): 7 classical edges I failed to annotate, 2 loop-carried
  self edges, 8 exception-family rows (7 TryCatchFinally + 1 TryWithResources), 1 exact duplicate.
* Flows: 8 of 16 in-gate misses are annotation errors (dead defs and kills, gen/kill semantics
  correct in the tool); the other 8 are edges that exist at **coarsened lines** (block granularity).
  Edge-level flow recall on the corrected set: 36/36. Extras (59 in gate): 31 parameter formal
  def→use rows (declared expected by my own pre-written rule but never enumerated — my omission),
  5 exact duplicates, 8 exception/finally-family rows, 2 loop-carried self edges, the remainder are
  block-coarsened variants of annotated edges plus valid unannotated loop-carried data edges.

## 3. Defect classification (construct by construct)

| # | class | severity | evidence | constructs |
| --- | --- | --- | --- | --- |
| D2 | **Line coarsening (not a missing edge).** A straight-line run is one BasicBlock; every def/use inside is reported at the block's START line; `use.text`/`dependent.text` keep the true statements (`\n`-joined). | high for statement-precise impact mapping | fixtures: DoWhile (`value 5->7` → `4->7`, `5->11` → `4->10`, `8->11` → `8->10`, `11->7` → `10->7`, `11->12` → `10->12`), ShortCircuit (`valid 4->5` → `4->4`), LambdaCase (`out 12->13` → `6->13`, capture `base 5->10` → `5->6`); killshop: `skuInfoValue` def 268 reported at 264, `count` 289 → 285, `skuId` 282 → 281, param `phone` "def" at 52 = the annotation line | any multi-statement block; all parameters |
| D3 | **Duplicate rows** (byte-identical emissions). | low, noise | ForContinue `5->5:T` ×2 control + 5 duplicate flow rows (`i 5->5` ×4, `5->6` ×2, `5->9` ×2); killshop `closeOrder 297->298:F` ×2 |
| D4 | **Exception-flow over-approximation, labels meaningless** (4 rows with EMPTY `dependent.text`; both `T` and `F` on one pair). | medium | TryCatchFinally `{6->10:T}`, `{6->10:F}`, `{9->10:F}` (empty), `{6->11:T/F}`, `{9->11:F}`, `{16->18:F guard}`; TryWithResources `{13->14:F guard}` (`F` on the success exit) | try/catch/finally (documented) |
| D5 | **No CDG for expression-level branches** — ternary and value-position `&&`/`||` yield 0 rows for the whole function. Classical-correct, but a real blast-radius hole. (`&&` in an `if` test is one predicate and its guard edge IS emitted — verified on killshop `kill()`.) | medium | Ternary, ShortCircuit |
| D6 | **Anchor collisions** — name ambiguous in a monorepo (4/4 killshop methods); file anchor not function-scoped (27 rows for a 7-row method, 48 for an 18-row method); UID resolves nowhere (silently empty) | medium, Phase B ergonomics | §6 |
| D7 | **Silent empty result for an unresolvable target** (`results: []`, not an error) — indistinguishable from "no dependence"; the UNKNOWN-vs-empty trap | medium | 7/7 UID probes |
| — | **No loop-exit dependence** (loop test → post-loop statement). Classical CDG agrees (the post-loop statement post-dominates the loop header). Coverage boundary, not a defect; consumers needing "what runs after the loop" must use the CFG or `impact`. | informational | while / for / do-while |

No returned control row contradicts classical CDG except the D4 family; no returned data-flow row was
found unsound.

## 4. Documented gaps: which showed up

| gap | observed | evidence |
| --- | --- | --- |
| lambda bodies opaque both directions | **partially falsified** — the body IS emitted as its own unit keyed to the lambda header line, and its guard edges are returned (`LambdaCase {7->8:T guard}`, `{7->10:F guard}`); only the join to the enclosing method fails (capture `base 5->10` reported at the merged block line 6; result `out 12->13` attributed to 6) | LambdaCase; killshop `functionLine: 119` for the `forEach` lambda |
| exception flow over-approximated | **confirmed** | TryCatchFinally 7 extras of 11 returned rows, 4 with empty text |
| switch arms all labelled `T` | **confirmed** | SwitchArrow `{5->6,5->7,5->8}` all `T`; colon-form `break`s appear as extra guard-flagged rows `{5->8,5->11,5->14}` |
| deep nesting skipped | **not observed** | 0 `[cfg]`/`[cdg]`/`[reaching-defs]` warnings on killshop (16,338 nodes) or the fixtures; those paths warn unconditionally (`pipeline/run.ts:1592,1606`), so the zero is trustworthy |

**Harness trap found building the fixtures:** `fixtures` is a hardcoded ignored directory name
(`gitnexus/src/config/ignore-service.ts:129`) — sources under any `fixtures/` segment index as
`0 nodes | 0 edges` with a success message and exit 0. The first run of this harness was silently
empty for that reason; `runner.mjs` stages into `src/main/java` instead.

## 5. Annotation errors disclosed (no ground-truth file was edited)

Controls (18 in gate, all derivably non-classical):
* join over-annotation (12) — I annotated the join point as a dependent: `EarlyReturnGuard 4->10:F`,
  `NestedIf 5->12:F`, `ElseIfChain 5->10:F`, `SwitchArrow 5->10:T/F`, `TryWithResources 8->14:T/F`,
  `WhileBreak 5->9:T`, `ForContinue 5->9:T`, `DoWhile 7->11:F`, `ThrowAfterGuard 5->9:F`, `8->11:F`.
  The classical counterparts the tool DID emit (`5->7:F`, `else-if 7->10:F`, `4->7:F`, `6->5:F`,
  `6->9:F`, `12->10:T`) I had failed to annotate at all.
* loop-exit (1) — `DoWhile 12->13:F`: the post-loop `return ticks;` post-dominates the loop header
  (the only exit of the loop leads to it), so this is not a control dependence; my expectation, not
  the tool, was wrong.
* expression-level (5) — `Ternary 4->5:T/F`, `ShortCircuit 4->5:F`, `5->6:T/F`: no statement-level
  branch exists (the value selection is a data dependence, which the tool does report).

Flows (8 of 16 in-gate misses are annotation errors; the other 8 exist at coarsened lines):
* dead initializers: `PlainIfElse bonus 4->10`, `ElseIfChain band 4->12`, `SwitchArrow size 4->10`,
  `DoWhile ticks 4->13` (do-while always executes the body, killing the def at 4),
* killed defs: `TryCatchFinally len 9->18` and `14->18` (the `finally` def at 16 kills),
  `DoWhile value 8->12` (killed by 11),
* wrong annotation: `ShortCircuit valid 4->6` (line 6 reads `blocked`, not `valid`).

My own `PlainIfElse` note says line 4 is dead while its `expectedFlows` still lists it — an internal
inconsistency left in place rather than edited. With the corrected set the fixture gate would read
controls 31/32 and flows 36/36 at edge level.

## 6. UID targeting — verdict for Phase B

**`pdg_query` does NOT accept a UID; it fails silently with an empty result** (7/7 probes: 2 fixtures
+ 5 killshop methods, both the full UID and the kind-stripped form):

    pdg_query {mode: 'controls', target: 'Method:src/main/java/PlainIfElse.java:PlainIfElse.plain#1'}
      -> { anchor: { file: 'Method:src/main/java/PlainIfElse.java:PlainIfElse.plain#1' }, results: [], total: 0 }

Cause (source-verified): `looksLikeFilePath` (`src/mcp/local/local-backend.ts:282`) classifies any
target containing `/` as a file path, and the UID contains slashes. Working forms, in order:

1. `target = <symbol name>` — best when unique: line-range-granular anchor, exact `startLine`/
   `endLine` echo, correct `guard` flags. **Ambiguous in a monorepo** (`status: 'ambiguous'` with
   `candidates[].uid` that are themselves unusable as targets) — 4/4 required killshop methods.
2. `target = <file path>` (repo-relative or suffix) — always resolves but is **not function-scoped**
   (no line window in `resolveBlockAnchor`'s file branch). The consumer must filter rows by
   `functionLine`: the declaration unit's first line — the **annotation** line when annotated
   (`@Override` 260 for the method at 261; `@ResponseBody` 52 for 54), else the declaration line;
   lambda bodies are separate units keyed to the lambda header line.
3. No third form: `pdg_query` has no `line`/`symbol_uid` parameter.

## 7. Recommendations for Phase B

1. **Do not enable PDG by default on this run** — the pre-registered gate failed; I will not argue it
   into a pass. A re-run needs a corrected instrument (post-dominance-frontier controls, gen/kill
   flows), annotated by someone other than the author of this report.
2. If PDG ships behind a flag, **ship it for guard/control discovery first**: 11/11 hand-derived
   guard edges on killshop, correct `T`/`F` sense, correct lines, compound `&&`/`||` modelled as one
   predicate, `guard:true` exactly on return/throw/continue/break dependents, and it correctly
   declined the tempting-but-wrong `486->496:F` empty-cart "guard". Zero false guard edges observed.
3. **Do not use flows as a statement-line-precise oracle.** Consumer compensations: treat the
   reported line as a block anchor; recover the statement from `use.text`/`dependent.text`; dedupe;
   never trust a parameter's `def.line` (function-unit start line, may be an annotation line); drop or
   label rows with empty `dependent.text` (exception family, `T`/`F` meaningless).
4. Treat `results: []` as **UNKNOWN**, not as "no dependence" — it is also what an unresolvable
   target returns (the project's own UNKNOWN rule applies verbatim here).
5. Resolve methods to `filePath` + `functionLine` first, query with the file path, filter on
   `functionLine`; never anchor by UID, never by bare name in a multi-module repo.
6. Compensate for the missing loop-exit dependence (post-loop code is invisible to CDG) from the CFG
   or via `impact`.
7. Avoid `fixtures` (and the other ignored names: `tmp`, `cache`, `generated`, `snapshots`,
   `__snapshots__`) as any path segment in sample/test repos — silent 0-file index.

## 8. Reproduce

    cd /Users/sugerdaddy/AI/agent/parseCode/GitNexus/release-impact/precision
    node runner.mjs                # fixture gate; exit 0 only at 100 % recall; raw rows -> results/latest.json
    node spotcheck-killshop.mjs    # real-code probes; raw rows -> results/killshop-spotcheck.json
    # killshop re-index (touches only its .gitnexus/, not git-tracked):
    cd /Users/sugerdaddy/AI/shop/killshop && node /Users/sugerdaddy/AI/agent/parseCode/GitNexus/gitnexus/dist/cli/index.js analyze --pdg --index-only

`runner.mjs` builds a throwaway git repo under `$TMPDIR`, indexes, queries, scores, and removes the
index from the global registry again (verified: registry back to its original three entries).

## 9. Killshop spot check summary (full tables in `KILLSHOP-SPOTCHECK.md`)

Re-index: `pdg mode changed … forcing a full rebuild`, 20.1 s, 16,338 nodes / 26,114 edges;
`[cfg]` / `[cdg]` / `[reaching-defs]` skip counters all zero.

| method | hand-derived guard edges | found | missed | extras | verdict |
| --- | --- | --- | --- | --- | --- |
| `loginController.sendCode` | 1 | 1 | 0 | 2 (classical long-range escapes) | PASS |
| `loginController.register` | 5 | 5 | 0 | 3 | PASS |
| `SeckillServiceImpl.kill` | 5 | 5 | 0 | 2 (classical) | PASS |
| `OrderServiceImpl.closeOrder` | 0 (1 non-guard) | 1 | 0 | 1 + 1 duplicate | PASS |
| `OrderServiceImpl.builderOrderItems` (bonus) | 0 (1 non-guard) | 1 | 0 | 0 | PASS |
| **total** | **11** | **11** | **0** | 8 | **PASS** |

Zero missed guard edges on real code → the spot-check gate clause is not triggered.

## 10. Independent coordinator re-check

The coordinator re-derived `loginController.sendCode` guards from source and confirmed the stored
rows: `58→61[T]`, `61→63[T] GUARD`, `58→68[F]`, `61→68[F]`, `58→78[F] GUARD`, `61→78[F] GUARD` —
all correct; D3 duplicates (`297→298[F]` ×2) and D4 empty-text exception rows visible in raw data.
