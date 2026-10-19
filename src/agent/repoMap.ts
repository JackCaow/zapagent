import { RepoIndex, type RepoMapResult } from "../../zapsdk/repo-index/index.js";

const indexes = new Map<string, Promise<RepoIndex>>();

export interface RepoMapAttachmentResult extends RepoMapResult {
  refresh: {
    indexed: number;
    reused: number;
    removed: number;
    skipped: number;
  };
  tokenBudget: number;
}

function repoMapTokenBudget(contextWindow?: number): number {
  if (!contextWindow || !Number.isFinite(contextWindow)) return 2_000;
  return Math.max(512, Math.min(3_000, Math.floor(contextWindow * 0.035)));
}

export async function buildRepoMapAttachment(
  root: string,
  query: string,
  contextWindow?: number,
): Promise<RepoMapAttachmentResult> {
  let pending = indexes.get(root);
  if (!pending) {
    pending = RepoIndex.open(root);
    indexes.set(root, pending);
  }
  const index = await pending;
  const refresh = await index.refresh();
  const tokenBudget = repoMapTokenBudget(contextWindow);
  return {
    ...index.map(query, tokenBudget),
    refresh: {
      indexed: refresh.indexed,
      reused: refresh.reused,
      removed: refresh.removed,
      skipped: refresh.skipped,
    },
    tokenBudget,
  };
}
