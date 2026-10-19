import { describe, it, expect, beforeEach } from "bun:test"
import {
  enqueue,
  dequeueAll,
  popAllForEditing,
  clearQueue,
  subscribeToQueue,
  getQueueSnapshot,
  getQueueLength,
  hasQueue,
  queuedCommandPreview,
  _resetForTest,
  type QueuedCommand,
  type PendingImage,
} from "../src/queue/inputQueue.js"

beforeEach(() => {
  _resetForTest()
})

const fakeImage = (id: number): PendingImage => ({
  id,
  content: {
    type: "image",
    filePath: `/tmp/fake-${id}.png`,
    mediaType: "image/png",
    source: "test",
  },
})

const cmd = (text: string, opts?: Partial<QueuedCommand>): QueuedCommand => ({
  text,
  displayForm: opts?.displayForm ?? text,
  restoreText: opts?.restoreText,
  pastedContents: opts?.pastedContents,
  images: opts?.images,
})

describe("inputQueue:basic operations", () => {
  it("starts empty", () => {
    expect(getQueueLength()).toBe(0)
    expect(hasQueue()).toBe(false)
    expect(getQueueSnapshot()).toEqual([])
  })

  it("enqueue increases length and snapshot", () => {
    enqueue(cmd("hello"))
    expect(getQueueLength()).toBe(1)
    expect(hasQueue()).toBe(true)
    const snap = getQueueSnapshot()
    expect(snap.length).toBe(1)
    expect(snap[0]?.text).toBe("hello")
  })

  it("dequeueAll returns FIFO order and empties queue", () => {
    enqueue(cmd("a"))
    enqueue(cmd("b"))
    enqueue(cmd("c"))
    const all = dequeueAll()
    expect(all.map(c => c.text)).toEqual(["a", "b", "c"])
    expect(getQueueLength()).toBe(0)
  })

  it("dequeueAll preserves optional restore text", () => {
    enqueue(cmd("model text\n\n<file_content>x</file_content>", {
      displayForm: "[Pasted #1 · 1 lines · 11 chars]",
      restoreText: "model text",
    }))
    const all = dequeueAll()
    expect(all[0]?.restoreText).toBe("model text")
  })

  it("dequeueAll preserves pasted contents for queued long-paste turns", () => {
    enqueue(cmd("[Pasted #1 · 1 lines · 11 chars]", {
      pastedContents: { "1": "model text" },
    }))

    const all = dequeueAll()

    expect(all[0]?.pastedContents).toEqual({ "1": "model text" })
  })

  it("dequeueAll on empty queue returns empty array (no crash)", () => {
    expect(dequeueAll()).toEqual([])
  })

  it("clearQueue empties without returning items", () => {
    enqueue(cmd("a"))
    enqueue(cmd("b"))
    clearQueue()
    expect(getQueueLength()).toBe(0)
  })
})

describe("inputQueue:snapshot stability for useSyncExternalStore", () => {
  it("returns the same frozen reference across reads when queue is unchanged", () => {
    const s1 = getQueueSnapshot()
    const s2 = getQueueSnapshot()
    expect(s1).toBe(s2)  // reference equality — required by useSyncExternalStore
  })

  it("returns a new reference after enqueue", () => {
    const s1 = getQueueSnapshot()
    enqueue(cmd("x"))
    const s2 = getQueueSnapshot()
    expect(s1).not.toBe(s2)
  })

  it("returns a new reference after dequeueAll", () => {
    enqueue(cmd("x"))
    const s1 = getQueueSnapshot()
    dequeueAll()
    const s2 = getQueueSnapshot()
    expect(s1).not.toBe(s2)
  })

  it("snapshots are frozen (defense against external mutation)", () => {
    enqueue(cmd("x"))
    const s = getQueueSnapshot()
    expect(Object.isFrozen(s)).toBe(true)
  })
})

describe("inputQueue:subscribers", () => {
  it("notifies subscribers on enqueue", () => {
    let calls = 0
    const unsub = subscribeToQueue(() => { calls++ })
    enqueue(cmd("a"))
    expect(calls).toBe(1)
    enqueue(cmd("b"))
    expect(calls).toBe(2)
    unsub()
  })

  it("notifies on dequeueAll only when queue had items", () => {
    let calls = 0
    const unsub = subscribeToQueue(() => { calls++ })
    dequeueAll()  // empty → no notify
    expect(calls).toBe(0)
    enqueue(cmd("a"))
    expect(calls).toBe(1)
    dequeueAll()  // had items → notify
    expect(calls).toBe(2)
    unsub()
  })

  it("unsubscribe stops notifications", () => {
    let calls = 0
    const unsub = subscribeToQueue(() => { calls++ })
    enqueue(cmd("a"))
    expect(calls).toBe(1)
    unsub()
    enqueue(cmd("b"))
    expect(calls).toBe(1)  // no further notifications
  })
})

