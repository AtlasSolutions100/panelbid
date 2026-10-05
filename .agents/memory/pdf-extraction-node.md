---
name: PDF text extraction in the API server
description: Why the server uses unpdf instead of pdfjs-dist for plan scanning
---

Rule: for server-side PDF text extraction in the bundled Express API, use `unpdf` (`extractText(data, { mergePages: false })` for per-page text), not `pdfjs-dist`.

**Why:** pdfjs-dist fails inside the esbuild bundle at runtime — `DOMMatrix is not defined`, `PDFDocumentLoadingTask is not a constructor` — because it expects DOM/canvas polyfills that aren't present in the Node bundle. unpdf is a serverless-friendly pdfjs wrapper that works without them.

**How to apply:** any future feature that reads PDF content server-side (dedup previews, OCR pipeline, takeoff parsing) should go through unpdf or an equivalent DOM-free library; if extraction throws or yields no text, flag the file `needs_ocr` rather than failing the request.
