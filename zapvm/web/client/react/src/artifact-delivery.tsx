import { useQuery } from "@tanstack/react-query";
import { Download, FileArchive, LoaderCircle, MoreHorizontal, RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "./api";
import { Button, IconButton } from "./design-system";
import type { AgentSession, Artifact } from "./types";

const artifactQueryKey = (taskID?: string) => ["artifacts", taskID] as const;

export function MessageArtifacts({ taskID }: { taskID: string }) {
  const artifacts = useQuery({ queryKey: artifactQueryKey(taskID), queryFn: () => api.artifacts(taskID), staleTime: 60_000 });
  const [downloading, setDownloading] = useState("");
  const [error, setError] = useState("");
  const available = availableArtifacts(artifacts.data?.artifacts);
  if (artifacts.isPending || (!artifacts.isError && !available.length)) return null;
  if (artifacts.isError) return <button className="artifact-inline-retry" type="button" onClick={() => void artifacts.refetch()}><RefreshCw className="size-3" />产物读取失败，点击重试</button>;
  return <section className="message-artifacts" aria-label="本轮生成的文件"><header><span><FileArchive className="size-4" />交付文件</span><small>{available.length} 个</small></header><div className="message-artifact-list">{available.map((artifact) => <button className="message-artifact" type="button" key={artifact.id} disabled={Boolean(downloading)} onClick={async () => { setError(""); setDownloading(artifact.id); try { await downloadArtifact(artifact); } catch (reason) { setError(errorMessage(reason)); } finally { setDownloading(""); } }}><span className="artifact-icon"><FileArchive className="size-4" /></span><span className="message-artifact-copy"><strong>{artifactName(artifact)}</strong><small>{formatBytes(artifact.size)} · {artifactLabel(artifact.content_type)}</small></span><span className="message-artifact-action">{downloading === artifact.id ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}<span>下载</span></span></button>)}</div>{error && <p className="artifact-inline-error" role="alert">{error}</p>}</section>;
}

export function OutcomeArtifacts({ task }: { task?: AgentSession }) {
  const taskID = task?.id;
  const terminal = task ? ["succeeded", "failed", "canceled", "interrupted"].includes(task.state) : false;
  const artifacts = useQuery({
    queryKey: artifactQueryKey(taskID),
    queryFn: () => api.artifacts(taskID!),
    enabled: Boolean(taskID),
    staleTime: terminal ? 0 : 2_000,
    refetchInterval: taskID && !terminal ? 2_000 : false,
  });
  const [downloadError, setDownloadError] = useState("");
  if (!taskID) return <EmptyOutcome label="选择一个已运行的任务以查看产物" />;
  if (artifacts.isPending) return <div className="center-state"><LoaderCircle className="size-4 animate-spin" />正在读取产物…</div>;
  if (artifacts.isError) return <div className="outcome-read-error"><p>{errorMessage(artifacts.error)}</p><Button tone="quiet" size="sm" onClick={() => void artifacts.refetch()} leadingIcon={<RefreshCw className="size-3" />}>重新读取</Button></div>;
  if (!terminal && !artifacts.data?.artifacts?.length) return <div className="center-state"><LoaderCircle className="size-4 animate-spin" />正在收集并上传产物…</div>;
  if (!artifacts.data?.artifacts?.length) return <EmptyOutcome label="本次任务尚未生成可下载产物" />;
  return <>{artifacts.data.artifacts.map((artifact) => <div className="artifact" key={artifact.id}><div className="artifact-icon"><FileArchive className="size-4" /></div><div><strong>{artifactName(artifact)}</strong><small>{formatBytes(artifact.size)} · {artifactLabel(artifact.content_type)}</small></div><IconButton disabled={artifact.state !== "available"} onClick={async () => { setDownloadError(""); try { await downloadArtifact(artifact); } catch (reason) { setDownloadError(errorMessage(reason)); } }} aria-label={`下载 ${artifactName(artifact)}`}><Download className="size-4" /></IconButton></div>)}{downloadError && <p className="artifact-inline-error" role="alert">{downloadError}</p>}</>;
}

function availableArtifacts(artifacts?: Artifact[]) {
  return artifacts?.filter((artifact) => artifact.state === "available") ?? [];
}

function artifactName(artifact: Artifact) {
  return artifact.name ?? artifact.path ?? artifact.id;
}

function artifactLabel(contentType?: string) {
  const normalized = (contentType ?? "").split(";", 1)[0];
  if (normalized === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "PowerPoint";
  if (normalized === "application/pdf") return "PDF";
  if (normalized === "application/zip") return "ZIP";
  if (normalized.startsWith("image/")) return "图片";
  return normalized || "文件";
}

function formatBytes(value?: number) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

async function downloadArtifact(artifact: Artifact) {
  const descriptor = await api.artifactDownload(artifact.id);
  const url = new URL(descriptor.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("产物下载地址无效");
  const anchor = document.createElement("a");
  anchor.href = url.toString();
  anchor.download = descriptor.filename ?? artifact.name ?? "artifact";
  anchor.rel = "noopener noreferrer";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : "产物下载失败，请稍后重试。";
}

function EmptyOutcome({ label }: { label: string }) {
  return <div className="empty-outcome"><MoreHorizontal className="size-5" />{label}</div>;
}
