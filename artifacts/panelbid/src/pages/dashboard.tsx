import { useListJobs, useGetJobsSummary, useGetGmailStatus, getListJobsQueryKey, getGetJobsSummaryQueryKey, getGetGmailStatusQueryKey, JobStatus } from "@workspace/api-client-react"
import { Layout } from "@/components/layout"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AddJobDialog } from "@/components/add-job-dialog"
import { StatusBadge } from "@/components/status-badge"
import { formatDate } from "@/lib/format"
import { Link } from "wouter"
import { Inbox, FileText, Activity, AlertCircle, FileCheck, XCircle } from "lucide-react"

function SummaryCards() {
  const { data: summary } = useGetJobsSummary({
    query: { queryKey: getGetJobsSummaryQueryKey() }
  })

  if (!summary) return null

  const stats = [
    { label: "New", value: summary.byStatus.new, icon: Inbox, color: "text-blue-500" },
    { label: "Analyzing", value: summary.byStatus.analyzing, icon: Activity, color: "text-purple-500" },
    { label: "Needs Review", value: summary.byStatus.needs_review, icon: AlertCircle, color: "text-amber-500" },
    { label: "Takeoff", value: summary.byStatus.takeoff, icon: FileText, color: "text-indigo-500" },
    { label: "Proposal Ready", value: summary.byStatus.proposal_ready, icon: FileCheck, color: "text-emerald-500" },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
      {stats.map((stat) => {
        const Icon = stat.icon
        return (
          <Card key={stat.label} className="border-border/50 shadow-sm">
            <CardContent className="p-4 flex flex-col items-center text-center">
              <Icon className={`h-6 w-6 mb-2 ${stat.color} opacity-80`} />
              <div className="text-2xl font-mono font-bold">{stat.value}</div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mt-1">{stat.label}</div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

/**
 * One line while Gmail is not bringing bids in: it needs a reconnect, or it
 * was never connected. Nothing is shown while the answer is not known.
 */
function GmailLine() {
  const { data: gmail } = useGetGmailStatus({
    query: { queryKey: getGetGmailStatusQueryKey() }
  })
  if (!gmail) return null
  if (gmail.connected && !gmail.needsReconnect) return null
  return (
    <div
      role="status"
      data-testid="gmail-line"
      className="mb-6 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800"
    >
      <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
      <p>
        {gmail.connected
          ? "No new bid e-mails are coming in: Gmail needs to be reconnected. "
          : "No new bid e-mails are coming in: Gmail is not connected. "}
        <Link href="/settings" className="font-medium underline">Open Settings</Link>
      </p>
    </div>
  )
}

export default function Dashboard() {
  const { data: jobs, isLoading } = useListJobs({
    query: { queryKey: getListJobsQueryKey() }
  })

  return (
    <Layout>
      <GmailLine />
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Job Queue</h1>
          <p className="text-muted-foreground mt-1">Manage bids and track active projects.</p>
        </div>
        <AddJobDialog />
      </div>

      <SummaryCards />

      <Card className="border-border/60 shadow-sm overflow-hidden">
        <CardHeader className="bg-muted/30 border-b border-border/40 pb-4">
          <CardTitle className="text-lg flex items-center justify-between">
            <span>Active Pipeline</span>
            <span className="text-xs font-mono font-normal text-muted-foreground px-2 py-1 bg-background rounded border">{jobs?.length || 0} JOBS</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading queue...</div>
          ) : jobs && jobs.length > 0 ? (
            <Table>
              <TableHeader className="bg-muted/20">
                <TableRow>
                  <TableHead className="w-[300px]">JOB NAME</TableHead>
                  <TableHead>LOCATION</TableHead>
                  <TableHead>SOURCE</TableHead>
                  <TableHead>ADDED</TableHead>
                  <TableHead className="text-right">STATUS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id} className="group relative">
                    <TableCell className="font-medium">
                      <Link href={`/jobs/${job.id}`} className="absolute inset-0 z-10" />
                      <span className="group-hover:text-primary transition-colors">{job.jobName}</span>
                      {job.fileCount > 0 && (
                        <span className="ml-2 inline-flex items-center text-xs text-muted-foreground bg-muted px-1.5 rounded font-mono">
                          <FileText className="h-3 w-3 mr-1" />
                          {job.fileCount}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <span className="block">{job.address}</span>
                      <span className="block text-xs">{job.city}</span>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-secondary/10 text-secondary-foreground uppercase tracking-wider">
                        {job.source}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm font-mono">
                      {formatDate(job.createdAt)}
                    </TableCell>
                    <TableCell className="text-right relative z-20">
                      <StatusBadge status={job.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="flex flex-col items-center justify-center p-12 text-center">
              <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
                <Inbox className="h-8 w-8 text-muted-foreground/50" />
              </div>
              <h3 className="text-lg font-semibold">Queue is empty</h3>
              <p className="text-muted-foreground max-w-sm mt-2 mb-6">
                There are no active jobs in the pipeline right now. Add a job manually to get started.
              </p>
              <AddJobDialog />
            </div>
          )}
        </CardContent>
      </Card>
    </Layout>
  )
}
