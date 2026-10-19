import type { Computer } from "./types";

export function computerStatusLabel(computer?: Computer) {
  if (computer?.failure_code === "computer_stopping") return "正在释放";
  switch (computer?.observed_state) {
  case "ready": return "已就绪";
  case "busy": return "正在执行";
  case "degraded": return "需要恢复";
  case "unavailable": return computer.state === "online" ? "按需就绪" : "离线";
  default: return computer?.state === "online" ? "已连接" : "状态未知";
  }
}

export function computerStatusTone(computer?: Computer): "neutral" | "active" | "success" | "danger" | "warning" {
  if (computer?.failure_code === "computer_stopping") return "active";
  switch (computer?.observed_state) {
  case "ready": return "success";
  case "busy": return "active";
  case "degraded": return "warning";
  case "unavailable": return computer.state === "online" ? "success" : "danger";
  default: return computer?.state === "online" ? "success" : "neutral";
  }
}
