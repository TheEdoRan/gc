---
"@theedoran/gc": minor
---

Make commit planning succeed against providers that do not enforce a schema.

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

The output ceiling is 16,000 tokens by default and configurable per profile as `maxOutputTokens`. Reasoning models spend
an unreported share of the output budget before writing anything, and the previous 4,096 ceiling was routinely consumed
in full, returning nothing. The request deadline moves from 30 seconds to 120 seconds, with a 180 second limit on the
whole plan, and the CLI prints elapsed time while it waits.
