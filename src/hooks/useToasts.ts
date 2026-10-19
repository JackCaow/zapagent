import { useCallback, useRef, useState } from "react"
import type { Toast } from "../ui/types.js"

interface ToastOpts {
  variant?: Toast["variant"]
  /** ms before auto-dismiss; default 2500. Set to 0 for sticky. */
  duration?: number
}

let _toastSeq = 0

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  // Keep references to live timers so a re-add of the "same" toast doesn't
  // leak handles or fire late (Ink unmount + remount race).
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const addToast = useCallback((text: string, opts?: ToastOpts) => {
    const id = ++_toastSeq
    const toast: Toast = { id, text, variant: opts?.variant }
    setToasts(prev => [...prev, toast])
    const duration = opts?.duration ?? 2500
    if (duration > 0) {
      const handle = setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id))
        timers.current.delete(id)
      }, duration)
      timers.current.set(id, handle)
    }
  }, [])

  const clearToasts = useCallback(() => {
    for (const h of timers.current.values()) clearTimeout(h)
    timers.current.clear()
    setToasts([])
  }, [])

  return { toasts, addToast, clearToasts }
}
