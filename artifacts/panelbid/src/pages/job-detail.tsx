import { useState, useRef, useEffect } from "react"
import { useRoute, Link, useLocation } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import { 
  useGetJob, 
  useUpdateJob, 
  useDeleteJob, 
  useListJobFiles, 
  useDeleteJobFile,
  useListPlanScans,
  useRescanJob,
  getGetJobQueryKey,
  getListJobFilesQueryKey,
  getListJobsQueryKey,
  getGetJobsSummaryQueryKey,
  getListPlanScansQueryKey,
  JobStatus,
  KeywordCategory,
  type PlanScanMatch,
} from "@workspace/api-client-react"
import { Layout } from "@/components/layout"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { StatusBadge, STATUS_LABELS } from "@/components/status-badge"
import { formatDate, formatDateTime, formatBytes } from "@/lib/format"
import { ArrowLeft, Trash2, Upload, FileText, Download, Building2, MapPin, Calendar, HardDrive, Clock, FileWarning, ScanSearch, RefreshCw, ScanLine, ChevronDown, Eye } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { RoomSpecsSection } from "@/components/room-specs"
import { TakeoffSection } from "@/components/takeoff"
import { ProposalSection } from "@/components/proposal"
import { PdfViewer } from "@/components/pdf-viewer"
import { NoticeLine } from "@/components/notice-line"
import { responseSentence, serverSentence, useNotice } from "@/lib/server-words"

// The same limit the server has (lib/planFileStore.ts).
const MAX_PLAN_FILE_MB = 50

