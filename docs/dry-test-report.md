# Dry test report: staged-change scale matrix

Date: 2026-08-06
Branch: `feat/scale-commit-context`
Provider under test: active profile `ds4` (`compatible`, `https://api.deepseek.com`, `deepseek-v4-flash`), `split: true`, default `maxInputTokens` (32,000).

## What was tested

Sixteen synthetic repositories were generated, each with a real seed history and a real staged index, then driven through the exact pipeline `gc` uses:

`readRepository` -> `discoverContext` -> `mergeConfig` -> `generateCommitPlan`

The run stops before `createCommits`, so nothing is ever committed. Each scenario asserts afterwards that `HEAD` did not move and that `git diff --cached --name-status -z --find-renames` still reports the same number of staged entries.

Plans are audited by an independent checker rather than by `validatePlan`, so a defect in `gc`'s own validation cannot hide itself: every staged path must appear exactly once, no invented paths, rename pairs in the same commit, non-empty subject, and exactly one commit when splitting is disabled.

The matrix crosses file count (1, 5-7, 60, 600, 4000) with file size (small ~360 B, large ~150 KB, huge ~8 MB) and adds the awkward shapes: binaries, lockfiles, minified bundles, renames, deletions, `--no-split`, and `--instructions` with `AGENTS.md`/`CONTEXT.md` present.

## Headline result

**Before the fix: the local machinery is correct in all sixteen shapes, but the provider integration is broken. 14 of 16 runs never got a usable plan from the model and silently degraded to the local fallback commit.**

**After the fix: 32 of 32 across two full runs, zero fallbacks.** See "The fix, and results after it" below.

A fallback plan is not an error the user sees as a failure. It is a single `chore: update N files` commit, shown with a `!` banner. So `gc` "worked" in the sense that it never crashed and never corrupted the index, but with this provider it was not actually generating commit messages: it was generating `chore: update N files` and asking you to edit it.

## Results: the system as originally configured

`read` is `readRepository` wall time. `plan` is `generateCommitPlan` wall time. `Outcome` is `model` when the provider produced a valid plan, `fallback` when `gc` built the plan locally.

| #   | Scenario                                 | Files | Total diff | read   | Evidence tiering               | plan   | Outcome   | Audit |
| --- | ---------------------------------------- | ----- | ---------- | ------ | ------------------------------ | ------ | --------- | ----- |
| 1   | single-small                             | 1     | 362 B      | 24 ms  | 1 full                         | 30.4 s | fallback  | pass  |
| 2   | single-large                             | 1     | 307.5 KB   | 22 ms  | 1 excerpt                      | 30.3 s | fallback  | pass  |
| 3   | single-huge                              | 1     | 17.5 MB    | 83 ms  | 1 excerpt                      | 37.5 s | fallback  | pass  |
| 4   | few-small                                | 5     | 1.7 KB     | 24 ms  | 5 full                         | 30.3 s | fallback  | pass  |
| 5   | few-large                                | 5     | 1.5 MB     | 28 ms  | 5 excerpts                     | 30.3 s | fallback  | pass  |
| 6   | few-mixed (+binary, +lockfile)           | 6     | 368.9 KB   | 26 ms  | 3 full, 2 excerpts, 1 stats    | 30.3 s | fallback  | pass  |
| 7   | many-small                               | 60    | 21.3 KB    | 25 ms  | 60 full                        | 30.4 s | fallback  | pass  |
| 8   | many-large                               | 60    | 18.9 MB    | 85 ms  | 20 excerpts, 40 stats          | 30.4 s | fallback  | pass  |
| 9   | many-mixed (+binary, lockfile, minified) | 60    | 3.9 MB     | 37 ms  | 41 full, 10 excerpts, 9 stats  | 60.0 s | fallback  | pass  |
| 10  | vmany-small                              | 600   | 214.9 KB   | 42 ms  | 102 full, 498 stats            | 30.6 s | fallback  | pass  |
| 11  | vmany-mixed                              | 600   | 9.6 MB     | 75 ms  | 42 full, 558 stats             | 30.4 s | fallback  | pass  |
| 12  | xmany-small                              | 4000  | 1.6 MB     | 123 ms | 258 excerpts, 3742 in 1 group  | 46.6 s | **model** | pass  |
| 13  | xmany-mixed                              | 4000  | 14.2 MB    | 137 ms | 257 excerpts, 3743 in 3 groups | 30.5 s | fallback  | pass  |
| 14  | realistic-edits (rename, delete, modify) | 7     | 1.9 KB     | 22 ms  | 5 full, 1 excerpt              | 30.3 s | fallback  | pass  |
| 15  | nosplit-many-mixed (`--no-split`)        | 60    | 3.9 MB     | 37 ms  | 41 full, 10 excerpts, 9 stats  | 51.2 s | **model** | pass  |
| 16  | instructions-agents-md (`-i`, AGENTS.md) | 6     | 1.9 KB     | 25 ms  | 6 full                         | 30.4 s | fallback  | pass  |

