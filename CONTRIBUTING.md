# Contributing

## Setup

Use Node.js 26 and pnpm 11.20.0:

```sh
pnpm install
pnpm check
```

Run focused commands while developing:

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Tests use `node:test`, temporary Git repositories, and local HTTP servers. Do not make live provider calls in tests.

Try the review flow by hand against checked-in fixtures, without a provider and without creating a commit:

```sh
pnpm demo --offline
```

Drop `--offline` to use your own configured profile instead of the canned plan.

## Pull requests

Keep changes focused and add a Changeset for changes that affect the published package:

```sh
pnpm changeset
```

Documentation-only and internal maintenance pull requests can use an empty Changeset when no package release is needed:

```sh
pnpm changeset --empty
```

CI checks formatting, linting, types, tests, builds, and the built CLI on Linux, macOS, and Windows.

## Releases

Merges to `main` update the Changesets release pull request. Merging that release pull request publishes to npm with
GitHub Actions OIDC and provenance.

Before the first release, configure npm trusted publishing for `@theedoran/gc` with:

- organization or user: `TheEdoRan`;
- repository: `gc`;
- workflow filename: `release.yml`; and
- environment: leave empty unless the workflow is later assigned one.

The workflow requires `contents: write`, `pull-requests: write`, and `id-token: write`. Do not add a long-lived npm token.
