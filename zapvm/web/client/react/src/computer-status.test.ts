import { describe, expect, it } from "vitest";
import { computerStatusLabel, computerStatusTone } from "./computer-status";

describe("Computer status", () => {
  it("shows an unplaced on-demand Computer as available when its Node is online", () => {
    const computer = { id: "cloud", state: "online", observed_state: "unavailable" as const };
    expect(computerStatusLabel(computer)).toBe("按需就绪");
    expect(computerStatusTone(computer)).toBe("success");
  });

  it("keeps a genuinely unreachable Computer offline", () => {
    const computer = { id: "cloud", state: "offline", observed_state: "unavailable" as const, failure_code: "node_offline" };
    expect(computerStatusLabel(computer)).toBe("离线");
    expect(computerStatusTone(computer)).toBe("danger");
  });

  it("shows an in-flight release as an active lifecycle transition", () => {
    const computer = { id: "cloud", state: "online", observed_state: "unavailable" as const, failure_code: "computer_stopping" };
    expect(computerStatusLabel(computer)).toBe("正在释放");
    expect(computerStatusTone(computer)).toBe("active");
  });
});
