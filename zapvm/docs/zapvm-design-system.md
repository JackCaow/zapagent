# zapVM Design System

## Brand idea

zapVM is an **Agent Computer**, not a chat toy and not an infrastructure console. The visual system combines a quiet graphite workspace with a restrained electrical signal:

- **Graphite** communicates durable infrastructure and keeps long technical sessions readable.
- **Volt** is reserved for brand identity, primary actions, and confirmed execution state.
- **Signal cyan** identifies live compute activity; success, warning, and failure keep their standard semantic meaning.
- The `Z` circuit mark connects an entry node to an exit node: a goal enters, a verified outcome leaves.

The interface must remain calm while the Agent is busy. Large neon surfaces, multiple simultaneous spinners, decorative gradients, and raw infrastructure vocabulary are outside the system.

## Token architecture

Tokens live in `web/client/react/src/tokens.css` and are grouped by responsibility:

| Layer | Prefix/examples | Rule |
| --- | --- | --- |
| Brand | `--z-brand-volt-*`, `--z-brand-cyan-*` | Never use raw brand values in feature CSS |
| Semantic color | `--z-color-surface-*`, `--z-color-text-*`, `--z-color-success` | Components consume semantic meaning, not palette names |
| Typography | `--z-font-*`, `--z-text-*`, `--z-leading-*` | UI uses sans; commands, paths, and tool names use mono |
| Space | `--z-space-1` through `--z-space-12` | 4 px base grid |
| Shape | `--z-radius-*` | Small controls 10 px, cards 14–18 px, pills only for compact metadata |
| Elevation | `--z-shadow-*`, `--z-focus-ring` | Elevation is subtle and always paired with a border |
| Motion | `--z-duration-*`, `--z-ease-standard` | 120–200 ms; reduced-motion is mandatory |
| Layout | `--z-sidebar-width`, `--z-content-width`, `--z-outcome-width` | Shared shell geometry belongs to tokens |

## Component primitives

Reusable React primitives live in `web/client/react/src/design-system.tsx`:

- `BrandMark` and `BrandLockup`
- `Button`: primary, secondary, quiet, and danger tones; small, medium, and large sizes
- `IconButton`: 36 px interaction target for icon-only actions
- `StatusDot`: neutral, active, success, warning, and danger states with optional live pulse
- `Badge`: compact runtime or state metadata

Product components may compose these primitives but must not recreate their focus, disabled, hover, icon, or typography behavior.

## Icon board

The product uses Lucide icons with a global 1.75 px stroke. Icon meaning must remain stable:

| Intent | Icon | Surface |
| --- | --- | --- |
| Create task | `MessageSquarePlus` | Secondary button |
| Send | `ArrowUp` | Volt primary square |
| Running | `LoaderCircle` | Signal cyan, animation only for the single active step |
| Succeeded | `Check` | Semantic success |
| Failed | `X` | Semantic danger |
| Stop | `CircleStop` | Text action, never a primary filled button |
| Outcome | `PanelRight` | Icon button; active uses a muted Volt surface |
| Artifact | `FileArchive` | Signal cyan muted tile |
| Workspace | `FolderOpen` | Neutral by default, Volt only for a directory affordance |
| Runtime | `Cloud` | Metadata badge |

Icons are not decoration. Do not mix filled emoji, text glyphs, and outline icons in the same control family. The custom brand symbol is the only filled product icon.

## Accessibility and interaction rules

- Interactive text and essential icons meet WCAG AA contrast on their assigned surface.
- Every icon-only control has an accessible name.
- Keyboard focus uses the shared Volt focus ring and is never removed without replacement.
- The 320–1440 px layout has no horizontal scrolling; below 860 px the sidebar and outcome panel become drawers.
- Only the current execution step may animate. Terminal turns have no busy indicator.
- Motion is disabled through `prefers-reduced-motion`.
