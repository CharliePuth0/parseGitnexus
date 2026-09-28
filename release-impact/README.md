# release-impact

Pre-release **code change impact assessment** engine.

Give it a repository and a release baseline (`HEAD~20`, a tag, a branch) and it produces:

| file | who reads it |
| --- | --- |
| `out/report.json` | the frontend (`impact-web/`) — the machine contract, [REPORT_SCHEMA.md](./REPORT_SCHEMA.md) v1 (+ the v1.1 `changeType` field) |
| `out/llm-prompt.md` | a human or Claude — one self-contained brief for the release narrative |

Zero npm dependencies. Plain Node ESM (`node:child_process`, `node:fs`, `fetch`), tested on
Node 24.

---

## Quick start

```bash
# from anywhere — every path is resolved absolutely
node /path/to/release-impact/release-impact.mjs \
  --repo /Users/sugerdaddy/AI/shop/killshop \
  --base-ref HEAD~20
```

```
mcp server ready on port 61434
analysis source: mcp
detect-changes scope=compare base-ref=HEAD~20 (this walks the git diff)
detect-changes: 932 files, 1240 symbols, 179 affected processes, risk critical (listing TRUNCATED)
git name-status: 512 added, 97 modified, 325 removed file(s) in range
analysis targets: 30 of 998 eligible symbols (limit 30); excluded 2 test-file, 0 path-less, 0 duplicate; 968 left unanalyzed by --limit
[1/30] MemberFeignService → LOW
...
[25/30] sendCode → CRITICAL
...
done in 4.2s — 30 changes (29 added, 1 modified), 348 processes, risk critical
wrote .../release-impact/out/report.json (150.4 KiB)
wrote .../release-impact/out/llm-prompt.md (51.8 KiB)
```

Progress goes to **stderr** one line per symbol (`name → merged risk`); stdout stays clean.

### Options

