/**
 * The inbox watcher reads every message in the inbox, so what it writes to
 * the server log matters: counts and ids, never what a message says or who
 * sent it.
 *
 * This reads the watcher's own source and checks each log call. It is a
 * plain check on purpose: it needs no Gmail and no database, and it fails
 * the moment someone logs a subject or a sender again.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The first argument (the logged fields) of every logger call in a file. */
function loggedFields(file: string): string[] {
  const source = readFileSync(path.join(here, file), "utf8");
  const calls = source.match(
    /\b(?:logger|log|req\.log)\.(?:trace|debug|info|warn|error|fatal)\(\s*\{[^}]*\}/g,
  );
  return calls ?? [];
}

// Words that stand for what a message says, who sent it, or whose mailbox
// it is, when they appear as a logged field.
const MAIL_CONTENT =
  /\b(subject|sender|snippet|email|connectedEmail|fileName|name|url|originalUrl|finalUrl|confirmUrl|term|contractor)\b\s*[,:}]/;

describe("what the inbox watcher writes to the log", () => {
  it("finds the watcher's log calls (so the check below is not empty)", () => {
    expect(loggedFields("gmailWorker.ts").length).toBeGreaterThan(20);
  });

  for (const file of ["gmailWorker.ts", "gmailClient.ts", "../routes/gmail.ts"]) {
    it(`${file} logs no subject, sender, address, file name or link`, () => {
      const offending = loggedFields(file).filter((call) =>
        MAIL_CONTENT.test(call),
      );
      expect(offending).toEqual([]);
    });
  }

  it("still logs the ids needed to follow a message to its job", () => {
    const all = loggedFields("gmailWorker.ts").join("\n");
    expect(all).toContain("gmailMessageId");
    expect(all).toContain("jobId");
    expect(all).toMatch(/count|Count/);
  });
});
