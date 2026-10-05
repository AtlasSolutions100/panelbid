/**
 * The server sends one plain sentence with every failure ({ message }).
 * The page shows that sentence, not a bare "failed".
 */
import { useCallback, useState } from "react"

interface ServerBody {
  code?: unknown
  message?: unknown
  fileName?: unknown
}

function sentenceOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const { code, message, fileName } = body as ServerBody
  if (typeof message !== "string" || message.trim() === "") return null
  // A lost plan is named, so the person knows which one to upload again.
  if (code === "plan_file_gone" && typeof fileName === "string" && fileName !== "") {
    return `${fileName}: ${message}`
  }
  return message
}

/** The sentence of a failed API call (the generated client keeps the body in `data`). */
export function serverSentence(err: unknown, fallback: string): string {
  const data = (err as { data?: unknown } | null)?.data
  return sentenceOf(data) ?? fallback
}

/** The sentence of a failed fetch() response. */
export async function responseSentence(response: Response, fallback: string): Promise<string> {
  try {
    return sentenceOf(await response.json()) ?? fallback
  } catch {
    return fallback
  }
}

export interface Notice {
  /** "failed": the last try did not work. "warning": it worked, with something left out. */
  kind: "failed" | "warning"
  text: string
}

/**
 * The last failure of one action on one job. It stays on the screen (also
 * after a reload, in this tab) until the next try clears it.
 */
export function useNotice(key: string): [Notice | null, (notice: Notice | null) => void] {
  const storageKey = `panelbid.notice.${key}`
  const [notice, setNotice] = useState<Notice | null>(() => {
    try {
      const raw = window.sessionStorage.getItem(storageKey)
      const parsed: unknown = raw ? JSON.parse(raw) : null
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as Notice).text === "string" &&
        ((parsed as Notice).kind === "failed" || (parsed as Notice).kind === "warning")
      ) {
        return parsed as Notice
      }
    } catch {
      // no storage: the notice simply does not outlive a reload
    }
    return null
  })
  const set = useCallback(
    (next: Notice | null) => {
      setNotice(next)
      try {
        if (next) window.sessionStorage.setItem(storageKey, JSON.stringify(next))
        else window.sessionStorage.removeItem(storageKey)
      } catch {
        // no storage
      }
    },
    [storageKey],
  )
  return [notice, set]
}