describe("inputQueue:popAllForEditing", () => {
  it("returns null on empty queue", () => {
    expect(popAllForEditing()).toBeNull()
  })

  it("joins displayForms with single newline", () => {
    enqueue(cmd("first", { displayForm: "first display" }))
    enqueue(cmd("second", { displayForm: "second display" }))
    const popped = popAllForEditing()
    expect(popped?.text).toBe("first display\nsecond display")
  })

  it("collects images in queue order", () => {
    enqueue(cmd("a", { images: [fakeImage(1)] }))
    enqueue(cmd("b"))  // no images
    enqueue(cmd("c", { images: [fakeImage(2), fakeImage(3)] }))
    const popped = popAllForEditing()
    expect(popped?.images.length).toBe(3)
    expect(popped?.images[0]?.id).toBe(1)
    expect(popped?.images[1]?.id).toBe(2)
    expect(popped?.images[2]?.id).toBe(3)
    expect(popped?.images[0]?.content.filePath).toBe("/tmp/fake-1.png")
  })

  it("empties the queue after popping", () => {
    enqueue(cmd("a"))
    enqueue(cmd("b"))
    popAllForEditing()
    expect(getQueueLength()).toBe(0)
    expect(getQueueSnapshot()).toEqual([])
  })

  it("preserves [Image #N] markers in the popped text (transcript fidelity)", () => {
    enqueue(cmd("hello", { displayForm: "hello [Image #1]" }))
    const popped = popAllForEditing()
    expect(popped?.text).toContain("[Image #1]")
  })

  it("renumbers duplicate image placeholders when popping multiple queued turns", () => {
    const first = fakeImage(1)
    const second = fakeImage(1)
    enqueue(cmd("first image", {
      displayForm: "first [Image #1]",
      images: [first],
    }))
    enqueue(cmd("second image", {
      displayForm: "second [Image #1]",
      images: [second],
    }))

    const popped = popAllForEditing()

    expect(popped?.text).toBe("first [Image #1]\nsecond [Image #2]")
    expect(popped?.images).toEqual([
      { ...first, id: 1 },
      { ...second, id: 2 },
    ])
  })

  it("starts popped image ids after the provided nextImageId", () => {
    const img = fakeImage(1)
    enqueue(cmd("queued image", {
      displayForm: "queued [Image #1]",
      images: [img],
    }))

    const popped = popAllForEditing({ nextImageId: 4 })

    expect(popped?.text).toBe("queued [Image #4]")
    expect(popped?.images).toEqual([{ ...img, id: 4 }])
  })

  it("falls back to positive image ids when the provided nextImageId is invalid", () => {
    const img = fakeImage(1)
    enqueue(cmd("queued image", {
      displayForm: "queued [Image #1]",
      images: [img],
    }))

    const popped = popAllForEditing({ nextImageId: Number.POSITIVE_INFINITY })

    expect(popped?.text).toBe("queued [Image #1]")
    expect(popped?.images).toEqual([{ ...img, id: 1 }])
  })

  it("does not rewrite non-canonical image placeholder ids", () => {
    const img = fakeImage(1)
    enqueue(cmd("queued image", {
      displayForm: "queued [Image #01]",
      images: [img],
    }))

    const popped = popAllForEditing()

    expect(popped?.text).toBe("queued [Image #01]")
    expect(popped?.images).toEqual([{ ...img, id: 1 }])
  })

  it("returns pasted contents so popped long-paste placeholders can re-expand", () => {
    enqueue(cmd("first full paste", {
      displayForm: "[Pasted #1 · 1 lines · 16 chars]",
      pastedContents: { "1": "first full paste" },
    }))
    enqueue(cmd("second full paste", {
      displayForm: "[Pasted #2 · 1 lines · 17 chars]",
      pastedContents: { "2": "second full paste" },
    }))

    const popped = popAllForEditing()

    expect(popped?.text).toBe("[Pasted #1 · 1 lines · 16 chars]\n[Pasted #2 · 1 lines · 17 chars]")
    expect(popped?.pastedContents).toEqual({
      "1": "first full paste",
      "2": "second full paste",
    })
  })

  it("renumbers duplicate pasted placeholders when popping multiple queued turns", () => {
    enqueue(cmd("first full paste", {
      displayForm: "[Pasted #1 · 1 lines · 16 chars]",
      pastedContents: { "1": "first full paste" },
    }))
    enqueue(cmd("second full paste", {
      displayForm: "[Pasted #1 · 1 lines · 17 chars]",
      pastedContents: { "1": "second full paste" },
    }))

    const popped = popAllForEditing()

    expect(popped?.text).toBe("[Pasted #1 · 1 lines · 16 chars]\n[Pasted #2 · 1 lines · 17 chars]")
    expect(popped?.pastedContents).toEqual({
      "1": "first full paste",
      "2": "second full paste",
    })
  })

  it("keeps duplicate pasted placeholders in one queued turn mapped to one blob", () => {
    enqueue(cmd("full paste and full paste", {
      displayForm: "[Pasted #1 · 1 lines · 10 chars]\nagain [Pasted #1 · 1 lines · 10 chars]",
      pastedContents: { "1": "full paste" },
    }))

    const popped = popAllForEditing()

    expect(popped?.text).toBe("[Pasted #1 · 1 lines · 10 chars]\nagain [Pasted #1 · 1 lines · 10 chars]")
    expect(popped?.pastedContents).toEqual({ "1": "full paste" })
  })

  it("starts popped paste ids after the provided nextPasteId", () => {
    enqueue(cmd("queued paste", {
      displayForm: "[Pasted #1 · 1 lines · 12 chars]",
      pastedContents: { "1": "queued paste" },
    }))

    const popped = popAllForEditing({ nextPasteId: 4 })

    expect(popped?.text).toBe("[Pasted #4 · 1 lines · 12 chars]")
    expect(popped?.pastedContents).toEqual({ "4": "queued paste" })
  })

  it("falls back to positive pasted ids when the provided nextPasteId is invalid", () => {
    enqueue(cmd("queued paste", {
      displayForm: "[Pasted #1 · 1 lines · 12 chars]",
      pastedContents: { "1": "queued paste" },
    }))

    const popped = popAllForEditing({ nextPasteId: Number.NaN })

    expect(popped?.text).toBe("[Pasted #1 · 1 lines · 12 chars]")
    expect(popped?.pastedContents).toEqual({ "1": "queued paste" })
  })

  it("does not rehydrate non-canonical pasted placeholder ids", () => {
    enqueue(cmd("queued paste", {
      displayForm: "[Pasted #01 · 1 lines · 12 chars]",
      pastedContents: { "01": "queued paste" },
    }))

    const popped = popAllForEditing()

    expect(popped?.text).toBe("[Pasted #01 · 1 lines · 12 chars]")
    expect(popped?.pastedContents).toEqual({})
  })

  it("recomputes pasted placeholder metadata from the preserved content", () => {
    enqueue(cmd("first\nsecond\nthird", {
      displayForm: "[Pasted #1 · 1 lines · 999 chars]",
      pastedContents: { "1": "first\nsecond\nthird" },
    }))

    const popped = popAllForEditing()

    expect(popped?.text).toBe("[Pasted #1 · 3 lines · 18 chars]")
    expect(popped?.pastedContents).toEqual({ "1": "first\nsecond\nthird" })
  })

  it("recomputes pasted placeholder line counts from CR-only preserved content", () => {
    enqueue(cmd("first\rsecond\rthird", {
      displayForm: "[Pasted #1 · 1 lines · 999 chars]",
      pastedContents: { "1": "first\rsecond\rthird" },
    }))

    const popped = popAllForEditing()

    expect(popped?.text).toBe("[Pasted #1 · 3 lines · 18 chars]")
    expect(popped?.pastedContents).toEqual({ "1": "first\rsecond\rthird" })
  })

  it("recomputes pasted placeholder char counts by code point", () => {
    enqueue(cmd("emoji paste", {
      displayForm: "[Pasted #1 · 1 lines · 999 chars]",
      pastedContents: { "1": "a😀b" },
    }))

    const popped = popAllForEditing()

    expect("a😀b".length).toBe(4)
    expect(popped?.text).toBe("[Pasted #1 · 1 lines · 3 chars]")
    expect(popped?.pastedContents).toEqual({ "1": "a😀b" })
  })

  it("recovers pasted contents from restoreText when queued metadata is missing", () => {
    enqueue(cmd("ask full pasted body now", {
      displayForm: "ask [Pasted #1 · 1 lines · 999 chars] now",
      restoreText: "ask full pasted body now",
    }))

    const popped = popAllForEditing({ nextPasteId: 4 })

    expect(popped?.text).toBe("ask [Pasted #4 · 1 lines · 16 chars] now")
    expect(popped?.pastedContents).toEqual({ "4": "full pasted body" })
  })

  it("recovers restoreText pastes whose content contains the display boundary", () => {
    enqueue(cmd("ask body now inside paste now", {
      displayForm: "ask [Pasted #1 · 1 lines · 21 chars] now",
      restoreText: "ask body now inside paste now",
    }))

    const popped = popAllForEditing()

    expect(popped?.text).toBe("ask [Pasted #1 · 1 lines · 21 chars] now")
    expect(popped?.pastedContents).toEqual({ "1": "body now inside paste" })
  })

  it("recovers restoreText pastes whose placeholder char count used code points", () => {
    enqueue(cmd("ask 😀 now inside paste now", {
      displayForm: "ask [Pasted #1 · 1 lines · 18 chars] now",
      restoreText: "ask 😀 now inside paste now",
    }))

    const popped = popAllForEditing()

    expect(popped?.text).toBe("ask [Pasted #1 · 1 lines · 18 chars] now")
    expect(popped?.pastedContents).toEqual({ "1": "😀 now inside paste" })
  })

  it("does not infer pasted contents when restoreText no longer matches the display boundaries", () => {
    enqueue(cmd("rendered prompt", {
      displayForm: "ask [Pasted #1 · 1 lines · 999 chars] now",
      restoreText: "different full pasted body text",
    }))

    const popped = popAllForEditing()

    expect(popped?.text).toBe("ask [Pasted #1 · 1 lines · 999 chars] now")
    expect(popped?.pastedContents).toEqual({})
  })

  it("restores MCP prompt queued paste and image metadata for editing", () => {
    const img = fakeImage(7)
    enqueue(cmd("server rendered prompt", {
      displayForm: '/mcp.docs.summarize text="[Pasted #1 · 1 lines · 999 chars]" [Image #7]',
      restoreText: '/mcp.docs.summarize text="first\nsecond"',
      pastedContents: { "1": "first\nsecond" },
      images: [img],
    }))

    const popped = popAllForEditing()

    expect(popped?.text).toBe('/mcp.docs.summarize text="[Pasted #1 · 2 lines · 12 chars]" [Image #1]')
    expect(popped?.pastedContents).toEqual({ "1": "first\nsecond" })
    expect(popped?.images).toEqual([{ ...img, id: 1 }])
  })

  it("recovers unquoted MCP prompt paste restore text without swallowing following args", () => {
    enqueue(cmd("server rendered prompt", {
      displayForm: "/mcp.docs.summarize text=[Pasted #1 · 2 lines · 12 chars] mode=fast",
      restoreText: "/mcp.docs.summarize text=first\nsecond mode=fast",
    }))

    const popped = popAllForEditing()

    expect(popped?.text).toBe("/mcp.docs.summarize text=[Pasted #1 · 2 lines · 12 chars] mode=fast")
    expect(popped?.pastedContents).toEqual({ "1": "first\nsecond" })
  })

  it("notifies subscribers on pop", () => {
    let calls = 0
    const unsub = subscribeToQueue(() => { calls++ })
    enqueue(cmd("a"))
    calls = 0  // reset
    popAllForEditing()
    expect(calls).toBe(1)
    unsub()
  })
})

