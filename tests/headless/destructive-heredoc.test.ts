import { describe, expect, it } from "bun:test"
import { destructiveShellRisk } from "../../zapsdk/utils/destructive-shell.js"

// Classification only: none of these commands are executed.
const context = {
  cwd: "/workspace", workspaceRoot: "/workspace",
  syntax: "posix", pathResolution: "lexical",
} as const

describe("heredoc shell risk state", () => {
  for (const command of [
    "cat <<'DATA'\ncd /\nDATA\nrm -rf cache",
    "python3 - <<'PY'\nentries = [len(ds)+len(fs) for _,ds,fs in os.walk('cache')]\nprint(max(entries))\nPY\nrm -rf cache",
    "cat <<'DATA'\n)\ncd /\n(\nDATA\nrm -rf cache",
    "cat <<-'DATA'\n\tcd /\n\tDATA\nrm -rf cache",
    "cat <<D'AT'A\ncd /\nDATA\nrm -rf cache",
    "cat <<D\\ATA\ncd /\nDATA\nrm -rf cache",
    "cat <<FIRST <<'SECOND'\ncd /\nFIRST\n)\nSECOND\nrm -rf cache",
    "cat <<'DATA' # consume the body after this comment\ncd /\nDATA\nrm -rf cache",
    "cat <<'DATA' && cd nested\ncd /\nDATA\nrm -rf cache",
    "sh <<'SCRIPT'\ncd /\nSCRIPT\nrm -rf cache",
  ]) {
    it(`keeps input body state separate: ${JSON.stringify(command)}`, () => {
      expect(destructiveShellRisk(command, context)).toBeNull()
    })
  }

  for (const command of [
    "sh <<'SCRIPT'\ncd / && rm -rf etc\nSCRIPT",
    "cat <<'SCRIPT' | sh\ncd / && rm -rf etc\nSCRIPT",
    "sh <<'SCRIPT' && cd /workspace\ncd / && rm -rf etc\nSCRIPT",
    "cat <<DATA\n$(rm -rf /etc)\nDATA",
    "cat <<DATA\n$(cd /; rm -rf etc)\nDATA",
    "cat <<DATA\n`rm -rf /etc`\nDATA",
    "cat <<'DATA'\ncd /workspace\nDATA\ncd / && rm -rf etc",
    "cat <<'DATA' && cd /\ncd /workspace\nDATA\nrm -rf etc",
    "cat <<'DATA' && cd nested\nhello\nDATA\nrm -rf ../cache",
    "cat <<'DATA'\nhello\nDATA\nrm -rf cache /etc",
    ". /dev/stdin <<'SCRIPT'\ncd /\nSCRIPT\nrm -rf etc",
    "sh <<-'SCRIPT'\n\tcd / && rm -rf etc\n\tSCRIPT",
    "cat <<'FIRST' <<'SECOND'\nhello\nFIRST\nrm -rf /etc\nSECOND",
    "cat <<'MISSING'\ncd / && rm -rf etc",
  ]) {
    it(`retains destructive-operation signals: ${JSON.stringify(command)}`, () => {
      expect(destructiveShellRisk(command, context)).toBe("rm_recursive_system_path")
    })
  }

  it("retains world-writable permission signals inside script input", () => {
    expect(destructiveShellRisk("sh <<'SCRIPT'\nchmod 777 /etc\nSCRIPT", context))
      .toBe("world_writable_chmod")
  })

  it("keeps checking nested script input at the separation depth limit", () => {
    let command = "cd / && rm -rf etc"
    for (let i = 0; i < 12; i++) command = `sh <<'END${i}'\n${command}\nEND${i}`
    expect(destructiveShellRisk(command, context)).toBe("rm_recursive_system_path")
  })

  it("retains conservative scanning for unquoted line folding", () => {
    expect(destructiveShellRisk("sh <<END\ncd / && rm -rf etc\nEN\\\nD", context))
      .toBe("rm_recursive_system_path")
  })
})
