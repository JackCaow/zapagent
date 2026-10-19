import { Readable, Writable } from "node:stream"
import { ndJsonStream } from "@agentclientprotocol/sdk"
import { createAcpApp, ZapAcpAgent } from "./agent.js"

export async function serveAcp(): Promise<void> {
  console.log = (...args) => console.error(...args)
  const server = new ZapAcpAgent()
  const stream = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>, { maxMessageBytes: 16 * 1024 * 1024 })
  const connection = createAcpApp(server).connect(stream)
  const stop = () => connection.close()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try { await connection.closed }
  finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop)
    await server.dispose()
  }
}
