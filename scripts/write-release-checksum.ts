import { createHash } from "node:crypto"
import { basename } from "node:path"
import { readFileSync, writeFileSync } from "node:fs"

const artifactPath = process.argv[2]
if (!artifactPath) {
  console.error("usage: bun scripts/write-release-checksum.ts <artifact>")
  process.exit(2)
}

const digest = createHash("sha256").update(readFileSync(artifactPath)).digest("hex")
writeFileSync(`${artifactPath}.sha256`, `${digest}  ${basename(artifactPath)}\n`)
