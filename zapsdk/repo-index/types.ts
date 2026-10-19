export const REPO_INDEX_SCHEMA_VERSION = 1 as const;

export interface RepoSymbol {
  name: string;
  kind: string;
  line: number;
  signature: string;
  exported: boolean;
}

export interface RepoFileRecord {
  path: string;
  bytes: number;
  mtimeMs: number;
  language: string;
  symbols: RepoSymbol[];
  imports: string[];
  isTest: boolean;
  changed: boolean;
}

export interface RepoIndexSnapshot {
  schemaVersion: typeof REPO_INDEX_SCHEMA_VERSION;
  root: string;
  revision: number;
  updatedAt: number;
  files: Record<string, RepoFileRecord>;
}

export interface RepoIndexRefreshReport {
  revision: number;
  discovered: number;
  indexed: number;
  reused: number;
  removed: number;
  skipped: number;
}

export interface RepoMapResult {
  text: string;
  selectedFiles: string[];
  estimatedTokens: number;
  truncated: boolean;
  revision: number;
}