Success rate against the configured provider: **2 / 16**.

Note the plan latencies cluster on exact multiples of 30 s (`30.3`, `30.4`, `60.0`). That is `REQUEST_TIMEOUT_MS` firing, not the model thinking.

## Results: local machinery in isolation

The same sixteen scenarios re-run with the provider replaced by a stub that always answers correctly. This isolates `gc`'s own diff streaming, byte budgeting, tiering, grouping, validation and group expansion.

| #   | Scenario               | Files | read   | plan  | Commits | Group mode | Audit |
| --- | ---------------------- | ----- | ------ | ----- | ------- | ---------- | ----- |
| 1   | single-small           | 1     | 24 ms  | 2 ms  | 1       | no         | pass  |
| 2   | single-large           | 1     | 22 ms  | 0 ms  | 1       | no         | pass  |
| 3   | single-huge            | 1     | 81 ms  | 0 ms  | 1       | no         | pass  |
| 4   | few-small              | 5     | 21 ms  | 0 ms  | 2       | no         | pass  |
| 5   | few-large              | 5     | 26 ms  | 0 ms  | 2       | no         | pass  |
| 6   | few-mixed              | 6     | 23 ms  | 0 ms  | 2       | no         | pass  |
| 7   | many-small             | 60    | 25 ms  | 1 ms  | 2       | no         | pass  |
| 8   | many-large             | 60    | 83 ms  | 1 ms  | 2       | no         | pass  |
| 9   | many-mixed             | 60    | 35 ms  | 1 ms  | 2       | no         | pass  |
| 10  | vmany-small            | 600   | 41 ms  | 5 ms  | 2       | yes        | pass  |
| 11  | vmany-mixed            | 600   | 75 ms  | 6 ms  | 2       | yes        | pass  |
| 12  | xmany-small            | 4000  | 107 ms | 23 ms | 1       | yes        | pass  |
| 13  | xmany-mixed            | 4000  | 127 ms | 24 ms | 2       | yes        | pass  |
| 14  | realistic-edits        | 7     | 24 ms  | 0 ms  | 2       | no         | pass  |
| 15  | nosplit-many-mixed     | 60    | 36 ms  | 0 ms  | 1       | no         | pass  |
| 16  | instructions-agents-md | 6     | 22 ms  | 0 ms  | 2       | no         | pass  |

**16 / 16 pass.** No unassigned path, no duplicated path, no invented path, no rename split across commits, `--no-split` honoured, `HEAD` unmoved, index untouched.

The scale work on this branch does what it claims:

- 17.5 MB in one file is read in 83 ms; 18.9 MB across 60 files in 85 ms; 4000 files in 137 ms. Retention is bounded by `retainBudget`, so the cost is I/O, not diff size.
- Tiering degrades in the right order. At 60 large files the budget buys 20 excerpts and stats for the rest; at 600 files it switches to per-file stats; at 4000 files it aggregates into directory groups and still reports every path.
- Group mode engages exactly where predicted (600+ paths), and group ids expand back to exact paths locally without loss.

## Root cause of the provider failures

Three independent defects, verified against the live endpoint.

### 1. The JSON shape is never communicated to the model

`gc` relies on provider-side schema enforcement via `Output.object({ schema })`. That enforcement never reaches the wire.
`modelFor` builds the compatible provider without `supportsStructuredOutputs`, so the AI SDK sends
`response_format: {type: "json_object"}` and **silently drops the schema**, warning:

```
AI SDK Warning (compatible.chat / deepseek-v4-flash): The feature "responseFormat" is not
supported. JSON response format schema is only supported with structuredOutputs
```

Sending the schema would not have helped either: DeepSeek rejects it outright.

```
POST /chat/completions  response_format: {type: "json_schema", ...}
-> 400  "This response_format type is unavailable now"
```

`json_object` guarantees only that the output parses as JSON, not its shape. The prompt built by `buildPrompt` never states the shape, and the non-structured retry only appends `Return JSON only, matching the required schema.` while never including that schema. The model invents its own keys:

```json
{ "commits": [{ "message": "feat(handler): add payload handler", "files": ["src/handler.ts"] }] }
```

`message` instead of `subject` + `body`, so `validatePlan` rejects it. On retry the validation error text pushes it further off-shape, in one observed case to a bare top-level array:

