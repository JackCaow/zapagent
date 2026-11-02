import { useMemo } from "react"
import type { AskUserAnswer, AskUserCallbacks, AskUserQuestion } from "../../zapsdk/index.js"

import { usePendingInteraction } from "./usePendingInteraction.js"

export interface PendingQuestions {
  questions: AskUserQuestion[]
  /** null = the user dismissed the questions. */
  resolve: (answers: AskUserAnswer[] | null) => void
}

export interface UseAskUserResult {
  /** Pass to `buildAgentObjects(... askUserCallbacks)`. Stable reference. */
  askUserCallbacks: AskUserCallbacks
  /** Non-null while the model waits for an answer; the App renders <AskUserBar /> against it. */
  pendingQuestions: PendingQuestions | null
}

/** One question set at a time: the tool executor runs `ask_user_question`
 *  exclusively, so a second `ask` can only arrive after the first resolved. */
export function useAskUser(): UseAskUserResult {
  const { pending, request } = usePendingInteraction<AskUserQuestion[], AskUserAnswer[] | null>()
  const askUserCallbacks = useMemo<AskUserCallbacks>(() => ({
    ask: (questions, signal) => request(questions, null, signal),
  }), [request])
  // Keep identity stable across renders; App effects depend on this value.
  const pendingQuestions = useMemo(
    () => pending ? { questions: pending.value, resolve: pending.resolve } : null,
    [pending],
  )
  return { askUserCallbacks, pendingQuestions }
}
