# Interactive CLI: streaming generation, a review list, and opt-in bodies

Date: 2026-08-08
Status: approved, ready for an implementation plan

## Problem

The generation and review experience of `gc` is raw. Three specific complaints, plus one gap in the
development loop:

1. **The waiting state is ugly.** `src/cli.ts` writes `waiting for <model>... 12s` on a carriage
   return once a second. It reports elapsed time and nothing else: not what is being sent, not
   whether a retry happened, not whether the model has started answering. A halved input budget or a
   dropped structured-output path is invisible.
2. **The plan preview is a flat, monochrome dump.** `formatPlan` prints every subject, every body,
   and every path in one block, then hands the user a four-item `select`. Editing a message means
   navigating a second `select`, then a full `$EDITOR` round trip, then re-reading the whole dump.
3. **Every commit gets a body.** The prompt in `src/context.ts` says only "Bodies may be empty",
   which is far too weak an instruction, and `commitPlanSchema` marks `body` as required. Models
   answer the way they are asked, so they write a body every time.
4. **There is no way to exercise the CLI without making commits.** Testing a UI change today means
   staging real work in a real repository, running the real binary, and either committing or
   discarding. That loop is too slow to iterate on a terminal interface and it burns tokens on every
   pass.

## Goals

- Replace the ticker with a colored spinner that reports the current phase, the model, and retries.
- Stream commit subjects as the model writes them. Subjects only, never bodies.
- Replace the flat preview plus `select` loop with a single interactive list: colored, navigable,
  editable in place, with a per-commit expanded view.
- Make bodies opt-in. Default to no bodies at all, with the user requesting one per commit.
- Add a demo harness that runs the real pipeline against fixture data using the user's real profile,
  and never creates a commit.

## Non-goals

- No change to how the plan is generated, validated, or committed. `generateCommitPlan`'s retry
  state machine, `validatePlan`, `validateGroupPlan`, and `createCommits` keep their current
  behavior apart from the specific edits named below.
- No new runtime dependency beyond promoting `@inquirer/core` from transitive to direct.
- No color library. `node:util` `styleText` covers every case.
- No mouse support, no scrolling viewport for very long plans. A plan with more commits than the
  terminal has rows simply overflows, as the current preview does.

## Module layout

`src/cli.ts` is reduced to argument parsing and `run()` orchestration. `formatPlan` and `reviewPlan`
move out and are replaced. Three new files:

| File | Responsibility | Depends on | Approx. size |
| --- | --- | --- | --- |
| `src/terminal.ts` | Color helpers and the generation spinner. The only module that writes raw escape sequences during generation. | `node:util` | 110 lines |
| `src/textarea.ts` | A pure text buffer: content, cursor position, and the key handlers that mutate them. No I/O, no ANSI. | none | 130 lines |
| `src/review.ts` | The review list. A pure `reduce(state, key)` and `render(state, width)`, wrapped in a thin `@inquirer/core` prompt. | `src/textarea.ts`, `src/terminal.ts`, `@inquirer/core` | 320 lines |

The pure `reduce`/`render` split in `src/review.ts` is the central testability decision. Every
interaction is a plain function call returning a plain value, so the entire list is testable with
`node:test` assertions and no pseudo-terminal. The `@inquirer/core` wrapper contains no logic beyond
translating key events into `reduce` calls and writing `render`'s output.

### Dependencies

Add `@inquirer/core` (currently `11.2.1`) as a direct dependency. It is already resolved in the
lockfile as a child of `@inquirer/prompts`, so no new package is downloaded. It supplies
`createPrompt`, `useState`, `useKeypress`, `useEffect`, and the terminal cleanup that a hand-rolled
raw-mode prompt would otherwise have to reimplement.

`@inquirer/external-editor` is likewise already present, via `@inquirer/editor`. It backs `ctrl+e`.

## Section 1: generation feedback

### Progress events

`generateCommitPlan` gains one optional input:

```ts
export type PlanEvent =
  | { type: "phase"; label: string }
  | { type: "subject"; index: number; text: string }
  | { type: "retry"; attempt: number; reason: string };

export interface GenerateCommitPlanInput {
  // ...existing fields unchanged...
  onProgress?: (event: PlanEvent) => void;
}
```

`onProgress` is optional and synchronous. When absent, `generateCommitPlan` behaves exactly as it
does today, which keeps the existing tests in `test/ai.test.ts` valid and keeps the function usable
from a non-interactive context.

