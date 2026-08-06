# gc

`gc` reviews staged changes, proposes one or more commit messages with AI, and creates the commits only after you
approve the complete plan.

## Requirements

- Node.js 26 or newer
- Git
- An OpenAI, Anthropic, or OpenAI-compatible API

## Install

```sh
npm install --global @theedoran/gc
gc init
```

`gc init` creates or updates a profile, activates it, and asks whether commit splitting should be enabled by default.
Setup includes provider, base URL, API key, and model selection. If the provider cannot list its models, you can enter a
model name manually.

## Usage

```text
gc [-a|--all] [-i|--instructions <text>] [--split|--no-split]
gc init
gc profile [name]
gc --help
gc --version
```

Plain `gc` considers only staged changes. `gc --all` first runs `git add -A`, including untracked files while respecting
`.gitignore`. Changes staged by `--all` remain staged if you cancel.

Use `--instructions` for invocation-specific guidance with the highest priority:

```sh
gc -i "Emphasize the migration impact"
```

Use `--split` or `--no-split` to override the configured default. Splits are whole-file groups. Rename pairs remain
together, and partially staged files keep their unstaged hunks.

## Review flow

Before changing Git history, `gc` shows every proposed message and file group. You can:

- approve and commit the plan;
- edit one message in your system editor, then return to the full preview;
- regenerate the complete plan; or
- cancel without creating a commit.

Every commit uses normal `git commit`, so existing hooks and signing configuration still apply. If a later commit in a
split plan fails, earlier successful commits remain and all uncommitted patches are restored to the index.

## Profiles and configuration

Run `gc profile` to select a profile interactively, or `gc profile <name>` to switch directly. Initializing or selecting a
profile makes it the default for future runs.

Configuration is stored in `config.yaml` under the native per-user configuration directory selected by
[`env-paths`](https://github.com/sindresorhus/env-paths). The directory is created with mode `0700` and the file with mode
`0600` where the operating system supports POSIX permissions.

API keys are stored as plaintext in that protected file and are never printed by `gc`. Compatible profiles may omit the
key when their endpoint does not require authentication.

## Repository context

`gc` uses the staged diff, affected paths, the latest 20 commit subjects, and applicable `AGENTS.md`, `CLAUDE.md`, and
`CONTEXT.md` files. `CONTEXT.md` provides project information. Invocation instructions and nearer repository instruction
files take priority over broader context and commit history.

The staged diff is read as a stream and fitted to a byte budget locally, so `gc` makes exactly one model call no matter
how large the change is. Files are granted full content smallest first. Anything that does not fit, along with
lockfiles, generated output, minified bundles and binaries, is reduced to its path, its added and deleted line counts,
and a short excerpt of its changed lines. Every staged path is always reported. The plan preview states what was
reduced.

Reduced files are still ordinary grouping candidates: `gc` asks the model to attach each one to the commit whose changes
caused it, so a lockfile normally rides along with the manifest change that produced it rather than forming its own
commit.

The default budget is 32,000 input tokens. Set `maxInputTokens` on a profile to lower it for a small local model, or
raise it up to that model's window. Since providers do not share a tokenizer, `gc` estimates two UTF-8 bytes per token,
which is conservative for unified diffs; if a provider still rejects the request for length, `gc` halves the budget and
retries once.

The answer has its own ceiling, 16,000 output tokens by default. It is much larger than a commit plan needs because
reasoning models spend an unreported share of it thinking before they write anything. Set `maxOutputTokens` on a profile
for a model that refuses a ceiling that high; `gc` also halves it and retries when a provider rejects it.

### When files are reduced

Content reduction is controlled by glob lists that merge in order: built-in defaults, then `excludeContent` in the user
config, then `excludeContent` in a per-project `.gc.yaml`. Use `includeContent` to send a file that a broader rule would
otherwise reduce. Files are also reduced automatically when Git reports them as binary or when their shape indicates
generated content, so an unknown large artifact can never exhaust the budget.

```yaml
# .gc.yaml at the repository root
excludeContent:
  - "docs/generated/**"
  - "**/*.pb.go"
includeContent:
  - "pnpm-lock.yaml"
```

`.gc.yaml` is committed to the repository and therefore may not contain `apiKey`, `profiles`, or `activeProfile`.

### When the provider fails

`gc` states the required JSON shape in the prompt rather than relying on the provider to enforce a schema, because many
OpenAI-compatible endpoints accept a schema and then ignore it. It asks for a schema as well where the provider supports
one, and drops to plain JSON for the rest of the run if the endpoint refuses.

Each failure is answered with the change that addresses it: an oversized prompt halves the input budget, a refused output
ceiling halves the output budget, an answer in the wrong shape is sent back with the specific problem, and a timeout or a
rate limit is simply retried. One request may take up to 120 seconds and the whole plan up to 180 seconds, since a
reasoning model can think for a minute before writing anything. While waiting, `gc` prints elapsed time to the terminal.

An unusable API key or model name stops with that error rather than hiding it, since retrying cannot fix it.

Only once every retry is spent does `gc` build a plain local commit plan covering every staged path, mark it as a
fallback, print why the provider was given up on, and open the usual review prompt. Edit the message and commit, or
regenerate to retry the provider. `gc` does not leave you without a plan.

## License

[MIT](LICENSE) © Edoardo Ranghieri