```json
[{ "subject": "feat(handler): add payload handler", "body": "Introduce handler that ..." }]
```

Three attempts, three rejections, fallback.

### 2. `MAX_OUTPUT_TOKENS = 4096` is consumed entirely by reasoning tokens

`deepseek-v4-flash` is a reasoning model, and its reasoning tokens count against the same output budget. The dominant failure mode is a response with **zero content**:

```
attempt: 35894ms finish=length reasoning=4096 textLen=0
attempt: 34418ms finish=length reasoning=4096 textLen=0
```

`JSON.parse("")` throws, and a throw on the non-structured path returns the fallback immediately with no retry. Observed reasoning-token counts on successful calls ranged from 384 to 13,763 for prompts that are otherwise trivial.

### 3. `REQUEST_TIMEOUT_MS = 30_000` is far below this model's latency

Successful calls in this test took 5 s to 115 s. A 30 s deadline turns the majority into timeouts, which is why so many rows land on exactly 30.3 s.

### Incidental: behaviour depends on whether a staged path contains the word "json"

DeepSeek rejects `json_object` mode unless the literal word "json" appears in the prompt:

```
400  "Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'."
```

`buildPrompt` never emits that word. It appears only by accident, when a staged path happens to be `package.json`. Scenarios 9 and 15 stage `package.json` and reached the model; scenario 6, an otherwise similar mixed set without it, was rejected in 370 ms. Staging an unrelated file therefore changes which code path runs.

### Incidental: the retry policy is inverted

In `generateCommitPlan`, a **validation** failure retries up to three times, but a **transport** failure on the non-structured path returns the fallback immediately. Transient failures are the ones worth retrying; a model that returned the wrong shape once will usually return it again.

## Verification that these are the causes

The same scenarios were re-run with only two changes: the required JSON shape written into the prompt text, and `maxOutputTokens` raised to 16,384.

| Scenario               | Files | Attempts | Outcome                   | Commits produced |
| ---------------------- | ----- | -------- | ------------------------- | ---------------- |
| single-small           | 1     | 1        | model, 5.1 s              | 1                |
| few-mixed              | 6     | 1        | model, 114.9 s            | 5                |
| many-mixed             | 60    | 1        | fallback (exceeded 120 s) | -                |
| vmany-small            | 600   | 1        | model, 52.0 s             | 3                |
| xmany-mixed            | 4000  | 1        | model, 29.4 s             | 3                |
| realistic-edits        | 7     | 1        | fallback (exceeded 120 s) | -                |
| instructions-agents-md | 6     | 1        | model, 12.1 s             | 2                |

**5 / 7 succeed on the first attempt**, versus 2 / 16 before. The two remaining failures are pure latency, not shape errors. The plans are also good rather than merely valid:

- `few-mixed` split six files into five coherent commits, attaching the lockfile and the binary separately from the cache feature.
- `xmany-mixed` assigned all three directory groups across 4000 files correctly, and group ids expanded back to exact paths.
- `instructions-agents-md` honoured `--instructions` exactly: `GC-42 docs(repo): add agent and context docs`, `GC-42 feat(webhook): add step handlers`.

## The fix, and results after it

All of the above was then implemented. The changes, all in `src/`:

- `context.ts`: `buildPrompt` always ends with an explicit response contract naming `subject`, `body`, and `files` or `groups`, and forbidding `message`, `title`, and `description`. It carries the literal word "json", so `json_object` mode no longer depends on which files happen to be staged.
- `ai.ts`: `MAX_OUTPUT_TOKENS` becomes `DEFAULT_MAX_OUTPUT_TOKENS = 16,384`, decoupled from the input budget. The old `Math.min(4096, floor(budgetTokens / 4))` capped the request at 8,000 even if the constant were raised, so raising the constant alone would not have worked. Only a quarter of the ceiling is budgeted for the plan text; the rest is reasoning headroom, which keeps the group-mode threshold exactly where it was.
- `ai.ts`: one retry state machine replaces the previous split policy. Failures are classified by what they say to change: `input-limit` halves the input budget, `output-limit` halves the output budget, `response-format` drops to plain JSON for the rest of the run, `length` and `invalid-output` return the specific problem to the model, `transient` repeats the request unchanged, and `fatal` (bad key, unknown model) throws instead of hiding behind a local plan. Bounded by 4 network calls, 2 content failures, and a 180 s overall deadline.
- `ai.ts`: `extractJsonObject` recovers a plan from fenced, prefixed, or suffixed replies by scanning for the first balanced object that parses, rather than taking the outermost braces. `NoObjectGeneratedError.text` is salvaged locally instead of spending another request.
- `ai.ts`: `maxRetries: 0` on the SDK call, so its blind retries do not multiply the outer state machine.
- `providers.ts`, `config.ts`: `maxOutputTokens` is a validated, round-tripped profile option.
- `cli.ts`: elapsed time is printed to a terminal while waiting, and a fallback now prints why the provider was given up on.

