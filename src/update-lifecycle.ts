/** Keep the composer and queue paused until both preparation and commit finish. */
export async function restoreAfterUpdate<T>(options: {
  load: () => Promise<T>
  commit: (loaded: T) => void
  failed: () => void
  finished: () => void
}): Promise<void> {
  try { options.commit(await options.load()) }
  catch { options.failed() }
  finally { options.finished() }
}

/** Cleanup must complete before a replacement TUI inherits the terminal. */
export async function prepareUpdateRestart(options: {
  stopWatch: () => Promise<void>
  stopHost: () => Promise<void>
  stopRuntime: () => void
}): Promise<void> {
  await options.stopWatch()
  await options.stopHost()
  options.stopRuntime()
}
