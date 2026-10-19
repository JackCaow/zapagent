/** models.dev canonical identities are lab/model IDs, not URLs or wire IDs.
 * Validate at both catalog and persisted-config boundaries. */
export function canonicalModelId(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 256
    && /^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)
    ? value : undefined;
}
