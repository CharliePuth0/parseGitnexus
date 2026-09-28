# Prometheus spot check — Go PDG guard edges on real code

**Scope.** The second Go gate: does `pdg_query` return the true guard-edge set on real Go?
Mirrors `../KILLSHOP-SPOTCHECK.md` for Java. Fixture-level gate: `FINDINGS.md` § Fixture gate.

**Integrity rule.** Every `guards` / `other` entry in `spotcheck-prometheus.mjs::EXPECTATIONS` was
hand-derived from the Prometheus source **before any `pdg_query` was issued**. Nothing was edited
after the run; annotation mistakes are recorded in § Adjudication and in `FINDINGS.md`, not fixed
silently.

**Target.** `/Users/sugerdaddy/AI/shop/prometheus` — HEAD `063606dbcfdf580f80449bb998d717b74a554388`,
`indexedAt 2026-09-28T17:37:38.826Z`, `pdg` stamp present
(`maxFunctionLines 2000`, `maxCdgEdgesPerFunction 5000`, `maxReachingDefEdgesPerFunction 4000`).
None of the five methods below exceeds the 2000-line cap.

**Anchor policy (fixed before the run).** Query by symbol name first; if the name form returns
`ambiguous` or nothing, fall back to the repo-relative file path and filter rows by
`functionLine == <declLine>` (the consumer workaround established by the Java Phase A run).
Every miss was then re-checked against the raw persisted edges via `cypher`, to separate
*edge not derived* from *edge not retrievable*.

---

## Result

| method | file:declLine | anchor actually used | guards expected | guards found | other expected | other found | rows scored | misses |
|---|---|---|---|---|---|---|---|---|
| `readHistogramChunkLayout` | `tsdb/chunkenc/histogram_meta.go:35` | name (unique) | 5 | **5** | 8 | 8 | 16 | — |
| `readCheckpoint` | `tsdb/wlog/watcher.go:715` | name (unique) | 6 | **6** | 5 | 5 | 20 | — |
| `Visit` (`durationVisitor`) | `promql/durations.go:39` | file + `functionLine` (name ambiguous) | 5 | **5** | 8 | 8 | 41 | — |
| `OpenBlock` | `tsdb/block.go:355` | name (unique) | 4 *(was 3)* | **4** | 5 | 4 | 17 | 1 (my error) |
| `labelNames` | `web/api/v1/api.go:884` | **none reachable** | 7 | **0** | 7 | 0 | 0 | 7 + 7 |
| **total** | | | **27** *(was 26)* | **20** *(was 19)* | 33 | 25 | | **7** |

As the script computed it (uncorrected expectation list): guards 26 expected, 19 found, **7 MISSED**,
**0 wrong-sense**, 19 tool-`guard:true`-flagged → `SPOT-CHECK GATE: FAIL`.

After the correction in § Adjudication: 27 expected, 20 found, still **7 MISSED**, 0 wrong-sense.

**Engine vs. tool.** All 5 methods' guard edges — including all 7 "misses" — are present in the
persisted CDG with the correct `T` sense; verified by raw `cypher` on
`BasicBlock:web/api/v1/api.go:884:`. So:

* **CDG derivation on real Go: 27/27 guard edges, 0 wrong-sense, 0 spurious guard-derived edges.**
* **`pdg_query` retrieval: 20/27.** The 7 retrieval failures are one method, one cause, and they are
  the D6/D7 access-path defect below — not a missing dependence.

