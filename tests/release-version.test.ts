import { expect, test } from "bun:test";
import { checkReleaseVersion } from "../scripts/check-release-version.js";

test("release version accepts stable and prerelease tags only when they match the manifest", () => {
  for (const version of ["0.1.0", "1.14.6", "2.0.0-rc.1", "2.0.0-beta"])
    expect(checkReleaseVersion(version, `v${version}`)).toBe(version);
  expect(checkReleaseVersion("1.14.6")).toBe("1.14.6");
  expect(() => checkReleaseVersion("1.14.6", "v1.14.7")).toThrow("must match");
  expect(() => checkReleaseVersion("1.14.6", "main")).toThrow("must match");
  for (const version of ["01.2.3", "1.2", "1.2.3-01", "1.2.3+build", "1.2.3/escape", "1.2.3\n"])
    expect(() => checkReleaseVersion(version)).toThrow("Invalid release version");
});