Events are emitted from the points that already exist in the retry loop:

- `phase` when the request is about to be sent (`waiting for <model>`), and when the first token
  arrives (`writing plan`).
- `retry` from each `continue` branch in the failure switch, carrying the reason already computed
  for `failureReason` (structured output refused, input budget halved, output ceiling halved,
  invalid output, transient).
- `subject` from the streaming reader, described next.

`run()` in `src/cli.ts` emits its own `phase` events for the steps that happen before
`generateCommitPlan` is called: `reading staged changes` around `readRepository`, and
`building context` around `discoverContext`.

### Streaming

`callModel` moves from `generateText` to `streamText`. The two output paths already present in that
function stay, and each gets its own reader:

- **Schema path** (`structured === true`): iterate `result.partialOutputStream`. The AI SDK
  normalizes both OpenAI JSON deltas and Anthropic tool-input deltas into the same growing partial
  object, so `partial.commits?.[i]?.subject` is read directly and emitted as a `subject` event when
  it differs from the last value seen for that index. The final value is taken from the resolved
  output as today, so validation is unchanged.
- **Plain-text path** (`structured === false`): iterate `result.textStream`, accumulating into the
  same buffer that `extractJsonObject` already consumes at the end. Subjects are pulled from the
  growing buffer with a single regular expression:

  ```ts
  /"subject"\s*:\s*"((?:[^"\\]|\\.)*)/g
  ```

  The last match is deliberately allowed to be unterminated, which is exactly what a subject
  mid-write looks like. Captured text is JSON-unescaped on a best-effort basis; a malformed escape
  is left as-is rather than throwing, because this value is only ever displayed.

`finishReason === "length"` handling, the `NoObjectGeneratedError` salvage, `maxRetries: 0`, and the
`AbortSignal.timeout` all carry over unchanged.

**Risk.** `callModel` is the single function every provider path runs through, so this is the
riskiest edit in the set. If `partialOutputStream` proves unreliable for a given provider, the
plain-text regex reader works against `textStream` in the schema path too and is the documented
fallback. Streaming is a presentation feature: if the stream yields nothing, the spinner simply
shows no subjects and the plan still arrives.

### Rendering

`src/terminal.ts` exports a spinner that owns its own interval and its own region of `stderr`:

```
⠹ claude-sonnet-4-5 · writing plan · 12s

  1  feat(cli): stream commit subjects while generat▌
  2  fix(git): keep rename pairs in one batch
```

- Frames are the ten braille characters `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at 80 ms, colored cyan.
- The model name is default weight. The phase and the elapsed seconds are dim.
- Subjects are indented and numbered. Only the subject streams; bodies never appear here.
- A `retry` event prints a dim line above the spinner and is left in the scrollback, so a halved
  budget is visible after the fact rather than being overwritten.
- The spinner region is cleared on completion, exactly as the current ticker clears its line.

**Non-TTY and NO_COLOR.** When `process.stderr.isTTY` is false, or `process.env.NO_COLOR` is set to
any value, the spinner degrades to one plain line per `phase` and per `retry` event, with no escape
sequences and no color. `subject` events are dropped in this mode, since redrawing is what makes
them meaningful. `styleText` is called through a single wrapper in `src/terminal.ts` that returns
the input unchanged when color is disabled, so no call site needs a conditional.

## Section 2: the review list

### Layout, collapsed

```
  3 commits · 12 files

❯ feat(cli): stream commit subjects while generating
    src/cli.ts  src/ai.ts  src/terminal.ts

  fix(git): keep rename pairs in one batch                       ¶ 3 lines
    src/git.ts

  chore(deps): bump oxlint to 1.77.0
    package.json  pnpm-lock.yaml  +9 more

  ↑↓ move · space expand · e subject · ctrl+e editor · r regen · ↵ commit · q cancel
```

- The header counts commits and files. A fallback plan additionally prints the existing red banner
  and its `failureReason`; the `notice` line from `CommitPlan` prints dim below the header.
- A collapsed row shows the subject, a `¶ N lines` marker on the right when a body exists, and at
  most three file paths followed by `+N more`.
- The selected row is bold with a cyan `❯`.

### Layout, expanded

Exactly one row can be expanded at a time. Expanding a row collapses any other.

Body present:

```
❯ fix(git): keep rename pairs in one batch
  │ Rename detection is scoped to a single git diff invocation, so
  │ splitting a pair across batches loses the pairing.
    src/git.ts

  space collapse · i edit body · g generate body · x drop body · ctrl+e editor
