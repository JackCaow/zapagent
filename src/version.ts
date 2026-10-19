// Single source of truth for the displayed version string. Reads from
// package.json so a release bump only needs to touch package.json — the
// welcome banner, --version output, /clear footer, and any future
// version surfaces all pick it up automatically. Bun inlines the JSON
// import at compile time so this works for both `bun run` (dev) and
// `bun build --compile` (binary).
import pkg from "../package.json" with { type: "json" }

export const VERSION: string = pkg.version
