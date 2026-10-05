---
name: Plan-page vision tiling
description: How to make Claude vision read small text (dimension strings) on large plan sheets
---

Rule: Claude vision cannot read small dimension text on a full plan sheet — the API downscales images to ~1568px long edge, and multi-image requests hard-reject any image over 2576px per side. Send a downscaled full-page overview plus overlapping tiles where each crop (including overlap) stays ≤1568px, with a cap on tile count (reduce DPI for huge sheets).

**Why:** Room-spec height extraction returned null for every room until tiling was added; quadrant crops at 300dpi failed with 400 "exceed max allowed size for many-image requests: 2576 pixels".

**How to apply:** Any AI vision task on rendered PDF plan pages. Also: pdfinfo reports pre-rotation page size, but pdftoppm renders post-rotation — swap width/height when "Page rot" is 90/270, or tile crops go out of range and pdftoppm silently emits full-size (oversized) images.
