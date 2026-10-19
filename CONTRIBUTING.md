# Contributing to zapAgent

Start with an issue for a protocol, permission, runtime-policy, or large UI
change. Small fixes can go directly to a pull request. Describe the problem,
keep changes focused, and preserve unrelated work.

## Development

Use the Bun version declared in `package.json`:

```sh
bun install --frozen-lockfile
bun start
bun run typecheck
bun test
bun run build
```

Run tests and experiments with an isolated data directory, never with your
personal provider keys or sessions:

```sh
ZAPCODE_DATA_DIR="$(mktemp -d)" bun test
```

Tests should use disposable fixtures and fake providers unless a live test is
explicitly requested. Do not submit API keys, personal config, session journals,
unredacted screenshots, or customer repositories. Live model calls cost money.

`src/` is the CLI/TUI host; `zapsdk/` is the reusable Agent/Harness. Follow
[AGENTS.md](AGENTS.md) for TypeScript conventions. For `zapvm/`, also follow
[its contribution guide](zapvm/CONTRIBUTING.md) and run `bun run check:vm`.
Keep VM policy independent of agent prompts and permissions. Run web-client
tests in `zapvm/web/client/react`, not through the root Bun suite.

## Pull requests

- Explain behavior, scope, and any migration or trust-boundary changes.
- Include regression tests and the actual commands/results, not just a plan.
- Include terminal screenshots or recordings for TUI changes, including resize
  and multiline input when relevant.
- Distinguish unit tests, live-provider checks, VM boot, and real-platform
  acceptance. A build or smoke task does not prove a security boundary.
- Use scoped Conventional Commit subjects, for example `fix(runtime): ...`.

Contributions to the root project use ISC; contributions under `zapvm/` use
Apache-2.0. Submit only material you have the right to contribute, and preserve
third-party licenses and attribution. Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md).