export default function JobDetail() {
  const [, params] = useRoute("/jobs/:id")
  const id = params?.id ? parseInt(params.id, 10) : 0
  const [, setLocation] = useLocation()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [isUploading, setIsUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [viewingFile, setViewingFile] = useState<{ id: number; fileName: string } | null>(null)
  // True while the takeoff on screen differs from the saved one. The proposal
  // is only made from a saved takeoff, so it needs to know.
  const [takeoffUnsaved, setTakeoffUnsaved] = useState(false)
  // Why the last upload / the last keyword scan did not work. Each stays on
  // the job until the next try.
  const [uploadNotice, setUploadNotice] = useNotice(`upload.${id}`)
  const [scanNotice, setScanNotice] = useNotice(`scan.${id}`)

  const { data: job, isLoading: isLoadingJob } = useGetJob(id, {
    query: { enabled: !!id, queryKey: getGetJobQueryKey(id) }
  })

  const { data: files, isLoading: isLoadingFiles } = useListJobFiles(id, {
    query: { enabled: !!id, queryKey: getListJobFilesQueryKey(id) }
  })

  const { data: scans, isLoading: isLoadingScans } = useListPlanScans(id, {
    query: { enabled: !!id, queryKey: getListPlanScansQueryKey(id) }
  })

  const scanGroups = groupScans(scans ?? [])

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const updateJob = useUpdateJob()
  const deleteJob = useDeleteJob()
  const deleteFile = useDeleteJobFile()
  const rescanJob = useRescanJob()

  const handleRescan = () => {
    setScanNotice(null)
    rescanJob.mutate(
      { jobId: id },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: getListPlanScansQueryKey(id) })
          queryClient.invalidateQueries({ queryKey: getListJobFilesQueryKey(id) })
          // The server names a plan it had to leave out.
          if (result.warning) setScanNotice({ kind: "warning", text: result.warning })
          toast({
            title: "Scan complete",
            description: `${result.matchCount} match${result.matchCount === 1 ? "" : "es"} across ${result.filesScanned} file${result.filesScanned === 1 ? "" : "s"}${result.filesNeedingOcr > 0 ? ` — ${result.filesNeedingOcr} file(s) need OCR` : ""}`,
          })
        },
        onError: (err) => {
          const why = serverSentence(err, "The keyword scan did not work and the server did not say why. Try again.")
          setScanNotice({ kind: "failed", text: why })
          toast({ title: "Scan did not work", description: why, variant: "destructive" })
        }
      }
    )
  }

  const handleStatusChange = (newStatus: JobStatus) => {
    updateJob.mutate(
      { jobId: id, data: { status: newStatus } },
      {
        onSuccess: (updatedJob) => {
          queryClient.setQueryData(getGetJobQueryKey(id), updatedJob)
          queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() })
          queryClient.invalidateQueries({ queryKey: getGetJobsSummaryQueryKey() })
          toast({ title: "Status updated" })
        },
        onError: () => {
          toast({ title: "Failed to update status", variant: "destructive" })
        }
      }
    )
  }

  const handleDeleteJob = () => {
    deleteJob.mutate(
      { jobId: id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() })
          queryClient.invalidateQueries({ queryKey: getGetJobsSummaryQueryKey() })
          toast({ title: "Job deleted" })
          setLocation("/")
        },
        onError: () => {
          toast({ title: "Failed to delete job", variant: "destructive" })
        }
      }
    )
  }

  const handleDeleteFile = (fileId: number) => {
    deleteFile.mutate(
      { fileId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListJobFilesQueryKey(id) })
          toast({ title: "File deleted" })
        },
        onError: () => {
          toast({ title: "Failed to delete file", variant: "destructive" })
        }
      }
    )
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const refuse = (why: string) => {
      setUploadNotice({ kind: "failed", text: why })
      toast({ title: "Upload did not work", description: why, variant: "destructive" })
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      refuse("That file is not a PDF. Plans must be PDF files.")
      return
    }
    if (file.size > MAX_PLAN_FILE_MB * 1024 * 1024) {
      refuse(`This file is too big. The limit is ${MAX_PLAN_FILE_MB} MB.`)
      return
    }

    setUploadNotice(null)
    setIsUploading(true)
    try {
      const formData = new FormData()
      formData.append("file", file)

      const response = await fetch(`${import.meta.env.BASE_URL}api/jobs/${id}/files`, {
        method: "POST",
        body: formData,
      })

      if (!response.ok) {
        // The server says why, in one sentence.
        refuse(await responseSentence(response, "The upload did not work and the server did not say why. Try again."))
        return
      }

      queryClient.invalidateQueries({ queryKey: getListJobFilesQueryKey(id) })
      toast({ title: "File uploaded", description: "Keyword scan started automatically." })
      // Auto-scan runs server-side after upload; refresh results shortly after.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: getListPlanScansQueryKey(id) })
        queryClient.invalidateQueries({ queryKey: getListJobFilesQueryKey(id) })
      }, 4000)
    } catch (error) {
      refuse("The upload did not reach the server. Check your connection and try again.")
    } finally {
      setIsUploading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    }
  }

  if (isLoadingJob) {
    return <Layout><div className="p-8 text-center text-muted-foreground">Loading job details...</div></Layout>
  }

  if (!job) {
    return <Layout><div className="p-8 text-center text-destructive">Job not found</div></Layout>
  }

  return (
    <Layout>
      <div className="mb-6">
        <Link href="/" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Queue
        </Link>
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">{job.jobName}</h1>
            <p className="text-muted-foreground mt-1 flex items-center font-mono text-sm">
              <span className="bg-muted px-2 py-0.5 rounded mr-2">ID: {job.id}</span>
              Added {formatDate(job.createdAt)} via {job.source}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Select value={job.status} onValueChange={(val) => handleStatusChange(val as JobStatus)}>
              <SelectTrigger className="w-[180px] font-medium border-border/60">
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" className="text-destructive border-destructive/20 hover:bg-destructive hover:text-destructive-foreground">
                  <Trash2 className="h-4 w-4 mr-2" /> Delete
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete Job</DialogTitle>
                  <DialogDescription>
                    Are you sure you want to delete {job.jobName}? This action cannot be undone and will delete all associated files.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
                  <Button variant="destructive" onClick={handleDeleteJob}>Delete Job</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1 space-y-6">
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="bg-muted/30 border-b border-border/40 pb-4">
              <CardTitle className="text-lg">Job Details</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <dl className="divide-y divide-border/40 text-sm">
                <div className="p-4 grid grid-cols-3 gap-4">
                  <dt className="text-muted-foreground font-medium flex items-center col-span-1"><StatusBadge status={job.status} /></dt>
                  <dd className="col-span-2 font-medium flex items-center justify-end">Current Status</dd>
                </div>
                <div className="p-4 grid grid-cols-3 gap-4">
                  <dt className="text-muted-foreground flex items-center"><MapPin className="mr-2 h-4 w-4" /> Address</dt>
                  <dd className="col-span-2 font-medium text-right">{job.address}</dd>
                </div>
                <div className="p-4 grid grid-cols-3 gap-4">
                  <dt className="text-muted-foreground flex items-center"><Building2 className="mr-2 h-4 w-4" /> City</dt>
                  <dd className="col-span-2 font-medium text-right">{job.city}</dd>
                </div>
                <div className="p-4 grid grid-cols-3 gap-4">
                  <dt className="text-muted-foreground flex items-center"><HardDrive className="mr-2 h-4 w-4" /> Source</dt>
                  <dd className="col-span-2 font-medium text-right uppercase tracking-wider">{job.source}</dd>
                </div>
                <div className="p-4 grid grid-cols-3 gap-4">
                  <dt className="text-muted-foreground flex items-center"><Calendar className="mr-2 h-4 w-4" /> Created</dt>
                  <dd className="col-span-2 text-right font-mono">{formatDateTime(job.createdAt)}</dd>
                </div>
                <div className="p-4 grid grid-cols-3 gap-4">
                  <dt className="text-muted-foreground flex items-center"><Clock className="mr-2 h-4 w-4" /> Updated</dt>
                  <dd className="col-span-2 text-right font-mono">{formatDateTime(job.updatedAt)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>

        <div className="md:col-span-2">
          <Card className="border-border/60 shadow-sm h-full flex flex-col">
            <CardHeader className="bg-muted/30 border-b border-border/40 pb-4 flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-lg">Plan Documents</CardTitle>
                <CardDescription className="mt-1">Upload and manage PDFs for takeoff analysis.</CardDescription>
              </div>
              <div>
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  onChange={handleFileUpload} 
                  accept="application/pdf" 
                  className="hidden" 
                />
                <Button 
                  onClick={() => fileInputRef.current?.click()} 
                  disabled={isUploading}
                  size="sm"
                  className="font-mono uppercase tracking-wider text-xs"
                >
                  <Upload className="mr-2 h-4 w-4" /> {isUploading ? "Uploading..." : "Upload PDF"}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0 flex-1 flex flex-col">
              <NoticeLine notice={uploadNotice} testId="upload-notice" />
              {isLoadingFiles ? (
                <div className="p-8 text-center text-muted-foreground">Loading files...</div>
              ) : files && files.length > 0 ? (
                <ul className="divide-y divide-border/40">
                  {files.map((file) => (
                    <li key={file.id} className="p-4 hover:bg-muted/20 transition-colors flex items-center justify-between group">
                      <div className="flex items-start">
                        <FileText className="h-8 w-8 text-primary/80 mr-4 mt-0.5" />
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-sm">{file.fileName}</p>
                            {file.needsOcr && (
                              <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-600 text-[10px] font-mono uppercase tracking-wider gap-1">
                                <ScanLine className="h-3 w-3" /> Needs OCR
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center text-xs text-muted-foreground mt-1 space-x-3 font-mono">
                            <span>{formatBytes(file.fileSize)}</span>
                            <span>•</span>
                            <span>{formatDateTime(file.uploadedAt)}</span>
                            <span>•</span>
                            <span className="truncate max-w-[100px]" title={file.fileHash}>{file.fileHash.substring(0, 8)}...</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setViewingFile({ id: file.id, fileName: file.fileName })}
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        >
                          <Eye className="h-4 w-4" />
                          <span className="sr-only">View</span>
                        </Button>
                        <Button variant="ghost" size="icon" asChild className="h-8 w-8 text-muted-foreground hover:text-foreground">
                          <a href={`${import.meta.env.BASE_URL}api/files/${file.id}/download`} target="_blank" rel="noreferrer" download>
                            <Download className="h-4 w-4" />
                            <span className="sr-only">Download</span>
                          </a>
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          onClick={() => handleDeleteFile(file.id)}
                          className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="h-4 w-4" />
                          <span className="sr-only">Delete</span>
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
                  <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
                    <FileWarning className="h-8 w-8 text-muted-foreground/50" />
                  </div>
                  <h3 className="text-lg font-semibold">No documents uploaded</h3>
                  <p className="text-muted-foreground max-w-sm mt-2">
                    Upload architectural plans or project specifications as PDFs to begin your analysis.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="md:col-span-3">
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="bg-muted/30 border-b border-border/40 pb-4 flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-lg">Scan Results</CardTitle>
                <CardDescription className="mt-1">
                  Keyword matches found in this job's plan documents.
                </CardDescription>
              </div>
              <Button
                onClick={handleRescan}
                disabled={rescanJob.isPending || !files || files.length === 0}
                size="sm"
                variant="outline"
                className="font-mono uppercase tracking-wider text-xs"
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${rescanJob.isPending ? "animate-spin" : ""}`} />
                {rescanJob.isPending ? "Scanning..." : "Rescan"}
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <NoticeLine notice={scanNotice} testId="scan-notice" />
              {isLoadingScans ? (
                <div className="p-8 text-center text-muted-foreground">Loading scan results...</div>
              ) : scanGroups.length > 0 ? (
                <ul className="divide-y divide-border/40">
                  {scanGroups.map((group) => {
                    const isExpanded = expandedGroups.has(group.key)
                    return (
                      <li key={group.key}>
                        <button
                          type="button"
                          onClick={() => toggleGroup(group.key)}
                          aria-expanded={isExpanded}
                          className="w-full text-left p-4 hover:bg-muted/20 transition-colors flex items-center justify-between gap-3"
                        >
                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                            <Badge className="font-mono text-xs">{group.term}</Badge>
                            <Badge variant="secondary" className="text-[10px] font-mono uppercase tracking-wider">
                              {CATEGORY_LABELS[group.category]}
                            </Badge>
                            <span className="text-xs text-muted-foreground font-mono truncate max-w-[240px]" title={group.fileName}>
                              {group.fileName}
                            </span>
                            <span className="text-xs text-muted-foreground font-mono">— page {group.pageNumber}</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wider">
                              {group.matches.length} match{group.matches.length === 1 ? "" : "es"}
                            </Badge>
                            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                          </div>
                        </button>
                        {isExpanded && (
                          <ul className="border-t border-border/40 bg-muted/10 divide-y divide-border/30">
                            {group.matches.map((scan) => (
                              <li key={scan.id} className="px-4 py-3 pl-8">
                                <p className="text-sm text-muted-foreground leading-relaxed">{scan.context}</p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <div className="flex flex-col items-center justify-center p-12 text-center">
                  <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
                    <ScanSearch className="h-8 w-8 text-muted-foreground/50" />
                  </div>
                  <h3 className="text-lg font-semibold">No keyword matches</h3>
                  <p className="text-muted-foreground max-w-sm mt-2">
                    {files && files.length > 0
                      ? "No active keywords were found in the uploaded documents. Adjust keywords in Settings or run a rescan."
                      : "Upload plan documents and they will be scanned automatically for your keywords."}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="md:col-span-3">
          <RoomSpecsSection job={job} />
        </div>

        {(job.status === "takeoff" || job.status === "proposal_ready") && (
          <div className="md:col-span-3">
            <TakeoffSection job={job} files={files ?? []} onUnsavedChange={setTakeoffUnsaved} />
          </div>
        )}

        {job.status === "proposal_ready" && (
          <div className="md:col-span-3">
            <ProposalSection job={job} takeoffUnsaved={takeoffUnsaved} />
          </div>
        )}
      </div>

      <Dialog open={!!viewingFile} onOpenChange={(open) => { if (!open) setViewingFile(null) }}>
        <DialogContent className="max-w-[95vw] w-[95vw] h-[92vh] flex flex-col p-4 sm:p-6 gap-3">
          <DialogHeader className="shrink-0">
            <DialogTitle className="truncate pr-8">{viewingFile?.fileName}</DialogTitle>
            <DialogDescription className="sr-only">PDF viewer</DialogDescription>
          </DialogHeader>
          {viewingFile && (
            <div className="flex-1 min-h-0 rounded-md border border-border/60 overflow-hidden bg-muted/20">
              <PdfViewer
                key={viewingFile.id}
                url={`${import.meta.env.BASE_URL}api/files/${viewingFile.id}/view`}
                downloadUrl={`${import.meta.env.BASE_URL}api/files/${viewingFile.id}/download`}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Layout>
  )
}

interface ScanGroup {
  key: string
  term: string
  category: KeywordCategory
  fileId: number
  fileName: string
  pageNumber: number
  matches: PlanScanMatch[]
}

function groupScans(scans: PlanScanMatch[]): ScanGroup[] {
  const groups = new Map<string, ScanGroup>()
  for (const scan of scans) {
    const key = `${scan.term.toLowerCase()}|${scan.fileId}|${scan.pageNumber}`
    const existing = groups.get(key)
    if (existing) {
      existing.matches.push(scan)
    } else {
      groups.set(key, {
        key,
        term: scan.term,
        category: scan.category,
        fileId: scan.fileId,
        fileName: scan.fileName,
        pageNumber: scan.pageNumber,
        matches: [scan],
      })
    }
  }
  return Array.from(groups.values())
}

const CATEGORY_LABELS: Record<KeywordCategory, string> = {
  frp: "FRP Panels",
  stainless: "Stainless Steel",
  pvc: "PVC Panels",
  high_impact: "High Impact",
  manufacturer: "Manufacturer",
}
