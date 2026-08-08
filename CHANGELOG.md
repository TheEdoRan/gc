# @theedoran/gc

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
