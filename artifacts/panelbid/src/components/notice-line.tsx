import { AlertCircle, AlertTriangle } from "lucide-react"
import type { Notice } from "@/lib/server-words"

/**
 * The last failure (or the "something was left out" note) of an action,
 * kept on the job until the next try. A toast alone goes away.
 */
export function NoticeLine({ notice, testId }: { notice: Notice | null; testId: string }) {
  if (!notice) return null
  const failed = notice.kind === "failed"
  const Icon = failed ? AlertCircle : AlertTriangle
  return (
    <div
      role={failed ? "alert" : "status"}
      data-testid={testId}
      data-kind={notice.kind}
      className={`flex items-start gap-2 border-b px-4 py-3 text-sm ${
        failed
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-amber-500/30 bg-amber-500/10 text-amber-800"
      }`}
    >
      <Icon className="h-4 w-4 mt-0.5 shrink-0" />
      <p>{notice.text}</p>
    </div>
  )
}
