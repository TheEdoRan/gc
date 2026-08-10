# @theedoran/gc

## 0.3.1

### Patch Changes

- a7f6972: Commit and push in one keystroke. `⇧↵` in the review list creates the commits and then pushes the
  branch, setting the upstream to `origin` when the branch has none yet. The hint bar names it next to
  `↵ commit`.

  Telling `⇧↵` apart from `↵` needs the Kitty keyboard protocol, so the review turns it on while the
  list has the keys and off again for the two in-place editors, the external editor, and the way out.
  Under it `⇧↵`, `esc` and every `ctrl+key` arrive as escape codes Node has no rule for, so the review
  names them itself and raises `SIGINT` for `ctrl+c`. Terminals that do not speak the protocol ignore
  the request and `⇧↵` stays a plain commit.

## 0.3.0

### Minor Changes

- 1174010: Rework the review experience. Generation now shows a spinner with the model, the current phase and
  the elapsed time, streams each commit subject as it is written, and prints the reason for every
  retry. The plan preview is replaced by an interactive list that navigates, colours by Conventional
  Commit type, edits subjects and bodies in place, and expands one commit at a time.

  Commit bodies are now opt-in. The new `body` setting takes `manual` (the default, no bodies),
  `auto`, or `always`, and is read from the user config, `.gc.yaml`, or `--body`. Ask for a body on a
  single commit by expanding its row and pressing `g`, or write one yourself with `b`.

  Existing configuration files keep working unchanged and default to `manual`.

### Patch Changes

- 074051e: Bring commit bodies forward in the review list. A collapsed row now previews the first three lines
  of its body, marked with an ellipsis when there is more, instead of a line-count badge, so the list
  says what each commit explains without being expanded.

  The body editor opens with `b` from any row, collapsed or not, and expands that row on the way in.
  It replaces `i`, which only worked on an already expanded row. `g` and `x` still live in the
  expanded view.

  Leaving the body editor now saves. `esc` writes the body back to the commit and closes the box, and
  `ctrl+d` is no longer bound, so it deletes forward as readline does everywhere else. An unwanted
  line is deleted by hand rather than thrown away with a key.

  A lone `esc` is also read faster: readline waits half a second to tell it from an arrow key, which
  is now shortened to 50ms.

## 0.2.1

### Patch Changes

- 93183e6: Lower the supported Node.js floor to 22.13.0, since the CLI does not use any Node.js 26 API.

## 0.2.0

### Minor Changes

- 80da85a: Fit staged changes to a local budget so commit planning works at any scale.

  `gc` now streams the staged diff instead of buffering it, fits it to a byte budget locally, and makes exactly one model
  call regardless of diff size. Lockfiles, generated output, minified bundles and binaries are reduced to stats plus a
  short excerpt rather than sent in full, and the model is asked to attach them to the commit that caused them. Reduction
  rules come from built-in defaults plus `excludeContent` and `includeContent` in the user config and in a new
  per-project `.gc.yaml`.

  Profiles accept an optional `maxInputTokens` for models with a small context window. The default budget is 32,000 input
  tokens, estimated at two UTF-8 bytes per token; a provider that rejects the request for length triggers one halved
  retry.

  When there are too many staged paths for the model to list them back, `gc` groups them locally and asks the model to
  name the groups instead. If the provider fails outright, `gc` produces a local fallback plan covering every staged path
  so a commit can still be reviewed, edited, and made.

  Removes recursive AI summarization of oversized diffs, along with the "repository context is too large" error.

- 80da85a: Make commit planning succeed against providers that do not enforce a schema.

  `gc` relied on the provider to enforce the response schema. Many OpenAI-compatible endpoints accept the request, drop the
  schema, and answer in whatever shape they like, so the plan failed validation and `gc` fell back to a local
  `chore: update N files` message. Against a reasoning model this was the usual outcome rather than the exception.

  The required JSON shape is now stated in the prompt for every request, so the contract no longer depends on provider
  support. A schema is still requested where the provider offers one, and only a refusal to enforce a schema drops the run
  to plain JSON; a timeout or a rate limit no longer counts as evidence about schema support.

  Failures are now answered with the change that addresses them. An oversized prompt halves the input budget, a refused
  output ceiling halves the output budget, an unusable answer is returned to the model with the specific problem, and a
  timeout, rate limit, or dropped connection is retried instead of being surrendered on the first attempt. An unusable API
  key or model name now raises that error rather than hiding it behind a local plan, and a fallback reports why the
  provider was given up on.

  The output ceiling is 16,384 tokens by default and configurable per profile as `maxOutputTokens`. Reasoning models spend
  an unreported share of the output budget before writing anything, and the previous 4,096 ceiling was routinely consumed
  in full, returning nothing. The request deadline moves from 30 seconds to 120 seconds, with a 180 second limit on the
  whole plan, and the CLI prints elapsed time while it waits.

## 0.1.0

### Minor Changes

- 8d509af: Release the initial AI commit CLI.
