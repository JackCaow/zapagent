/** Account-advertised capabilities for an exact request model ID. */
export interface ModelReasoning {
  levels: Array<{ effort: string; description?: string }>;
  defaultEffort?: string;
}

export function effortName(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

/** Missing/malformed is unknown; an explicit empty array means no override. */
export function normalizeModelReasoning(levels: unknown, defaultEffort?: unknown): ModelReasoning | undefined {
  if (!Array.isArray(levels)) return undefined;
  const result: ModelReasoning = { levels: [] };
  const seen = new Set<string>();
  for (const level of levels) {
    if (!level || typeof level !== "object" || !effortName(level.effort)) return undefined;
    const key = level.effort.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const description = typeof level.description === "string"
      ? level.description.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 256) : undefined;
    result.levels.push({ effort: level.effort, ...(description ? { description } : {}) });
  }
  const canonical = typeof defaultEffort === "string"
    ? result.levels.find(level => level.effort.toLowerCase() === defaultEffort.toLowerCase())?.effort : undefined;
  if (canonical) result.defaultEffort = canonical;
  return result;
}

export function resolveModelEffort(profile: ModelReasoning | undefined, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return profile ? profile.levels.find(level => level.effort.toLowerCase() === value.toLowerCase())?.effort : value;
}

export function normalizeReasoningMap(value: unknown): Record<string, ModelReasoning> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).flatMap(([model, raw]) => {
    if (!model || model.length > 256 || /[\x00-\x1f\x7f]/.test(model) || !raw || typeof raw !== "object") return [];
    const profile = normalizeModelReasoning(raw.levels, raw.defaultEffort);
    return profile ? [[model, profile]] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function modelReasoningFor(profiles: Record<string, ModelReasoning> | undefined, model: string): ModelReasoning | undefined {
  return profiles && Object.hasOwn(profiles, model) ? profiles[model] : undefined;
}
