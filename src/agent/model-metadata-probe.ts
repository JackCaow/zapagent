import { createInterface } from "node:readline"
import { createLocalProcessBroker, terminateProcessTreeWithGrace } from "../../zapsdk/execution/process.js"

interface JsonLines {
  send: (message: object) => void
  receive: (match: (message: Record<string, any>) => boolean) => Promise<Record<string, any>>
}

/** Metadata inspection runs on a private, short-lived stdio connection. */
export async function probeModelMetadata<T>(
  cli: { command: string; args: string[] }, cwd: string, signal: AbortSignal,
  inspect: (protocol: JsonLines) => Promise<T>, environment?: Record<string, string>,
): Promise<T> {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(8000)])
  const child = createLocalProcessBroker(lifetime).spawnCommand(cli.command, cli.args, {
    cwd, hostHome: true, stdin: "pipe", environment,
  })
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()))
  child.on("error", () => {})
  child.stdin!.on("error", () => {})
  child.stderr!.resume()
  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity })
  const input = lines[Symbol.asyncIterator]()
  try {
    return await inspect({
      send: message => child.stdin!.write(JSON.stringify(message) + "\n"),
      async receive(match) {
        for (;;) {
          const next = await input.next()
          lifetime.throwIfAborted()
          if (next.done) throw new Error("Agent closed its model metadata connection")
          let message
          try { message = JSON.parse(next.value) } catch { continue }
          if (message && typeof message === "object" && match(message)) return message
        }
      },
    })
  } finally {
    lines.close()
    child.stdin!.end()
    if (child.pid && child.exitCode === null && child.signalCode === null) terminateProcessTreeWithGrace(child)
    await closed
  }
}
