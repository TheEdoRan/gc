---
"@theedoran/gc": minor
---

Fit staged changes to a local budget so commit planning works at any scale.

`gc` now streams the staged diff instead of buffering it, fits it to a byte budget locally, and makes exactly one model
call regardless of diff size. Lockfiles, generated output, minified bundles and binaries are reduced to stats plus a
short excerpt rather than sent in full, and the model is asked to attach them to the commit that caused them. Reduction
rules come from built-in defaults plus `excludeContent` and `includeContent` in the user config and in a new
per-project `.gc.yaml`.

Profiles accept an optional `maxInputTokens` for models with a small context window. The default budget is 32,000 input
tokens, estimated at two UTF-8 bytes per token; a provider that rejects the request for length triggers one halved
retry. Requests now carry a 30 second deadline.

When there are too many staged paths for the model to list them back, `gc` groups them locally and asks the model to
name the groups instead. If the provider fails outright, `gc` produces a local fallback plan covering every staged path
so a commit can still be reviewed, edited, and made.

Removes recursive AI summarization of oversized diffs, along with the "repository context is too large" error.