**Verdict: FAIL as a tool-level gate** (the gate is "any missed guard edge = failure", and a consumer
retrieving guard clauses through `pdg_query` cannot get `labelNames`' 7 guards at all), with the
failure attributed to anchoring, not to the CDG.

---

## Method by method

### `readHistogramChunkLayout` — `tsdb/chunkenc/histogram_meta.go:35`
Straight-line chain of 5 `if err != nil { return … }` guards + one guarded nested call.
Guards `42→43, 47→48, 53→54, 58→59, 64→65` all returned with label `T`, all `guard:true`. `other`
8/8 (both arms at `62`, the F-arm descents `42→46, 47→50, 53→57, 58→62, 64→69`).
3 extras, all classical F-arm descents into the next predicate test: `42→47[F]`, `47→53[F]`, `53→58[F]`.
Verdict: complete and correct; the extras are the engine's post-dominator-chain rule, not noise
unique to Go.

### `readCheckpoint` — `tsdb/wlog/watcher.go:715`
Guard chain with a `for-range` whose body returns, plus the compound predicate
`err != nil && !errors.Is(err, io.EOF)` at 741. Guards `718→719, 724→725, 729→730, 734→735,
741→742, 745→746` all returned `T` + `guard:true`; `other` 5/5.
9 extras, all classical: F-arm descents into the next test (`718→724`, `729→734`, `734→741`),
the loop-header rows (`727→728[T]`, `727→729[T]`), the back-edge `745→727[F]`, and the loop-exit
descent into the tail (`727→748[F]` — **empty `dependent.text`**, `727→750[F]`,
`727→751[F]` flagged `guard:true` although 751 is the function's *closing* `return nil`).
**Compound-predicate check: PASS** — `err != nil && !errors.Is(...)` is one predicate, guard edge intact
(confirms the Java KILLSHOP finding for Go).

### `Visit` — `promql/durations.go:39` (type switch)
`target:"Visit"` → `status: ambiguous`, 8 candidates (mostly `web/ui/**/*.ts`), so the file anchor was
used: 82 rows in `promql/durations.go`, 41 scoped to `functionLine 39`.
Guards `44→45, 52→53, 60→61, 67→68, 74→75` all returned `T` + `guard:true`; `other` 8/8 (the five
non-return `if` tests `42/50/58/65/72` on their `T` arms).
28 extras, all classical case-dispatch / arm chains (e.g. `40→42[T]`, `40→50[T]`, `40→58[T]`,
`44→80[F] GUARD`, `52→80[F] GUARD`, `72→80[F] GUARD` — every arm's F-descend ends on the closing
`return v, nil` at 80 and gets flagged as a guard).
**Go-only construct, works**: the type switch derives one controller per arm; as documented, *all*
arms are labelled `T`, including `default:`.

### `OpenBlock` — `tsdb/block.go:355` (named return + `defer func(){…}()`)
Guards `366→367, 381→382, 387→388` returned `T` + `guard:true`.
Extras (10) include `371→372[T] GUARD` — see § Adjudication, this is a guard my pre-query list
**omitted**, and the tool found it (so OpenBlock is really **4/4**) — and
`387→405[F] GUARD`, a long-range F-arm descent into the function's closing `return pb, nil`.
`other` 4/5: the miss `377→380[F]` is my derivation error (380 is `ipdom(377)`, so it is excluded by
the CDG definition).
Also returned: `356→357[T]` (the `logger == nil` nil-guard whose body is an assignment, correctly
*not* a guard-class edge) and **`361→362[T]`** — a row belonging to the *deferred closure's own unit*
(`BasicBlock:tsdb/block.go:360:…`), pulled in because the symbol anchor is a **line window**
(`a.startLine ∈ [symStart+1, symEnd+1]`), not a unit key.

### `labelNames` — `web/api/v1/api.go:884` **(the failure)**
51-line method, seven `if err != nil { return … }` guards, a `defer q.Close()`.
**No supported `pdg_query` anchor reaches it** — see the investigation below. All 7 guards, and all 7
`other` edges, are present in the persisted CDG with correct sense:

```
886->887[T] 891->892[T] 895->896[T] 900->901[T] 909->910[T] 923->924[T] 945->946[T]
```
(49 CDG rows at `BasicBlock:web/api/v1/api.go:884:`; 9 guard-class rows: the 7 above plus the
classical `921→958[F]` and `945→958[F]`.)

---

## Why `labelNames` is unreachable

`pdg_query`'s input schema is `{mode, target, variable, limit, repo, branch}` — **no line, symbol,
kind, or offset scoping**. Probed and rejected at the MCP envelope:

```
args {"line":884}          -> Unknown argument "line" for tool "pdg_query"
args {"functionLine":884}  -> Unknown argument "functionLine"
args {"symbol":"labelNames"} -> Unknown argument "symbol"
```

Three target forms, three dead ends, each with a different root cause:

1. **`target:"labelNames"` → `status: ambiguous`, `totalCandidates 8`.** No qualified-name form
   resolves it: `API.labelNames`, `api.API.labelNames`, `(*API).labelNames`, `v1.API.labelNames`,
   `labelNames#1` → all `"Symbol '…' not found"`. The tool's own advice ("re-call with the file
   path") is the only documented escape.
2. **`target:"Method:web/api/v1/api.go:API.labelNames#1"` (the UID from the ambiguity payload) →
   `{results: [], total: 0}`, no error, no note.** Root cause: `looksLikeFilePath()`
   (`gitnexus/src/mcp/local/local-backend.ts:282`) classifies any target containing `/` as a file
   path, so the UID is never resolved as a symbol — it becomes a *file anchor* with
   `idPrefix = "BasicBlock:Method:web/api/v1/api.go:API.labelNames#1:"`, which matches nothing.
   Same for the kind-stripped id. **This is the Java Phase A D6/D7 defect, unchanged on the Go
   path**, and it is silent: 0 rows is indistinguishable from "this function has no CDG rows".
3. **`target:"web/api/v1/api.go"` → `200 rows returned, total 813, truncated: true`, 0 rows at
   `functionLine 884`.** The page is produced by
   `ORDER BY srcId, dstLine, reason, b.id LIMIT <limit>` (`local-backend.ts:6023`) where
   `srcId = BasicBlock:<path>:<fnLine>:<fnCol>:<blockIdx>` — a **string** sort. `"…:1003:…"` sorts
   before `"…:884:…"` because `'1' < '8'`, so the first page covers function lines 1003–1615 and
   line 884 is ~600 rows deeper. There is no offset parameter and no line filter, so the documented
   file-path workaround — which is what made the Java killshop pass — fails for any function whose
   line number sorts late inside a large file. The basename form (`api.go`) and the flows mode
   (`total 1197`, same 200-row cap) behave identically.

**The one path that does reach the unit** is the neighbouring tool:
`impact({target:"labelNames", target_uid:"Method:web/api/v1/api.go:API.labelNames#1",
direction:"upstream", mode:"pdg", line:886})` returns `affectedStatements`. It resolves the UID
(`impact` accepts `target_uid`; `pdg_query` does not) but **flattens the PDG**: the rows carry no
`controller`/`dependent`/`label`/`guard`, so branch sense (T/F) and guard flags are lost — exactly
the fields the `pdg_query` contract tells consumers to rely on ("don't filter guards by a fixed
label" presumes the label exists).

---

## The `defer` probe (real code)

`OpenBlock` is the annotated defer probe: `defer func(){ if err != nil { err = errors.Join(err,
closeAll(closers)) } }()` over the **named return** `err`, with `postingsDecoderFactory != nil` and a
closing `return pb, nil` at 405. Raw edges (exact anchor semantics, `a.startLine ∈ [356,406]`):

* The deferred literal gets **two representations**: one opaque block in the enclosing unit
  (`BasicBlock:tsdb/block.go:355:0:5 @360 "defer func() { … }"`, plus an empty-text companion) **and**
  a full separate unit `BasicBlock:tsdb/block.go:360:7:{0,1,2,3}`.
* That nested unit has exactly **two** edges in the whole graph:
  `CDG 361→362[T]` (its internal `if`) and `REACHING_DEF 362→362[err]` (a def/use **self-pair** on the
  same line).
* The enclosing unit's 16 CDG rows contain **no** row whose controller or dependent is in 360–364, and
  its 27 windowed REACHING_DEF rows contain **no def of `err` at 361/362** and nothing into the
  epilogue: the closing `return pb, nil` at 405 is reached only by `390→405[pb]`.

**Consequence (consumer-visible, unsound):** the deferred write to the named return is the value that
actually escapes (`return pb, nil` sets `err = nil`, then the deferred func overwrites it), yet from
the enclosing function's anchor `err` looks like it is never written after line 365 and nothing flows
into the exit. Asking "what affects OpenBlock's returned `err`" — or "what does line 362 affect" —
returns a complete-looking answer that omits the defer chain entirely. The same double-modelling was
confirmed for `go func(){…}()` literals on other Prometheus units (e.g.
`BasicBlock:tsdb/agent/db_test.go:181:…` holds `183→183[err]`, `183→183[app]` self-pairs; the
enclosing unit holds only the opaque `go func() { … }` block). **The literal's rows do not link to the
enclosing unit's rows in either direction, and nothing in the response says so.**

---

## Adjudication and disclosed annotation errors

| # | Item | Disposition |
|---|---|---|
| 1 | `OpenBlock` pre-query guard list had 3 entries; the source has **4** early-return guards — `371→372` (`chunks.NewDirReader`) was omitted. | **My annotation omission.** The tool returned `371→372[T] GUARD` and the script scored it as an "extra". Totals corrected 26→27 expected / 19→20 found. Not a tool defect. |
| 2 | `OpenBlock` `other` entry `377→380[F]` was not returned. | **My derivation error.** 380 is `ipdom(377)` (both arms of `postingsDecoderFactory != nil` reach it), so the CDG definition excludes it. The tool is right. |
| 3 | 33 `other` entries were annotated; 25 returned. The un-annotated returned rows are the classical **F-arm descent chain** (`42→47[F]`, `729→734[F]`, `921→950[F]`, …), which the Java Phase A run already established as the engine's post-dominator-chain rule. | **Deliberate under-annotation**, not a tool defect: I annotate crisp edges only. The gate is the guard set, which is fully annotated. |
| 4 | Every row flagged `guard:true` whose dependent text is a `return` — including the function's **closing** return (`387→405` in OpenBlock, `921→958` / `945→958` in labelNames, `727→751` in readCheckpoint, `52→80` in Visit) — is a false guard clause for a consumer. | **Genuine defect (D11)**: the guard flag is a text heuristic (`isGuardExit`, `local-backend.ts:6059`) with no check that the return is on the predicate's taken arm or that the controller's other arm does not rejoin. 1 false guard per method with a non-post-dominated tail; 3/3 fixture instances are the same shape. |
| 5 | `readCheckpoint`'s `727→748[F]` has an empty `dependent.text`; labelNames' `909→912[F]` is returned twice (once with text, once empty). | **D3/D4 shapes, unchanged for Go**: empty-text CFG bookkeeping blocks (defer drains, branch merges, loop joins) surface as dependents with no source text. |

**No wrong-sense edge was found on any of the five methods** (0/27), and no guard edge was
*derived incorrectly* (0/27).
