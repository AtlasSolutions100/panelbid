---
name: Google Drive link downloads
description: How to reliably download PDFs from Drive share links server-side
---

- Drive `uc?export=download` redirects to `drive.usercontent.google.com` and serves PDFs with `content-type: application/octet-stream` — never trust content-type for PDF detection; sniff `%PDF-` magic bytes instead.
- Large files (>~100 MB) return an HTML virus-scan confirmation page; parse the form (action must be a google.com/usercontent host) and follow once, re-applying SSRF checks.
- Login-gated files return an HTML login page with no confirmation form → treat as "no plans found", not an error.

**Why:** A publicly shared 25 MB PDF was rejected as "No PDFs found" because the content-type check assumed `pdf` in the header.
**How to apply:** Any server-side URL→PDF download path (email link extraction, future retry logic) should validate by magic bytes, not content-type or URL suffix.
