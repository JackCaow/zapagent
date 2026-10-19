# Repository Guidelines

## Project Structure & Module Organization

Zapcode is a Bun-powered TypeScript terminal AI assistant. The CLI entry point is `src/index.tsx`, with the main TUI in `src/App.tsx`. UI components live in `src/ui/`, hooks in `src/hooks/`, prompt text in `src/prompts/`, and shared CLI helpers in `src/utils/`. The reusable agent SDK is under `zapsdk/`, organized by domain such as `agent/`, `builtin-tools/`, `core/`, `memory/`, `mcp/`, and `tools/`. Tests are split between top-level `tests/` for app behavior and `zapsdk/tests/` for SDK behavior. Generated release output goes to `dist/`.

## Build, Test, and Development Commands

- `bun install` installs dependencies.
- `bun start` or `bun run dev` runs the local CLI from `src/index.tsx`.
- `bun run build` compiles a standalone executable to `dist/zap`.
- `bun test` runs all Bun tests in `tests/` and `zapsdk/tests/`.

## Coding Style & Naming Conventions

Use TypeScript with strict checking and ESM imports. Keep indentation at two spaces, prefer double quotes, and follow the semicolon style of the file you edit. Local TypeScript imports generally use `.js` extensions, for example `import { App } from "./App.js"`. Name React/Ink components in PascalCase, hooks as `useSomething`, types/interfaces in PascalCase, and utility functions in camelCase. Keep comments focused on non-obvious behavior or platform quirks.

## Testing Guidelines

Tests use `bun:test`; name files `*.test.ts` and place them near the relevant test area (`tests/ui/truncate.test.ts`, `zapsdk/tests/builtin-tools/edit.test.ts`). Prefer isolated fixtures and temporary directories. When code touches persisted app state, set or preserve `ZAPCODE_DATA_DIR` so tests do not read or write a developer’s real `~/.zapcode` data. Run `bun test` before submitting changes.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style subjects such as `feat(memory): ...`, `fix(permissions): ...`, `docs: ...`, and `refactor(ui): ...`. Keep commits scoped and imperative. Pull requests should describe the behavior change, list verification commands, link related issues when available, and include terminal screenshots or recordings for visible TUI changes.

## Security & Configuration Tips

Do not commit `.env`, API keys, local session data, or generated personal config. Use `ZAPCODE_DATA_DIR` for sandboxed runs, CI isolation, or tests that need disposable state.

## VM Module Boundary

`zapvm/` is an independent Apache-2.0 Go module. Run `bun run test:vm` or
`bun run check:vm` from the root; `bun run build:all` builds both Host components.
Keep its protocol and runtime policy independent of the Agent. Do not import Go
internals into the SDK, inject prompts from the VM, or override Agent permissions.
VM web-client tests belong to its own npm/Vitest suite, not the root Bun suite.
Imported workflows in `zapvm/.github/` are historical references; active monorepo
workflows live in the root `.github/workflows/` directory.
