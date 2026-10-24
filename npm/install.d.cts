export interface BinaryOptions {
  version?: string
  platform?: string
  arch?: string
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
}
export function ensureBinary(options?: BinaryOptions): Promise<string>
