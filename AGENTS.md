# Repository instructions

## Commands

- `pnpm install`: install dependencies.
- `pnpm format`: format supported files.
- `pnpm format:check`: verify formatting.
- `pnpm lint`: run type-aware lint rules.
- `pnpm typecheck`: run the TypeScript compiler without emitting files.
- `pnpm test`: run the native Node.js test suite.
- `pnpm demo`: run the CLI against checked-in fixtures without creating commits. Add `--offline` to skip the network.
- `pnpm build`: build `dist/index.mjs`.
- `pnpm check`: run all required checks.

## Requirements

- Use Node.js 26 and pnpm 11.20.0.
- Keep the package ESM-only and the public surface limited to the `gc` binary.
- Use Conventional Commits, adding a scope when useful and a body when the change needs further explanation.
- Prefer Node.js built-ins over new dependencies.
- Use `node:test` for tests and local servers for provider test doubles.
- Never make live provider calls in tests.
- Never use em dash characters in source, comments, documentation, or generated project content.
