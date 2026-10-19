import { isAbsolute, relative, resolve, sep } from "node:path";

/** The shared host-cwd to guest-cwd mapping used for approval facts and launch. */
export function resolveZapVmGuestCwd(workspaceRoot: string, hostCwd: string): string {
  const rel = relative(resolve(workspaceRoot), resolve(hostCwd));
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Command working directory is outside the authorized workspace");
  }
  return `./${rel.split(sep).join("/")}`;
}
