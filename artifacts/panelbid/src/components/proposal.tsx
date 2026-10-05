import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useGetProposal,
  useGenerateProposal,
  useUpdateProposal,
  useGetTakeoff,
  getGetProposalQueryKey,
  getGetTakeoffQueryKey,
  type Proposal,
  type Job,
} from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useToast } from "@/hooks/use-toast"
import { FileSignature, RefreshCw, Save, Download, AlertTriangle } from "lucide-react"
import { formatDateTime } from "@/lib/format"
// The price is read, and its words written, by the shared rules: one number
// for both, and anything unclear is refused instead of guessed.
import {
  checkProposalForExport,
  computeCosts,
  noPriceRegenerateResult,
  noPriceRegenerateWarning,
  priceDifferenceNotice,
  roundToCents,
  type ExportCheck,
} from "@/lib/takeoff-rules"

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
  /** As typed. Read strictly by checkProposalForExport, never by parseFloat. */
  priceAmount: string
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
    // A price of 0 means "no price yet": show an empty box, not $0.00.
    priceAmount: p.priceAmount > 0 ? p.priceAmount.toFixed(2) : "",
  }
}

/** A refusal from the server in its own plain words (without "HTTP 409 ..."). */
function serverWords(err: unknown): string | undefined {
  const data = (err as { data?: { message?: unknown } } | null)?.data
  if (data && typeof data.message === "string" && data.message.trim() !== "") return data.message
  return err instanceof Error ? err.message : undefined
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const multiline = (s: string) => escapeHtml(s).replace(/\n/g, "<br/>")

// Standalone HTML that mirrors the RCP bid proposal template, printed to PDF
// via the browser print dialog. The figure and the words are passed in as one
// checked number: this function never reads the typed text itself.
function buildProposalHtml(f: ProposalFields, amount: number, words: string): string {
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
  <div class="price">River City Plastics, Inc., is pleased to provide you with a price of: <b>${escapeHtml(money(amount))}</b> (${escapeHtml(words)}) to provide and install the above listed items. This price and obligation are valid for 30 days from the date quoted above.</div>
  <div class="sig">
    <p>Thank you,</p>
    <p>Ryan Ledbetter, Estimator</p>
    <p>Upon approval of this bid, please email this page to julie@rivercityplastics.com</p>
    <p class="signline">Signed By: _______________________________ &nbsp;&nbsp; Date: _______________</p>
  </div>
</body></html>`
}

export function ProposalSection({
  job,
  takeoffUnsaved,
}: {
  job: Job
  /** True while the takeoff on screen has changes that are not saved. */
  takeoffUnsaved: boolean
}) {
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
  // Same cached copy the takeoff section uses: tells us when it was last saved.
  const { data: takeoff } = useGetTakeoff(jobId, {
    query: { enabled: !!jobId, queryKey: getGetTakeoffQueryKey(jobId) },
  })
  const generateProposal = useGenerateProposal()
  const updateProposal = useUpdateProposal()

  const [previewOpen, setPreviewOpen] = useState(false)
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
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

  // The takeoff was saved again after this proposal was made: its sheet count
  // and price may be old.
  const takeoffNewer =
    !!proposal &&
    !!takeoff?.saved &&
    !!takeoff.updatedAt &&
    new Date(takeoff.updatedAt).getTime() > new Date(proposal.generatedAt).getTime()

  // Prices are optional. A takeoff that is not fully priced gives the proposal
  // no price: the person types the total here instead.
  const takeoffCosts = takeoff?.saved ? computeCosts(takeoff) : null
  const takeoffGivesPrice = takeoffCosts?.fullyPriced ?? false

  // One strict reading of the price, used for the screen, the save and the PDF.
  const check: ExportCheck = fields
    ? checkProposalForExport({ frp: fields.frp, priceAmount: fields.priceAmount })
    : { amount: null, words: "", problems: [] }
  const priceBoxEmpty = (fields?.priceAmount.trim() ?? "") === ""
  const priceUnclear = !!fields && !priceBoxEmpty && check.amount === null

  // A notice, never a block: the saved takeoff is fully priced and its total
  // is not the price this proposal says. On the card it is the stored price;
  // in the window it is the price as typed now (nothing while it is unclear).
  const takeoffPrice = takeoffCosts?.fullyPriced ? roundToCents(takeoffCosts.total) : null
  const storedPriceNotice = proposal ? priceDifferenceNotice(takeoffPrice, proposal.priceAmount) : null
  const typedPriceNotice =
    fields && !priceUnclear ? priceDifferenceNotice(takeoffPrice, check.amount ?? 0) : null
  const exportProblems = [
    ...check.problems,
    ...(takeoffUnsaved
      ? ["The takeoff has changes that are not saved. Save the takeoff, then regenerate."]
      : takeoffNewer
        ? ["The takeoff was saved after this proposal was made. Close this window and press Regenerate so the sheet count and the price match the takeoff. Your other text is kept."]
        : []),
  ]

  const runGenerate = () => {
    // The price this proposal holds now: said in the message if it is cleared.
    const priceBefore = proposal?.priceAmount ?? 0
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
            // The server decides the price; the message says what it answered.
            description: !(p.priceAmount > 0)
              ? noPriceRegenerateResult(priceBefore)
              : proposal
                ? "The FRP line and the price were rewritten from the saved takeoff. Everything else you typed was kept."
                : "Filled in from the job and the saved takeoff.",
          })
        },
        onError: (err) =>
          toast({
            title: "The proposal was not made",
            description: serverWords(err),
            variant: "destructive",
          }),
      },
    )
  }

  const handleGenerate = () => {
    if (takeoffUnsaved) {
      toast({
        title: "Save the takeoff first",
        description: "The takeoff has changes that are not saved. A proposal is only made from the saved takeoff.",
        variant: "destructive",
      })
      return
    }
    if (proposal) setConfirmRegenerate(true)
    else runGenerate()
  }

  const saveEdits = (onSaved?: () => void) => {
    if (!fields) return
    if (priceUnclear) {
      toast({
        title: "The price was not saved",
        description: check.problems[0],
        variant: "destructive",
      })
      return
    }
    updateProposal.mutate(
      {
        jobId,
        // An empty price box is saved as "no price yet" (0). The words are
        // written by the server from the same number.
        data: { ...fields, priceAmount: check.amount ?? 0 },
      },
      {
        onSuccess: (p) => {
          queryClient.setQueryData(getGetProposalQueryKey(jobId), p)
          setFields(toFields(p))
          setDirty(false)
          onSaved?.()
        },
        onError: (err) =>
          toast({
            title: "Failed to save proposal",
            // the server's own words when it refused (a price below 0, say)
            description: (err as { data?: { message?: unknown } } | null)?.data ? serverWords(err) : undefined,
            variant: "destructive",
          }),
      },
    )
  }

  const handleExport = () => {
    if (!fields) return
    if (exportProblems.length > 0 || check.amount === null) {
      toast({
        title: "Not exported",
        description: exportProblems[0],
        variant: "destructive",
      })
      return
    }
    const amount = check.amount
    const words = check.words
    const snapshot = fields
    const doExport = () => {
      const win = window.open("", "_blank")
      if (!win) {
        toast({ title: "Popup blocked", description: "Allow popups to export the PDF.", variant: "destructive" })
        return
      }
      win.document.write(buildProposalHtml(snapshot, amount, words))
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
            Customer-ready proposal on the River City Plastics template, made from the saved takeoff.
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
            disabled={generateProposal.isPending || takeoffUnsaved}
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
      <CardContent className="p-4 text-sm text-muted-foreground space-y-2">
        {takeoffUnsaved && (
          <p className="flex items-start gap-2 text-amber-700" data-testid="text-proposal-takeoff-unsaved">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            The takeoff has changes that are not saved. Save the takeoff first: a proposal is only made from the saved takeoff.
          </p>
        )}
        {!takeoffUnsaved && takeoffNewer && (
          <p className="flex items-start gap-2 text-amber-700" data-testid="text-proposal-takeoff-newer">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            The takeoff was saved after this proposal was made. Press Regenerate so the sheet count and the price match it. Your other text is kept.
          </p>
        )}
        {storedPriceNotice && (
          <p className="flex items-start gap-2 text-amber-700" data-testid="text-proposal-price-differs">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            {storedPriceNotice}
          </p>
        )}
        {isLoading ? (
          "Loading proposal..."
        ) : proposal ? (
          <span data-testid="text-proposal-status">
            Generated {formatDateTime(proposal.generatedAt)} — last edited {formatDateTime(proposal.updatedAt)} — price{" "}
            {proposal.priceAmount > 0 ? money(proposal.priceAmount) : "not set yet"}
          </span>
        ) : (
          "No proposal yet. Generate one from the saved takeoff to review, edit, and export as PDF."
        )}
      </CardContent>

      <AlertDialog open={confirmRegenerate} onOpenChange={setConfirmRegenerate}>
        <AlertDialogContent data-testid="dialog-confirm-regenerate">
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate from the saved takeoff?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                {takeoffGivesPrice ? (
                  <p>
                    Two things are rewritten from the takeoff: the <b>FRP line</b> and the <b>price</b>.
                  </p>
                ) : (
                  <p data-testid="text-regenerate-no-price">
                    The <b>FRP line</b> is rewritten from the takeoff.{" "}
                    <b>{noPriceRegenerateWarning(proposal?.priceAmount ?? 0, takeoffCosts?.notPriced ?? [])}</b>
                  </p>
                )}
                {proposal && (
                  <div className="rounded-md border p-2 bg-muted/20 text-xs space-y-1">
                    <p className="font-medium text-foreground">Replaced:</p>
                    <p>{proposal.frp}</p>
                    {takeoffGivesPrice ? (
                      <p>Price: {proposal.priceAmount > 0 ? money(proposal.priceAmount) : "not set yet"}</p>
                    ) : (
                      proposal.priceAmount > 0 && <p>Price: {money(proposal.priceAmount)} (cleared, not replaced)</p>
                    )}
                  </div>
                )}
                <p>
                  Everything else you typed stays as it is: the date, the project lines, high impact panel, corner
                  guards, stainless steel, adds/deducts, exclusions and notes.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-regenerate">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runGenerate} data-testid="button-confirm-regenerate">
              Regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
                <div className="space-y-1">
                  <label className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Price ($)</label>
                  <Input
                    value={fields.priceAmount}
                    onChange={(e) => set({ priceAmount: e.target.value })}
                    placeholder="Type the total, e.g. 4,100.00"
                    className={`h-8 text-sm ${priceUnclear ? "border-destructive" : ""}`}
                    data-testid="input-proposal-priceAmount"
                  />
                  <p className="text-xs" data-testid="text-proposal-price-read">
                    {check.amount !== null ? (
                      <span className="text-muted-foreground">Read as {money(check.amount)}</span>
                    ) : (
                      <span className="text-destructive">
                        {priceBoxEmpty ? "No price yet: type the total price." : check.problems[0]}
                      </span>
                    )}
                  </p>
                  {typedPriceNotice && (
                    <p className="text-xs text-amber-700" data-testid="text-proposal-price-differs-typed">
                      {typedPriceNotice}
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                    Price in Words (written from the price)
                  </label>
                  <p className="min-h-8 rounded-md border bg-muted/20 px-3 py-1.5 text-sm" data-testid="text-proposal-priceInWords">
                    {check.words || "—"}
                  </p>
                </div>
              </div>

              <div className="rounded-md border p-3 bg-muted/20 text-xs text-muted-foreground leading-relaxed">
                <p>
                  River City Plastics, Inc., is pleased to provide you with a price of:{" "}
                  <b className="text-foreground" data-testid="text-proposal-price-sentence">
                    {check.amount !== null ? money(check.amount) : "(no price yet)"}
                  </b>{" "}
                  ({check.words || "—"}) to provide and install the above listed items. This price and obligation are valid for 30 days from the date quoted above.
                </p>
                <p className="mt-2">Thank you, — Ryan Ledbetter, Estimator</p>
                <p>Upon approval of this bid, please email this page to julie@rivercityplastics.com</p>
                <p className="mt-1">Signed By: _______________ Date: _______________</p>
              </div>

              {exportProblems.length > 0 && (
                <div
                  className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive space-y-1"
                  data-testid="text-proposal-export-problems"
                >
                  <p className="font-medium">This proposal cannot be exported yet:</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {exportProblems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => saveEdits(() => toast({ title: "Proposal saved" }))}
                  disabled={updateProposal.isPending || !dirty || priceUnclear}
                  className="font-mono uppercase tracking-wider text-xs"
                  data-testid="button-save-proposal"
                >
                  <Save className="mr-2 h-4 w-4" />
                  {updateProposal.isPending ? "Saving..." : dirty ? "Save Edits" : "Saved"}
                </Button>
                <Button
                  size="sm"
                  onClick={handleExport}
                  disabled={updateProposal.isPending || exportProblems.length > 0}
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
