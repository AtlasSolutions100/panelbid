---
name: Inline PDF rendering in the web frontend
description: Why native <object>/<iframe> PDF embedding fails in the Replit preview and how to set up react-pdf/pdf.js with Vite
---

Do not rely on the browser's native PDF plugin (`<object type="application/pdf">` / `<iframe>`) to display PDFs in-app. Render pages to canvas with react-pdf (pdf.js) instead.

**Why:** The Replit preview pane is a cross-origin proxied iframe; Chrome's native PDF viewer is often unavailable/blocked there, so the `<object>` fallback content renders for every file even though the endpoint streams a valid `application/pdf` inline. The server side was never the problem.

**How to apply:**
- Use `react-pdf` with `renderTextLayer={false} renderAnnotationLayer={false}` (avoids needing its CSS).
- Worker setup under Vite: `new URL("pdfjs-dist/...", import.meta.url)` FAILS in dev (404, "fake worker" fallback). Instead add `pdfjs-dist` as a direct dependency (pin to the version react-pdf resolves in the pnpm store) and use `import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url"` then `pdfjs.GlobalWorkerOptions.workerSrc = workerSrc`.