```

No body:

```
❯ feat(cli): stream commit subjects while generating
  │ No body for this commit
    src/cli.ts  src/ai.ts  src/terminal.ts

  space collapse · i write body · g generate body · ctrl+e editor
```

Expanding also reveals the complete file list, replacing the `+N more` elision. The body is dim and
carries a `│` gutter, soft-wrapped to the terminal width. The hint line is contextual: `x` appears
only when a body exists, and `i` reads `write body` rather than `edit body` when there is none.

### Keys

Body actions are modal. They exist only while a row is expanded, which is what keeps the collapsed
list short.

| Key | Scope | Action |
| --- | --- | --- |
| `↑` `↓` `j` `k` | always | Move the selection. Moving collapses the expanded row. |
| `space` | always | Toggle the expanded view on the selected row |
| `e` | always | Edit the subject in place |
| `ctrl+e` | always | Open subject and body together in `$EDITOR` |
| `r` | always | Regenerate the whole plan |
| `↵` | always | Accept the plan and commit |
| `q` `esc` | always | Cancel without committing |
| `i` | expanded | Edit the body in place. Opens empty when there is no body. |
| `g` | expanded | Ask the model to write a body for this commit |
| `x` | expanded | Drop the body. Shown only when a body exists. |
| `esc` | generating | Cancel the running body generation. Takes priority over cancelling the review. |

`ctrl+c` cancels, as `@inquirer/core` already arranges.

`esc` is modal. While any body generation is in flight it aborts that request and nothing else. It
returns to meaning "cancel the review" only once no generation is running. `q` always cancels the
review, so there is an unambiguous way out either way.

### Color

Color carries meaning and nothing else.

- The Conventional Commit type prefix is colored by type: `feat` green, `fix` yellow, `docs` blue,
  any other recognized type magenta. A subject that does not match `type(scope):` is printed plain,
  with no attempt to guess.
- The scope, the file paths, the `¶ N lines` marker, and the body are dim.
- The fallback banner and inline errors are red.
- The selection marker is cyan.

### Editing in place

Both editors are backed by `src/textarea.ts`, which holds text, a cursor offset, and pure handlers
for insert, backspace, delete, and the arrow, home, and end keys. `render` in `src/review.ts` maps
that offset to a screen position after soft-wrapping.

**Subject (`e`).** Single line. `↵` saves, `esc` cancels. An empty or whitespace-only subject is
refused inline: a red hint appears and the editor stays open. This replaces the current behavior in
`reviewPlan`, which throws and aborts the whole run.

**Body (`i`).** Multi-line box. `↵` inserts a newline, `ctrl+d` saves, `esc` cancels. `ctrl+e` from
inside the box hands the current text to `$EDITOR` and reads the result back.

```
❯ fix(git): keep rename pairs in one batch
  ┌─ body ──────────────────────────────────┐
  │ Rename detection is scoped to a single  │
  │ git diff invocation, so splitting a     │
  │ pair across batches loses the pairing.▌ │
  └─ ↵ newline  ctrl+d save  esc cancel  ───┘
    src/git.ts
