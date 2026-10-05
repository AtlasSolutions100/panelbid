/**
 * For the few tests that need a real PostgreSQL: the plan file store keeps
 * bytes in a table, and "the delete cascades" or "the table is made at
 * start-up" cannot be shown with a stand-in.
 *
 * They run only when PANELBID_TEST_DATABASE_URL names a THROWAWAY database
 * on this computer that already has the app's tables (made with
 * `drizzle-kit push`). Any other address is refused: these tests write and
 * delete rows. Without the setting they are skipped, loudly.
 *
 * Also here: sending and fetching a file as raw bytes (the shared harness
 * speaks text only), and two small PDFs made up for the tests.
 */
import http from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Running } from "./harness";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The throwaway database's address, or the reason the tests cannot run. */
export function readTestDatabase(): { url: string } | { skip: string } {
  const url = process.env.PANELBID_TEST_DATABASE_URL ?? "";
  if (!url) {
    return {
      skip: "PANELBID_TEST_DATABASE_URL is not set (a throwaway local PostgreSQL with the app's tables)",
    };
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { skip: "PANELBID_TEST_DATABASE_URL is not an address" };
  }
  if (!LOCAL_HOSTS.has(host)) {
    // Refuse rather than skip quietly: someone pointed the tests at a real database.
    throw new Error(
      "PANELBID_TEST_DATABASE_URL must be a throwaway database on this computer (127.0.0.1). " +
        "These tests write and delete rows.",
    );
  }
  return { url };
}

/** A fresh folder for the app's working copies; removed by the caller. */
export function makeUploadDir(): string {
  return mkdtempSync(path.join(tmpdir(), "panelbid-test-uploads-"));
}

/** What the host does at every restart: the working copies are gone. */
export function wipeUploads(uploadDir: string): void {
  for (const name of readdirSync(uploadDir)) {
    rmSync(path.join(uploadDir, name), { recursive: true, force: true });
  }
}

/** Every file under a folder, as paths relative to it. */
export function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (at: string, prefix: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(at, entry.name), rel);
      else found.push(rel);
    }
  };
  walk(dir, "");
  return found.sort();
}

// ---------------------------------------------------------------------------
// Raw bytes over HTTP
// ---------------------------------------------------------------------------

export interface BytesReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** The parsed JSON body, or null when the body is not JSON. */
  json: Record<string, unknown> | null;
}

function rawRequest(
  running: Running,
  method: string,
  urlPath: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<BytesReply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: running.port, method, path: urlPath, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          let json: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = JSON.parse(bytes.toString("utf8"));
            if (parsed && typeof parsed === "object") {
              json = parsed as Record<string, unknown>;
            }
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: bytes, json });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** GET as bytes (a PDF must come back byte for byte). */
export function getBytes(running: Running, cookie: string, urlPath: string): Promise<BytesReply> {
  return rawRequest(running, "GET", urlPath, { cookie });
}

/** Upload one file the way the page does (multipart, field "file"). */
export function uploadPlan(
  running: Running,
  cookie: string,
  jobId: number,
  fileName: string,
  bytes: Buffer,
  mimeType = "application/pdf",
): Promise<BytesReply> {
  const boundary = "----panelbidtest" + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([head, bytes, tail]);
  return rawRequest(
    running,
    "POST",
    `/api/jobs/${jobId}/files`,
    {
      cookie,
      origin: running.origin,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
    body,
  );
}

// ---------------------------------------------------------------------------
// Made-up PDFs
// ---------------------------------------------------------------------------

/**
 * Not a drawing: a file that starts like a PDF and then holds every byte
 * value many times over, so "byte for byte" means something.
 */
export function binaryPlan(size: number, seed = 7): Buffer {
  const out = Buffer.alloc(size);
  out.write("%PDF-1.4\n", 0, "latin1");
  let x = seed;
  for (let i = 9; i < size; i++) {
    // Every value 0..255 appears; a small generator varies the order.
    x = (x * 73 + 41) % 65521;
    out[i] = i < 9 + 256 ? i - 9 : x & 0xff;
  }
  return out;
}

/** A small real PDF with one line of text on each page. */
export function textPlan(pageTexts: string[]): Buffer {
  const objects: string[] = [];
  const n = pageTexts.length;
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  const kids = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  pageTexts.forEach((text, i) => {
    const pageNum = 4 + i * 2;
    const contentNum = pageNum + 1;
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
    objects.push(
      `${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  });
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    body += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
