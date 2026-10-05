/**
 * The inbox watcher never looks back more than 7 days.
 *
 * On the live site the connection needed a reconnect for about eight weeks.
 * The day it is reconnected the watcher must not sweep those eight weeks in
 * one go. No Gmail and no database: the rule is a small function, and the
 * watcher's source is read to see that its query uses it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_LOOK_BACK_MS, lookBackStartSeconds } from "./gmailLookBack";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 5, 18, 0, 0); // 2026-10-05
const seconds = (ms: number) => Math.floor(ms / 1000);

describe("how far back the inbox watcher looks", () => {
  it("the limit is 7 days", () => {
    expect(MAX_LOOK_BACK_MS).toBe(7 * DAY);
  });

  it("looked ten minutes ago: from then, as before", () => {
    const last = new Date(now - 10 * 60 * 1000);
    expect(lookBackStartSeconds(last, now)).toBe(seconds(last.getTime()));
  });

  it("last looked about eight weeks ago (2026-08-13): only the last 7 days", () => {
    const last = new Date(Date.UTC(2026, 7, 13, 9, 30, 0));
    expect(lookBackStartSeconds(last, now)).toBe(seconds(now - 7 * DAY));
    expect(lookBackStartSeconds(last, now)).toBeGreaterThan(seconds(last.getTime()));
  });

  it("never looked: 7 days, as before", () => {
    expect(lookBackStartSeconds(null, now)).toBe(seconds(now - 7 * DAY));
    expect(lookBackStartSeconds(undefined, now)).toBe(seconds(now - 7 * DAY));
  });

  it("just inside and just outside the limit", () => {
    const inside = new Date(now - 7 * DAY + 1000);
    const outside = new Date(now - 7 * DAY - 1000);
    expect(lookBackStartSeconds(inside, now)).toBe(seconds(inside.getTime()));
    expect(lookBackStartSeconds(outside, now)).toBe(seconds(now - 7 * DAY));
  });

  it("a date that is not a date counts as never looked", () => {
    expect(lookBackStartSeconds(new Date(Number.NaN), now)).toBe(seconds(now - 7 * DAY));
  });

  it("the watcher's query is built from this rule and from nothing else", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, "gmailWorker.ts"), "utf8");
    expect(source).toMatch(/after:\$\{lookBackStartSeconds\(connection\.lastPolledAt, Date\.now\(\)\)\}/);
    // The old way (straight from the last poll, however long ago) is gone.
    expect(source).not.toMatch(/lastPolledAt\.getTime\(\)/);
    expect(source.match(/after:/g)?.length).toBe(1);
  });
});
