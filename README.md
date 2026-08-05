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

## License

[MIT](LICENSE) © Edoardo Ranghieri
