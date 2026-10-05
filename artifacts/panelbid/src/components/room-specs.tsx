import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListRoomSpecs,
  useExtractSpecs,
  useCreateRoomSpec,
  useUpdateRoomSpec,
  useDeleteRoomSpec,
  useConfirmSpecs,
  useListPlanScans,
  getListRoomSpecsQueryKey,
  getGetJobQueryKey,
  getListJobsQueryKey,
  getGetJobsSummaryQueryKey,
  getListPlanScansQueryKey,
  MaterialCategory,
  type RoomSpec,
  type RoomSpecInput,
  type Job,
} from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { Sparkles, Plus, Trash2, Pencil, Check, X, ClipboardList, AlertTriangle, CheckCircle2 } from "lucide-react"

const MATERIAL_LABELS: Record<MaterialCategory, string> = {
  frp: "FRP",
  stainless: "Stainless",
  pvc: "PVC",
}

const EDIT_FIELDS = [
  { key: "roomName", label: "Room", width: "min-w-[140px]" },
  { key: "roomNumber", label: "Rm #", width: "w-20" },
  { key: "materialHeight", label: "Height", width: "w-24" },
  { key: "ceilingHeight", label: "Clg Ht", width: "w-20" },
  { key: "manufacturer", label: "Manufacturer", width: "min-w-[110px]" },
  { key: "color", label: "Color", width: "w-24" },
  { key: "productCode", label: "Product", width: "w-24" },
  { key: "texture", label: "Texture", width: "w-24" },
  { key: "fireRating", label: "Fire Rating", width: "w-24" },
] as const

type TextFieldKey = (typeof EDIT_FIELDS)[number]["key"]

type Draft = Partial<Record<TextFieldKey, string>> & {
  materialCategory?: MaterialCategory | "none"
}

function draftFromSpec(spec: RoomSpec): Draft {
  return {
    roomName: spec.roomName ?? "",
    roomNumber: spec.roomNumber ?? "",
    materialCategory: spec.materialCategory ?? "none",
    materialHeight: spec.materialHeight ?? "",
    ceilingHeight: spec.ceilingHeight ?? "",
    manufacturer: spec.manufacturer ?? "",
    color: spec.color ?? "",
    productCode: spec.productCode ?? "",
    texture: spec.texture ?? "",
    fireRating: spec.fireRating ?? "",
  }
}

function draftToInput(draft: Draft): RoomSpecInput {
  const val = (s?: string) => (s && s.trim() !== "" ? s.trim() : null)
  return {
    roomName: val(draft.roomName),
    roomNumber: val(draft.roomNumber),
    materialCategory: draft.materialCategory === "none" ? null : draft.materialCategory ?? null,
    materialHeight: val(draft.materialHeight),
    ceilingHeight: val(draft.ceilingHeight),
    manufacturer: val(draft.manufacturer),
    color: val(draft.color),
    productCode: val(draft.productCode),
    texture: val(draft.texture),
    fireRating: val(draft.fireRating),
  }
}

