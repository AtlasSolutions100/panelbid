import { Badge } from "@/components/ui/badge"
import { JobStatus } from "@workspace/api-client-react"

export function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case JobStatus.new:
      return <Badge variant="default" className="bg-blue-500 hover:bg-blue-600 text-white">NEW</Badge>
    case JobStatus.analyzing:
      return <Badge variant="secondary" className="bg-purple-100 text-purple-800 hover:bg-purple-200 border-purple-200">ANALYZING</Badge>
    case JobStatus.needs_review:
      return <Badge variant="destructive" className="bg-amber-100 text-amber-800 hover:bg-amber-200 border-amber-200">NEEDS REVIEW</Badge>
    case JobStatus.takeoff:
      return <Badge variant="secondary" className="bg-indigo-100 text-indigo-800 hover:bg-indigo-200 border-indigo-200">TAKEOFF</Badge>
    case JobStatus.proposal_ready:
      return <Badge variant="default" className="bg-emerald-500 hover:bg-emerald-600 text-white">PROPOSAL READY</Badge>
    case JobStatus.discarded:
      return <Badge variant="outline" className="text-muted-foreground border-muted-foreground/30">DISCARDED</Badge>
    default:
      return <Badge variant="outline">{status.toUpperCase()}</Badge>
  }
}

export const STATUS_LABELS: Record<string, string> = {
  [JobStatus.new]: "New",
  [JobStatus.analyzing]: "Analyzing",
  [JobStatus.needs_review]: "Needs Review",
  [JobStatus.takeoff]: "Takeoff",
  [JobStatus.proposal_ready]: "Proposal Ready",
  [JobStatus.discarded]: "Discarded",
}
