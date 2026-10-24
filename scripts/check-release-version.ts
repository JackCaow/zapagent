import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function checkReleaseVersion(version: string, tag?: string): string {
  const numeric = "(?:0|[1-9][0-9]*)";
  const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
  const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?$`);
  if (version.trim() !== version || !semver.test(version)) throw new Error(`Invalid release version: ${version}`);
  if (tag && tag !== `v${version}`) throw new Error(`Release tag ${tag} must match package.json v${version}`);
  return version;
}

if (import.meta.main) {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  console.log(checkReleaseVersion(manifest.version, process.env.RELEASE_TAG || undefined));
}
