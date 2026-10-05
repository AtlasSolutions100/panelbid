import { useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useGetTakeoff,
  useSaveTakeoff,
  getGetTakeoffQueryKey,
  getGetJobQueryKey,
  getListJobsQueryKey,
  getGetJobsSummaryQueryKey,
  getListJobFilesQueryKey,
  type Takeoff,
  type TakeoffInput,
  type TakeoffRoomRow,
  type TakeoffSheetRow,
  type Job,
  type JobFile,
  MoldingType,
  SheetSize,
  useExtractPriceSheet,
  useGetPriceSheetExtraction,
  getGetPriceSheetExtractionQueryKey,
  useListPriceSheetItems,
  getListPriceSheetItemsQueryKey,
  type PriceSheetItem,
} from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { Plus, Trash2, Save, Calculator, Upload, FileText, Sparkles, Loader2, ChevronDown } from "lucide-react"

// Every takeoff rule (wall lengths, sheets, cost lines, the total) comes from
// the shared rules file. No rule is written in this page.
import {
  SHEET_SIZES,
  OVERTIME_RATE,
  HOTEL_NIGHTLY,
  PROFIT_FLAT,
  PROFIT_PER_DAY,
  PROFIT_SHEET_THRESHOLD,
  computeCosts,
  flatProfitApplies,
  linearFootage,
  resolvePricePerSheet,
  sameJson,
  sheetAreaSqft,
} from "@/lib/takeoff-rules"

/** Everything on the takeoff sheet that a person types (the total is worked out). */
type TakeoffData = Omit<TakeoffInput, "totalPrice">