export function RoomSpecsSection({ job }: { job: Job }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const jobId = job.id

  const { data: specs, isLoading } = useListRoomSpecs(jobId, {
    query: { enabled: !!jobId, queryKey: getListRoomSpecsQueryKey(jobId) },
  })

  const { data: scans } = useListPlanScans(jobId, {
    query: { enabled: !!jobId, queryKey: getListPlanScansQueryKey(jobId) },
  })

  // Manufacturer brand names found by the keyword scan — surfaced as
  // suggestions for the reviewer to confirm, never auto-filled.
  const suggestedManufacturers = Array.from(
    new Map(
      (scans ?? [])
        .filter((s) => s.category === "manufacturer")
        .map((s) => [s.term.toLowerCase(), s.term]),
    ).values(),
  ).sort((a, b) => a.localeCompare(b))

  const extractSpecs = useExtractSpecs()
  const createSpec = useCreateRoomSpec()
  const updateSpec = useUpdateRoomSpec()
  const deleteSpec = useDeleteRoomSpec()
  const confirmSpecs = useConfirmSpecs()

  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft>({})
  const [adding, setAdding] = useState(false)

  const invalidateSpecs = () =>
    queryClient.invalidateQueries({ queryKey: getListRoomSpecsQueryKey(jobId) })

  const handleExtract = () => {
    extractSpecs.mutate(
      { jobId },
      {
        onSuccess: (result) => {
          invalidateSpecs()
          const hadFailures = result.pagesFailed > 0 || result.filesFailed > 0
          toast({
            title: hadFailures ? "Spec extraction finished with warnings" : "Spec extraction complete",
            variant: hadFailures ? "destructive" : undefined,
            description: `${result.roomsExtracted} room${result.roomsExtracted === 1 ? "" : "s"} extracted from ${result.pagesProcessed} of ${result.candidatePages} candidate page${result.candidatePages === 1 ? "" : "s"}${result.ambiguousRooms > 0 ? ` — ${result.ambiguousRooms} need review` : ""}${result.pagesFailed > 0 ? ` — ${result.pagesFailed} page${result.pagesFailed === 1 ? "" : "s"} could not be processed (existing rows kept)` : ""}${result.filesFailed > 0 ? ` — ${result.filesFailed} file${result.filesFailed === 1 ? "" : "s"} could not be read` : ""}`,
          })
        },
        onError: () => toast({ title: "Extraction failed", variant: "destructive" }),
      },
    )
  }

  const startEdit = (spec: RoomSpec) => {
    setAdding(false)
    setEditingId(spec.id)
    setDraft(draftFromSpec(spec))
  }

  const saveEdit = (specId: number) => {
    updateSpec.mutate(
      { specId, data: draftToInput(draft) },
      {
        onSuccess: () => {
          setEditingId(null)
          invalidateSpecs()
          toast({ title: "Row updated" })
        },
        onError: () => toast({ title: "Failed to update row", variant: "destructive" }),
      },
    )
  }

  const startAdd = () => {
    setEditingId(null)
    setAdding(true)
    setDraft({ materialCategory: "none" })
  }

  const saveAdd = () => {
    createSpec.mutate(
      { jobId, data: draftToInput(draft) },
      {
        onSuccess: () => {
          setAdding(false)
          invalidateSpecs()
          toast({ title: "Row added" })
        },
        onError: () => toast({ title: "Failed to add row", variant: "destructive" }),
      },
    )
  }

  const handleDelete = (specId: number) => {
    deleteSpec.mutate(
      { specId },
      {
        onSuccess: () => {
          invalidateSpecs()
          toast({ title: "Row deleted" })
        },
        onError: () => toast({ title: "Failed to delete row", variant: "destructive" }),
      },
    )
  }

  const handleConfirm = () => {
    confirmSpecs.mutate(
      { jobId },
      {
        onSuccess: (updatedJob) => {
          queryClient.setQueryData(getGetJobQueryKey(jobId), updatedJob)
          queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() })
          queryClient.invalidateQueries({ queryKey: getGetJobsSummaryQueryKey() })
          toast({ title: "Specs confirmed", description: "Job moved to Takeoff." })
        },
        onError: () => toast({ title: "Failed to confirm specs", variant: "destructive" }),
      },
    )
  }

  const renderDraftCells = () => (
    <>
      <td className="p-2">
        <Select
          value={draft.materialCategory ?? "none"}
          onValueChange={(v) => setDraft((d) => ({ ...d, materialCategory: v as Draft["materialCategory"] }))}
        >
          <SelectTrigger className="h-8 w-[110px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">—</SelectItem>
            {Object.entries(MATERIAL_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>
      {EDIT_FIELDS.map((f) => (
        <td key={f.key} className="p-2">
          <Input
            className={`h-8 text-xs ${f.width}`}
            value={draft[f.key] ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
            placeholder="—"
            list={f.key === "manufacturer" && suggestedManufacturers.length > 0 ? "manufacturer-suggestions" : undefined}
          />
          {f.key === "manufacturer" && suggestedManufacturers.length > 0 && (
            <datalist id="manufacturer-suggestions">
              {suggestedManufacturers.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          )}
        </td>
      ))}
    </>
  )

  return (
    <Card className="border-border/60 shadow-sm">
      <CardHeader className="bg-muted/30 border-b border-border/40 pb-4 flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-lg">Room Specs</CardTitle>
          <CardDescription className="mt-1">
            Room-by-room panel materials extracted from finish schedules. Review, edit, then confirm.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {job.status === "needs_review" && (
            <Button
              onClick={handleExtract}
              disabled={extractSpecs.isPending}
              size="sm"
              className="font-mono uppercase tracking-wider text-xs"
            >
              <Sparkles className={`mr-2 h-4 w-4 ${extractSpecs.isPending ? "animate-pulse" : ""}`} />
              {extractSpecs.isPending ? "Extracting..." : "Extract Specs"}
            </Button>
          )}
          {specs && specs.length > 0 && (
            <Button
              onClick={handleConfirm}
              disabled={confirmSpecs.isPending || job.status === "takeoff"}
              size="sm"
              variant="outline"
              className="font-mono uppercase tracking-wider text-xs border-green-600/40 text-green-700 hover:bg-green-600 hover:text-white"
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              {job.status === "takeoff" ? "Confirmed" : confirmSpecs.isPending ? "Confirming..." : "Confirm Specs"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {suggestedManufacturers.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-border/40 bg-blue-500/5">
            <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Manufacturers detected in plans:
            </span>
            {suggestedManufacturers.map((m) => (
              <Badge
                key={m}
                variant="outline"
                className="border-blue-500/40 bg-blue-500/10 text-blue-700 text-[10px] font-mono cursor-default"
                title="Found by keyword scan — suggested value for the Manufacturer field; confirm before using"
              >
                {m}
              </Badge>
            ))}
            <span className="text-[11px] text-muted-foreground">
              — suggested values for the Manufacturer field (confirm when editing a row)
            </span>
          </div>
        )}
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground">Loading room specs...</div>
        ) : (specs && specs.length > 0) || adding ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/40 bg-muted/20 text-left text-xs font-mono uppercase tracking-wider text-muted-foreground">
                  <th className="p-3">Material</th>
                  {EDIT_FIELDS.map((f) => (
                    <th key={f.key} className="p-3">{f.label}</th>
                  ))}
                  <th className="p-3">Source</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {(specs ?? []).map((spec) => {
                  const isEditing = editingId === spec.id
                  const ambiguous = spec.extractionConfidence === "ambiguous"
                  return (
                    <tr
                      key={spec.id}
                      className={`${ambiguous ? "bg-amber-500/5" : ""} hover:bg-muted/20 transition-colors`}
                    >
                      {isEditing ? (
                        renderDraftCells()
                      ) : (
                        <>
                          <td className="p-3">
                            <div className="flex items-center gap-1.5">
                              {spec.materialCategory ? (
                                <Badge className="font-mono text-[10px] uppercase">{MATERIAL_LABELS[spec.materialCategory]}</Badge>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                              {ambiguous && (
                                <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-600 text-[10px] font-mono uppercase tracking-wider gap-1">
                                  <AlertTriangle className="h-3 w-3" /> Review
                                </Badge>
                              )}
                            </div>
                          </td>
                          <td className="p-3 font-medium">{spec.roomName ?? <span className="text-muted-foreground">—</span>}</td>
                          <td className="p-3 font-mono text-xs">{spec.roomNumber ?? "—"}</td>
                          <td className="p-3 text-xs">{spec.materialHeight ?? "—"}</td>
                          <td className="p-3 text-xs">{spec.ceilingHeight ?? "—"}</td>
                          <td className="p-3 text-xs">{spec.manufacturer ?? "—"}</td>
                          <td className="p-3 text-xs">{spec.color ?? "—"}</td>
                          <td className="p-3 font-mono text-xs">{spec.productCode ?? "—"}</td>
                          <td className="p-3 text-xs">{spec.texture ?? "—"}</td>
                          <td className="p-3 text-xs">
                            {spec.fireRating ?? "—"}
                            {spec.fireRatingDefaulted && (
                              <span className="ml-1 text-[10px] text-muted-foreground" title="No rating found anywhere in the plans; Class C applied by default">
                                (default)
                              </span>
                            )}
                          </td>
                        </>
                      )}
                      <td className="p-3 text-xs font-mono text-muted-foreground whitespace-nowrap">
                        {spec.sourceFileId && spec.sourcePage ? (
                          <a
                            href={`${import.meta.env.BASE_URL}api/files/${spec.sourceFileId}/view#page=${spec.sourcePage}`}
                            target="_blank"
                            rel="noreferrer"
                            className="underline decoration-dotted hover:text-foreground"
                            title={spec.sourceFileName ?? undefined}
                          >
                            p. {spec.sourcePages ?? spec.sourcePage}
                          </a>
                        ) : (
                          "manual"
                        )}
                      </td>
                      <td className="p-3">
                        <div className="flex items-center justify-end gap-1">
                          {isEditing ? (
                            <>
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-green-600" onClick={() => saveEdit(spec.id)} disabled={updateSpec.isPending}>
                                <Check className="h-4 w-4" />
                                <span className="sr-only">Save</span>
                              </Button>
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditingId(null)}>
                                <X className="h-4 w-4" />
                                <span className="sr-only">Cancel</span>
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => startEdit(spec)}>
                                <Pencil className="h-3.5 w-3.5" />
                                <span className="sr-only">Edit</span>
                              </Button>
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => handleDelete(spec.id)} disabled={deleteSpec.isPending}>
                                <Trash2 className="h-3.5 w-3.5" />
                                <span className="sr-only">Delete</span>
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {adding && (
                  <tr className="bg-muted/10">
                    {renderDraftCells()}
                    <td className="p-3 text-xs font-mono text-muted-foreground">manual</td>
                    <td className="p-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-green-600" onClick={saveAdd} disabled={createSpec.isPending}>
                          <Check className="h-4 w-4" />
                          <span className="sr-only">Save</span>
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setAdding(false)}>
                          <X className="h-4 w-4" />
                          <span className="sr-only">Cancel</span>
                        </Button>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {!adding && (
              <div className="border-t border-border/40 p-3">
                <Button variant="ghost" size="sm" onClick={startAdd} className="text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground">
                  <Plus className="mr-2 h-4 w-4" /> Add Row
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center p-12 text-center">
            <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <ClipboardList className="h-8 w-8 text-muted-foreground/50" />
            </div>
            <h3 className="text-lg font-semibold">No room specs extracted</h3>
            <p className="text-muted-foreground max-w-sm mt-2">
              {job.status === "needs_review"
                ? "Run Extract Specs to detect finish schedules in the plans and pull room-by-room material data."
                : "Move the job to Needs Review status to run spec extraction."}
            </p>
            {job.status === "needs_review" && (
              <Button variant="ghost" size="sm" onClick={startAdd} className="mt-4 text-xs font-mono uppercase tracking-wider">
                <Plus className="mr-2 h-4 w-4" /> Add Row Manually
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