```

**Cost note.** The multi-line editor is the largest single piece of new code, roughly 130 lines of
cursor arithmetic across soft-wrapped lines. `ctrl+e` is the release valve: the in-place box only has
to be good at short bodies, and anything longer belongs in a real editor. This is a deliberate
ceiling and should carry a `ponytail:` comment naming it.

### Generating one body (`g`)

A new export in `src/ai.ts`:

```ts
export async function generateCommitBody(input: {
  profile: Profile;
  commit: ProposedCommit;
  files: StagedFile[];        // only the files belonging to this commit
  context: RepositoryContext;
  instructions?: string;
  signal?: AbortSignal;
}): Promise<string>;
```

- One request. The prompt carries the repository instructions, the commit's subject, and the
  evidence for that commit's files only, built with the existing `buildEvidence`. It asks for a
  plain-text body, not JSON, so there is no schema and no `extractJsonObject`.
- It reuses `modelFor`, `classifyFailure`, and `REQUEST_TIMEOUT_MS`. It does not reuse the retry
  state machine: one attempt, and a failure is reported rather than retried. The user can press `g`
  again.
- While it runs, the row shows its own inline spinner and the hint line states how to stop it. The
  rest of the list stays navigable and readable. Keys that would mutate that row (`i`, `g`, `x`,
  `e`, `ctrl+e`) are ignored until it settles; `↵` is also ignored, so a plan is never committed
  mid-generation.

  ```
  ❯ fix(git): keep rename pairs in one batch
    ⠹ writing body · 3s
      src/git.ts

    space collapse · esc cancel generation · ctrl+e editor
  ```

- `esc` aborts it. The `signal` passed to `generateCommitBody` is triggered, the row returns to its
  previous state, and no error is reported: the user asked for this. The abort is reachable from
  anywhere in the list, including after collapsing or moving away, since the hint line names it
  wherever the affected row is visible and `esc` is captured globally while a generation is in
  flight.
- On failure, a red single-line message appears on the row. Nothing else changes.
- Collapsing or moving away does not cancel the request. The result lands on the row when it
  arrives. Only `esc` cancels it.

## Section 3: opt-in bodies

### The setting

A new key, `body`, with three values:

| Value | Meaning | Prompt instruction |
| --- | --- | --- |
| `manual` | Default. No bodies are generated. | Leave every body empty. The user will request bodies where they are wanted. |
| `auto` | A body only where it earns its place. | Write a body only when the subject cannot carry the change. Most commits need none. |
| `always` | Every commit gets a body. | Every commit must have a body. |

Resolution order, later winning: user config, then `.gc.yaml`, then `--body <mode>` on the command
line. This mirrors how `split` already resolves through `mergeConfig`.

### Enforcement

`manual` is guaranteed twice, deliberately.

1. The prompt asks for empty bodies. This saves output tokens and removes the temptation.
2. `validatePlan` and `validateGroupPlan` clear `body` to `""` when the mode is `manual`, whatever
   the model returned.

The second is what makes the setting true rather than merely requested. It costs about four lines.

The schema is not changed. `body` stays a required key in both `commitPlanSchema` and
`groupPlanSchema`, and `assertCommitShape` keeps requiring a string. Adding schema variants for each
mode would multiply an already conditional code path for no behavioral gain.

### Configuration changes

- `src/config.ts`: `body` is added to the **optional** key set for both `Config` and `ProjectConfig`,
  never to the required set. Every configuration file that exists today keeps validating and
  defaults to `manual`. A value outside the three names is a validation error naming the three.
- `mergeConfig` resolves `body` the same way it resolves `split`: overridden, not merged.
- `body` is permitted in `.gc.yaml`. It is not a credential and belongs in `forbiddenProjectKeys`
  no more than `split` does.
- `gc init` asks for it, with `manual` as the default answer.
- `src/cli.ts` gains `--body <mode>`, validated against the three names at parse time.

### Prompt changes

The line `Fallback convention: Conventional Commits. Subject lines must be concise. Bodies may be
empty.` in `buildPrompt` is split. The Conventional Commits sentence stays. The body sentence is
replaced by the mode's instruction from the table above, passed in as a new `body` field on
`buildPrompt`'s input.

## Section 4: the demo harness

`scripts/demo.ts`, run through a new `demo` script in `package.json`. It is not published:
`files: ["dist"]` already excludes it.

```
pnpm demo                    # real profile, real request, fixture "mixed"
pnpm demo --fixture rename   # a different scenario
pnpm demo --offline          # canned plan, no network, instant
pnpm demo --offline --slow   # canned plan, streaming simulated over ~2s
pnpm demo --body always      # any real flag passes through
```

### Fixtures

`test/fixtures/staged/<name>.diff` and `test/fixtures/staged/<name>.names` hold real Git output.
Making a new one is two commands against any repository with staged changes:

```sh
git -c core.quotePath=false diff --cached --find-renames --no-ext-diff > test/fixtures/staged/x.diff
git diff --cached --name-status -z --find-renames > test/fixtures/staged/x.names
```

Four scenarios ship: `single` (one file), `mixed` (twelve files across three unrelated concerns),
`lockfile` (a large generated file that content reduction must handle), and `rename` (a rename pair
that must stay together).

To consume them, `readRepository` is split:

```ts
export function parseRepository(
  diff: Buffer, names: Buffer, history: string[], retainBudgetBytes?: number
): RepositoryChanges;