function dataFromTakeoff(t: Takeoff): TakeoffData {
  return {
    roomRows: t.roomRows,
    sheetRows: t.sheetRows,
    priceSheetFileId: t.priceSheetFileId,
    laborRate: t.laborRate,
    laborDays: t.laborDays,
    laborHoursPerDay: t.laborHoursPerDay,
    travelMiles: t.travelMiles,
    hotelNights: t.hotelNights,
    freight: t.freight,
    profitOverride: t.profitOverride,
    notes: null,
    thickness: t.thickness,
  }
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" })

const num = (v: string) => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Searchable selector of extracted price-sheet items. Picking one fills the
 * row's price per sheet (converting from price/sqft when needed); the value
 * stays manually editable in the input beside it.
 */
function PricePicker({
  items,
  rowSize,
  rowIndex,
  onPick,
}: {
  items: PriceSheetItem[]
  rowSize: SheetSize
  rowIndex: number
  onPick: (pricePerSheet: number) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground shrink-0"
          title="Pick from extracted price sheet"
          data-testid={`button-price-picker-${rowIndex}`}
        >
          <Sparkles className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search extracted price items..." className="text-xs" />
          <CommandList>
            <CommandEmpty>No matching price items.</CommandEmpty>
            <CommandGroup>
              {items.map((item) => {
                const price = resolvePricePerSheet(item, rowSize)
                const label = [item.productDescription, item.productCode, item.sheetSize]
                  .filter(Boolean)
                  .join(" ")
                return (
                  <CommandItem
                    key={item.id}
                    value={`${label} ${item.id}`}
                    disabled={price === null}
                    onSelect={() => {
                      if (price === null) return
                      onPick(price)
                      setOpen(false)
                    }}
                    className="text-xs"
                    data-testid={`option-price-item-${rowIndex}-${item.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="truncate">
                        {item.productDescription ?? <span className="text-muted-foreground">(no description)</span>}
                      </div>
                      <div className="text-[10px] text-muted-foreground font-mono">
                        {[item.productCode, item.sheetSize && `size ${item.sheetSize}`, `p.${item.sourcePage}`]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <div className="ml-2 text-right font-mono shrink-0">
                      {price !== null ? money(price) : "—"}
                      {item.pricePerSheet == null && item.pricePerSqft != null && price !== null && (
                        <div className="text-[10px] text-muted-foreground">
                          {money(item.pricePerSqft)}/sqft × {sheetAreaSqft(rowSize)} sqft
                        </div>
                      )}
                    </div>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function TakeoffSection({
  job,
  files,
  onUnsavedChange,
}: {
  job: Job
  files: JobFile[]
  /** Told whenever the sheet on screen stops (or starts) matching what is saved. */
  onUnsavedChange?: (unsaved: boolean) => void
}) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const jobId = job.id

  const { data: takeoff, isLoading } = useGetTakeoff(jobId, {
    query: { enabled: !!jobId, queryKey: getGetTakeoffQueryKey(jobId) },
  })
  const saveTakeoff = useSaveTakeoff()

  // Editable local state, initialized from the fetched takeoff (saved or draft).
  const [roomRows, setRoomRows] = useState<TakeoffRoomRow[]>([])
  const [sheetRows, setSheetRows] = useState<TakeoffSheetRow[]>([])
  const [priceSheetFileId, setPriceSheetFileId] = useState<number | null>(null)
  const [laborRate, setLaborRate] = useState("0")
  const [laborDays, setLaborDays] = useState("0")
  const [laborHoursPerDay, setLaborHoursPerDay] = useState("0")
  const [travelMiles, setTravelMiles] = useState("0")
  const [hotelNights, setHotelNights] = useState("0")
  const [freight, setFreight] = useState("0")
  const [thickness, setThickness] = useState("")
  const [profitOverride, setProfitOverride] = useState<string | null>(null)
  const [isUploadingPriceSheet, setIsUploadingPriceSheet] = useState(false)
  const [showPriceItems, setShowPriceItems] = useState(false)
  const priceSheetInputRef = useRef<HTMLInputElement>(null)
  const loadedFor = useRef<number | null>(null)
  // The takeoff as it is saved on the server (null: never saved).
  const [savedData, setSavedData] = useState<TakeoffData | null>(null)

  // Price-sheet extraction: status polling + extracted items for the picker.
  const extractPrices = useExtractPriceSheet()
  const { data: priceExtraction } = useGetPriceSheetExtraction(
    priceSheetFileId ?? 0,
    {
      query: {
        enabled: priceSheetFileId !== null,
        queryKey: getGetPriceSheetExtractionQueryKey(priceSheetFileId ?? 0),
        refetchInterval: (q) =>
          q.state.data?.status === "running" ? 2000 : false,
      },
    },
  )
  const extractionStatus = priceExtraction?.status ?? "not_started"
  const { data: priceItems = [] } = useListPriceSheetItems(priceSheetFileId ?? 0, {
    query: {
      enabled: priceSheetFileId !== null && extractionStatus === "completed",
      queryKey: getListPriceSheetItemsQueryKey(priceSheetFileId ?? 0),
    },
  })

  const handleExtractPrices = () => {
    if (priceSheetFileId === null) return
    extractPrices.mutate(
      { fileId: priceSheetFileId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetPriceSheetExtractionQueryKey(priceSheetFileId),
          })
          toast({
            title: "Price extraction started",
            description: "Reading the price sheet — items will appear here when done.",
          })
        },
        onError: () => toast({ title: "Failed to start price extraction", variant: "destructive" }),
      },
    )
  }

  // Refresh the item list when a running extraction completes.
  const prevStatus = useRef(extractionStatus)
  useEffect(() => {
    if (prevStatus.current === "running" && extractionStatus === "completed" && priceSheetFileId !== null) {
      queryClient.invalidateQueries({ queryKey: getListPriceSheetItemsQueryKey(priceSheetFileId) })
      setShowPriceItems(true)
      toast({
        title: "Price extraction complete",
        description: `${priceExtraction?.itemCount ?? 0} price items extracted. Review them below.`,
      })
    }
    if (prevStatus.current === "running" && extractionStatus === "failed") {
      toast({
        title: "Price extraction failed",
        description: priceExtraction?.error ?? undefined,
        variant: "destructive",
      })
    }
    prevStatus.current = extractionStatus
  }, [extractionStatus, priceSheetFileId, queryClient, toast, priceExtraction])

  // Put a takeoff from the server on screen and remember it as "what is saved".
  const showTakeoff = (t: Takeoff) => {
    setRoomRows(t.roomRows)
    setSheetRows(t.sheetRows)
    setPriceSheetFileId(t.priceSheetFileId)
    setLaborRate(String(t.laborRate))
    setLaborDays(String(t.laborDays))
    setLaborHoursPerDay(String(t.laborHoursPerDay))
    setTravelMiles(String(t.travelMiles))
    setHotelNights(String(t.hotelNights))
    setFreight(String(t.freight))
    setThickness(t.thickness ?? "")
    setProfitOverride(t.profitOverride === null ? null : String(t.profitOverride))
    setSavedData(t.saved ? dataFromTakeoff(t) : null)
  }

  useEffect(() => {
    if (!takeoff || loadedFor.current === jobId) return
    loadedFor.current = jobId
    showTakeoff(takeoff)
  }, [takeoff, jobId])

  // What would be saved if Save were pressed now.
  const currentData: TakeoffData = useMemo(
    () => ({
      roomRows,
      sheetRows,
      priceSheetFileId,
      laborRate: num(laborRate),
      laborDays: num(laborDays),
      laborHoursPerDay: num(laborHoursPerDay),
      travelMiles: num(travelMiles),
      hotelNights: num(hotelNights),
      freight: num(freight),
      profitOverride: profitOverride !== null ? num(profitOverride) : null,
      notes: null,
      thickness: thickness.trim() !== "" ? thickness.trim() : null,
    }),
    [roomRows, sheetRows, priceSheetFileId, laborRate, laborDays, laborHoursPerDay, travelMiles, hotelNights, freight, profitOverride, thickness],
  )

  // The proposal is only ever made from a saved takeoff, so the page has to
  // know when the screen and the saved copy differ.
  const loaded = !!takeoff && loadedFor.current === jobId
  const unsaved = loaded && (savedData === null || !sameJson(savedData, currentData))
  useEffect(() => {
    onUnsavedChange?.(unsaved)
  }, [unsaved, onUnsavedChange])

  // Live calculations
  const totals = useMemo(
    () =>
      computeCosts({
        sheetRows,
        laborRate: num(laborRate),
        laborDays: num(laborDays),
        laborHoursPerDay: num(laborHoursPerDay),
        travelMiles: num(travelMiles),
        hotelNights: num(hotelNights),
        freight: num(freight),
        profitOverride: profitOverride !== null ? num(profitOverride) : null,
      }),
    [sheetRows, laborRate, laborDays, laborHoursPerDay, travelMiles, hotelNights, freight, profitOverride],
  )

  const updateRoomRow = (i: number, patch: Partial<TakeoffRoomRow>) =>
    setRoomRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const updateSheetRow = (i: number, patch: Partial<TakeoffSheetRow>) =>
    setSheetRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  const addRoomRow = () =>
    setRoomRows((rows) => [
      ...rows,
      { roomName: "", roomNumber: "", wallLengths: "", materialHeight: "", manufacturer: "", color: "", productCode: "", fireRating: "", moldingType: null },
    ])
  const addSheetRow = () =>
    setSheetRows((rows) => [...rows, { sheetsNeeded: 0, sheetSize: "4x8", pricePerSheet: 0 }])

  const handleSave = () => {
    saveTakeoff.mutate(
      {
        jobId,
        // The server works the total out again from the same rules.
        data: { ...currentData, totalPrice: totals.total },
      },
      {
        onSuccess: (saved) => {
          queryClient.setQueryData(getGetTakeoffQueryKey(jobId), saved)
          showTakeoff(saved)
          queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) })
          queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() })
          queryClient.invalidateQueries({ queryKey: getGetJobsSummaryQueryKey() })
          toast({
            title: "Takeoff saved",
            description:
              job.status === "takeoff"
                ? "Job moved to Proposal Ready."
                : `Total job price: ${money(totals.total)}`,
          })
        },
        onError: () => toast({ title: "Failed to save takeoff", variant: "destructive" }),
      },
    )
  }

  const handlePriceSheetUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.type !== "application/pdf") {
      toast({ title: "Invalid file type", description: "Only PDF files are accepted", variant: "destructive" })
      return
    }
    setIsUploadingPriceSheet(true)
    try {
      const formData = new FormData()
      formData.append("file", file)
      const response = await fetch(`${import.meta.env.BASE_URL}api/jobs/${jobId}/files`, {
        method: "POST",
        body: formData,
      })
      if (!response.ok) throw new Error("Upload failed")
      const uploaded = (await response.json()) as JobFile
      setPriceSheetFileId(uploaded.id)
      queryClient.invalidateQueries({ queryKey: getListJobFilesQueryKey(jobId) })
      toast({ title: "Price sheet uploaded", description: "Selected as the reference price sheet." })
    } catch {
      toast({ title: "Upload failed", variant: "destructive" })
    } finally {
      setIsUploadingPriceSheet(false)
      if (priceSheetInputRef.current) priceSheetInputRef.current.value = ""
    }
  }

  if (isLoading) {
    return (
      <Card className="border-border/60 shadow-sm">
        <CardContent className="p-8 text-center text-muted-foreground">Loading takeoff...</CardContent>
      </Card>
    )
  }

  const inputCls = "h-8 text-xs"

  return (
    <Card className="border-border/60 shadow-sm">
      <CardHeader className="bg-muted/30 border-b border-border/40 pb-4 flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-lg">Takeoff</CardTitle>
          <CardDescription className="mt-1">
            Room measurements, sheet pricing, and cost breakdown. Wall lengths are read manually from the plans.
          </CardDescription>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`text-xs ${unsaved ? "text-amber-600 font-medium" : "text-muted-foreground"}`}
            data-testid="text-takeoff-save-state"
          >
            {unsaved ? "Changes not saved" : "Saved"}
          </span>
          <Button
            onClick={handleSave}
            disabled={saveTakeoff.isPending}
            size="sm"
            className="font-mono uppercase tracking-wider text-xs"
            data-testid="button-save-takeoff"
          >
            <Save className="mr-2 h-4 w-4" />
            {saveTakeoff.isPending ? "Saving..." : "Save Takeoff"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {/* Room measurements */}
        <div className="p-4 pb-2">
          <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Room Measurements</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/40 bg-muted/20 text-left text-xs font-mono uppercase tracking-wider text-muted-foreground">
                <th className="p-3">Room</th>
                <th className="p-3">Rm #</th>
                <th className="p-3">Wall Lengths (ft)</th>
                <th className="p-3 text-right">Total LF</th>
                <th className="p-3">Height</th>
                <th className="p-3">Manufacturer</th>
                <th className="p-3">Color</th>
                <th className="p-3">Product</th>
                <th className="p-3">Fire Rating</th>
                <th className="p-3">Molding</th>
                <th className="p-3 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {roomRows.length === 0 && (
                <tr>
                  <td colSpan={11} className="p-6 text-center text-muted-foreground text-sm">
                    No rooms yet. Rooms are pre-populated from confirmed Room Specs, or add rows manually.
                  </td>
                </tr>
              )}
              {roomRows.map((row, i) => (
                <tr key={i} className="hover:bg-muted/20 transition-colors">
                  <td className="p-2">
                    <Input className={`${inputCls} min-w-[130px]`} value={row.roomName ?? ""} placeholder="Room" data-testid={`input-room-name-${i}`}
                      onChange={(e) => updateRoomRow(i, { roomName: e.target.value })} />
                  </td>
                  <td className="p-2">
                    <Input className={`${inputCls} w-16`} value={row.roomNumber ?? ""} placeholder="—"
                      onChange={(e) => updateRoomRow(i, { roomNumber: e.target.value })} />
                  </td>
                  <td className="p-2">
                    <Input className={`${inputCls} min-w-[150px] font-mono`} value={row.wallLengths} placeholder="8 + 8 + 8 + 8" data-testid={`input-wall-lengths-${i}`}
                      onChange={(e) => updateRoomRow(i, { wallLengths: e.target.value })} />
                  </td>
                  <td className="p-2 text-right font-mono text-xs whitespace-nowrap" data-testid={`text-lf-${i}`}>
                    {linearFootage(row.wallLengths) > 0 ? `${linearFootage(row.wallLengths)} LF` : "—"}
                  </td>
                  <td className="p-2">
                    <Input className={`${inputCls} w-20`} value={row.materialHeight ?? ""} placeholder="—"
                      onChange={(e) => updateRoomRow(i, { materialHeight: e.target.value })} />
                  </td>
                  <td className="p-2">
                    <Input className={`${inputCls} min-w-[100px]`} value={row.manufacturer ?? ""} placeholder="—"
                      onChange={(e) => updateRoomRow(i, { manufacturer: e.target.value })} />
                  </td>
                  <td className="p-2">
                    <Input className={`${inputCls} w-24`} value={row.color ?? ""} placeholder="—"
                      onChange={(e) => updateRoomRow(i, { color: e.target.value })} />
                  </td>
                  <td className="p-2">
                    <Input className={`${inputCls} w-24 font-mono`} value={row.productCode ?? ""} placeholder="—"
                      onChange={(e) => updateRoomRow(i, { productCode: e.target.value })} />
                  </td>
                  <td className="p-2">
                    <Input className={`${inputCls} w-24`} value={row.fireRating ?? ""} placeholder="—"
                      onChange={(e) => updateRoomRow(i, { fireRating: e.target.value })} />
                  </td>
                  <td className="p-2">
                    <Select
                      value={row.moldingType ?? "none"}
                      onValueChange={(v) => updateRoomRow(i, { moldingType: v === "none" ? null : (v as MoldingType) })}
                    >
                      <SelectTrigger className="h-8 w-[110px] text-xs" data-testid={`select-molding-${i}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">—</SelectItem>
                        <SelectItem value="aluminum">Aluminum</SelectItem>
                        <SelectItem value="pvc">PVC</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="p-2 text-right">
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => setRoomRows((rows) => rows.filter((_, idx) => idx !== i))}>
                      <Trash2 className="h-3.5 w-3.5" />
                      <span className="sr-only">Remove room</span>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border/40 p-3">
          <Button variant="ghost" size="sm" onClick={addRoomRow} className="text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground" data-testid="button-add-room">
            <Plus className="mr-2 h-4 w-4" /> Add Room
          </Button>
        </div>

        {/* Materials & pricing */}
        <div className="border-t border-border/40 p-4 pb-2 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Materials & Pricing</h3>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>Panel thickness</span>
              <Input
                className="h-8 w-24 text-xs font-mono"
                value={thickness}
                placeholder={'e.g. .090"'}
                onChange={(e) => setThickness(e.target.value)}
                data-testid="input-thickness"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input type="file" ref={priceSheetInputRef} onChange={handlePriceSheetUpload} accept="application/pdf" className="hidden" />
            <Select
              value={priceSheetFileId !== null ? String(priceSheetFileId) : "none"}
              onValueChange={(v) => setPriceSheetFileId(v === "none" ? null : parseInt(v, 10))}
            >
              <SelectTrigger className="h-8 w-[220px] text-xs" data-testid="select-price-sheet">
                <SelectValue placeholder="Price sheet reference" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No price sheet selected</SelectItem>
                {files.map((f) => (
                  <SelectItem key={f.id} value={String(f.id)}>{f.fileName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {priceSheetFileId !== null && (
              <Button variant="ghost" size="icon" asChild className="h-8 w-8 text-muted-foreground hover:text-foreground">
                <a href={`${import.meta.env.BASE_URL}api/files/${priceSheetFileId}/view`} target="_blank" rel="noreferrer" title="View price sheet">
                  <FileText className="h-4 w-4" />
                </a>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => priceSheetInputRef.current?.click()} disabled={isUploadingPriceSheet} className="text-xs font-mono uppercase tracking-wider" data-testid="button-upload-price-sheet">
              <Upload className="mr-2 h-3.5 w-3.5" /> {isUploadingPriceSheet ? "Uploading..." : "Upload Price Sheet"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExtractPrices}
              disabled={priceSheetFileId === null || extractionStatus === "running" || extractPrices.isPending}
              className="text-xs font-mono uppercase tracking-wider"
              data-testid="button-extract-prices"
            >
              {extractionStatus === "running" ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-3.5 w-3.5" />
              )}
              {extractionStatus === "running" ? "Extracting..." : "Extract Prices"}
            </Button>
          </div>
        </div>

        {/* Price extraction status + review table */}
        {priceSheetFileId !== null && extractionStatus !== "not_started" && (
          <div className="px-4 pb-2">
            <div className="rounded-md border border-border/40 bg-muted/10">
              <button
                type="button"
                className="w-full flex items-center justify-between p-3 text-left"
                onClick={() => setShowPriceItems((v) => !v)}
                data-testid="button-toggle-price-items"
              >
                <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5" />
                  Extracted Price Items
                  {extractionStatus === "running" && (
                    <span className="normal-case font-sans tracking-normal flex items-center gap-1.5 text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      reading page {(priceExtraction?.pagesProcessed ?? 0) + 1}... ({priceExtraction?.itemCount ?? 0} items so far)
                    </span>
                  )}
                  {extractionStatus === "completed" && (
                    <Badge variant="secondary" className="text-[10px] font-mono" data-testid="badge-price-item-count">
                      {priceExtraction?.itemCount ?? 0} items
                    </Badge>
                  )}
                  {extractionStatus === "failed" && (
                    <span className="normal-case font-sans tracking-normal text-destructive" data-testid="text-price-extraction-error">
                      Failed{priceExtraction?.error ? ` — ${priceExtraction.error}` : ""}
                    </span>
                  )}
                </div>
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${showPriceItems ? "rotate-180" : ""}`} />
              </button>
              {showPriceItems && extractionStatus === "completed" && (
                <div className="border-t border-border/40 overflow-x-auto max-h-72 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/40 bg-muted/20 text-left font-mono uppercase tracking-wider text-muted-foreground">
                        <th className="p-2">Product</th>
                        <th className="p-2">Code</th>
                        <th className="p-2">Size</th>
                        <th className="p-2 text-right">$ / Sheet</th>
                        <th className="p-2 text-right">$ / Sqft</th>
                        <th className="p-2">Confidence</th>
                        <th className="p-2 text-right">Page</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                      {priceItems.length === 0 && (
                        <tr>
                          <td colSpan={7} className="p-4 text-center text-muted-foreground">
                            No priced line items were found in this PDF.
                          </td>
                        </tr>
                      )}
                      {priceItems.map((item) => (
                        <tr key={item.id} className="hover:bg-muted/20" data-testid={`row-price-item-${item.id}`}>
                          <td className="p-2">{item.productDescription ?? <span className="text-muted-foreground">—</span>}</td>
                          <td className="p-2 font-mono">{item.productCode ?? "—"}</td>
                          <td className="p-2 font-mono">{item.sheetSize ?? "—"}</td>
                          <td className="p-2 text-right font-mono">{item.pricePerSheet != null ? money(item.pricePerSheet) : "—"}</td>
                          <td className="p-2 text-right font-mono">{item.pricePerSqft != null ? money(item.pricePerSqft) : "—"}</td>
                          <td className="p-2">
                            <Badge variant={item.extractionConfidence === "high" ? "secondary" : "outline"} className="text-[10px]">
                              {item.extractionConfidence}
                            </Badge>
                          </td>
                          <td className="p-2 text-right font-mono">
                            <a
                              href={`${import.meta.env.BASE_URL}api/files/${item.jobFileId}/view#page=${item.sourcePage}`}
                              target="_blank"
                              rel="noreferrer"
                              className="underline decoration-dotted hover:text-foreground"
                            >
                              p.{item.sourcePage}
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/40 bg-muted/20 text-left text-xs font-mono uppercase tracking-wider text-muted-foreground">
                <th className="p-3">Sheets Needed</th>
                <th className="p-3">Sheet Size</th>
                <th className="p-3">Price / Sheet</th>
                <th className="p-3 text-right">Row Total</th>
                <th className="p-3 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {sheetRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-muted-foreground text-sm">
                    No sheet rows yet. Add a row per sheet size/price. Enter prices manually from the manufacturer price sheet.
                  </td>
                </tr>
              )}
              {sheetRows.map((row, i) => (
                <tr key={i} className="hover:bg-muted/20 transition-colors">
                  <td className="p-2">
                    <Input type="number" min={0} className={`${inputCls} w-28 font-mono`} value={row.sheetsNeeded} data-testid={`input-sheets-needed-${i}`}
                      onChange={(e) => updateSheetRow(i, { sheetsNeeded: num(e.target.value) })} />
                  </td>
                  <td className="p-2">
                    <Select value={row.sheetSize} onValueChange={(v) => updateSheetRow(i, { sheetSize: v as SheetSize })}>
                      <SelectTrigger className="h-8 w-[100px] text-xs font-mono" data-testid={`select-sheet-size-${i}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SHEET_SIZES.map((s) => (
                          <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="p-2">
                    <div className="flex items-center gap-1">
                      <Input type="number" min={0} step="0.01" className={`${inputCls} w-28 font-mono`} value={row.pricePerSheet} data-testid={`input-price-per-sheet-${i}`}
                        onChange={(e) => updateSheetRow(i, { pricePerSheet: num(e.target.value) })} />
                      {priceItems.length > 0 && (
                        <PricePicker
                          items={priceItems}
                          rowSize={row.sheetSize}
                          rowIndex={i}
                          onPick={(price) => updateSheetRow(i, { pricePerSheet: price })}
                        />
                      )}
                    </div>
                  </td>
                  <td className="p-2 text-right font-mono text-xs" data-testid={`text-sheet-row-total-${i}`}>
                    {money(row.sheetsNeeded * row.pricePerSheet)}
                  </td>
                  <td className="p-2 text-right">
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => setSheetRows((rows) => rows.filter((_, idx) => idx !== i))}>
                      <Trash2 className="h-3.5 w-3.5" />
                      <span className="sr-only">Remove sheet row</span>
                    </Button>
                  </td>
                </tr>
              ))}
              {sheetRows.length > 0 && (
                <tr className="bg-muted/10 font-medium">
                  <td className="p-3 text-xs font-mono" data-testid="text-total-sheets">{totals.totalSheets} sheets</td>
                  <td className="p-3" colSpan={2}></td>
                  <td className="p-3 text-right font-mono text-xs" data-testid="text-materials-total">{money(totals.materials)}</td>
                  <td></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border/40 p-3">
          <Button variant="ghost" size="sm" onClick={addSheetRow} className="text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground" data-testid="button-add-sheet-row">
            <Plus className="mr-2 h-4 w-4" /> Add Sheet Row
          </Button>
        </div>

        {/* Cost breakdown */}
        <div className="border-t border-border/40 p-4 pb-2">
          <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Calculator className="h-3.5 w-3.5" /> Cost Breakdown
          </h3>
        </div>
        <div className="px-4 pb-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8">
            <dl className="divide-y divide-border/30 text-sm">
              <div className="py-3 flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">
                  Labor
                  <div className="flex items-center gap-1.5 mt-1.5 text-xs">
                    <span>$</span>
                    <Input type="number" min={0} className="h-7 w-20 text-xs font-mono" value={laborRate} onChange={(e) => setLaborRate(e.target.value)} data-testid="input-labor-rate" />
                    <span>/hr ×</span>
                    <Input type="number" min={0} className="h-7 w-16 text-xs font-mono" value={laborDays} onChange={(e) => setLaborDays(e.target.value)} data-testid="input-labor-days" />
                    <span>days ×</span>
                    <Input type="number" min={0} className="h-7 w-16 text-xs font-mono" value={laborHoursPerDay} onChange={(e) => setLaborHoursPerDay(e.target.value)} data-testid="input-labor-hours" />
                    <span>hrs/day</span>
                  </div>
                </dt>
                <dd className="font-mono font-medium" data-testid="text-labor-total">{money(totals.labor)}</dd>
              </div>
              <div className="py-3 flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">
                  Overtime
                  <p className="text-xs mt-0.5">
                    {totals.overtimeHours > 0
                      ? `${totals.overtimeHours} hr${totals.overtimeHours === 1 ? "" : "s"} over 10/day × $${OVERTIME_RATE}/hr`
                      : `Hours over 10/day at $${OVERTIME_RATE}/hr — none`}
                  </p>
                </dt>
                <dd className="font-mono font-medium" data-testid="text-overtime-total">{money(totals.overtime)}</dd>
              </div>
              <div className="py-3 flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">
                  Travel
                  <div className="flex items-center gap-1.5 mt-1.5 text-xs">
                    <Input type="number" min={0} className="h-7 w-20 text-xs font-mono" value={travelMiles} onChange={(e) => setTravelMiles(e.target.value)} data-testid="input-travel-miles" />
                    <span>miles from Rocklin, CA × 8 × 1.5</span>
                  </div>
                </dt>
                <dd className="font-mono font-medium" data-testid="text-travel-total">{money(totals.travel)}</dd>
              </div>
            </dl>
            <dl className="divide-y divide-border/30 text-sm">
              <div className="py-3 flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">
                  Hotel
                  <div className="flex items-center gap-1.5 mt-1.5 text-xs">
                    <span>${HOTEL_NIGHTLY} ×</span>
                    <Input type="number" min={0} className="h-7 w-16 text-xs font-mono" value={hotelNights} onChange={(e) => setHotelNights(e.target.value)} data-testid="input-hotel-nights" />
                    <span>nights</span>
                  </div>
                </dt>
                <dd className="font-mono font-medium" data-testid="text-hotel-total">{money(totals.hotel)}</dd>
              </div>
              <div className="py-3 flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">
                  Freight
                  <div className="flex items-center gap-1.5 mt-1.5 text-xs">
                    <span>$</span>
                    <Input type="number" min={0} className="h-7 w-24 text-xs font-mono" value={freight} onChange={(e) => setFreight(e.target.value)} data-testid="input-freight" />
                    <span className="text-muted-foreground italic">pending company freight policy</span>
                  </div>
                </dt>
                <dd className="font-mono font-medium" data-testid="text-freight-total">{money(totals.freight)}</dd>
              </div>
              <div className="py-3 flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">
                  Profit
                  <div className="flex items-center gap-1.5 mt-1.5 text-xs">
                    <span>$</span>
                    <Input
                      type="number"
                      min={0}
                      className="h-7 w-24 text-xs font-mono"
                      value={profitOverride !== null ? profitOverride : totals.autoProfit}
                      onChange={(e) => setProfitOverride(e.target.value)}
                      data-testid="input-profit"
                    />
                    {profitOverride !== null ? (
                      <button type="button" className="underline decoration-dotted hover:text-foreground" onClick={() => setProfitOverride(null)} data-testid="button-reset-profit">
                        reset to auto ({money(totals.autoProfit)})
                      </button>
                    ) : (
                      <span>auto: {flatProfitApplies(totals.totalSheets) ? `$${PROFIT_FLAT} flat (< ${PROFIT_SHEET_THRESHOLD} sheets)` : `$${PROFIT_PER_DAY}/day`}</span>
                    )}
                  </div>
                </dt>
                <dd className="font-mono font-medium" data-testid="text-profit-total">{money(totals.profit)}</dd>
              </div>
            </dl>
          </div>

          {/* Total */}
          <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Total Job Price</p>
              <p className="text-xs text-muted-foreground mt-0.5">Materials {money(totals.materials)} + costs {money(totals.total - totals.materials)}</p>
            </div>
            <p className="text-3xl font-bold font-mono tracking-tight" data-testid="text-total-job-price">{money(totals.total)}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
