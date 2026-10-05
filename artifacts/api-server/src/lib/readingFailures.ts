/**
 * Why a reading (room reading, price-sheet reading) did not work, as a
 * status and ONE plain sentence a tradesman can act on.
 *
 * The page shows the sentence as it is. So: no stack traces, no file paths,
 * no code words, and never the AI provider's own text. What really happened
 * goes to the server log.
 */
import { PdfToolsMissingError } from "./pdfTools";
import { isPlanFileError, planFileErrorBody } from "./planFileStore";

export type ReadingFailureCode =
  | "no_plan"
  | "no_schedule_page"
  | "no_text"
  | "plan_unreadable"
  | "ai_no_answer"
  | "ai_refused"
  | "ai_too_slow"
  | "ai_bad_answer"
  | "page_not_rendered"
  | "page_not_read"
  | "already_running";

interface FailureWords {
  status: number;
  /** The whole sentence, when this is why nothing could be read. */
  message: string;
  /** The short form, used when naming one page among others. */
  short: string;
}

export const READING_FAILURES: Record<ReadingFailureCode, FailureWords> = {
  no_plan: {
    status: 422,
    message: "Add a plan first.",
    short: "no plan",
  },
  no_schedule_page: {
    status: 422,
    message:
      'No page in these plans looks like a finish schedule. The app looks for a page with the words "Finish Schedule" or "Finish Legend", or a room table with your keywords on it. You can add the rooms by hand with Add Row.',
    short: "no finish schedule",
  },
  no_text: {
    status: 422,
    message:
      "This plan has no text the app can read (it is probably a scan), so the finish schedule cannot be found in it. You can add the rooms by hand with Add Row.",
    short: "no readable text",
  },
  plan_unreadable: {
    status: 422,
    message: "This plan's PDF could not be opened. Save it again as a PDF and upload it again.",
    short: "the PDF could not be opened",
  },
  ai_no_answer: {
    status: 502,
    message: "The AI reader did not answer. Try again in a few minutes.",
    short: "the AI reader did not answer",
  },
  ai_refused: {
    status: 502,
    message: "The AI reader refused the request. Try again later; if it keeps happening, tell support.",
    short: "the AI reader refused",
  },
  ai_too_slow: {
    status: 504,
    message: "The AI reader took too long to answer. Try again.",
    short: "the AI reader took too long",
  },
  ai_bad_answer: {
    status: 502,
    message: "The AI reader's answer could not be understood. Try again.",
    short: "the AI reader's answer could not be understood",
  },
  page_not_rendered: {
    status: 422,
    message:
      "A page of this plan could not be turned into a picture. Save the plan again as a PDF and upload it again.",
    short: "the page could not be turned into a picture",
  },
  page_not_read: {
    status: 500,
    message: "A page could not be read because of a fault on the server. Try again; if it keeps happening, tell support.",
    short: "a fault on the server",
  },
  already_running: {
    status: 409,
    message: "Room reading is already running for this job. Wait for it to finish.",
    short: "already running",
  },
};

export const SERVER_FAULT_MESSAGE =
  "Something went wrong on the server. Try again; if it keeps happening, tell support.";

/** A reading that did not work, for a reason the person can be told. */
export class ReadingFailure extends Error {
  readonly status: number;
  constructor(
    readonly code: ReadingFailureCode,
    /** What really happened, for the server log only. */
    readonly detail?: unknown,
  ) {
    super(READING_FAILURES[code].message);
    this.name = "ReadingFailure";
    this.status = READING_FAILURES[code].status;
  }
}

/**
 * Which of the three the AI reader did: did not answer, refused, or was
 * too slow. Told apart by the HTTP status and the kind of error, never by
 * showing the provider's text.
 */
export function classifyAiError(err: unknown): ReadingFailureCode {
  const status = (err as { status?: unknown } | null)?.status;
  const kind =
    (err as { constructor?: { name?: string } } | null)?.constructor?.name ?? "";
  const text = err instanceof Error ? err.message : "";
  if (
    kind === "APIConnectionTimeoutError" ||
    status === 408 ||
    /timed out|timeout/i.test(text)
  ) {
    return "ai_too_slow";
  }
  if (typeof status === "number") {
    return status >= 500 ? "ai_no_answer" : "ai_refused";
  }
  return "ai_no_answer";
}

/** Ask the AI reader; a failure becomes one of the three above. */
export async function askAi<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (err) {
    throw new ReadingFailure(classifyAiError(err), err);
  }
}

/** Read the AI reader's answer; anything it cannot be read as: ai_bad_answer. */
export function readAiAnswer<T>(read: () => T): T {
  try {
    return read();
  } catch (err) {
    throw new ReadingFailure("ai_bad_answer", err);
  }
}

/** The code of a failure met while reading one page. */
export function pageFailureCode(err: unknown): ReadingFailureCode {
  return err instanceof ReadingFailure ? err.code : "page_not_read";
}

export interface FailedPage {
  fileName: string;
  pageNumber: number;
  code: ReadingFailureCode;
}

/** "A-601.pdf page 3 (the AI reader took too long); page 4 (...)". */
export function namePages(pages: FailedPage[]): string {
  return pages
    .map((p) => `${p.fileName} page ${p.pageNumber} (${READING_FAILURES[p.code].short})`)
    .join("; ");
}

export interface FailureAnswer {
  status: number;
  body: Record<string, unknown>;
  /** True when the fault is the server's own: log it as an error. */
  ours: boolean;
}

/**
 * The status and the JSON body for anything a reading can throw. An error
 * nobody planned for becomes a 500 with a plain sentence; its own text is
 * never sent.
 */
export function describeFailure(err: unknown): FailureAnswer {
  if (isPlanFileError(err)) {
    return { status: err.status, body: planFileErrorBody(err), ours: err.status >= 500 };
  }
  if (err instanceof PdfToolsMissingError) {
    return { status: err.status, body: { code: err.code, message: err.message }, ours: true };
  }
  if (err instanceof ReadingFailure) {
    return {
      status: err.status,
      body: { code: err.code, message: err.message },
      ours: err.status === 500,
    };
  }
  return {
    status: 500,
    body: { code: "server_fault", message: SERVER_FAULT_MESSAGE },
    ours: true,
  };
}

/** The sentence alone (stored as the reason a background reading failed). */
export function failureSentence(err: unknown): string {
  return String(describeFailure(err).body.message);
}
