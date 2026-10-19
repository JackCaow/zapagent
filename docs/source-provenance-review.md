# Source provenance review

Review date: 2026-10-19. This is an engineering evidence register, not a legal
opinion or a finding of infringement. Publication remains pending where rights
or implementation origins have not been established.

## Current-source findings

| Area | Evidence in this snapshot | Required resolution |
|---|---|---|
| Action prompt | `src/prompts/sections/actions.ts` says the text was adopted from CCB's action guidance. | Identify the source and redistribution permission, or replace from Zap's own documented requirements and review the replacement. |
| Compaction prompt | `zapsdk/context/autocompact.ts` describes its template as ported from Claude Code's `getCompactPrompt`. | Resolve prompt provenance while preserving the tested summary-section contract. |
| Task and communication prompts | `src/prompts/sections/tasks.ts` records CCB-informed additions; `output-efficiency.ts` cites an external measured improvement without a retained primary source. | Review wording origins and remove unsupported performance claims or provide evidence. |
| Todo guidance | Historical design instructions requested wholesale prompt porting; current `zapsdk/builtin-tools/todo.ts` still contains the corresponding guidance, with later Zap-specific extensions. | Review text provenance against the actual source/version; design intent alone does not prove identical copying. |
| Tool-output persistence | `zapsdk/utils/tool-result-storage.ts` describes a port and matching constants/tags. | Distinguish independently implemented mechanics and interoperable formats from copied implementation or prose. |
| Ink patch | `patches/ink@7.1.1.patch` mentions another product's Ink fork. Upstream Ink's MIT notice is retained. | Confirm the added patch's origin; Ink's license by itself does not establish permission for additions from another fork. |

Other references to Claude Code in configuration/session formats, tool naming,
UI behavior and defaults are compatibility or design references. They are not
by themselves evidence of copied code, and have not been erased to make the
snapshot appear independent. Review unresolved implementation origins before
claiming full clearance.

## Material excluded from this snapshot

The original private repository retains internal design plans and source
research, the two private-company benchmark task manifests and related report,
and artwork without recorded distribution provenance. Exclusion avoids exporting
that material; it does not clear current code influenced by it.

## Attribution already retained

- Root ISC and VM Apache-2.0 license/NOTICE boundaries.
- Modified Ink MIT notice in `THIRD_PARTY_NOTICES.md`.
- Yoga Layout license and its version-specific upstream provenance.
- Generated Watch page's Motion/Framer Motion/Motion DOM/Motion Utils/tslib notices.

The dependency lockfiles identify versions but are not a complete license audit
of compiled release artifacts. No release publication is approved by this file.
