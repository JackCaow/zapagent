import { useCallback, useEffect, useRef, useState } from "react"

/** A single, cancellable UI interaction. Old resolvers cannot settle a newer
 * request; unmount settles the waiter without updating an unmounted view. */
export function usePendingInteraction<Value, Answer>() {
  const [pending, setPending] = useState<{ value: Value; resolve: (answer: Answer) => void } | null>(null)
  const cancelRef = useRef<(() => void) | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancelRef.current?.()
    }
  }, [])

  const request = useCallback((value: Value, cancelled: Answer, signal?: AbortSignal): Promise<Answer> => {
    if (!mounted.current || signal?.aborted) return Promise.resolve(cancelled)
    cancelRef.current?.()
    return new Promise((resolve) => {
      const settle = (answer: Answer) => {
        if (cancelRef.current !== cancel) return
        cancelRef.current = null
        signal?.removeEventListener("abort", cancel)
        if (mounted.current) setPending(null)
        resolve(answer)
      }
      const cancel = () => settle(cancelled)
      cancelRef.current = cancel
      signal?.addEventListener("abort", cancel, { once: true })
      setPending({ value, resolve: settle })
    })
  }, [])

  return { pending, request }
}
