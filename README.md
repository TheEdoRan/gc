# gc

`gc` reviews staged changes, proposes one or more commit messages with AI, and creates the commits only after you
approve the complete plan.

## Requirements

- Node.js 22.13.0 or newer
- Git
- A supported AI provider or OpenAI-compatible API

## Install

```sh
npm install --global @theedoran/gc
gc init
```

`gc init` creates the first profile and asks for the global commit-splitting and commit-body defaults. If configuration
already exists, it asks before replacing the complete file and defaults to keeping it. Profile setup includes searchable
provider selection, an editable endpoint, API key, and model selection. If the provider cannot list its models, you can
enter a model name manually.

## Usage

```text
gc [-a|--all] [-i|--instructions <text>] [--split|--no-split] [--body <mode>]
gc init
gc setup
gc config
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

Before changing Git history, `gc` shows every proposed message and file group in an interactive list.

| Key             | Action                                                   |
| --------------- | -------------------------------------------------------- |
| `↑` `↓` `j` `k` | Move the selection                                       |
| `space`         | Expand the selected commit: full body and full file list |
| `e`             | Edit the subject in place                                |
| `b`             | Edit the body in place, expanding the row first          |
| `ctrl+e`        | Open subject and body together in `$VISUAL` or `$EDITOR` |
| `r`             | Throw the plan away and ask the model for another        |
| `↵`             | Create the commits                                       |
| `⇧↵`            | Create the commits, then push the branch                 |
| `q` `esc`       | Cancel without committing                                |

`⇧↵` pushes with `git push`, and sets the upstream to `origin` when the branch has none yet. It needs the Kitty
keyboard protocol, which `gc` turns on while the list is open and off again for every editor and on the way out. Ghostty,
Kitty, WezTerm, foot, Alacritty and recent iTerm2 and Windows Terminal speak it. Anywhere else `⇧↵` commits without
pushing.

`r` is the only action that cannot be undone, and it sits one key away from `e`. It discards every subject you edited,
every body you wrote by hand, and every body you spent a request on with `g`. It asks for no confirmation.

A collapsed row shows the first three lines of its body, marked with `…` when there is more. `space` shows the rest.

The other body actions live in the expanded view, so the collapsed list stays short:

| Key | Action                                        |
| --- | --------------------------------------------- |
| `g` | Ask the model to write a body for this commit |
| `x` | Drop the body                                 |

While the model is writing a body, only `↑` `↓` `j` `k`, `space`, `esc`, and `q` answer: nothing that would change the
plan under the request runs. `esc` is modal in the list, so it stops that body first and cancels the review only once
none is being written.

Both editors are modal too. The subject editor leaves the commit as it was when you cancel; the body editor always
saves, so an unwanted line is deleted by hand rather than thrown away with a key:

| Key      | In the subject editor (`e`)     | In the body editor (`b`)      |
| -------- | ------------------------------- | ----------------------------- |
| `↵`      | Save the subject                | Insert a newline              |
| `ctrl+e` | Nothing                         | Open both in the editor       |
| `↑` `↓`  | Nothing                         | Move between the body's lines |
| `esc`    | Cancel, keeping the old subject | Save the body and close       |

`ctrl+e` is therefore available from the list and from the body editor, but not from the subject editor. It always opens
the subject and the body together in `$VISUAL` or `$EDITOR`, with the subject on the first line, so editing that line
changes the subject as well.

Every commit uses normal `git commit`, so existing hooks and signing configuration still apply. If a later commit in a
split plan fails, earlier successful commits remain and all uncommitted patches are restored to the index.

## Profiles and configuration

| Command             | Action                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------- |
| `gc setup`          | Change the global commit-splitting and commit-body defaults.                            |
| `gc config`         | Open the user configuration file in `$VISUAL` or `$EDITOR`.                             |
| `gc profile`        | Add, edit, delete, or activate profiles in an interactive list.                         |
| `gc profile <name>` | Activate a profile directly.                                                            |
| `gc init`           | Replace the complete configuration after confirmation, or create it when it is missing. |

In `gc setup`, use `up` and `down` to move. Use `space`, `left`, `right`, `h`, or `l` to cycle a setting. Use `enter`
to save and exit.

In `gc profile`, the active profile is first and marked `(active)`. Use `enter` to activate a profile, `a` to add one,
`e` to edit one, or `d` to delete one. Adding a profile activates it. Editing a profile does not change the active
profile or the global settings. If you leave the API key blank while editing, `gc` keeps the stored key, including when
you change the provider.

A `.gc.yaml` setting or command-line flag can override the global `split` and `body` defaults.

Configuration is stored in `config.yaml` under the native per-user configuration directory selected by
[`env-paths`](https://github.com/sindresorhus/env-paths). The directory is created with mode `0700` and the file with mode
`0600` where the operating system supports POSIX permissions.

API keys are stored as plaintext in that protected file and are never printed by `gc`. Keys are optional for custom
OpenAI-compatible endpoints, LM Studio, and Ollama.

`gc` includes direct presets for Anthropic, Cerebras, Chutes, DeepInfra, DeepSeek, Fireworks, Gemini, Groq, LM Studio,
MiniMax, Mistral, Moonshot, Ollama, OpenAI, OpenRouter, Qwen, Qwen China, Together, xAI, Z.AI, and Z.AI Coding. All
presets except OpenAI and Anthropic use the OpenAI-compatible transport. The preset URL remains editable for proxies
and enterprise endpoints. Choose OpenAI-compatible to supply any other compatible endpoint.

### Commit bodies

By default `gc` writes subjects only. Ask for a body on the commits that need one by expanding the row in the review
list and pressing `g`, or write it yourself with `b`.

Set `body` in the user config, in `.gc.yaml`, or with `--body` to change the default:

| Value    | Behavior                                                     |
| -------- | ------------------------------------------------------------ |
| `manual` | The default. No bodies are generated.                        |
| `auto`   | A body only where the subject alone cannot carry the change. |
| `always` | Every commit gets a body.                                    |

```yaml
# config.yaml
body: auto
```

Each setting overrides the one before it: the user config is the base, `.gc.yaml` overrides it per repository, and
`gc --body always` overrides both for one run.

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
reasoning model can think for a minute before writing anything. While waiting, `gc` shows a spinner with the model, the
current phase, and the elapsed time, and streams each commit subject as the model writes it. Retries print their reason
above the spinner, so a halved budget or a refused schema stays visible instead of silent. When the output is not a
terminal, for example piped or redirected to a file, `gc` cannot redraw in place, so it prints one plain line per phase
and one per retry instead, with no streamed subjects. Setting `NO_COLOR` removes color from the spinner and its lines but,
on a real terminal, does not turn off the live redraw by itself.

An unusable API key or model name stops with that error rather than hiding it, since retrying cannot fix it.

Only once every retry is spent does `gc` build a plain local commit plan covering every staged path, mark it as a
fallback, print why the provider was given up on, and open the usual review prompt. Edit the message and commit, or
regenerate to retry the provider. `gc` does not leave you without a plan.

## License

[MIT](LICENSE) © Edoardo Ranghieri
