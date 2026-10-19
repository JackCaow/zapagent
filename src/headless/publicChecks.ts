import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import { JsonAcceptanceStore } from "../../zapsdk/runtime/acceptance-store.js"
import { FileBytesSnapshotProvider } from "../../zapsdk/runtime/file-acceptance.js"
import { validateAcceptanceSpec, type InlineHostVerifier } from "../../zapsdk/runtime/inline-acceptance.js"
import { OutcomeProtocolError } from "../../zapsdk/runtime/outcome.js"
import type { BoundedRepairOptions } from "../../zapsdk/runtime/bounded-repair.js"

const id = z.string().min(1).max(128)
const timer = z.number().int().min(1).max(2_147_483_647)
const common = { id, path: z.string().min(1).max(1024) }
const manifestSchema = z.object({
  version: z.literal(1), id, revision: z.number().int().min(1),
  maxRepairAttempts: z.number().int().min(0).max(10),
  budget: z.object({ modelCalls: z.number().int().min(1), toolCalls: z.number().int().min(0), timeoutMs: timer }).strict(),
  checks: z.array(z.discriminatedUnion("kind", [
    z.object({ ...common, kind: z.literal("file-size"), maxBytes: z.number().int().min(0).max(16 * 1024 * 1024) }).strict(),
    z.object({ ...common, kind: z.literal("utf8") }).strict(),
    z.object({ ...common, kind: z.literal("json-equals"), pointer: z.string().max(1024).regex(/^(?:\/(?:[^~]|~[01])*)*$/),
      expected: z.union([z.string().max(2048), z.number().finite(), z.boolean(), z.null()]) }).strict(),
  ])).min(1).max(64),
}).strict()

type Manifest = z.infer<typeof manifestSchema>
export type PublicChecksConfiguration = Pick<BoundedRepairOptions, "acceptance" | "repair" | "budget">

const display = (value: unknown): string => (JSON.stringify(value) ?? "missing").slice(0, 4096)
function atPointer(value: unknown, pointer: string): unknown {
  if (!pointer) return value
  for (const part of pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~")
    if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) return undefined
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

/** Declarative checks only: no executable modules, shell commands or hidden tests. */
export function createPublicChecks(input: unknown, root: string, storeDirectory: string): PublicChecksConfiguration {
  const parsed = manifestSchema.safeParse(input)
  if (!parsed.success) throw new OutcomeProtocolError("INVALID_PUBLIC_CHECKS", "Invalid public checks manifest")
  const manifest: Manifest = parsed.data
  const paths = [...new Set(manifest.checks.map(check => check.path))]
  const subjects = paths.map((path, index) => ({ id: `file-${index}`, path, expected: "exists" as const }))
  const subjectId = (path: string) => subjects.find(subject => subject.path === path)!.id
  const spec = { id: manifest.id, revision: manifest.revision, subjects,
    checks: manifest.checks.map(check => ({ id: check.id, verifierId: "public-file-v1", subjectIds: [subjectId(check.path)] })) }
  validateAcceptanceSpec(spec)
  const instruction = (check: Manifest["checks"][number]) => check.kind === "file-size"
    ? `${check.path} must contain at most ${check.maxBytes} bytes`
    : check.kind === "utf8" ? `${check.path} must contain valid UTF-8`
      : `${check.path} must be valid UTF-8 JSON whose JSON Pointer ${JSON.stringify(check.pointer)} equals ${JSON.stringify(check.expected)}`
  const verifier: InlineHostVerifier = { id: "public-file-v1", async verify({ outcome, snapshot, signal }) {
    const results = []
    for (const check of manifest.checks) {
      signal.throwIfAborted()
      const bytes = await snapshot.readFile(subjectId(check.path), signal)
      let passed = false, actual: string, code: string
      if (check.kind === "file-size") {
        passed = bytes.length <= check.maxBytes
        actual = `${bytes.length} bytes`
        code = passed ? "FILE_SIZE_OK" : "FILE_TOO_LARGE"
      } else {
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
          if (check.kind === "utf8") { passed = true; actual = "valid UTF-8"; code = "UTF8_OK" }
          else {
            try {
              const value = atPointer(JSON.parse(text), check.pointer)
              passed = value === check.expected
              actual = display(value)
              code = passed ? "JSON_VALUE_OK" : "JSON_VALUE_MISMATCH"
            } catch { actual = "invalid JSON"; code = "INVALID_JSON" }
          }
        } catch { actual = "invalid UTF-8"; code = "INVALID_UTF8" }
      }
      results.push({ checkId: check.id, attemptId: outcome.attemptId, specId: spec.id, specRevision: spec.revision,
        snapshotId: snapshot.id, dependencies: snapshot.subjects.filter(subject => subject.subjectId === subjectId(check.path)),
        status: passed ? "passed" as const : "failed" as const, code, evidenceRefs: [],
        publicDiagnostic: { expected: instruction(check).slice(0, 4096), actual },
      })
    }
    return results
  } }
  return { budget: { ...manifest.budget },
    repair: { maxAttempts: manifest.maxRepairAttempts, publicChecks: manifest.checks.map(check => ({ checkId: check.id,
      instruction: instruction(check), includeDiagnostics: true,
      repairableCodes: check.kind === "file-size" ? ["FILE_TOO_LARGE"] : check.kind === "utf8" ? ["INVALID_UTF8"]
        : ["INVALID_UTF8", "INVALID_JSON", "JSON_VALUE_MISMATCH"],
    })) },
    acceptance: { mode: "required", timing: "inline", spec, timeoutMs: Math.min(30_000, manifest.budget.timeoutMs),
      snapshotProvider: new FileBytesSnapshotProvider(root), store: new JsonAcceptanceStore(storeDirectory), verifiers: [verifier] },
  }
}

export async function loadPublicChecks(path: string, root: string, storeDirectory: string): Promise<PublicChecksConfiguration> {
  const handle = await open(resolve(root, path), constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 128 * 1024) throw new OutcomeProtocolError("INVALID_PUBLIC_CHECKS", "Public checks must be a JSON file at most 128 KiB")
    const bytes = Buffer.alloc(128 * 1024 + 1)
    let bytesRead = 0
    while (bytesRead < bytes.length) {
      const read = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
      if (!read.bytesRead) break
      bytesRead += read.bytesRead
    }
    if (bytesRead > 128 * 1024) throw new OutcomeProtocolError("INVALID_PUBLIC_CHECKS", "Public checks file grew past the limit")
    return createPublicChecks(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")), root, storeDirectory)
  } finally { await handle.close() }
}
