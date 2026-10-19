# Web Agent UI dependency register

The browser application is built locally into `web/client/app/dist` and served
by the same-origin Go BFF. It does not load a hosted UI, CDN script, font, or
telemetry SDK.

| Package | Version | License | Purpose |
| --- | --- | --- | --- |
| React / React DOM | 19.2.8 | MIT | Component runtime and DOM renderer |
| Vite / plugin-react | 8.2.1 / 6.0.5 | MIT | Local development and production asset build |
| TypeScript | 5.9.3 | Apache-2.0 | Type checking |
| Tailwind CSS / Vite plugin | 4.3.3 | MIT | Design tokens and utility layer |
| Radix Dialog, Dropdown Menu, Tabs | 1.1.23 / 2.1.24 / 1.1.21 | MIT | Accessible interaction primitives |
| TanStack Query | 5.101.4 | MIT | Server-state cache and recovery |
| Streamdown | 2.5.0 | Apache-2.0 | Streaming-safe Markdown renderer |
| Lucide React | 1.30.0 | ISC | Local SVG icons |
| Vitest | 4.1.10 | MIT | Unit tests for stream projection |

`package-lock.json` is the authoritative resolved dependency graph. New runtime
dependencies require an entry in this register and must remain locally bundled.
