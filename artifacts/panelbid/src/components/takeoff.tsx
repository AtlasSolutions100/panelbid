import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
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
import { Plus, Trash2, Save, Calculator, Upload, FileText, Sparkles, Loader2, ChevronDown, ClipboardList } from "lucide-react"
import { MaterialListDialog } from "@/components/material-list"

// Every takeoff rule (wall lengths, sheets, cost lines, the total) comes from
// the shared rules file. No rule is written in this page.
import {
  SHEET_SIZES,
  OVERTIME_RATE,
  HOTEL_NIGHTLY,
  PROFIT_FLAT,
  PROFIT_PER_DAY,
  PROFIT_FLAT_MAX_SHEETS,
  CURRENT_RULES,
  MOLDING_KIND_NAMES,
  addSuggestedSize,
  jobHasTypedRow,
  wallNeeds,
  MOLDING_PER_SHEET_ASSUMED,
  applySuggestions,
  buildMaterialList,
  checkTakeoffNumbers,
  computeCosts,
  convertToNewRules,
  flatProfitApplies,
  followsWalls,
  glueBuckets,
  jobUnderEarlierRules,
  moldingsByKind,
  readSheetCount,
  refreshSuggestedRows,
  roomSheetsText,
  setKindCount,
  setMoldingCount,
  suggestedEarlier,
  tidyMoldingCounts,
  wallRoundingWords,
  resolvePricePerSheet,
  sameJson,
  screenMayTakeSavedCopy,
  sheetAreaSqft,
  suggestSheets,
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

/** A number for an input box: 0 means "nothing typed", so the box is empty. */
const box = (n: number) => (n === 0 ? "" : String(n))

/** Shown wherever a price has not been typed. Never "$0.00". */
const NOT_PRICED = "not priced"

/**
 * Price per sheet. An empty box means "not priced" (stored as 0). It keeps its
 * own text so a price can be typed digit by digit without the box clearing.
 */
function PriceInput({
  value,
  onChange,
  testId,
}: {
  value: number
  onChange: (price: number) => void
  testId: string
}) {
  const [text, setText] = useState(box(value))
  useEffect(() => {
    setText((t) => (num(t) === value ? t : box(value)))
  }, [value])
  return (
    <Input
      type="number"
      min={0}
      step="0.01"
      className="h-8 text-xs w-28 font-mono"
      value={text}
      placeholder={NOT_PRICED}
      data-testid={testId}
      onChange={(e) => {
        setText(e.target.value)
        onChange(num(e.target.value))
      }}
    />
  )
}

/**
 * Sheets needed. Only a whole number of 0 or more is a count. Anything else
 * ("-5", "8.5", "1e3", words) is said in words under the box: the row keeps
 * the count it had, and Save stays off until the box is put right. The box
 * keeps its own text so the words can name exactly what was typed.
 */
function SheetCountInput({
  value,
  onChange,
  onProblem,
  testId,
  problemTestId,
  className,
  children,
}: {
  value: number
  onChange: (count: number) => void
  /** Told the reason while this box cannot be read, and null when it can. */
  onProblem: (id: string, reason: string | null) => void
  testId: string
  /** For the words under the box. Not "input-...": only the box itself is one. */
  problemTestId: string
  className: string
  /** Shown beside the box (whose count it is). */
  children?: React.ReactNode
}) {
  const id = useId()
  const [text, setText] = useState(String(value))
  // The count changed from outside (a suggestion followed the walls, or the
  // saved copy was put on screen): show it, unless the box already reads as it.
  useEffect(() => {
    setText((t) => {
      const r = readSheetCount(t)
      return r.ok && r.count === value ? t : String(value)
    })
  }, [value])
  const read = readSheetCount(text)
  const reason = read.ok ? null : read.reason
  useEffect(() => {
    onProblem(id, reason)
    return () => onProblem(id, null)
  }, [id, reason, onProblem])
  return (
    <div>
      <div className="flex items-center gap-2">
        <Input
          type="text"
          inputMode="numeric"
          className={`${className} ${reason ? "border-destructive" : ""}`}
          value={text}
          data-testid={testId}
          onChange={(e) => {
            setText(e.target.value)
            const r = readSheetCount(e.target.value)
            if (r.ok) onChange(r.count)
          }}
        />
        {children}
      </div>
      {reason && (
        <div className="mt-1 max-w-[240px] text-[10px] text-destructive" data-testid={problemTestId}>
          {reason}
        </div>
      )}
    </div>
  )
}

/**
 * A whole number of 0 or more that may be left empty (empty = not typed).
 * Used for corner pieces and molding counts. Anything else is said in words
 * under the box and Save stays off, as for sheet counts.
 */
function CountBox({
  value,
  onChange,
  onProblem,
  testId,
  placeholder,
  className,
  title,
}: {
  value: number | null
  onChange: (count: number | null) => void
  onProblem: (id: string, reason: string | null) => void
  testId: string
  placeholder?: string
  className: string
  title?: string
}) {
  const id = useId()
  const shownValue = value === null ? "" : String(value)
  const [text, setText] = useState(shownValue)
  useEffect(() => {
    setText((t) => (t.trim() === shownValue ? t : shownValue))
  }, [shownValue])
  const typed = text.trim()
  const reason =
    typed === "" || /^\d+$/.test(typed) ? null : `Can't use "${typed}": type a whole number of 0 or more, or leave it empty.`
  useEffect(() => {
    onProblem(id, reason)
    return () => onProblem(id, null)
  }, [id, reason, onProblem])
  return (
    <div>
      <Input
        type="text"
        inputMode="numeric"
        className={`${className} ${reason ? "border-destructive" : ""}`}
        value={text}
        placeholder={placeholder}
        title={title}
        data-testid={testId}
        onChange={(e) => {
          setText(e.target.value)
          const t = e.target.value.trim()
          if (t === "") onChange(null)
          else if (/^\d+$/.test(t)) onChange(Number(t))
        }}
      />
      {reason && <div className="mt-1 max-w-[160px] text-[10px] text-destructive">{reason}</div>}
    </div>
  )
}

/** A refusal from the server in its own plain words (without "HTTP 400 ..."). */
function serverWords(err: unknown): string | undefined {
  const data = (err as { data?: { message?: unknown } } | null)?.data
  if (data && typeof data.message === "string" && data.message.trim() !== "") return data.message
  return undefined
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
  const [laborRate, setLaborRate] = useState("")
  const [laborDays, setLaborDays] = useState("")
  const [laborHoursPerDay, setLaborHoursPerDay] = useState("")
  const [travelMiles, setTravelMiles] = useState("")
  const [hotelNights, setHotelNights] = useState("")
  const [freight, setFreight] = useState("")
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
    // A saved takeoff keeps its rows (suggested ones follow the rooms). A new
    // one starts with the suggestion for any wall lengths it already has.
    setSheetRows(
      t.saved
        ? refreshSuggestedRows(t.roomRows, t.sheetRows)
        : applySuggestions([], t.roomRows, t.sheetRows),
    )
    setPriceSheetFileId(t.priceSheetFileId)
    setLaborRate(box(t.laborRate))
    setLaborDays(box(t.laborDays))
    setLaborHoursPerDay(box(t.laborHoursPerDay))
    setTravelMiles(box(t.travelMiles))
    setHotelNights(box(t.hotelNights))
    setFreight(box(t.freight))
    setThickness(t.thickness ?? "")
    setProfitOverride(t.profitOverride === null ? null : String(t.profitOverride))
    setSavedData(t.saved ? dataFromTakeoff(t) : null)
  }

  useEffect(() => {
    if (!takeoff || loadedFor.current === jobId) return
    loadedFor.current = jobId
    showTakeoff(takeoff)
  }, [takeoff, jobId])

  // The profit he typed, or null for automatic. An empty box is automatic.
  const typedProfit =
    profitOverride !== null && profitOverride.trim() !== "" ? num(profitOverride) : null

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
      profitOverride: typedProfit,
      notes: null,
      thickness: thickness.trim() !== "" ? thickness.trim() : null,
    }),
    [roomRows, sheetRows, priceSheetFileId, laborRate, laborDays, laborHoursPerDay, travelMiles, hotelNights, freight, typedProfit, thickness],
  )

  // Everything typed on the sheet, exactly as it is on screen (text boxes as
  // their text). Kept in a ref so that the answer to a save, which arrives
  // later, can tell whether anything was typed since Save was pressed.
  const onScreen = {
    roomRows,
    sheetRows,
    priceSheetFileId,
    laborRate,
    laborDays,
    laborHoursPerDay,
    travelMiles,
    hotelNights,
    freight,
    thickness,
    profitOverride,
  }
  const onScreenRef = useRef(onScreen)
  onScreenRef.current = onScreen

  // The proposal is only ever made from a saved takeoff, so the page has to
  // know when the screen and the saved copy differ.
  const loaded = !!takeoff && loadedFor.current === jobId
  const unsaved = loaded && (savedData === null || !sameJson(savedData, currentData))

  // Numbers the takeoff may not hold (the server refuses them too): said in
  // words at the top of the sheet, and Save stays off until they are put right.
  const [countProblems, setCountProblems] = useState<Record<string, string>>({})
  const reportCountProblem = useCallback((id: string, reason: string | null) => {
    setCountProblems((all) => {
      if (reason === null) {
        if (!(id in all)) return all
        const { [id]: _gone, ...rest } = all
        return rest
      }
      return all[id] === reason ? all : { ...all, [id]: reason }
    })
  }, [])
  const cannotSave = useMemo(
    () => [
      ...checkTakeoffNumbers(currentData),
      ...(Object.keys(countProblems).length > 0
        ? ["A count cannot be read: see the words under its box."]
        : []),
    ],
    [currentData, countProblems],
  )
  const blocked = cannotSave.length > 0

  useEffect(() => {
    // A sheet with a number that cannot be saved is not "what is saved" either.
    onUnsavedChange?.(unsaved || blocked)
  }, [unsaved, blocked, onUnsavedChange])

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
        profitOverride: typedProfit,
      }),
    [sheetRows, laborRate, laborDays, laborHoursPerDay, travelMiles, hotelNights, freight, typedProfit],
  )

  // The suggested sheet count for each room and for the job, with its working.
  const suggestion = useMemo(() => suggestSheets(roomRows), [roomRows])

  // Any change to the rooms also brings the SUGGESTED sheet rows up to date.
  // Rows the person typed are never touched (see applySuggestions).
  const changeRooms = (next: TakeoffRoomRow[]) => {
    setRoomRows(next)
    setSheetRows((rows) => tidyMoldingCounts(applySuggestions(roomRows, next, rows)))
  }
  const updateRoomRow = (i: number, patch: Partial<TakeoffRoomRow>) =>
    changeRooms(roomRows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const updateSheetRow = (i: number, patch: Partial<TakeoffSheetRow>) =>
    setSheetRows((rows) =>
      tidyMoldingCounts(
        rows.map((r, idx) => {
          if (idx !== i) return r
          // A row that moves to another sheet size takes that size's molding count.
          const moved = patch.sheetSize !== undefined && patch.sheetSize !== r.sheetSize
          const next = { ...r, ...patch, ...(moved ? { moldingCount: null } : {}) }
          // A row he types is his: it carries no rules mark.
          if (next.sheetsSource === "typed" && "rules" in next) {
            const { rules: _mark, ...mine } = next
            return mine
          }
          return next
        }),
      ),
    )

  // A job counted under the earlier rules keeps its counts until he converts
  // every size at once; this is what that would change.
  const earlierRules = jobUnderEarlierRules(sheetRows)
  const conversion = useMemo(() => convertToNewRules(roomRows, sheetRows), [roomRows, sheetRows])
  // A job where he typed his own counts: nothing is added or moved by itself;
  // what the walls need is shown beside his rows, with "add N x size".
  const typedJob = !earlierRules && jobHasTypedRow(sheetRows)
  const needs = useMemo(() => wallNeeds(roomRows, sheetRows), [roomRows, sheetRows])
  const typedRowsWords = sheetRows
    .filter((r) => r.sheetsSource !== "suggested" && r.sheetsNeeded > 0)
    .map((r) => `${r.sheetsNeeded} x ${r.sheetSize}`)
    .join(", ")

  // Moldings by kind and length (his rule) and glue buckets (his rule), with their working.
  const molding = useMemo(() => moldingsByKind(roomRows, sheetRows), [roomRows, sheetRows])
  const legacyLengths = new Set(molding.legacy.map((l) => l.lengthFt))

  // The Material list: the same quantities as a sheet to print or send.
  const [materialListOpen, setMaterialListOpen] = useState(false)
  const materialList = useMemo(
    () =>
      buildMaterialList({
        jobName: job.jobName,
        address: job.address,
        city: job.city,
        // the shop's own calendar day (Rocklin, CA)
        date: new Date().toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
          timeZone: "America/Los_Angeles",
        }),
        thickness,
        roomRows,
        sheetRows,
      }),
    [job.jobName, job.address, job.city, thickness, roomRows, sheetRows],
  )

  const addRoomRow = () =>
    changeRooms([
      ...roomRows,
      { roomName: "", roomNumber: "", wallLengths: "", materialHeight: "", ceilingHeight: "", manufacturer: "", color: "", productCode: "", fireRating: "", moldingType: null },
    ])
  // A row he adds himself is his from the start.
  const addSheetRow = () =>
    setSheetRows((rows) =>
      tidyMoldingCounts([...rows, { sheetsNeeded: 0, sheetSize: "4x8", pricePerSheet: 0, sheetsSource: "typed" }]),
    )

  const handleSave = () => {
    if (blocked) return
    // Exactly what is on screen at the moment Save is pressed.
    const shownWhenSent = onScreenRef.current
    saveTakeoff.mutate(
      {
        jobId,
        // The server works the total out again from the same rules.
        data: { ...currentData, totalPrice: totals.total },
      },
      {
        onSuccess: (saved) => {
          queryClient.setQueryData(getGetTakeoffQueryKey(jobId), saved)
          // The screen takes the server's copy only if it still shows exactly
          // what was sent. If something was typed while the save was on its
          // way, that typing stays on screen: only the saved copy is
          // remembered, so the page reads "Changes not saved", not "Saved".
          const typedSince = !screenMayTakeSavedCopy(shownWhenSent, onScreenRef.current)
          if (typedSince) setSavedData(dataFromTakeoff(saved))
          else showTakeoff(saved)
          queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) })
          queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() })
          queryClient.invalidateQueries({ queryKey: getGetJobsSummaryQueryKey() })
          if (typedSince) {
            toast({
              title: "What you typed since is not saved yet",
              description:
                "The takeoff was saved as it was when you pressed Save. What you typed after that is still on screen and is NOT saved: press Save Takeoff again.",
              variant: "destructive",
            })
            return
          }
          toast({
            title: "Takeoff saved",
            description:
              job.status === "takeoff"
                ? "Job moved to Proposal Ready."
                : totals.fullyPriced
                  ? `Total job price: ${money(totals.total)}`
                  : "Quantities saved. No job price yet: prices are optional.",
          })
        },
        onError: (err) =>
          toast({ title: "Failed to save takeoff", description: serverWords(err), variant: "destructive" }),
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
            className={`text-xs ${blocked ? "text-destructive font-medium" : unsaved ? "text-amber-600 font-medium" : "text-muted-foreground"}`}
            data-testid="text-takeoff-save-state"
          >
            {blocked ? "Cannot be saved yet" : unsaved ? "Changes not saved" : "Saved"}
          </span>
          <Button
            variant="outline"
            onClick={() => setMaterialListOpen(true)}
            size="sm"
            className="font-mono uppercase tracking-wider text-xs"
            data-testid="button-open-material-list"
          >
            <ClipboardList className="mr-2 h-4 w-4" />
            Material List
          </Button>
          <Button
            onClick={handleSave}
            // Nothing to save: the button is off, so a proposal is not marked
            // "older than the takeoff" by a save that changed nothing. (A job
            // still in Takeoff status can always be saved: that moves it on.)
            disabled={saveTakeoff.isPending || blocked || (!unsaved && job.status !== "takeoff")}
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
        {blocked && (
          <div
            className="border-b border-destructive/40 bg-destructive/5 px-4 py-2 text-xs text-destructive"
            data-testid="text-takeoff-cannot-save"
          >
            <p className="font-medium">This takeoff cannot be saved yet:</p>
            <ul className="list-disc pl-4 space-y-0.5">
              {cannotSave.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        {/* Room measurements */}
        <div className="p-4 pb-2">
          <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Room Measurements</h3>
          <p className="text-xs text-muted-foreground mt-1" data-testid="text-measure-rule">
            Type each wall straight through doors and windows: that is the waste, so no extra waste is added and no opening is taken out.
            Lengths can be feet (8.5) or feet and inches (8'-6"). Suggested sheets = counted wall ÷ what one sheet covers (4 ft upright; 8 ft for a 4x8 on its side when the panel is 4 ft tall or less; 4 ft for a 4x4 panel), added per size and rounded up once at the end.
          </p>
          <p className="text-xs mt-1 text-amber-700" data-testid="text-rounding-rule">
            {wallRoundingWords()}
          </p>
          {earlierRules && (
            <p className="text-xs mt-1 font-medium text-amber-800" data-testid="text-rooms-not-counted-yet">
              This job was counted under the earlier rules: changes to the rooms below are not counted in the sheet rows until you press "Use the new counts" under Materials.
            </p>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/40 bg-muted/20 text-left text-xs font-mono uppercase tracking-wider text-muted-foreground">
                <th className="p-3">Room</th>
                <th className="p-3">Rm #</th>
                <th className="p-3">Wall Lengths (ft)</th>
                <th className="p-3">Panel Height</th>
                <th className="p-3">Suggested Sheets</th>
                <th className="p-3">Corners</th>
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
                  <td colSpan={12} className="p-6 text-center text-muted-foreground text-sm">
                    No rooms yet. Rooms are pre-populated from confirmed Room Specs, or add rows manually.
                  </td>
                </tr>
              )}
              {roomRows.map((row, i) => {
                const rs = suggestion.rooms[i]
                return (
                <tr key={i} className="hover:bg-muted/20 transition-colors align-top">
                  <td className="p-2">
                    <Input className={`${inputCls} min-w-[110px]`} value={row.roomName ?? ""} placeholder="Room" data-testid={`input-room-name-${i}`}
                      onChange={(e) => updateRoomRow(i, { roomName: e.target.value })} />
                  </td>
                  <td className="p-2">
                    <Input className={`${inputCls} w-16`} value={row.roomNumber ?? ""} placeholder="—"
                      onChange={(e) => updateRoomRow(i, { roomNumber: e.target.value })} />
                  </td>
                  <td className="p-2">
                    <Input className={`${inputCls} min-w-[150px] font-mono`} value={row.wallLengths} placeholder="8 + 8 + 8 + 8" data-testid={`input-wall-lengths-${i}`}
                      onChange={(e) => updateRoomRow(i, { wallLengths: e.target.value })} />
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground" data-testid={`text-lf-${i}`}>
                      {rs && rs.wall.units > 0 ? `${Number(rs.wall.feet.toFixed(2))} LF` : "—"}
                    </div>
                    {rs && rs.wall.ok && rs.wallWorking && rs.walls.some((w) => w.countedFt !== w.typedFt) && (
                      <div className="text-[10px] text-muted-foreground max-w-[190px]" data-testid={`text-wall-working-${i}`}>
                        counted: {rs.wallWorking}
                      </div>
                    )}
                    {rs && !rs.wall.ok && (
                      <div className="text-[10px] text-destructive max-w-[150px]" data-testid={`text-lf-unread-${i}`}>
                        can't read "{rs.wall.unread[0]}"
                      </div>
                    )}
                  </td>
                  <td className="p-2">
                    <Input className={`${inputCls} w-24`} value={row.materialHeight ?? ""} placeholder="panel height" data-testid={`input-panel-height-${i}`}
                      title="Panel (FRP) height"
                      onChange={(e) => updateRoomRow(i, { materialHeight: e.target.value })} />
                    <div className="mt-1 text-[10px] text-muted-foreground">ceiling</div>
                    <Input className={`${inputCls} w-24`} value={row.ceilingHeight ?? ""} placeholder="—" data-testid={`input-ceiling-height-${i}`}
                      title="Ceiling height"
                      onChange={(e) => updateRoomRow(i, { ceilingHeight: e.target.value })} />
                    {rs?.height.assumed && (
                      <div className="mt-1 text-[10px] font-medium text-amber-700 whitespace-nowrap" data-testid={`text-height-assumed-${i}`}>
                        assumed to ceiling ({Number((rs.height.feet ?? 0).toFixed(2))} ft)
                      </div>
                    )}
                    {rs && rs.height.source === "none" && (
                      <div className="mt-1 text-[10px] text-muted-foreground max-w-[140px]" data-testid={`text-height-missing-${i}`}>
                        {rs.height.note}
                      </div>
                    )}
                    <label className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground whitespace-nowrap" title="The product comes as a 4x4 panel">
                      <input
                        type="checkbox"
                        checked={rs?.fourByFour.on ?? false}
                        data-testid={`checkbox-4x4-${i}`}
                        onChange={(e) => updateRoomRow(i, { fourByFour: e.target.checked })}
                      />
                      4x4 panel
                      {rs?.fourByFour.source === "product" && <span className="text-amber-700 font-medium">(by product: assumed)</span>}
                    </label>
                  </td>
                  <td className="p-2 text-xs min-w-[170px] max-w-[240px]" data-testid={`text-room-suggestion-${i}`}>
                    {rs && rs.sheets !== null ? (
                      <>
                        <div className="font-mono font-medium">{roomSheetsText(rs.parts)}</div>
                        <div className="text-[10px] text-muted-foreground">{rs.arithmetic}</div>
                        {rs.parts.some((p) => p.sheets % 1 !== 0) && (
                          <div className="text-[10px] text-muted-foreground">rounded up with the job's other sheets of that size</div>
                        )}
                        {rs.readingNote && (
                          <div className="mt-0.5 text-[10px] font-medium text-amber-700" data-testid={`text-reading-note-${i}`}>{rs.readingNote}</div>
                        )}
                        {rs.assumed.map((a) => (
                          <div key={a} className="mt-0.5 text-[10px] font-medium text-amber-700" data-testid={`text-room-assumed-${i}`}>{a}</div>
                        ))}
                      </>
                    ) : (
                      <span className="text-[10px] text-muted-foreground" data-testid={`text-room-problem-${i}`}>{rs?.problem ?? "—"}</span>
                    )}
                    {rs && rs.height.feet !== null && rs.height.feet > 12 && (
                      <div className="mt-1 rounded border border-amber-300 bg-amber-50/60 p-1.5" data-testid={`box-stack-${i}`}>
                        <div className="text-[10px] font-medium text-amber-800">Stacked wall ({Number(rs.height.feet.toFixed(2))} ft)</div>
                        {rs.stack && (
                          <>
                            <div className="text-[10px]" data-testid={`text-stack-${i}`}>{rs.stack.text}</div>
                            <div className="text-[10px] font-medium text-amber-700" data-testid={`text-stack-note-${i}`}>{rs.stack.note}</div>
                          </>
                        )}
                        <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                          courses (ft, from the floor)
                          <Input
                            className="h-6 w-24 text-[11px] font-mono"
                            value={row.stackCourses ?? ""}
                            placeholder={rs.stack ? rs.stack.courses.join(" + ") : "e.g. 10 + 4"}
                            data-testid={`input-stack-courses-${i}`}
                            onChange={(e) => updateRoomRow(i, { stackCourses: e.target.value.trim() === "" ? null : e.target.value })}
                          />
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="p-2">
                    <div className="flex flex-col gap-1 text-[10px] text-muted-foreground">
                      <span>inside</span>
                      <CountBox
                        className={`${inputCls} w-14 font-mono`}
                        value={row.insideCorners ?? null}
                        placeholder="—"
                        title="Inside corner pieces, counted from the plans"
                        testId={`input-inside-corners-${i}`}
                        onProblem={reportCountProblem}
                        onChange={(n) => updateRoomRow(i, { insideCorners: n })}
                      />
                      <span>outside</span>
                      <CountBox
                        className={`${inputCls} w-14 font-mono`}
                        value={row.outsideCorners ?? null}
                        placeholder="—"
                        title="Outside corner pieces, counted from the plans"
                        testId={`input-outside-corners-${i}`}
                        onProblem={reportCountProblem}
                        onChange={(n) => updateRoomRow(i, { outsideCorners: n })}
                      />
                    </div>
                  </td>
                  <td className="p-2">
                    <Input className={`${inputCls} min-w-[100px]`} value={row.manufacturer ?? ""} placeholder="—"
                      onChange={(e) => updateRoomRow(i, { manufacturer: e.target.value })} />
                  </td>
                  <td className="p-2">
                    <Input className={`${inputCls} w-20`} value={row.color ?? ""} placeholder="—" data-testid={`input-color-${i}`}
                      onChange={(e) => updateRoomRow(i, { color: e.target.value })} />
                  </td>
                  <td className="p-2">
                    <Input className={`${inputCls} w-20 font-mono`} value={row.productCode ?? ""} placeholder="—"
                      onChange={(e) => updateRoomRow(i, { productCode: e.target.value })} />
                  </td>
                  <td className="p-2">
                    <Input className={`${inputCls} w-20`} value={row.fireRating ?? ""} placeholder="—" data-testid={`input-fire-rating-${i}`}
                      onChange={(e) => updateRoomRow(i, { fireRating: e.target.value })} />
                  </td>
                  <td className="p-2">
                    <Select
                      value={row.moldingType ?? "none"}
                      onValueChange={(v) => updateRoomRow(i, { moldingType: v === "none" ? null : (v as MoldingType) })}
                    >
                      <SelectTrigger className="h-8 w-[100px] text-xs" data-testid={`select-molding-${i}`}>
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
                      onClick={() => changeRooms(roomRows.filter((_, idx) => idx !== i))}>
                      <Trash2 className="h-3.5 w-3.5" />
                      <span className="sr-only">Remove room</span>
                    </Button>
                  </td>
                </tr>
                )
              })}
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
        {typedJob && (
          <div className="mx-4 mb-2 rounded-md border border-amber-400 bg-amber-50/70 p-3 text-xs" data-testid="box-typed-job">
            <p className="font-medium text-amber-900">
              You typed your own count ({typedRowsWords}). While you have typed counts, no row of a new size is added by itself (the app cannot tell which rooms your typed rows cover); suggested rows still follow the walls, and your typed rows are never changed.
            </p>
            <p className="mt-1 text-amber-900">Under the rules, the walls need:</p>
            <ul className="mt-1 space-y-1">
              {needs.map((n) => (
                <li key={n.size} className="flex flex-wrap items-center gap-2" data-testid={`row-wall-need-${n.size}`}>
                  <span className="font-mono">
                    {n.size}: {n.need} (the rows hold {n.have}{n.typed > 0 ? `, ${n.typed} typed by you` : ""})
                  </span>
                  {n.canAdd && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[11px]"
                      onClick={() => setSheetRows((rows) => tidyMoldingCounts(addSuggestedSize(roomRows, rows, n.size)))}
                      data-testid={`button-add-size-${n.size}`}
                    >
                      add {n.need} x {n.size}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-amber-900">
              Your typed rows stay as they are and may cover the same walls: check them before you add a row.
            </p>
          </div>
        )}
        {earlierRules && (
          <div className="mx-4 mb-2 rounded-md border border-amber-400 bg-amber-50/70 p-3 text-xs" data-testid="box-earlier-rules">
            <p className="font-medium text-amber-900">
              This job was counted under the earlier rules. Its sheet counts stay exactly as they were saved, and changes to the rooms are not counted yet.
            </p>
            <p className="mt-1 text-amber-900" data-testid="text-new-counts-preview">
              {conversion.changes.length > 0
                ? `The new rules would change: ${conversion.changes.map((c) => `${c.size} ${c.before} → ${c.after}`).join("; ")}. Rows you typed stay yours.`
                : "The new rules give the same counts. Rows you typed stay yours."}
            </p>
            {conversion.typedKept.map((t) => (
              <p key={t} className="mt-1 font-medium text-amber-900" data-testid="text-typed-kept">{t}</p>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="mt-2 h-7 text-xs"
              onClick={() => setSheetRows(tidyMoldingCounts(convertToNewRules(roomRows, sheetRows).rows))}
              data-testid="button-use-new-counts"
            >
              Use the new counts for every size
            </Button>
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
                    No sheet rows yet. Type wall lengths above and the suggested sheets appear here, or add a row yourself.
                  </td>
                </tr>
              )}
              {sheetRows.map((row, i) => (
                <tr key={i} className="hover:bg-muted/20 transition-colors align-top">
                  <td className="p-2">
                    {/* Typing a count makes the row his: it is never changed for him again. */}
                    <SheetCountInput
                      className={`${inputCls} w-24 font-mono`}
                      value={row.sheetsNeeded}
                      testId={`input-sheets-needed-${i}`}
                      problemTestId={`text-sheet-count-problem-${i}`}
                      onProblem={reportCountProblem}
                      onChange={(count) => updateSheetRow(i, { sheetsNeeded: count, sheetsSource: "typed" })}
                    >
                      {followsWalls(row) ? (
                        <Badge variant="secondary" className="text-[10px]" data-testid={`badge-sheets-source-${i}`}>suggested</Badge>
                      ) : suggestedEarlier(row) ? (
                        <Badge variant="outline" className="text-[10px] border-amber-500 text-amber-700" data-testid={`badge-sheets-source-${i}`}>suggested (earlier rules)</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] border-primary/50" data-testid={`badge-sheets-source-${i}`}>yours</Badge>
                      )}
                    </SheetCountInput>
                    {suggestedEarlier(row) && (
                      <div className="mt-1 max-w-[260px] text-[10px] text-amber-700" data-testid={`text-earlier-rules-${i}`}>
                        {suggestion.bySize[row.sheetSize] !== row.sheetsNeeded
                          ? `Saved under the earlier rules. The new rules suggest ${suggestion.bySize[row.sheetSize]}.`
                          : "Saved under the earlier rules; the new rules give the same."}
                      </div>
                    )}
                    {!followsWalls(row) &&
                      !suggestedEarlier(row) &&
                      !earlierRules &&
                      suggestion.bySize[row.sheetSize] > 0 &&
                      !sheetRows.some((r) => followsWalls(r) && r.sheetSize === row.sheetSize) && (
                        <button
                          type="button"
                          className="mt-1 block text-[10px] text-muted-foreground underline decoration-dotted hover:text-foreground"
                          onClick={() => updateSheetRow(i, { sheetsNeeded: suggestion.bySize[row.sheetSize], sheetsSource: "suggested", rules: CURRENT_RULES })}
                          data-testid={`button-use-suggestion-${i}`}
                        >
                          wall lengths suggest {suggestion.bySize[row.sheetSize]}: use that
                        </button>
                      )}
                  </td>
                  <td className="p-2">
                    <Select value={row.sheetSize} onValueChange={(v) => updateSheetRow(i, { sheetSize: v as SheetSize, sheetsSource: "typed" })}>
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
                      <PriceInput
                        value={row.pricePerSheet}
                        testId={`input-price-per-sheet-${i}`}
                        onChange={(price) => updateSheetRow(i, { pricePerSheet: price })}
                      />
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
                    {row.pricePerSheet > 0 ? (
                      money(row.sheetsNeeded * row.pricePerSheet)
                    ) : (
                      <span className="text-muted-foreground font-sans">{NOT_PRICED}</span>
                    )}
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
                  <td className="p-3 text-right font-mono text-xs" data-testid="text-materials-total">
                    {totals.materialsPriced ? money(totals.materials) : <span className="text-muted-foreground font-sans">{NOT_PRICED}</span>}
                  </td>
                  <td></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {Object.keys(suggestion.sizeWorking).length > 0 && (
          <p className="px-4 pt-2 text-[11px] text-muted-foreground" data-testid="text-size-working">
            Suggested from the walls, rounded up once per size:{" "}
            {Object.values(suggestion.sizeWorking).join("; ")}.
          </p>
        )}
        <div className="border-t border-border/40 p-3">
          <Button variant="ghost" size="sm" onClick={addSheetRow} className="text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground" data-testid="button-add-sheet-row">
            <Plus className="mr-2 h-4 w-4" /> Add Sheet Row
          </Button>
        </div>

        {/* Moldings and glue: quantities, worked out from the sheets */}
        <div className="border-t border-border/40 p-4" data-testid="section-moldings-glue">
          <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Moldings & Glue</h3>
          <p className="mt-1 text-[11px] text-muted-foreground" data-testid="text-molding-rule">
            Your rule: 4 ft tall material takes a cap top and bottom (a full stick each) and one divider; taller than 4 ft, one cap stick for top and bottom.
            Corners: the pieces you type per room from the plans, never guessed. Length: 8 ft molding for sheets 8 ft high or less, 10 ft above.
          </p>
          <p className="mt-0.5 text-[11px] font-medium text-amber-700" data-testid="text-molding-assumed">{MOLDING_PER_SHEET_ASSUMED}</p>
          <div className="mt-3 space-y-3 text-sm">
            {molding.lines.length === 0 && molding.legacy.length === 0 && (
              <p className="text-xs text-muted-foreground">No moldings yet: type wall lengths and heights.</p>
            )}
            {molding.legacy.map((l) => (
              <div key={`legacy-${l.lengthFt}`} className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid={`row-molding-legacy-${l.lengthFt}`}>
                <span className="w-56 text-muted-foreground">
                  {l.lengthFt} ft molding, all kinds
                  <span className="block text-[10px]">typed before moldings were counted by kind</span>
                </span>
                <span className="font-mono font-medium">{l.count}</span>
                <Badge variant="outline" className="text-[10px] border-primary/50">yours</Badge>
                <span className="text-xs text-amber-700">Kept as you typed it; the {l.lengthFt} ft counts by kind below are not used while it is here.</span>
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground underline decoration-dotted hover:text-foreground"
                  onClick={() => setSheetRows((rows) => setMoldingCount(rows, l.lengthFt, null))}
                  data-testid={`button-molding-legacy-clear-${l.lengthFt}`}
                >
                  count {l.lengthFt} ft by kind instead
                </button>
              </div>
            ))}
            {molding.lines.map((line) => (
              <div
                key={line.key}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${legacyLengths.has(line.lengthFt) ? "opacity-50" : ""}`}
                data-testid={`row-molding-${line.key}`}
              >
                <span className="w-56 text-muted-foreground">
                  {MOLDING_KIND_NAMES[line.kind]}, {line.lengthFt} ft
                </span>
                <CountBox
                  className="h-8 w-20 text-xs font-mono"
                  value={line.count}
                  testId={`input-molding-${line.key}`}
                  onProblem={reportCountProblem}
                  onChange={(n) => setSheetRows((rows) => setKindCount(rows, line.key, n))}
                />
                <span className="text-xs text-muted-foreground">pieces</span>
                {line.typed ? (
                  <>
                    <Badge variant="outline" className="text-[10px] border-primary/50" data-testid={`badge-molding-source-${line.key}`}>yours</Badge>
                    <button
                      type="button"
                      className="text-[10px] text-muted-foreground underline decoration-dotted hover:text-foreground"
                      onClick={() => setSheetRows((rows) => setKindCount(rows, line.key, null))}
                      data-testid={`button-molding-reset-${line.key}`}
                    >
                      back to the rule ({line.suggested})
                    </button>
                  </>
                ) : (
                  <span className="text-[11px] text-muted-foreground" data-testid={`text-molding-working-${line.key}`}>{line.working}</span>
                )}
                {line.assumed.map((a) => (
                  <span key={a} className="text-[11px] font-medium text-amber-700">{a}</span>
                ))}
              </div>
            ))}
            {molding.notCounted.length > 0 && (
              <ul className="list-disc pl-5 text-[11px] text-amber-700" data-testid="list-molding-not-counted">
                {molding.notCounted.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            {sheetRows.length === 0 && molding.lines.length > 0 && (
              <p className="text-[11px] text-muted-foreground">Add a sheet row to type over a molding count.</p>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="row-glue">
              <span className="w-56 text-muted-foreground">
                Glue
                <span className="block text-[10px]">one bucket does 12 sheets of any height</span>
              </span>
              <span className="font-mono font-medium" data-testid="text-glue-buckets">
                {glueBuckets(totals.totalSheets).buckets} bucket{glueBuckets(totals.totalSheets).buckets === 1 ? "" : "s"}
              </span>
              <span className="text-xs text-muted-foreground" data-testid="text-glue-arithmetic">
                {glueBuckets(totals.totalSheets).arithmetic}
              </span>
            </div>
          </div>
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
                <dd className="font-mono font-medium" data-testid="text-labor-total">
                  {totals.laborPriced ? money(totals.labor) : <span className="text-muted-foreground font-sans font-normal">{NOT_PRICED}</span>}
                </dd>
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
                <dd className="font-mono font-medium" data-testid="text-overtime-total">{totals.overtime > 0 ? money(totals.overtime) : "—"}</dd>
              </div>
              <div className="py-3 flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">
                  Travel
                  <div className="flex items-center gap-1.5 mt-1.5 text-xs">
                    <Input type="number" min={0} className="h-7 w-20 text-xs font-mono" value={travelMiles} onChange={(e) => setTravelMiles(e.target.value)} data-testid="input-travel-miles" />
                    <span>miles from Rocklin, CA × 8 × 1.5</span>
                  </div>
                </dt>
                <dd className="font-mono font-medium" data-testid="text-travel-total">{totals.travel > 0 ? money(totals.travel) : "—"}</dd>
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
                <dd className="font-mono font-medium" data-testid="text-hotel-total">{totals.hotel > 0 ? money(totals.hotel) : "—"}</dd>
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
                <dd className="font-mono font-medium" data-testid="text-freight-total">{totals.freight > 0 ? money(totals.freight) : "—"}</dd>
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
                      value={profitOverride !== null ? profitOverride : box(totals.autoProfit)}
                      placeholder="auto"
                      onChange={(e) => setProfitOverride(e.target.value)}
                      data-testid="input-profit"
                    />
                    {typedProfit !== null ? (
                      <button type="button" className="underline decoration-dotted hover:text-foreground" onClick={() => setProfitOverride(null)} data-testid="button-reset-profit">
                        reset to auto ({money(totals.autoProfit)})
                      </button>
                    ) : (
                      <span data-testid="text-profit-rule">auto: {flatProfitApplies(totals.totalSheets) ? `$${PROFIT_FLAT} flat (${PROFIT_FLAT_MAX_SHEETS} sheets and under)` : `$${PROFIT_PER_DAY}/day (more than ${PROFIT_FLAT_MAX_SHEETS} sheets)`}</span>
                    )}
                  </div>
                </dt>
                <dd className="font-mono font-medium" data-testid="text-profit-total">
                  {typedProfit !== null || totals.profit > 0 ? (
                    money(totals.profit)
                  ) : (
                    <span className="text-muted-foreground font-sans font-normal">not set: type the labor days</span>
                  )}
                </dd>
              </div>
            </dl>
          </div>

          {/* Total */}
          <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Total Job Price</p>
              {totals.fullyPriced ? (
                <p className="text-xs text-muted-foreground mt-0.5">Materials {money(totals.materials)} + costs {money(totals.total - totals.materials)}</p>
              ) : (
                <p className="text-xs text-muted-foreground mt-0.5" data-testid="text-total-not-priced-detail">
                  No price yet for: {totals.notPriced.join(", ")}. Prices are optional: the sheets, moldings and glue above do not need them.
                  {totals.total > 0 ? ` Priced so far: ${money(totals.total)}.` : ""}
                </p>
              )}
            </div>
            <p className={`font-bold font-mono tracking-tight ${totals.fullyPriced ? "text-3xl" : "text-xl text-muted-foreground"}`} data-testid="text-total-job-price">
              {totals.fullyPriced ? money(totals.total) : NOT_PRICED}
            </p>
          </div>
        </div>
      </CardContent>
      <MaterialListDialog
        list={materialList}
        open={materialListOpen}
        onOpenChange={setMaterialListOpen}
        unsaved={unsaved}
      />
    </Card>
  )
}
