import { useState, useRef, useLayoutEffect } from "react"
import { Document, Page, pdfjs } from "react-pdf"
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import { Download, FileWarning, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc

interface PdfViewerProps {
  /** URL to fetch the PDF from. */
  url: string
  /** Download URL used in the failure fallback. */
  downloadUrl: string
}

/**
 * Renders a PDF with pdf.js (canvas pages), independent of the browser's
 * native PDF plugin — which is often unavailable inside embedded frames.
 */
export function PdfViewer({ url, downloadUrl }: PdfViewerProps) {
  const [numPages, setNumPages] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [pageWidth, setPageWidth] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setPageWidth(Math.min(el.clientWidth - 32, 1200))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
        <FileWarning className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground max-w-sm">{error}</p>
        <Button variant="outline" size="sm" asChild>
          <a href={downloadUrl} target="_blank" rel="noreferrer" download>
            <Download className="mr-2 h-4 w-4" /> Download instead
          </a>
        </Button>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="h-full overflow-y-auto bg-muted/40">
      <Document
        file={url}
        onLoadSuccess={({ numPages: n }) => setNumPages(n)}
        onLoadError={(err) => {
          console.error("PDF load error:", err)
          setError(
            "This PDF couldn't be loaded. The file may have been removed from the server.",
          )
        }}
        loading={
          <div className="flex items-center justify-center gap-2 p-12 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading PDF...
          </div>
        }
        className="flex flex-col items-center gap-4 py-4"
      >
        {pageWidth !== null &&
          numPages !== null &&
          Array.from({ length: numPages }, (_, i) => (
            <Page
              key={i + 1}
              pageNumber={i + 1}
              width={pageWidth}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              className="shadow-md"
              loading={
                <div
                  style={{ width: pageWidth, height: pageWidth * 0.75 }}
                  className="bg-background animate-pulse"
                />
              }
            />
          ))}
      </Document>
    </div>
  )
}
