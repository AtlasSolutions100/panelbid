import { useEffect, useState } from "react"
import { Layout } from "@/components/layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { 
  useListKeywords, 
  useCreateKeyword, 
  useUpdateKeyword, 
  useDeleteKeyword,
  getListKeywordsQueryKey,
  KeywordCategory,
  useGetGmailStatus,
  useDisconnectGmail,
  useTriggerGmailPoll,
  useListGmailActivity,
  getGetGmailStatusQueryKey,
  getListGmailActivityQueryKey,
  useListExclusionTerms,
  useCreateExclusionTerm,
  useUpdateExclusionTerm,
  useDeleteExclusionTerm,
  getListExclusionTermsQueryKey,
  ExclusionMatchType,
  useProcessEmailAnyway,
  useListContractorSources,
  useCreateContractorSource,
  useUpdateContractorSource,
  useDeleteContractorSource,
  getListContractorSourcesQueryKey,
} from "@workspace/api-client-react"
import { useQueryClient, useQuery } from "@tanstack/react-query"
import { useToast } from "@/hooks/use-toast"
import { Plus, Trash2, CheckCircle2, Circle, Mail, RefreshCw, AlertCircle, CheckCircle, FileX, Inbox, Building2, Pencil, X, Check, Filter } from "lucide-react"

// "example.com" (incl. subdomains) or "person@example.com"
const CONTRACTOR_VALUE_RE = /^(?:[^\s@]+@)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i

/** What GET /api/system/check answers: found or not and how, never where. */
interface SystemCheck {
  pdfinfo: { found: boolean; how: string }
  pdftoppm: { found: boolean; how: string }
  pathEntries: number
  nixStore: { exists: boolean; hasPopplerFolder: boolean }
}

