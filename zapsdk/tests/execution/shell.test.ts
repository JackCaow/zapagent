import { describe, expect, it } from "bun:test";
import { localExecutionShell } from "../../execution/shell.js";

describe("local execution shell contract", () => {
  it("does not select a Unix interpreter from the login shell", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(localExecutionShell(platform, { SHELL: "/bin/zsh" })).toEqual({
        executable: "/bin/sh", argsPrefix: ["-c"],
      });
    }
  });

  it("keeps Windows cmd launch semantics in PowerShell and Git Bash terminals", () => {
    expect(localExecutionShell("win32", {
      SHELL: "/usr/bin/bash", PSModulePath: "C:\\PowerShell",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    })).toEqual({
      executable: "C:\\Windows\\System32\\cmd.exe", argsPrefix: ["/d", "/s", "/c"],
    });
    expect(localExecutionShell("win32", {})).toEqual({
      executable: "cmd.exe", argsPrefix: ["/d", "/s", "/c"],
    });
  });
});
