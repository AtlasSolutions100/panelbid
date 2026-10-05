import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useGetProposal,
  useGenerateProposal,
  useUpdateProposal,
  getGetProposalQueryKey,
  type Proposal,
  type Job,
} from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { FileSignature, RefreshCw, Save, Download } from "lucide-react"
import { formatDateTime } from "@/lib/format"

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" })

interface ProposalFields {
  proposalDate: string
  projectName: string
  projectAddress: string
  projectCity: string
  frp: string
  highImpactWallPanel: string
  cornerGuards: string
  stainlessSteel: string
  addsDeducts: string
  exclusions: string
  notes: string
  priceAmount: string
  priceInWords: string
}

function toFields(p: Proposal): ProposalFields {
  return {
    proposalDate: p.proposalDate,
    projectName: p.projectName,
    projectAddress: p.projectAddress,
    projectCity: p.projectCity,
    frp: p.frp,
    highImpactWallPanel: p.highImpactWallPanel,
    cornerGuards: p.cornerGuards,
    stainlessSteel: p.stainlessSteel,
    addsDeducts: p.addsDeducts,
    exclusions: p.exclusions,
    notes: p.notes,
    priceAmount: String(p.priceAmount),
    priceInWords: p.priceInWords,
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const multiline = (s: string) => escapeHtml(s).replace(/\n/g, "<br/>")

// Standalone HTML that mirrors the RCP bid proposal template, printed to PDF
// via the browser print dialog.
function buildProposalHtml(f: ProposalFields): string {
  const amount = parseFloat(f.priceAmount)
  const amountStr = Number.isFinite(amount) ? money(amount) : f.priceAmount
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Bid Proposal — ${escapeHtml(f.projectName)}</title>
<style>
  @page { size: letter; margin: 0.75in; }
  body { font-family: "Times New Roman", Times, serif; color: #000; font-size: 12pt; line-height: 1.35; margin: 0; }
  .header { text-align: center; }
  .company { font-size: 16pt; font-weight: bold; letter-spacing: 0.5px; }
  .header p { margin: 1px 0; font-size: 11pt; }
  .title { text-align: center; font-size: 14pt; font-weight: bold; text-decoration: underline; margin: 18px 0 14px; }
  .field { margin: 10px 0; }
  .label { font-weight: bold; }
  .price { margin: 16px 0; }
  .sig { margin-top: 24px; }
  .sig p { margin: 4px 0; }
  .signline { margin-top: 28px; }
</style></head>
<body>
  <div class="header">
    <div class="company">RIVER CITY PLASTICS, INC.</div>
    <p>4074 Cincinnati Avenue</p>
    <p>Rocklin, CA 95765</p>
    <p>Phone (916) 408-5021 &nbsp;&bull;&nbsp; Estimating (916) 871-2725</p>
    <p>CA License # 1004436 &nbsp;&bull;&nbsp; DIR# 1000035986</p>
  </div>
  <div class="title">BID PROPOSAL</div>
  <div class="field"><span class="label">DATE:</span> ${escapeHtml(f.proposalDate)}</div>
  <div class="field"><span class="label">PROJECT:</span> ${escapeHtml(f.projectName)}, ${escapeHtml(f.projectAddress)}, ${escapeHtml(f.projectCity)}</div>
  <div class="field"><span class="label">FRP:</span> ${multiline(f.frp)}</div>
  <div class="field"><span class="label">HIGH IMPACT WALL PANEL:</span> ${multiline(f.highImpactWallPanel)}</div>
  <div class="field"><span class="label">CORNER GUARDS:</span> ${multiline(f.cornerGuards)}</div>
  <div class="field"><span class="label">STAINLESS STEEL:</span> ${multiline(f.stainlessSteel)}</div>
  <div class="field"><span class="label">ADDS/DEDUCTS:</span> ${multiline(f.addsDeducts)}</div>
  <div class="field"><span class="label">EXCLUSIONS:</span> ${multiline(f.exclusions)}</div>
  <div class="field"><span class="label">NOTES:</span><br/>${multiline(f.notes)}</div>
  <div class="price">River City Plastics, Inc., is pleased to provide you with a price of: <b>${escapeHtml(amountStr)}</b> (${escapeHtml(f.priceInWords)}) to provide and install the above listed items. This price and obligation are valid for 30 days from the date quoted above.</div>
  <div class="sig">
    <p>Thank you,</p>
    <p>Ryan Ledbetter, Estimator</p>
    <p>Upon approval of this bid, please email this page to julie@rivercityplastics.com</p>
    <p class="signline">Signed By: _______________________________ &nbsp;&nbsp; Date: _______________</p>
  </div>
</body></html>`
}

export function ProposalSection({ job }: { job: Job }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const jobId = job.id

  const { data: proposal, isLoading } = useGetProposal(jobId, {
    query: {
      enabled: !!jobId,
      queryKey: getGetProposalQueryKey(jobId),
      retry: false,
    },
  })
  const generateProposal = useGenerateProposal()
  const updateProposal = useUpdateProposal()

  const [previewOpen, setPreviewOpen] = useState(false)
  const [fields, setFields] = useState<ProposalFields | null>(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (proposal && !previewOpen) {
      setFields(toFields(proposal))
      setDirty(false)
    }
  }, [proposal, previewOpen])

  const set = (patch: Partial<ProposalFields>) => {
    setFields((f) => (f ? { ...f, ...patch } : f))
    setDirty(true)
  }

  const handleGenerate = () => {
    generateProposal.mutate(
      { jobId },
      {
        onSuccess: (p) => {
          queryClient.setQueryData(getGetProposalQueryKey(jobId), p)
          setFields(toFields(p))
          setDirty(false)
          setPreviewOpen(true)
          toast({
            title: proposal ? "Proposal regenerated" : "Proposal generated",
            description: "Pre-filled from the job and current takeoff.",
          })
        },
        onError: (err) =>
          toast({
            title: "Failed to generate proposal",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          }),
      },
    )
  }

  const saveEdits = (onSaved?: () => void) => {
    if (!fields) return
    const amount = parseFloat(fields.priceAmount)
    updateProposal.mutate(
      {
        jobId,
        data: {
          ...fields,
          priceAmount: Number.isFinite(amount) ? amount : 0,
        },
      },
      {
        onSuccess: (p) => {
          queryClient.setQueryData(getGetProposalQueryKey(jobId), p)
          setDirty(false)
          onSaved?.()
        },
        onError: () =>
          toast({ title: "Failed to save proposal", variant: "destructive" }),
      },
    )
  }

  const handleExport = () => {
    if (!fields) return
    const doExport = () => {
      const win = window.open("", "_blank")
      if (!win) {
        toast({ title: "Popup blocked", description: "Allow popups to export the PDF.", variant: "destructive" })
        return
      }
      win.document.write(buildProposalHtml(fields))
      win.document.close()
      win.focus()
      setTimeout(() => win.print(), 250)
    }
    if (dirty) saveEdits(doExport)
    else doExport()
  }

  const fieldRow = (label: string, key: keyof ProposalFields, rows = 1) => (
    <div className="space-y-1">
      <label className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{label}</label>
      {rows > 1 ? (
        <Textarea
          rows={rows}
          value={fields?.[key] ?? ""}
          onChange={(e) => set({ [key]: e.target.value } as Partial<ProposalFields>)}
          className="text-sm"
          data-testid={`input-proposal-${key}`}
        />
      ) : (
        <Input
          value={fields?.[key] ?? ""}
          onChange={(e) => set({ [key]: e.target.value } as Partial<ProposalFields>)}
          className="h-8 text-sm"
          data-testid={`input-proposal-${key}`}
        />
      )}
    </div>
  )

  return (
    <Card className="border-border/60 shadow-sm">
      <CardHeader className="bg-muted/30 border-b border-border/40 pb-4 flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-lg">Bid Proposal</CardTitle>
          <CardDescription className="mt-1">
            Customer-ready proposal on the River City Plastics template, generated from the takeoff.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {proposal && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPreviewOpen(true)}
              className="font-mono uppercase tracking-wider text-xs"
              data-testid="button-open-proposal"
            >
              <FileSignature className="mr-2 h-4 w-4" /> Edit / Export
            </Button>
          )}
          <Button
            onClick={handleGenerate}
            disabled={generateProposal.isPending}
            size="sm"
            className="font-mono uppercase tracking-wider text-xs"
            data-testid="button-generate-proposal"
          >
            {proposal ? (
              <RefreshCw className={`mr-2 h-4 w-4 ${generateProposal.isPending ? "animate-spin" : ""}`} />
            ) : (
              <FileSignature className="mr-2 h-4 w-4" />
            )}
            {generateProposal.isPending
              ? "Generating..."
              : proposal
                ? "Regenerate from Takeoff"
                : "Generate Proposal"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-4 text-sm text-muted-foreground">
        {isLoading ? (
          "Loading proposal..."
        ) : proposal ? (
          <span data-testid="text-proposal-status">
            Generated {formatDateTime(proposal.generatedAt)} — last edited {formatDateTime(proposal.updatedAt)} — price {money(proposal.priceAmount)}
          </span>
        ) : (
          "No proposal yet. Generate one from the saved takeoff to review, edit, and export as PDF."
        )}
      </CardContent>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Bid Proposal Preview</DialogTitle>
            <DialogDescription>
              Every field is editable. Save your edits, then export as PDF.
            </DialogDescription>
          </DialogHeader>
          {fields && (
            <div className="space-y-4">
              {/* Static template header */}
              <div className="text-center border rounded-md p-4 bg-muted/20">
                <p className="font-bold tracking-wide">RIVER CITY PLASTICS, INC.</p>
                <p className="text-xs text-muted-foreground">4074 Cincinnati Avenue, Rocklin, CA 95765</p>
                <p className="text-xs text-muted-foreground">Phone (916) 408-5021 • Estimating (916) 871-2725</p>
                <p className="text-xs text-muted-foreground">CA License # 1004436 • DIR# 1000035986</p>
                <p className="font-bold underline mt-2">BID PROPOSAL</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {fieldRow("Date", "proposalDate")}
                {fieldRow("Project Name", "projectName")}
                {fieldRow("Project Address", "projectAddress")}
                {fieldRow("Project City", "projectCity")}
              </div>
              {fieldRow("FRP", "frp", 3)}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {fieldRow("High Impact Wall Panel", "highImpactWallPanel")}
                {fieldRow("Corner Guards", "cornerGuards")}
                {fieldRow("Stainless Steel", "stainlessSteel")}
              </div>
              {fieldRow("Adds/Deducts", "addsDeducts", 2)}
              {fieldRow("Exclusions", "exclusions", 2)}
              {fieldRow("Notes", "notes", 8)}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {fieldRow("Price ($)", "priceAmount")}
                {fieldRow("Price in Words", "priceInWords")}
              </div>

              <div className="rounded-md border p-3 bg-muted/20 text-xs text-muted-foreground leading-relaxed">
                <p>
                  River City Plastics, Inc., is pleased to provide you with a price of:{" "}
                  <b className="text-foreground">
                    {Number.isFinite(parseFloat(fields.priceAmount)) ? money(parseFloat(fields.priceAmount)) : fields.priceAmount}
                  </b>{" "}
                  ({fields.priceInWords}) to provide and install the above listed items. This price and obligation are valid for 30 days from the date quoted above.
                </p>
                <p className="mt-2">Thank you, — Ryan Ledbetter, Estimator</p>
                <p>Upon approval of this bid, please email this page to julie@rivercityplastics.com</p>
                <p className="mt-1">Signed By: _______________ Date: _______________</p>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => saveEdits(() => toast({ title: "Proposal saved" }))}
                  disabled={updateProposal.isPending || !dirty}
                  className="font-mono uppercase tracking-wider text-xs"
                  data-testid="button-save-proposal"
                >
                  <Save className="mr-2 h-4 w-4" />
                  {updateProposal.isPending ? "Saving..." : dirty ? "Save Edits" : "Saved"}
                </Button>
                <Button
                  size="sm"
                  onClick={handleExport}
                  disabled={updateProposal.isPending}
                  className="font-mono uppercase tracking-wider text-xs"
                  data-testid="button-export-proposal"
                >
                  <Download className="mr-2 h-4 w-4" /> Export PDF
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