export default function Settings() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  
  const [newTerm, setNewTerm] = useState("")
  const [newCategory, setNewCategory] = useState<KeywordCategory>(KeywordCategory.frp)

  const [newContractorName, setNewContractorName] = useState("")
  const [newContractorValue, setNewContractorValue] = useState("")
  const [newContractorNotes, setNewContractorNotes] = useState("")

  // Inline editing of an existing keyword term
  const [editingKeywordId, setEditingKeywordId] = useState<number | null>(null)
  const [editKeywordTerm, setEditKeywordTerm] = useState("")

  // Email exclusion terms
  const [newExclusionTerm, setNewExclusionTerm] = useState("")
  const [newExclusionType, setNewExclusionType] = useState<ExclusionMatchType>(ExclusionMatchType.either)
  const [editingExclusionId, setEditingExclusionId] = useState<number | null>(null)
  const [editExclusionTerm, setEditExclusionTerm] = useState("")

  // Inline editing of an existing contractor source
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState("")
  const [editValue, setEditValue] = useState("")
  const [editNotes, setEditNotes] = useState("")

  const { data: keywords, isLoading } = useListKeywords({
    query: { queryKey: getListKeywordsQueryKey() }
  })

  const { data: gmailStatus, isLoading: gmailLoading } = useGetGmailStatus({
    query: { queryKey: getGetGmailStatusQueryKey(), refetchInterval: 60_000 }
  })

  // What this server needs to read plans (GET /api/system/check). Asked
  // once, here only: not on every page.
  const { data: systemCheck } = useQuery({
    queryKey: ["system-check"],
    queryFn: async (): Promise<SystemCheck> => {
      const response = await fetch(`${import.meta.env.BASE_URL}api/system/check`)
      if (!response.ok) throw new Error("system check refused")
      return (await response.json()) as SystemCheck
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  const { data: gmailActivity, isLoading: activityLoading } = useListGmailActivity({
    query: { queryKey: getListGmailActivityQueryKey(), refetchInterval: 60_000 }
  })

  const { data: contractorSources, isLoading: contractorsLoading } = useListContractorSources({
    query: { queryKey: getListContractorSourcesQueryKey() }
  })

  const { data: exclusionTerms, isLoading: exclusionsLoading } = useListExclusionTerms({
    query: { queryKey: getListExclusionTermsQueryKey() }
  })

  const createKeyword = useCreateKeyword()
  const createExclusion = useCreateExclusionTerm()
  const updateExclusion = useUpdateExclusionTerm()
  const deleteExclusion = useDeleteExclusionTerm()
  const processAnyway = useProcessEmailAnyway()
  const updateKeyword = useUpdateKeyword()
  const deleteKeyword = useDeleteKeyword()
  const disconnectGmail = useDisconnectGmail()
  const triggerPoll = useTriggerGmailPoll()
  const createContractor = useCreateContractorSource()
  const updateContractor = useUpdateContractorSource()
  const deleteContractor = useDeleteContractorSource()

  // Blank is allowed — a name-only entry can get its domain later.
  const contractorValueValid =
    !newContractorValue.trim() || CONTRACTOR_VALUE_RE.test(newContractorValue.trim())

  const handleAddContractor = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newContractorName.trim() || !contractorValueValid) return
    createContractor.mutate(
      {
        data: {
          name: newContractorName.trim(),
          value: newContractorValue.trim() || null,
          ...(newContractorNotes.trim() ? { notes: newContractorNotes.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListContractorSourcesQueryKey() })
          setNewContractorName("")
          setNewContractorValue("")
          setNewContractorNotes("")
          toast({ title: "Contractor source added" })
        },
        onError: () => {
          toast({ title: "Failed to add contractor source", variant: "destructive" })
        },
      }
    )
  }

  const handleToggleContractor = (id: number, currentActive: boolean) => {
    updateContractor.mutate(
      { contractorSourceId: id, data: { active: !currentActive } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListContractorSourcesQueryKey() })
        },
      }
    )
  }

  const editValueValid = !editValue.trim() || CONTRACTOR_VALUE_RE.test(editValue.trim())

  const startEditContractor = (source: { id: number; name: string; value: string | null; notes: string | null }) => {
    setEditingId(source.id)
    setEditName(source.name)
    setEditValue(source.value ?? "")
    setEditNotes(source.notes ?? "")
  }

  const cancelEditContractor = () => {
    setEditingId(null)
  }

  const handleSaveContractor = (id: number) => {
    if (!editName.trim() || !editValueValid) return
    updateContractor.mutate(
      {
        contractorSourceId: id,
        data: {
          name: editName.trim(),
          value: editValue.trim() || null,
          notes: editNotes.trim() || null,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListContractorSourcesQueryKey() })
          setEditingId(null)
          toast({ title: "Contractor source updated" })
        },
        onError: () => {
          toast({ title: "Failed to update contractor source", variant: "destructive" })
        },
      }
    )
  }

  const handleDeleteContractor = (id: number) => {
    deleteContractor.mutate(
      { contractorSourceId: id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListContractorSourcesQueryKey() })
          toast({ title: "Contractor source deleted" })
        },
      }
    )
  }

  const handleAddExclusion = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newExclusionTerm.trim()) return
    createExclusion.mutate(
      { data: { term: newExclusionTerm.trim(), matchType: newExclusionType } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListExclusionTermsQueryKey() })
          setNewExclusionTerm("")
          toast({ title: "Exclusion rule added" })
        },
        onError: () => {
          toast({ title: "Failed to add exclusion rule", variant: "destructive" })
        },
      }
    )
  }

  const handleToggleExclusion = (id: number, currentActive: boolean) => {
    updateExclusion.mutate(
      { exclusionTermId: id, data: { active: !currentActive } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListExclusionTermsQueryKey() })
        },
      }
    )
  }

  const startEditExclusion = (id: number, term: string) => {
    setEditingExclusionId(id)
    setEditExclusionTerm(term)
  }

  const cancelEditExclusion = () => {
    setEditingExclusionId(null)
    setEditExclusionTerm("")
  }

  const handleSaveExclusion = (id: number, originalTerm: string) => {
    if (updateExclusion.isPending) return
    const term = editExclusionTerm.trim()
    if (!term) return
    if (term === originalTerm) {
      cancelEditExclusion()
      return
    }
    updateExclusion.mutate(
      { exclusionTermId: id, data: { term } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListExclusionTermsQueryKey() })
          cancelEditExclusion()
          toast({ title: "Exclusion rule updated" })
        },
        onError: () => {
          toast({ title: "Failed to update exclusion rule", variant: "destructive" })
        },
      }
    )
  }

  const handleDeleteExclusion = (id: number) => {
    deleteExclusion.mutate(
      { exclusionTermId: id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListExclusionTermsQueryKey() })
          toast({ title: "Exclusion rule deleted" })
        },
      }
    )
  }

  const handleProcessAnyway = (id: number) => {
    processAnyway.mutate(
      { processedEmailId: id },
      {
        onSuccess: (updated) => {
          queryClient.invalidateQueries({ queryKey: getListGmailActivityQueryKey() })
          toast({
            title: updated.outcome === "job_created"
              ? `Job #${updated.jobId} created`
              : "Email reprocessed",
          })
        },
        onError: () => {
          toast({ title: "Failed to reprocess email", variant: "destructive" })
        },
      }
    )
  }

  const handleAddKeyword = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTerm.trim()) return

    createKeyword.mutate(
      { data: { term: newTerm.trim(), category: newCategory } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListKeywordsQueryKey() })
          setNewTerm("")
          toast({ title: "Keyword added" })
        },
        onError: () => {
          toast({ title: "Failed to add keyword", variant: "destructive" })
        }
      }
    )
  }

  const handleToggleActive = (id: number, currentActive: boolean) => {
    updateKeyword.mutate(
      { keywordId: id, data: { active: !currentActive } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListKeywordsQueryKey() })
        }
      }
    )
  }

  const startEditKeyword = (id: number, term: string) => {
    setEditingKeywordId(id)
    setEditKeywordTerm(term)
  }

  const cancelEditKeyword = () => {
    setEditingKeywordId(null)
    setEditKeywordTerm("")
  }

  const handleSaveKeyword = (id: number, originalTerm: string) => {
    if (updateKeyword.isPending) return
    const term = editKeywordTerm.trim()
    if (!term) return
    if (term === originalTerm) {
      cancelEditKeyword()
      return
    }
    updateKeyword.mutate(
      { keywordId: id, data: { term } },
      {
        onSuccess: (_data, variables) => {
          queryClient.invalidateQueries({ queryKey: getListKeywordsQueryKey() })
          // Only clear the editor if it still belongs to the keyword we saved —
          // the user may have started editing a different line meanwhile.
          setEditingKeywordId((current) => {
            if (current === variables.keywordId) {
              setEditKeywordTerm("")
              return null
            }
            return current
          })
          toast({ title: "Keyword updated" })
        },
        onError: () => {
          toast({ title: "Failed to update keyword", variant: "destructive" })
        }
      }
    )
  }

  const handleDeleteKeyword = (id: number) => {
    deleteKeyword.mutate(
      { keywordId: id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListKeywordsQueryKey() })
          toast({ title: "Keyword deleted" })
        }
      }
    )
  }

  // Handle the post-OAuth redirect back from /api/gmail/oauth/callback
  // (?gmail=connected or ?gmail=error:<reason>).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const result = params.get("gmail")
    if (!result) return
    // Clean the query string so refreshes don't re-toast.
    params.delete("gmail")
    const rest = params.toString()
    window.history.replaceState({}, "", window.location.pathname + (rest ? `?${rest}` : ""))

    if (result === "connected") {
      queryClient.invalidateQueries({ queryKey: getGetGmailStatusQueryKey() })
      toast({ title: "Gmail connected", description: "Your inbox will now be polled for bid invites." })
    } else {
      const reason = result.replace(/^error:/, "")
      const messages: Record<string, string> = {
        denied: "You declined access on the Google consent screen.",
        scope_denied: "Read-only Gmail access wasn't granted. Please allow it to connect.",
        not_configured: "Google OAuth isn't configured on the server yet.",
        already_connected: "A Gmail account is already connected. Disconnect first.",
        invalid_state: "The sign-in link expired or was invalid. Please try again.",
        no_refresh_token: "Google didn't return a long-lived token. Please try again.",
        gmail_api_disabled:
          "Google sign-in worked, but the Gmail API is not enabled in your Google Cloud project. Open console.cloud.google.com, select the project that owns your OAuth client, and enable the \"Gmail API\", then try connecting again.",
      }
      toast({
        title: "Failed to connect Gmail",
        description: messages[reason] ?? "Something went wrong during Google sign-in. Please try again.",
        variant: "destructive",
      })
      queryClient.invalidateQueries({ queryKey: getGetGmailStatusQueryKey() })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleConnect = () => {
    // Full-page redirect to the server's OAuth start endpoint, which
    // forwards to Google's consent screen.
    window.location.href = "/api/gmail/connect"
  }

  const handleDisconnect = () => {
    disconnectGmail.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetGmailStatusQueryKey() })
        queryClient.invalidateQueries({ queryKey: getListGmailActivityQueryKey() })
        toast({ title: "Gmail disconnected" })
      }
    })
  }

  const handlePoll = () => {
    triggerPoll.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Poll triggered — check activity log shortly" })
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: getListGmailActivityQueryKey() })
          queryClient.invalidateQueries({ queryKey: getGetGmailStatusQueryKey() })
        }, 3000)
      },
      onError: () => {
        toast({ title: "Failed to trigger poll", variant: "destructive" })
      }
    })
  }

  const groupedKeywords = keywords?.reduce((acc, keyword) => {
    if (!acc[keyword.category]) acc[keyword.category] = []
    acc[keyword.category].push(keyword)
    return acc
  }, {} as Record<string, typeof keywords>) || {}

  const categoryLabels = {
    [KeywordCategory.frp]: "FRP Panels",
    [KeywordCategory.stainless]: "Stainless Steel",
    [KeywordCategory.pvc]: "PVC Panels",
    [KeywordCategory.high_impact]: "High Impact Wall Covering",
    [KeywordCategory.manufacturer]: "Manufacturers",
  }

  const outcomeIcon = (outcome: string) => {
    if (outcome === "job_created") return <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
    if (outcome === "no_plans") return <FileX className="h-4 w-4 text-muted-foreground shrink-0" />
    if (outcome === "filtered") return <Filter className="h-4 w-4 text-amber-500 shrink-0" />
    return <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
  }

  const outcomeLabel = (outcome: string, jobId: number | null) => {
    if (outcome === "job_created") return `Job #${jobId} created`
    if (outcome === "no_plans") return "No PDFs found"
    if (outcome === "filtered") return "Filtered"
    return "Error"
  }

  const matchTypeLabel: Record<string, string> = {
    subject: "Subject",
    sender: "Sender",
    either: "Subject or sender",
  }

  return (
    <Layout>
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Settings</h1>
        <p className="text-muted-foreground mt-1">Configure application parameters and automated scanning rules.</p>
      </div>

      {/* Server check: one line */}
      {systemCheck && (
        <div className="mb-8 space-y-2" data-testid="server-check">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Server check</h2>
          {systemCheck.pdfinfo.found && systemCheck.pdftoppm.found ? (
            <p className="text-sm" data-testid="server-check-line">PDF tools: ready</p>
          ) : (
            <p className="text-sm font-medium text-destructive" data-testid="server-check-line">
              PDF tools: MISSING on this server: plans and price sheets can't be read yet.
            </p>
          )}
        </div>
      )}

      {/* Gmail Integration */}
      <div className="mb-8 space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Email Integration</h2>

        <Card className="border-border/60 shadow-sm">
          <CardHeader className="bg-muted/30 border-b border-border/40 pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Mail className="h-5 w-5 text-primary" />
                <CardTitle className="text-lg">Gmail</CardTitle>
              </div>
              {gmailStatus?.connected && gmailStatus.needsReconnect ? (
                <Badge variant="default" data-testid="gmail-badge" className="bg-amber-500/15 text-amber-700 border-amber-500/30">Needs reconnect</Badge>
              ) : gmailStatus?.connected ? (
                <Badge variant="default" data-testid="gmail-badge" className="bg-green-500/15 text-green-700 border-green-500/20">Connected</Badge>
              ) : (
                <Badge variant="secondary" data-testid="gmail-badge">Disconnected</Badge>
              )}
            </div>
            <CardDescription>
              Automatically pull bid invites from your Gmail inbox. PanelBid monitors for emails with PDF attachments
              and creates jobs from them — no manual uploads needed. Access is read-only.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-6">
            {gmailLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : gmailStatus?.connected && gmailStatus.needsReconnect ? (
              <div className="space-y-3">
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                  <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                  <p className="text-sm text-amber-800">
                    Access to <span className="font-medium">{gmailStatus.email}</span> has expired or been
                    revoked. Polling is paused — reconnect your Google account to resume.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleConnect} className="gap-2">
                    <Mail className="h-4 w-4" />
                    Reconnect Gmail
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleDisconnect}
                    disabled={disconnectGmail.isPending}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            ) : gmailStatus?.connected ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Account</span>
                    <p className="font-medium mt-0.5">{gmailStatus.email}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Last polled</span>
                    <p className="font-medium mt-0.5">
                      {gmailStatus.lastPolledAt
                        ? new Date(gmailStatus.lastPolledAt).toLocaleString()
                        : "Not yet polled"}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Connected since</span>
                    <p className="font-medium mt-0.5">
                      {gmailStatus.connectedAt ? new Date(gmailStatus.connectedAt).toLocaleDateString() : "—"}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Poll interval</span>
                    <p className="font-medium mt-0.5">Every 10 minutes</p>
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePoll}
                    disabled={triggerPoll.isPending}
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${triggerPoll.isPending ? 'animate-spin' : ''}`} />
                    Poll Now
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDisconnect}
                    disabled={disconnectGmail.isPending}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Connect your Gmail account to automatically detect new bid invite emails. PanelBid will poll your inbox
                  every 10 minutes, download attached plan PDFs, and create jobs — all without manual uploads.
                </p>
                <Button onClick={handleConnect} className="gap-2">
                  <Mail className="h-4 w-4" />
                  Connect Gmail
                </Button>
                <p className="text-xs text-muted-foreground">
                  You'll be taken to Google to sign in and grant read-only access to your inbox.
                  PanelBid never sends email or modifies your mailbox, and you can disconnect at any time.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Activity Log */}
        {gmailStatus?.connected && (
          <Card className="border-border/60 shadow-sm overflow-hidden">
            <CardHeader className="bg-muted/30 border-b border-border/40 pb-3 flex flex-row items-center justify-between">
              <div className="flex items-center gap-2">
                <Inbox className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Recent Email Activity</CardTitle>
              </div>
              <Badge variant="secondary" className="font-mono">{gmailActivity?.length ?? 0}</Badge>
            </CardHeader>
            <CardContent className="p-0">
              {activityLoading ? (
                <div className="p-6 text-center text-sm text-muted-foreground">Loading activity…</div>
              ) : !gmailActivity || gmailActivity.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground font-mono">
                  No emails processed yet. PanelBid will scan on the next poll cycle.
                </div>
              ) : (
                <ul className="divide-y divide-border/40">
                  {gmailActivity.map((entry) => (
                    <li key={entry.id} className="p-3 px-4 flex items-start gap-3 hover:bg-muted/10 transition-colors">
                      <div className="mt-0.5">{outcomeIcon(entry.outcome)}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium truncate">{entry.subject || "(no subject)"}</p>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {new Date(entry.receivedAt).toLocaleDateString()}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 min-w-0">
                          <p className="text-xs text-muted-foreground truncate">{entry.sender}</p>
                          {entry.matchedContractorName && (
                            <Badge variant="outline" className="shrink-0 gap-1 border-primary/30 text-primary text-[10px] px-1.5 py-0">
                              <Building2 className="h-3 w-3" />
                              {entry.matchedContractorName}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs mt-1 font-mono">
                          <span className={
                            entry.outcome === "job_created" ? "text-green-600" :
                            entry.outcome === "error" ? "text-destructive" :
                            entry.outcome === "filtered" ? "text-amber-600" :
                            "text-muted-foreground"
                          }>
                            {outcomeLabel(entry.outcome, entry.jobId)}
                          </span>
                          {entry.errorMessage && (
                            <span className="text-muted-foreground ml-1">— {entry.errorMessage}</span>
                          )}
                          {entry.outcome === "filtered" && entry.filterReason && (
                            <span className="text-muted-foreground ml-1">— {entry.filterReason}</span>
                          )}
                        </p>
                        {entry.outcome === "filtered" && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-2 h-7 text-xs"
                            onClick={() => handleProcessAnyway(entry.id)}
                            disabled={processAnyway.isPending}
                          >
                            <RefreshCw className={`h-3 w-3 mr-1.5 ${processAnyway.isPending ? 'animate-spin' : ''}`} />
                            Process anyway
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Email Exclusion Rules */}
      <div className="mb-8">
        <div className="mb-4">
          <h2 className="text-xl font-semibold tracking-tight">Email Exclusion Rules</h2>
          <p className="text-muted-foreground text-sm mt-1">
            Emails whose subject or sender matches one of these terms are skipped — no job is created. Skipped emails still show in Recent Email Activity and can be processed anyway.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1">
            <Card className="border-border/60 shadow-sm">
              <CardHeader className="bg-muted/30 border-b border-border/40 pb-4">
                <CardTitle className="text-lg">Add Exclusion Rule</CardTitle>
                <CardDescription>
                  Case-insensitive match against the email subject line and/or sender address.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6">
                <form onSubmit={handleAddExclusion} className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Match Against</label>
                    <Select value={newExclusionType} onValueChange={(val) => setNewExclusionType(val as ExclusionMatchType)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select field" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ExclusionMatchType.subject}>Subject</SelectItem>
                        <SelectItem value={ExclusionMatchType.sender}>Sender</SelectItem>
                        <SelectItem value={ExclusionMatchType.either}>Subject or sender</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Term</label>
                    <Input
                      value={newExclusionTerm}
                      onChange={(e) => setNewExclusionTerm(e.target.value)}
                      placeholder="e.g. invoice or billing@"
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={createExclusion.isPending || !newExclusionTerm.trim()}>
                    <Plus className="mr-2 h-4 w-4" /> Add Rule
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-2">
            <Card className="border-border/60 shadow-sm overflow-hidden">
              <CardHeader className="bg-muted/30 border-b border-border/40 pb-3 flex flex-row items-center justify-between">
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-base">Exclusion Terms</CardTitle>
                </div>
                <Badge variant="secondary" className="font-mono">{exclusionTerms?.length ?? 0}</Badge>
              </CardHeader>
              <CardContent className="p-0">
                {exclusionsLoading ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">Loading rules…</div>
                ) : !exclusionTerms || exclusionTerms.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground font-mono">
                    No exclusion rules. Every email with a PDF will be considered a bid invite.
                  </div>
                ) : (
                  <ul className="divide-y divide-border/40">
                    {exclusionTerms.map((rule) => (
                      <li key={rule.id} className="p-3 px-4 flex items-center justify-between hover:bg-muted/10 transition-colors">
                        {editingExclusionId === rule.id ? (
                          <div className="flex items-center gap-2 flex-1">
                            <Input
                              value={editExclusionTerm}
                              onChange={(e) => setEditExclusionTerm(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleSaveExclusion(rule.id, rule.term)
                                if (e.key === "Escape") cancelEditExclusion()
                              }}
                              autoFocus
                              className="h-8 font-mono text-sm"
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleSaveExclusion(rule.id, rule.term)}
                              disabled={updateExclusion.isPending || !editExclusionTerm.trim()}
                              className="h-8 w-8 text-primary hover:text-primary"
                            >
                              <Check className="h-4 w-4" />
                              <span className="sr-only">Save</span>
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={cancelEditExclusion}
                              className="h-8 w-8 text-muted-foreground"
                            >
                              <X className="h-4 w-4" />
                              <span className="sr-only">Cancel</span>
                            </Button>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-3 min-w-0">
                              <button
                                onClick={() => handleToggleExclusion(rule.id, rule.active)}
                                className={`flex items-center justify-center transition-colors shrink-0 ${rule.active ? 'text-primary' : 'text-muted-foreground'}`}
                                aria-label={rule.active ? "Deactivate" : "Activate"}
                              >
                                {rule.active ? <CheckCircle2 className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
                              </button>
                              <span className={`font-mono text-sm truncate ${!rule.active && 'text-muted-foreground line-through opacity-70'}`}>
                                "{rule.term}"
                              </span>
                              <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0">
                                {matchTypeLabel[rule.matchType] ?? rule.matchType}
                              </Badge>
                            </div>
                            <div className="flex items-center shrink-0">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => startEditExclusion(rule.id, rule.term)}
                                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                              >
                                <Pencil className="h-4 w-4" />
                                <span className="sr-only">Edit</span>
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDeleteExclusion(rule.id)}
                                className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                              >
                                <Trash2 className="h-4 w-4" />
                                <span className="sr-only">Delete</span>
                              </Button>
                            </div>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      <div className="mb-4">
        <h2 className="text-xl font-semibold tracking-tight">Keyword Rules</h2>
        <p className="text-muted-foreground text-sm mt-1">Terms used to identify relevant scope in uploaded plan PDFs.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-1 space-y-6">
          <Card className="border-border/60 shadow-sm sticky top-24">
            <CardHeader className="bg-muted/30 border-b border-border/40 pb-4">
              <CardTitle className="text-lg">Add Keyword</CardTitle>
              <CardDescription>
                Terms used by the automated plan scanner to identify relevant scope in PDFs.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-6">
              <form onSubmit={handleAddKeyword} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Material Category</label>
                  <Select value={newCategory} onValueChange={(val) => setNewCategory(val as KeywordCategory)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={KeywordCategory.frp}>FRP Panels</SelectItem>
                      <SelectItem value={KeywordCategory.stainless}>Stainless Steel</SelectItem>
                      <SelectItem value={KeywordCategory.pvc}>PVC Panels</SelectItem>
                      <SelectItem value={KeywordCategory.high_impact}>High Impact Wall Covering</SelectItem>
                      <SelectItem value={KeywordCategory.manufacturer}>Manufacturer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Search Term</label>
                  <Input 
                    value={newTerm} 
                    onChange={(e) => setNewTerm(e.target.value)} 
                    placeholder="e.g. fiberglass reinforced" 
                  />
                </div>
                <Button type="submit" className="w-full" disabled={createKeyword.isPending || !newTerm.trim()}>
                  <Plus className="mr-2 h-4 w-4" /> Add Keyword
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-6">
          {isLoading ? (
            <Card className="border-border/60 shadow-sm">
              <CardContent className="p-8 text-center text-muted-foreground">Loading keywords...</CardContent>
            </Card>
          ) : (
            Object.entries(categoryLabels).map(([category, label]) => {
              const categoryKeywords = groupedKeywords[category as KeywordCategory] || []
              
              return (
                <Card key={category} className="border-border/60 shadow-sm overflow-hidden">
                  <CardHeader className="bg-muted/30 border-b border-border/40 pb-3 flex flex-row items-center justify-between">
                    <div>
                      <CardTitle className="text-base">{label}</CardTitle>
                    </div>
                    <Badge variant="secondary" className="font-mono">{categoryKeywords.length}</Badge>
                  </CardHeader>
                  <CardContent className="p-0">
                    {categoryKeywords.length > 0 ? (
                      <ul className="divide-y divide-border/40">
                        {categoryKeywords.map((keyword) => (
                          <li key={keyword.id} className="p-3 px-4 flex items-center justify-between hover:bg-muted/10 transition-colors">
                            {editingKeywordId === keyword.id ? (
                              <div className="flex items-center gap-2 flex-1">
                                <Input
                                  value={editKeywordTerm}
                                  onChange={(e) => setEditKeywordTerm(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") handleSaveKeyword(keyword.id, keyword.term)
                                    if (e.key === "Escape") cancelEditKeyword()
                                  }}
                                  autoFocus
                                  className="h-8 font-mono text-sm"
                                />
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleSaveKeyword(keyword.id, keyword.term)}
                                  disabled={updateKeyword.isPending || !editKeywordTerm.trim()}
                                  className="h-8 w-8 text-primary hover:text-primary"
                                >
                                  <Check className="h-4 w-4" />
                                  <span className="sr-only">Save</span>
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={cancelEditKeyword}
                                  className="h-8 w-8 text-muted-foreground"
                                >
                                  <X className="h-4 w-4" />
                                  <span className="sr-only">Cancel</span>
                                </Button>
                              </div>
                            ) : (
                              <>
                                <div className="flex items-center gap-3">
                                  <button 
                                    onClick={() => handleToggleActive(keyword.id, keyword.active)}
                                    className={`flex items-center justify-center transition-colors ${keyword.active ? 'text-primary' : 'text-muted-foreground'}`}
                                    aria-label={keyword.active ? "Deactivate" : "Activate"}
                                  >
                                    {keyword.active ? <CheckCircle2 className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
                                  </button>
                                  <span className={`font-mono text-sm ${!keyword.active && 'text-muted-foreground line-through opacity-70'}`}>
                                    "{keyword.term}"
                                  </span>
                                </div>
                                <div className="flex items-center">
                                  <Button 
                                    variant="ghost" 
                                    size="icon" 
                                    onClick={() => startEditKeyword(keyword.id, keyword.term)}
                                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                  >
                                    <Pencil className="h-4 w-4" />
                                    <span className="sr-only">Edit</span>
                                  </Button>
                                  <Button 
                                    variant="ghost" 
                                    size="icon" 
                                    onClick={() => handleDeleteKeyword(keyword.id)}
                                    className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                    <span className="sr-only">Delete</span>
                                  </Button>
                                </div>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="p-6 text-center text-sm text-muted-foreground font-mono">
                        No keywords defined for {label.toLowerCase()}.
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            })
          )}
        </div>
      </div>
      {/* Contractor Sources */}
      <div className="mb-8">
        <div className="mb-4">
          <h2 className="text-xl font-semibold tracking-tight">Contractor Sources</h2>
          <p className="text-muted-foreground text-sm mt-1">
            Known GC senders and domains. Incoming emails from these sources get flagged in the activity log — the list never blocks processing.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1">
            <Card className="border-border/60 shadow-sm">
              <CardHeader className="bg-muted/30 border-b border-border/40 pb-4">
                <CardTitle className="text-lg">Add Contractor</CardTitle>
                <CardDescription>
                  Add a GC by domain (matches every sender at that company) or an exact email address.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6">
                <form onSubmit={handleAddContractor} className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Contractor Name</label>
                    <Input
                      value={newContractorName}
                      onChange={(e) => setNewContractorName(e.target.value)}
                      placeholder="e.g. Turner Construction"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Domain or Email <span className="text-muted-foreground font-normal">(optional)</span></label>
                    <Input
                      value={newContractorValue}
                      onChange={(e) => setNewContractorValue(e.target.value)}
                      placeholder="e.g. turnerconstruction.com"
                    />
                    {newContractorValue.trim() && !contractorValueValid && (
                      <p className="text-xs text-destructive">
                        Enter a domain like example.com or an email like estimating@example.com
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Notes <span className="text-muted-foreground font-normal">(optional)</span></label>
                    <Input
                      value={newContractorNotes}
                      onChange={(e) => setNewContractorNotes(e.target.value)}
                      placeholder="e.g. Sends invites via BuildingConnected"
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={createContractor.isPending || !newContractorName.trim() || !contractorValueValid}
                  >
                    <Plus className="mr-2 h-4 w-4" /> Add Contractor
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-2">
            <Card className="border-border/60 shadow-sm overflow-hidden">
              <CardHeader className="bg-muted/30 border-b border-border/40 pb-3 flex flex-row items-center justify-between">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-base">Known Contractors</CardTitle>
                </div>
                <Badge variant="secondary" className="font-mono">{contractorSources?.length ?? 0}</Badge>
              </CardHeader>
              <CardContent className="p-0">
                {contractorsLoading ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">Loading contractors…</div>
                ) : !contractorSources || contractorSources.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground font-mono">
                    No contractor sources yet. Add GCs so their emails get flagged automatically.
                  </div>
                ) : (
                  <ul className="divide-y divide-border/40">
                    {contractorSources.map((source) => (
                      <li key={source.id} className="p-3 px-4 hover:bg-muted/10 transition-colors">
                        {editingId === source.id ? (
                          <div className="space-y-2">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <Input
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                placeholder="Contractor name"
                                className="h-8 text-sm"
                              />
                              <Input
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                placeholder="Domain or email (optional)"
                                className="h-8 text-sm font-mono"
                              />
                            </div>
                            <Input
                              value={editNotes}
                              onChange={(e) => setEditNotes(e.target.value)}
                              placeholder="Notes (optional)"
                              className="h-8 text-sm"
                            />
                            {editValue.trim() && !editValueValid && (
                              <p className="text-xs text-destructive">
                                Enter a domain like example.com or an email like estimating@example.com
                              </p>
                            )}
                            <div className="flex gap-2 justify-end">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8"
                                onClick={cancelEditContractor}
                              >
                                <X className="h-4 w-4 mr-1" /> Cancel
                              </Button>
                              <Button
                                size="sm"
                                className="h-8"
                                onClick={() => handleSaveContractor(source.id)}
                                disabled={updateContractor.isPending || !editName.trim() || !editValueValid}
                              >
                                <Check className="h-4 w-4 mr-1" /> Save
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0">
                              <button
                                onClick={() => handleToggleContractor(source.id, source.active)}
                                className={`flex items-center justify-center transition-colors shrink-0 ${source.active ? 'text-primary' : 'text-muted-foreground'}`}
                                aria-label={source.active ? "Deactivate" : "Activate"}
                              >
                                {source.active ? <CheckCircle2 className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
                              </button>
                              <div className="min-w-0">
                                <p className={`text-sm font-medium truncate ${!source.active && 'text-muted-foreground line-through opacity-70'}`}>
                                  {source.name}
                                </p>
                                <p className="text-xs text-muted-foreground font-mono truncate">
                                  {source.value ?? <span className="font-sans italic opacity-70">no domain yet — won't match email</span>}
                                  {source.notes && <span className="font-sans ml-2 opacity-80">— {source.notes}</span>}
                                </p>
                              </div>
                            </div>
                            <div className="flex shrink-0">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => startEditContractor(source)}
                                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                              >
                                <Pencil className="h-4 w-4" />
                                <span className="sr-only">Edit</span>
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDeleteContractor(source.id)}
                                className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                              >
                                <Trash2 className="h-4 w-4" />
                                <span className="sr-only">Delete</span>
                              </Button>
                            </div>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

    </Layout>
  )
}
