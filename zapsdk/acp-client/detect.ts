import { which } from "../builtin-tools/delegate-detect.js";
import type { AcpAgentSpec } from "./types.js";

/** ACP agents zap recognizes on PATH without configuration. User config
 * entries with the same id win; zap itself is never auto-registered. */
export const KNOWN_ACP_AGENTS: readonly AcpAgentSpec[] = [
  { id: "agy", name: "Antigravity", command: "agy", args: ["acp"], selfGoverned: true,
    description: "Google Antigravity agent (Gemini models)." },
  // Codex has no native ACP mode; the adapter (`npm i -g @agentclientprotocol/codex-acp`)
  // speaks ACP and reuses the codex login. Its default "agent" mode asks
  // zap only for actions it judges unsafe and writes workspace files itself.
  // ("read-only" routes every edit to zap but stalls for minutes upstream.)
  { id: "codex", name: "Codex", command: "codex-acp", args: [], selfGoverned: true,
    description: "OpenAI Codex through its ACP adapter." },
]

/** Merge configured agents with known agents found on PATH. Configured
 * commands are resolved too, so a missing binary is dropped. */
export async function detectAcpAgents(configured: readonly AcpAgentSpec[] = [], pathEnv?: string): Promise<AcpAgentSpec[]> {
  const byId = new Map<string, AcpAgentSpec>();
  for (const spec of KNOWN_ACP_AGENTS) byId.set(spec.id, spec);
  for (const spec of configured) byId.set(spec.id, { ...byId.get(spec.id), ...spec });
  const resolved = await Promise.all([...byId.values()].map(async (spec) => {
    const bin = await which(spec.command, pathEnv);
    return bin ? { ...spec, command: bin } : null;
  }));
  return resolved.filter((spec): spec is AcpAgentSpec => spec !== null);
}