export async function readRepository(cwd, stageAll, retainBudgetBytes): Promise<RepositoryChanges>;
```

`parseRepository` holds the body of the current function from the parser construction onward.
`readRepository` becomes the `spawn` wrapper that feeds it. This is roughly twenty lines moved, and
it makes `git.ts` directly testable for the first time.

The one behavioral difference is that `parseRepository` takes the diff as a single buffer rather
than as a stream. That is correct for fixtures, which are bounded and already on disk, and
`readRepository` keeps streaming for real repositories, where the bound matters.

### Modes

- **Default.** Reads the user's real config with `readConfig()` and uses the active profile. Runs
  `discoverContext` against this repository. Calls `generateCommitPlan` for real, with real
  streaming into the real spinner. Ends at the real review list.
- **`--offline`.** No network at all. `generateCommitPlan`'s existing `generate` injection point
  takes a function returning a canned plan, so the retry loop, validation, and grouping all still
  run. With `--slow`, the harness also drives `onProgress` itself, emitting `subject` events
  character by character over about two seconds so the streaming display can be exercised without a
  provider. Offline mode does not require a configured profile.

### Safety

`createCommits` is never called. The harness substitutes a stub that prints the `git commit`
invocations it would have run:

```
would run: git commit -m "feat(cli): stream commit subjects while generating"
would run: git commit -m "fix(git): keep rename pairs in one batch" -m "Rename detection is..."
```

Nothing is staged, nothing is committed, and no configuration file is written. The harness never
calls `writeConfig`.

### Node version

`scripts/demo.ts` relies on native TypeScript stripping, so it needs the repository's development
Node version (26). The published package is unaffected: it ships compiled `dist/index.mjs` and keeps
its `>=22.13.0` floor.

## Section 5: testing

All tests use `node:test`. No test makes a live provider call, per the repository instructions.

| Module | What is tested |
| --- | --- |
| `src/textarea.ts` | Insert, backspace, delete, arrow, home, and end, as a pure state machine. Multi-byte characters are not split. |
| `src/review.ts` | `reduce` key by key: navigation, expand and collapse, that `i`, `g`, and `x` are ignored while collapsed, that `x` is ignored with no body, that mutating keys are ignored while a body is generating, that `esc` aborts a running generation instead of cancelling the review, and that `esc` cancels the review once none is running. `render` output for the collapsed, expanded-with-body, expanded-without-body, and generating states at a fixed width. |
| `src/terminal.ts` | `NO_COLOR` and a non-TTY `stderr` both produce plain text with no escape sequences. Frame selection advances. |
| `src/ai.ts` | Subjects extracted from a fake partial stream, in both the schema and the plain-text readers. `manual` clears bodies in `validatePlan` and `validateGroupPlan`. `generateCommitBody` against a local server double. |
| `src/config.ts` | `body` defaults to `manual` when absent, rejects an unknown value, is accepted in `.gc.yaml`, and is overridden rather than merged. |
| `src/git.ts` | `parseRepository` against each fixture, including the rename pair and the reduced lockfile. |
| `src/cli.ts` | `--body <mode>` parsing and its rejection of an unknown value. |

The existing `test/cli.test.ts` case `edits one message then returns to the full review` is removed
along with `formatPlan` and `reviewPlan`. Its coverage moves to the `src/review.ts` `reduce` tests.

## Documentation

`README.md` needs three edits:

- The **Review flow** section is rewritten around the list, its keys, and the expanded view.
- A new subsection under **Profiles and configuration** documents `body` and its three modes.
- The sentence "While waiting, `gc` prints elapsed time to the terminal" in **When the provider
  fails** is updated to describe the spinner, the streamed subjects, and the visible retry lines.

`CLAUDE.md` gains `pnpm demo` in its command list.

## Risks

1. **`callModel` is on every provider path.** Moving it to `streamText` is the riskiest edit here.
   Mitigated by keeping the surrounding retry state machine untouched, by having a documented
   fallback reader, and by treating streaming as presentation only: a stream that yields nothing
   still produces a plan.
2. **`partialOutputStream` behavior differs by provider.** Verified against Anthropic and OpenAI
   during implementation. The plain-text regex reader is the fallback for either.
3. **The multi-line editor is the largest new surface.** Bounded by `ctrl+e`, tested as a pure state
   machine, and marked with a `ponytail:` comment naming the ceiling.
4. **`parseRepository` buffers the whole diff.** Only used by fixtures and tests. `readRepository`
   keeps streaming for real repositories.