Timeouts move from 30 s to 120 s per request. Note that this turned out to matter least: stating the contract removed most of the latency rather than merely tolerating it. With the shape ambiguous the model burned up to 13,763 reasoning tokens deliberating; with it stated, the same request used ~300 and answered in 3 to 5 seconds.

The full sixteen-scenario matrix was then re-run twice end to end against the same DeepSeek profile.

| #   | Scenario               | Files | Run 1         | Run 2         | Commits (run 1) | Audit |
| --- | ---------------------- | ----- | ------------- | ------------- | --------------- | ----- |
| 1   | single-small           | 1     | model, 10.0 s | model, 8.5 s  | 1               | pass  |
| 2   | single-large           | 1     | model, 4.5 s  | model, 8.0 s  | 1               | pass  |
| 3   | single-huge            | 1     | model, 8.4 s  | model, 7.4 s  | 1               | pass  |
| 4   | few-small              | 5     | model, 8.5 s  | model, 11.7 s | 4               | pass  |
| 5   | few-large              | 5     | model, 9.3 s  | model, 5.1 s  | 1               | pass  |
| 6   | few-mixed              | 6     | model, 41.2 s | model, 33.2 s | 3               | pass  |
| 7   | many-small             | 60    | model, 21.1 s | model, 32.6 s | 3               | pass  |
| 8   | many-large             | 60    | model, 13.3 s | model, 11.2 s | 1               | pass  |
| 9   | many-mixed             | 60    | model, 42.6 s | model, 86.0 s | 4               | pass  |
| 10  | vmany-small            | 600   | model, 18.9 s | model, 15.8 s | 3               | pass  |
| 11  | vmany-mixed            | 600   | model, 32.2 s | model, 27.6 s | 2               | pass  |
| 12  | xmany-small            | 4000  | model, 10.1 s | model, 8.3 s  | 1               | pass  |
| 13  | xmany-mixed            | 4000  | model, 31.0 s | model, 59.6 s | 2               | pass  |
| 14  | realistic-edits        | 7     | model, 24.5 s | model, 46.9 s | 5               | pass  |
| 15  | nosplit-many-mixed     | 60    | model, 9.9 s  | model, 12.1 s | 1               | pass  |
| 16  | instructions-agents-md | 6     | model, 19.0 s | model, 8.5 s  | 2               | pass  |

**32 / 32, zero fallbacks**, against 2 / 16 before. Every plan passed the independent audit: exact path partition, renames intact, `--no-split` honoured, index untouched.

The plans are substantive, not merely well-formed. `realistic-edits` returned five commits that read the diff correctly:

```
refactor(core): rename legacy handler
feat(core): add handler10
chore(core): add patched export
fix(data): correct record id
refactor(core): remove unused handler
```

The rename pair stayed in one commit, and `fix(data): correct record id` identified a single changed field inside a 150 KB file that was reduced to an excerpt. `instructions-agents-md` again honoured `--instructions` exactly. `many-mixed` grouped the manifest with its lockfile and kept assets separate.

The runs that took 40 to 86 seconds did so because the state machine retried and recovered, which is the intended behaviour rather than a cost paid on every run.

## Remaining known limitation

At 4000 files all under a common root (`xmany-small`), `buildGroups` rolls up to a single group, so splitting cannot happen regardless of what the model wants. This is correct in that it protects the output budget, but a floor on group count when splitting is enabled would be better. Left as is: it produces a valid single commit rather than a wrong one.

Codex reviewed the design and argued for going further, replacing both the files-mode and groups-mode schemas with a single unit-id contract where the model never echoes paths at all. That is a genuine improvement and would make rename integrity structural rather than validated, but the measured evidence says the failures were shape ambiguity, output budget, and timeout, all of which are now fixed with a smaller diff. It is worth doing if a future provider proves flakier than this one.

## Reproducing

The harness is not committed. It builds each fixture in a fresh `mkdtemp` repository, stages it, and calls the same functions `cli.ts` calls. It never invokes `createCommits`. Working repositories are left in the system temp directory and can be deleted freely.

One caveat found while writing the harness, worth knowing when auditing this code: `git diff --cached --name-only` collapses a rename to its destination path, while `gc` tracks both sides via `--name-status -z --find-renames`. Comparing those two counts directly produces a false "index was mutated" report on any scenario containing a rename.
