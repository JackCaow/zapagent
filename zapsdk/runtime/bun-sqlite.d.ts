declare module "bun:sqlite" {
  export interface SQLQueryBindings {
    [key: string]: string | number | bigint | boolean | Uint8Array | null;
  }

  export interface Statement<TRow, TParams extends readonly unknown[]> {
    get(...params: TParams): TRow | null;
    all(...params: TParams): TRow[];
    run(...params: TParams): unknown;
  }

  export class Database {
    constructor(
      filename: string,
      options?: { create?: boolean; readwrite?: boolean; readonly?: boolean; strict?: boolean },
    );
    exec(sql: string): void;
    query<TRow = unknown, TParams extends readonly unknown[] = readonly unknown[]>(
      sql: string,
    ): Statement<TRow, TParams>;
    transaction<T extends (...args: never[]) => unknown>(callback: T): T;
    close(throwOnError?: boolean): void;
  }
}
