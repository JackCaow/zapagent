import {
  AppServer,
  HostProtocolService,
  HostRuntimeRegistry,
  type HostControllableRuntime,
  type AppServerEndpoint,
} from "../../zapsdk/index.js"

export const hostRuntimeRegistry = new HostRuntimeRegistry()
export const hostProtocolService = new HostProtocolService(hostRuntimeRegistry)
let appServer: AppServer | undefined
let endpoint: AppServerEndpoint | undefined

export function registerHostRuntime(runtime: HostControllableRuntime): () => void {
  return hostRuntimeRegistry.register(runtime)
}

export async function startHostProtocolServerIfEnabled(): Promise<AppServerEndpoint | undefined> {
  if (endpoint) return endpoint
  const raw = process.env.ZAPCODE_HOST_PROTOCOL_PORT
  if (raw === undefined) return undefined
  if (!/^\d{1,5}$/u.test(raw)) {
    throw new Error("ZAPCODE_HOST_PROTOCOL_PORT must be an integer between 0 and 65535")
  }
  const port = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("ZAPCODE_HOST_PROTOCOL_PORT must be an integer between 0 and 65535")
  }
  appServer = new AppServer({ service: hostProtocolService, port })
  endpoint = await appServer.start()
  return endpoint
}

export async function stopHostProtocolServer(): Promise<void> {
  const server = appServer
  appServer = undefined
  endpoint = undefined
  await server?.close()
}
