declare module "bun:test" {
  type TestResult = void | Promise<void>
  type TestCallback = () => TestResult
  type TestFn = ((name: string, fn: TestCallback, timeout?: number) => void) & {
    skip: (name: string, fn?: TestCallback, timeout?: number) => void
    only: (name: string, fn: TestCallback, timeout?: number) => void
  }
  type HookFn = (fn: TestCallback, timeout?: number) => void

  interface Matchers<T = unknown> {
    readonly not: Matchers<T>
    readonly resolves: Matchers<Awaited<T>>
    readonly rejects: Matchers<Awaited<T>>
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toContain(expected: unknown): void
    toMatch(expected: string | RegExp): void
    toMatchObject(expected: Record<string, unknown>): void
    toThrow(expected?: string | RegExp | Error | (new (...args: never[]) => Error)): void
    toBeCloseTo(expected: number, precision?: number): void
    toBeDefined(): void
    toBeUndefined(): void
    toBeNull(): void
    toBeTruthy(): void
    toBeInstanceOf(expected: new (...args: never[]) => unknown): void
    toHaveLength(expected: number): void
    toBeGreaterThan(expected: number | bigint): void
    toBeGreaterThanOrEqual(expected: number | bigint): void
    toBeLessThan(expected: number | bigint): void
    toBeLessThanOrEqual(expected: number | bigint): void
  }

  type ExpectFn = (<T>(actual: T) => Matchers<T>) & {
    unreachable(message?: string): never
  }
  type AnyFn = (...args: never[]) => unknown
  type MockedFunction<T extends (...args: never[]) => unknown> = T & {
    mock: { calls: Parameters<T>[] }
    mockImplementation(fn: T): MockedFunction<T>
    mockReturnValue(value: ReturnType<T>): MockedFunction<T>
    mockResolvedValue(value: Awaited<ReturnType<T>>): MockedFunction<T>
    mockRejectedValue(value: unknown): MockedFunction<T>
    mockClear(): void
    mockRestore(): void
  }
  type MockFactory = (<T extends AnyFn>(fn?: T) => MockedFunction<T>) & {
    module(path: string, factory: () => Record<string, unknown>): void
  }

  export const describe: TestFn
  export const it: TestFn
  export const test: TestFn
  export const expect: ExpectFn
  export const beforeAll: HookFn
  export const afterAll: HookFn
  export const beforeEach: HookFn
  export const afterEach: HookFn
  export const mock: MockFactory
  export function spyOn<T extends object, K extends keyof T>(
    object: T,
    method: K,
  ): T[K] extends (...args: infer A) => infer R
    ? MockedFunction<(...args: A) => R>
    : never
}

interface ImportMeta {
  readonly dir: string
}

declare const Bun: {
  serve<T = unknown>(opts: {
    port?: number
    hostname?: string
    fetch: (
      req: Request,
      server: { upgrade(req: Request, opts?: { data?: T }): boolean },
    ) => Response | undefined | Promise<Response | undefined>
    websocket?: {
      open?(ws: { data: T; send(data: string | Buffer): unknown }): void
      close?(ws: { data: T; send(data: string | Buffer): unknown }): void
      message?(ws: { data: T; send(data: string | Buffer): unknown }, data: string | Buffer): void
    }
  }): { port: number; stop(): void }
}
