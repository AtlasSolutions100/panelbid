import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { Printer } from "lucide-react"
// The list itself (quantities, working, assumptions) and its printed page are
// built by the shared rules, so the screen and the PDF always say the same.
import { materialListHtml, type MaterialList } from "@/lib/takeoff-rules"

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" })

const WHOSE = {
  suggested: "suggested from the wall lengths",
  yours: "your own count",
  both: "part suggested, part your own",
} as const

/**
 * The Material list on screen: sheets by size, moldings by length, glue
 * buckets, the rooms with their wall lengths and heights, and the assumptions
 * used. "Print / save as PDF" opens the same list as a printable page (the way
 * the proposal is exported). Prices appear only when some were typed.
 */
export function MaterialListDialog({
  list,
  open,
  onOpenChange,
  unsaved,
}: {
  list: MaterialList
  open: boolean
  onOpenChange: (open: boolean) => void
  /** True when the takeoff on screen has changes that are not saved yet. */
  unsaved: boolean
}) {
  const { toast } = useToast()

  const handlePrint = () => {
    const win = window.open("", "_blank")
    if (!win) {
      toast({ title: "Popup blocked", description: "Allow popups to print the material list.", variant: "destructive" })
      return
    }
    win.document.write(materialListHtml(list))
    win.document.close()
    win.focus()
    setTimeout(() => win.print(), 250)
  }

  const th = "p-2 text-left text-[11px] font-mono uppercase tracking-wider text-muted-foreground"
  const td = "p-2 align-top"
  const h3 = "text-xs font-mono uppercase tracking-wider text-muted-foreground mt-4 mb-1"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" data-testid="dialog-material-list">
        <DialogHeader>
          <DialogTitle>Material list</DialogTitle>
          <DialogDescription>
            {list.jobName}
            {[list.address, list.city].filter((v) => v.trim()).length > 0 && ` — ${[list.address, list.city].filter((v) => v.trim()).join(", ")}`}
            {" · "}
            {list.date}
            {list.thickness ? ` · panel thickness ${list.thickness}` : ""}
          </DialogDescription>
        </DialogHeader>

        {unsaved && (
          <p className="text-xs text-amber-700" data-testid="text-material-list-unsaved">
            This is the takeoff as it is on screen. It has changes that are not saved yet.
          </p>
        )}

        <div className="text-sm">
          <h3 className={h3}>Sheets</h3>
          {list.sheets.length === 0 ? (
            <p className="text-muted-foreground">No sheets yet. Type wall lengths or sheet counts in the takeoff.</p>
          ) : (
            <table className="w-full border border-border/60" data-testid="table-material-sheets">
              <thead>
                <tr className="bg-muted/30">
                  <th className={th}>Size</th>
                  <th className={`${th} text-right`}>Sheets</th>
                  <th className={th}>Count from</th>
                  {list.showPrices && <th className={`${th} text-right`}>Each</th>}
                  {list.showPrices && <th className={`${th} text-right`}>Total</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {list.sheets.map((s) => (
                  <tr key={s.size} data-testid={`row-material-sheet-${s.size}`}>
                    <td className={`${td} font-mono`}>{s.size}</td>
                    <td className={`${td} text-right font-mono font-medium`}>{s.count}</td>
                    <td className={td}>{WHOSE[s.whose]}</td>
                    {list.showPrices && (
                      <td className={`${td} text-right font-mono`}>
                        {s.price !== null ? money(s.price) : s.total !== null ? "mixed" : "not priced"}
                      </td>
                    )}
                    {list.showPrices && (
                      <td className={`${td} text-right font-mono`}>{s.total !== null ? money(s.total) : "not priced"}</td>
                    )}
                  </tr>
                ))}
                <tr className="font-medium bg-muted/10">
                  <td className={td}>All sheets</td>
                  <td className={`${td} text-right font-mono`} data-testid="text-material-total-sheets">{list.totalSheets}</td>
                  <td className={td}></td>
                  {list.showPrices && <td className={td}></td>}
                  {list.showPrices && (
                    <td className={`${td} text-right font-mono`}>
                      {list.materialsTotal !== null ? money(list.materialsTotal) : "not priced"}
                    </td>
                  )}
                </tr>
              </tbody>
            </table>
          )}

          <h3 className={h3}>Moldings</h3>
          {list.moldings.length === 0 ? (
            <p className="text-muted-foreground">No moldings yet.</p>
          ) : (
            <table className="w-full border border-border/60" data-testid="table-material-moldings">
              <thead>
                <tr className="bg-muted/30">
                  <th className={th}>Length</th>
                  <th className={`${th} text-right`}>Pieces</th>
                  <th className={th}>Count from</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {list.moldings.map((m) => (
                  <tr key={m.lengthFt} data-testid={`row-material-molding-${m.lengthFt}`}>
                    <td className={td}>{m.lengthFt} ft molding</td>
                    <td className={`${td} text-right font-mono font-medium`}>{m.count}</td>
                    <td className={td}>
                      {m.typed ? (
                        "your own count"
                      ) : (
                        <span className="text-amber-700 font-medium">ASSUMED one per sheet (not a confirmed rule)</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 className={h3}>Glue</h3>
          <p data-testid="text-material-glue">
            <span className="font-mono font-medium">
              {list.glue.buckets} bucket{list.glue.buckets === 1 ? "" : "s"}
            </span>{" "}
            <span className="text-xs text-muted-foreground">({list.glue.arithmetic})</span>
          </p>

          <h3 className={h3}>Rooms</h3>
          {list.rooms.length === 0 ? (
            <p className="text-muted-foreground">No rooms yet.</p>
          ) : (
            <table className="w-full border border-border/60" data-testid="table-material-rooms">
              <thead>
                <tr className="bg-muted/30">
                  <th className={th}>Room</th>
                  <th className={th}>Wall lengths as typed</th>
                  <th className={`${th} text-right`}>Wall</th>
                  <th className={th}>Panel height</th>
                  <th className={th}>Suggested</th>
                  <th className={th}>Working</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {list.rooms.map((r, i) => (
                  <tr key={i} data-testid={`row-material-room-${i}`}>
                    <td className={td}>{r.label}</td>
                    <td className={`${td} font-mono text-xs`}>{r.wallText || "—"}</td>
                    <td className={`${td} text-right font-mono whitespace-nowrap`}>{r.wallFeet > 0 ? `${Number(r.wallFeet.toFixed(2))} ft` : "—"}</td>
                    <td className={td}>{r.heightText}</td>
                    <td className={`${td} font-mono whitespace-nowrap`}>{r.sheets !== null ? `${r.sheets} × ${r.sheetSize}` : "—"}</td>
                    <td className={`${td} text-xs text-muted-foreground`}>{r.sheets !== null ? r.arithmetic : r.problem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {list.notCounted.length > 0 && (
            <>
              <h3 className={h3}>Not counted</h3>
              <ul className="list-disc pl-5 space-y-0.5 text-amber-700" data-testid="list-material-not-counted">
                {list.notCounted.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </>
          )}

          <h3 className={h3}>Assumptions used</h3>
          <ul className="list-disc pl-5 space-y-0.5 text-xs" data-testid="list-material-assumptions">
            {list.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>

        <div className="flex items-center justify-end pt-2">
          <Button
            size="sm"
            onClick={handlePrint}
            className="font-mono uppercase tracking-wider text-xs"
            data-testid="button-print-material-list"
          >
            <Printer className="mr-2 h-4 w-4" /> Print / save as PDF
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