describe("inputQueue:image carry-through (regression for P1)", () => {
  // The original bug: queued message stored only `string`, so attached
  // images were silently dropped on dispatch and the next live submit
  // got the previous message's images by mistake. The new schema
  // carries images per-command end-to-end.
  it("dequeue returns the same image references that were enqueued", () => {
    const img1 = fakeImage(1)
    const img2 = fakeImage(2)
    enqueue(cmd("first",  { images: [img1] }))
    enqueue(cmd("second", { images: [img2] }))
    const all = dequeueAll()
    expect(all[0]?.images).toEqual([img1])
    expect(all[1]?.images).toEqual([img2])
  })

  it("commands without images stay undefined (no accidental cross-pollination)", () => {
    enqueue(cmd("with-image", { images: [fakeImage(1)] }))
    enqueue(cmd("without-image"))
    const all = dequeueAll()
    expect(all[0]?.images).toBeDefined()
    expect(all[1]?.images).toBeUndefined()
  })
})

describe("inputQueue:queuedCommandPreview", () => {
  it("keeps single-line queued text unchanged", () => {
    expect(queuedCommandPreview(cmd("hello"))).toBe("hello")
  })

  it("summarizes multi-line queued text instead of silently showing only the first line", () => {
    const preview = queuedCommandPreview(cmd("full model text", {
      displayForm: "first line\nsecond line\nthird line",
    }))

    expect(preview).toBe("first line … (3 lines, 33 chars queued)")
  })

  it("summarizes CR-only queued text as logical multi-line input", () => {
    const preview = queuedCommandPreview(cmd("full model text", {
      displayForm: "first line\rsecond line\rthird line",
    }))

    expect(preview).toBe("first line … (3 lines, 33 chars queued)")
  })

  it("counts queued preview chars by code point", () => {
    const preview = queuedCommandPreview(cmd("full model text", {
      displayForm: "a😀\nb",
    }))

    expect("a😀\nb".length).toBe(5)
    expect(preview).toBe("a😀 … (2 lines, 4 chars queued)")
  })
})
