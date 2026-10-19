import { useMemo, useState } from "react"
import type { AskUserAnswer, AskUserCallbacks, AskUserQuestion } from "../../zapsdk/index.js"

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
  const [pendingQuestions, setPending] = useState<PendingQuestions | null>(null)
  const askUserCallbacks = useMemo<AskUserCallbacks>(() => ({
    ask: (questions) => new Promise((resolve) => {
      setPending({
        questions,
        resolve: (answers) => { setPending(null); resolve(answers) },
      })
    }),
  }), [])
  return { askUserCallbacks, pendingQuestions }
}