| flag | default | meaning |
| --- | --- | --- |
| `--repo <path>` | *required* | path to the **indexed** git repository |
| `--base-ref <ref>` | *required* | release baseline (`HEAD~20`, `v9.7.0`, `main`, a commit) |
| `--head-ref <ref>` | `HEAD` | exclusive end of the assessed commit range (`base..head`, worktree edits excluded); honored on the local GitNexus build — see [Deviations](#deviations-from-the-tool-contract) #4 |
| `--limit <n>` | `30` | how many changed symbols get `impact` walks |
| `--depth <n>` | `3` | impact traversal depth, per direction |
| `--impact-limit <n>` | `50` | nodes requested per depth level per direction |
| `--out <dir>` | `<engine>/out` | output directory (absolute, resolved from cwd) |
| `--mcp-url <url>` | — | reuse an already-running `gitnexus mcp --http` server instead of spawning one |
| `--cli <path>` | `<repo>/gitnexus/dist/cli/index.js` | built GitNexus CLI (or `GITNEXUS_CLI`) |
| `--llm` | off | call the LLM and backfill `llm.narrative` (see [Where the LLM step plugs in](#where-the-llm-step-plugs-in)) |
| `--quiet` | off | silence stderr progress |
| `-h`, `--help` | — | usage |

Run from any cwd; the script resolves `--repo`, `--out` and `--cli` against the process cwd
and its own location, never against a relative assumption.

---

## Architecture

```
┌──────────────────────────────── release-impact.mjs (CLI + orchestration) ────────────────────────────────┐
│  parse args → resolve paths → open source → detect → filter → walk → merge → validate → write            │
└───────┬──────────────────────────────────────────────────────────────────────────────────────────┬───────┘
        │                                                                                          │
        ▼                                                                                          ▼
┌───────────────────────────┐                                                    ┌──────────────────────────┐
│ src/gitnexus-client.mjs   │  tool facade, MCP first / CLI fallback             │ src/report.mjs (pure)    │
│  detectChanges(baseRef)   │◄──────────────────────────────────────────────────▶│  selectAnalysisTargets   │
│  impact(uid, direction)   │                                                    │  buildChangeEntry        │
└─────┬───────────────┬─────┘                                                    │  buildReport             │
      │               │                                                          │  validateReport          │
      │ MCP (primary) │ CLI (degraded)                                           └───────────┬──────────────┘
      ▼               ▼                                                                      │
┌───────────────────┐ ┌──────────────────────────────────────┐                  ┌────────────▼─────────────┐
│ src/mcp-http.mjs  │ │ node gitnexus/dist/cli/index.js      │                  │ src/prompt.mjs (pure)    │
│ spawn `mcp --http │ │  detect-changes / impact             │                  │  buildLlmPrompt          │
│ --port <free>`    │ │  stdout → temp FILE (not a pipe)     │                  └────────────┬─────────────┘
│ JSON-RPC over SSE │ │  banner-tolerant JSON extraction     │                               │
└───────────────────┘ └──────────────────────────────────────┘                               │
                                                                                            ▼
                                                              ┌───────────────────────────────────────────┐
                                                              │ out/report.json  +  out/llm-prompt.md     │
                                                              └───────────────────────────────────────────┘
                src/util.mjs — risk ordering, JSON extraction, uid→kind, dedupe (pure, unit-tested)
                src/git-status.mjs — `git diff --name-status -z` → changeType (file-level, pure parser)
                gitnexus-shared/dist/index.js — isTestFilePath (single source of truth for test paths)
```

### Pipeline

1. **detect** — `detect_changes(scope: 'compare', base_ref)` over MCP, which runs
   `git diff <baseRef> -U0` and maps hunks onto indexed symbols. Returns `changed_symbols[]`,
   `affected_processes[]`, `summary`, `truncated`.
2. **filter** — drop symbols whose `filePath` fails `isTestFilePath` (test files), drop
   path-less aggregate nodes, drop duplicate uids. Nothing is silently lost: the counts land
   in the log line and in the prompt's caveats.
3. **rank + cap** — keep the tool's own listing order and take the first `--limit` symbols.
   In the same pass, classify each analyzed file with `git diff --name-status` (see
   [`src/git-status.mjs`](./src/git-status.mjs)) to fill `changeType`.
4. **walk** — for each one, `impact` twice: `direction: 'upstream'` (callers — who breaks)
   and `direction: 'downstream'` (callees — what the change reaches). Sequential, addressed
   by `target_uid` for zero-ambiguity lookup.
5. **merge** — flatten `byDepth` into `ImpactNode[]`, union processes/modules, merge the two
   verdicts, sort `changes` by risk descending.
6. **validate** — `validateReport()` checks the shape before anything is written; a
   regression throws instead of shipping a broken contract.
7. **prompt** — `llm-prompt.md` is written and the same text is embedded in `llm.prompt`.

### Field mapping (report.json ← GitNexus)

| report field | source |
| --- | --- |
| `summary.changedFiles` | `detect_changes.summary.changed_files` |
| `summary.changedSymbols` | `detect_changes.summary.changed_count` (the observed total, *including* a capped listing) |
| `summary.analyzedSymbols` | `changes.length` — symbols that actually got an impact walk |
| `summary.affectedProcesses` | `processes.length` (deduplicated union) |
| `summary.riskLevel` | `detect_changes.summary.risk_level`, raised to the worst analyzed per-symbol risk when that is higher |
| `summary.truncated` | `detect_changes.truncated` (the server caps the listing at 1000 entries) |
| `meta.indexStatus` | `impact.staleness.status` (`current` / `behind` / `diverged`), else `unknown` |
| `ChangeEntry.uid/name/kind/filePath` | `changed_symbols[].id/name/type/filePath` |
| `ChangeEntry.isTestFile` | `isTestFilePath(filePath)` from `gitnexus-shared` |
| `ChangeEntry.changeType` | `git diff --name-status` for that `filePath` (**file**-level; see [Deviations](#deviations-from-the-tool-contract) #10) — `gitnexus`' `change_type` is hardcoded to `touched` |
| `ChangeEntry.impact.risk` | merged upstream/downstream `risk` (see below) |
| `ChangeEntry.impact.epistemic` | merged `epistemic` (`lower-bound` beats `exact`; a failed leg → `unknown`) |
| `ChangeEntry.impact.boundaries` | tool-reported `boundaries` + `riskNote` + engine notes (caps, failures) |
| `ImpactNode` | flattened `byDepth[depth][]` → `{depth, id→uid, name, type/uid-prefix→kind, filePath, relationType, confidence}` |
| `ChangeEntry.impact.affectedProcesses` | flows whose own steps changed (`detect_changes.affected_processes[].changed_steps`) first, then flows reached through `byDepth[].processes[]`, nearest depth first |
| `ChangeEntry.impact.affectedModules` | `affected_modules[].name`, unioned over both directions |
| `ProcessEntry` | `affected_processes[]` → `{id, name→summary, step_count→stepCount}`; flows discovered only through `impact` use the deepest step index as a `stepCount` floor |

### Risk merge rule (upstream + downstream → one verdict)

REPORT_SCHEMA.md fixes the order `CRITICAL > HIGH > MEDIUM > LOW > UNKNOWN`, so:

* **both legs completed** → the worst of the two verdicts. A withheld `UNKNOWN` from one leg
  never outranks a concrete verdict from the other, but it always leaves a boundary line
  (`"upstream verdict is UNKNOWN — unresolved, not an all-clear: …"`) so an unresolved walk is
  never read as safety. This matters: GitNexus reports UNKNOWN, never LOW, for a walk that
  resolved zero callers, and a Spring controller legitimately has none.
* **either leg failed** (transport error, `status: "ambiguous"`, `status: "error"`) → the
  symbol is `UNKNOWN` outright. An incomplete walk is not evidence of anything.

Bounded lists state their bounds: `affectedProcesses` is capped at 50 per change, and each
direction's node list at `--impact-limit` per depth level. Both add a boundary line naming the
true size, and `report.processes` always carries the complete deduplicated union.

`changeType: 'removed'` adds a boundary line of its own (`the file is gone from the working
tree, so this impact walk describes the last indexed revision of the symbol`): a removal has
no caller set left to break, so a LOW verdict there describes the graph as indexed, not the
tree as it now stands.

---

## Where the LLM step plugs in

The engine is zero-dependency and works without a model. It writes `llm-prompt.md` (also
embedded verbatim in `llm.prompt`) containing the v2 instruction block (role, six-section
output contract, per-section rules, risk calibration, honesty red lines, style example)
followed by the release context, the summary, every deduplicated flow, and per changed symbol
the risk/epistemic verdict, the upstream and downstream node lists (top 15 per direction), the
affected flows, the affected modules, and every boundary.

### Automatic: `--llm`

`node release-impact.mjs --repo <path> --base-ref <ref> --llm` sends the brief to an
Anthropic-Messages-compatible endpoint (`src/llm.mjs`, plain HTTPS, no new dependency) and
backfills `llm.narrative` in the same run. Credentials/model come from the same env the
Anthropic SDK reads — `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`), `ANTHROPIC_MODEL`
(default `claude-opus-5`), `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`) — so
the same code works against api.anthropic.com or a compatible gateway. A failed LLM step
degrades to a report without `llm.narrative` (plus a note); it never fails the run.

### Manual: hand the brief to a model

To close the loop by hand, write the answer back into the report and the frontend picks it up:

```bash
# 1. produce the brief
node release-impact.mjs --repo /path/to/repo --base-ref HEAD~20

# 2. hand out/llm-prompt.md to a model, then backfill its answer
node -e '
  const fs = require("node:fs");
  const p = "release-impact/out/report.json";
  const report = JSON.parse(fs.readFileSync(p, "utf8"));
  report.llm.narrative = fs.readFileSync("narrative.md", "utf8");   // markdown
  fs.writeFileSync(p, JSON.stringify(report, null, 2) + "\n");
'

# 3. re-validate after editing by hand
node -e '
  import("./release-impact/src/report.mjs").then(async ({ validateReport }) => {
    const report = JSON.parse(require("node:fs").readFileSync("release-impact/out/report.json", "utf8"));
    const { ok, errors } = validateReport(report);
    console.log(ok ? "report.json OK" : errors.join("\n"));
  });
'
```

`llm.narrative` is optional in the schema, so a report without it is still valid — the
frontend should render the structural views and show the narrative when present.

---

## Demo — killshop @ `HEAD~20`

`killshop` is the indexed Java Spring Cloud test repo (8742 nodes), tied to release
`HEAD~20..HEAD`. Run (index taken as-is; the repo is only read):

| metric | value |
| --- | --- |
| changed files | 932 |
| changed symbols observed | 1240 (listing capped at 1000 → `summary.truncated: true`) |
| eligible after filtering | 998 (2 test-file symbols excluded) |
| analyzed (`--limit 30`) | 30 |
| affected execution flows (deduped) | 348 |
| overall risk | `critical` |
| per-symbol risk | 1 CRITICAL, 3 HIGH, 6 MEDIUM, 20 LOW |
| `changeType` distribution (analyzed 30) | 29 `added`, 1 `modified`, 0 `removed` |
| `changeType` distribution (all 998 eligible) | 773 `added`, 225 `modified`, 0 `removed` |
| file-level git status over the range | 512 added, 97 modified, 325 removed, 2 renamed |
| runtime | ~4.2 s (warm index) |
| outputs | `out/report.json` (150.4 KiB, schema-valid), `out/llm-prompt.md` (51.8 KiB) |

Top verdicts: `sendCode` (CRITICAL, upstream unresolved → boundary note), `weibo` / `register`
/ `login` (HIGH), `OAuth2Controller` and the `loginController$N` lambda classes (MEDIUM).
Because the first 30 symbols follow `detect_changes`' own file-ordered listing, the slice is
dominated by `killshop-auth-server` — raise `--limit` (impact calls are ~0.1 s each on a warm
index) for a broader sample.

The 325 deleted files in the range produce **no** `changeType: 'removed'` entry, and that is
the tool's behavior rather than a bug in the classification: `detect_changes` reports a symbol
only when a diff hunk overlaps its line range **in the file as it now exists** (a deleted file's
header is `+++ /dev/null`, so it contributes no hunks), and a symbol that no longer exists in
any file cannot be listed. `removed` is reachable only if a future tool version lists symbols
from deleted files; the engine handles that case, and unit-tests it.

The `killshop` working tree is untouched by a run: the engine is strictly read-only (MCP plus
`git diff`).

---

## Tests

```bash
cd release-impact && node --test        # 29 tests, no dependencies, Node 24
```

Covers risk ordering and the upstream/downstream merge, test-file filtering and the `--limit`
cap, boundary recording for capped/failed legs, the banner-tolerant JSON extractor, the CLI
banner parser, the `git diff --name-status -z` parser and the `changeType` precedence rule, the
schema checker (including the rejects), report assembly, and the prompt.

---

## Deviations from the tool contract

Findings from the installed GitNexus **1.6.12** — behavior that differs from what the task
description assumed, and what the engine does about it:

1. **`detect-changes` has no JSON mode on the CLI.** It prints a localized banner, then only
   the first **15** changed symbols and **10** flows (`src/cli/detect-changes-format.ts`).
   MCP is therefore the *only* source of the full changed-symbol set, and the CLI path is a
   documented **degraded** fallback: it still emits a schema-valid report, but at most 15
   symbols, no process ids, and it says so in the log, in the prompt caveats, and in
   `summary`. MCP spawn failure also demotes the run to this path.
2. **Piped CLI stdout is truncated mid-JSON.** `impact` writes a large payload and then calls
   `process.exit()`, so Node's asynchronous pipe write is cut off — the same command emits
   100_413 bytes to a file and 65_296 unparseable bytes through `execFile`. The CLI fallback
   therefore captures stdout through a **file descriptor**, not a pipe.
3. **`detect_changes` paginates its listing at 1000 entries per page** (the page size is both
   the default and the maximum). The engine walks the pages (`offset += page length` while
   `truncated` is true, capped at 50 pages) and merges them, so `summary.changedSymbols`
   covers the full observed set; `summary.truncated` stays faithful to the last page.
   (Requires the local GitNexus build with `head_ref`/`limit`/`offset`; against an upstream
   1.6.12 server the first page is all that exists.)
4. **`--head-ref` is honored** on the local GitNexus build: `detect_changes` diffs
   `git diff <base_ref> <head_ref> -U0` — an exclusive commit-to-commit range, **worktree
   edits excluded**. A dirty working tree is therefore outside the assessed range (it is
   still detected and warned: the index may have been built from uncommitted work, which
   can shift symbol line mapping). The CLI fallback passes `--head-ref` too; against an
   upstream server that rejects the argument the run degrades instead of mis-assessing.
5. **`impact` returns no `startLine`/`endLine`**, and `detect_changes` does not report line
   ranges either, so the schema's optional `ChangeEntry.startLine/endLine` are omitted.
   `impact`'s `candidates[]` carry a `line`, but only on the ambiguous path.
6. **`impact` requires resolution by uid.** Name lookups for common Java methods return
   `status: "ambiguous"` with a candidate list instead of a blast radius, so the engine always
   passes `target_uid`. The CLI fallback cannot (a) — its uids are reconstructed from the
   banner and would not resolve — so it addresses by name plus `--file` and records UNKNOWN
   with an explicit boundary when the tool still reports ambiguity.
7. **`impact` is a budgeted MCP tool.** An inherited `GITNEXUS_MCP_DEFAULT_MAX_TOKENS` would
   cut the payload mid-JSON. The engine requests an explicit large `maxTokens` per call so a
   configured budget cannot silently turn a real blast radius into UNKNOWN.
8. **`impact.affected_processes` is keyed by entry-point symbol, not by process id.** Process
   ids exist only in `byDepth[].processes[]` annotations, so `ChangeEntry.impact.affectedProcesses`
   is assembled from those plus `detect_changes`' own per-symbol flow attribution.
9. **`ProcessEntry.stepCount` is a floor for impact-only flows.** `byDepth[].processes[].step`
   is the symbol's index *inside* the flow, not the flow's length; `detect_changes` supplies
   the true `step_count` for flows it knows about.
10. **`change_type` is hardcoded to `'touched'`.** Every `changed_symbols[]` entry carries that
    literal (`local-backend.ts`: `change_type: 'touched'`), so the tool reports *that* a symbol
    changed but never *how*. `ChangeEntry.changeType` is therefore derived by the engine from
    `git diff --name-status -z <baseRef> <headRef>` — the same exact range the tool's own diff
    walks, so the two views cannot disagree about which files changed. Consequences: the granularity is **file**-level (a symbol added inside a
    modified file reads `modified`; `detect_changes` reports no line ranges for changed
    symbols, so nothing finer exists), and a rename is reported as `modified` at both endpoints
    while a copy's destination is `added`. If `git diff` fails, every entry falls back to
    `modified` and the prompt says so, rather than dropping the field.

---

## Limitations and open questions for the frontend

* **Test symbols are excluded from analysis, so `isTestFile` is always `false` in `changes`.**
  The contract keeps the field and the frontend keeps its hide-toggle; if you want test
  symbols analyzable, the engine needs an `--include-tests` flag (currently they are filtered
  before the `--limit` cut, and the count is stated in the prompt caveats).
* **`changeType` is emitted but is file-level, and `'removed'` does not occur today.**
  `detect_changes` never lists a symbol whose file no longer exists, so the deleted-file badge
  the frontend would like to render has nothing to attach to on this tool version — the 325
  deleted files in the killshop range yield zero `removed` entries (see the demo section). If
  the UI needs "what disappeared" as a first-class view, that is a *file*-level list, and the
  engine should surface `git name-status` output directly rather than through changed symbols.
* **The first-`--limit` slice inherits `detect_changes`' listing order** (grouped by file, not
  by risk), so a large diff can cluster on one service. A future `--rank` option could order
  candidates by file churn or by a cheap risk probe before the full walk. Schema-neutral.
* **`affectedProcesses` is capped at 50 per change** (`PER_CHANGE_PROCESS_CAP`) because hub
  symbols sit inside hundreds of flows; the full union is in `report.processes` and the cap is
  reported in `boundaries`. Tell us if the UI wants the uncapped per-node list.
* **`report.processes` has no truncation flag** in schema v1 and can reach several hundred
  entries on a wide diff. If the UI paginates it, no change is needed; otherwise a
  `processesTruncated` field would be an additive, non-breaking schema change.
* **`meta.repo` is the directory basename**, not the GitNexus registry name. They match for
  killshop; a repo registered under a different name than its folder would show the folder name.
