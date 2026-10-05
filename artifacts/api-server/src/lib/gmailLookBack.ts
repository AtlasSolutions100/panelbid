/**
 * How far back the inbox watcher looks.
 *
 * It asks Gmail for messages "after" the last time it looked. When it has
 * not looked for a long while (the connection needed a reconnect for
 * weeks), that would sweep the whole gap in one go and pull every PDF in
 * it into the database. So it never looks back more than 7 days: the later
 * of "the last time it looked" and "7 days ago". With no last time at all
 * it is 7 days, as before.
 */
export const MAX_LOOK_BACK_MS = 7 * 24 * 60 * 60 * 1000;

/** The moment to look back to, in whole seconds (Gmail's `after:`). */
export function lookBackStartSeconds(
  lastPolledAt: Date | null | undefined,
  nowMs: number,
): number {
  const sevenDaysAgo = nowMs - MAX_LOOK_BACK_MS;
  const last = lastPolledAt ? lastPolledAt.getTime() : Number.NaN;
  const from = Number.isFinite(last) ? Math.max(last, sevenDaysAgo) : sevenDaysAgo;
  return Math.floor(from / 1000);
}
