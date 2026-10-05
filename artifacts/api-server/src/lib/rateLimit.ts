/**
 * Two small limits, kept in memory (no database, no extra package):
 *
 * - SignInThrottle slows down password guessing.
 * - PressLimiter caps how often the two AI buttons can be pressed.
 *
 * In memory means: a restart forgets the counts, and two copies of the
 * server each keep their own. Good enough for one small company's app; see
 * SIGNIN-SETUP.md for the next steps.
 */

type Clock = () => number;

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export interface SignInThrottleOptions {
  now?: Clock;
  /** Wrong passwords one address may type before it has to wait. */
  freeTries?: number;
  /** The first wait. It doubles with every further wrong password. */
  firstLockMs?: number;
  /** The longest wait. */
  maxLockMs?: number;
  /** A quiet address is forgotten this long after its last wrong password. */
  forgetAfterMs?: number;
  /** Most addresses remembered at once (so memory cannot be filled). */
  maxAddresses?: number;
  /** Wrong passwords allowed in a burst from everywhere together. */
  siteBurst?: number;
  /** After a burst, one more wrong password is allowed per this long. */
  siteRefillMs?: number;
}

export type ThrottleCheck =
  | { ok: true }
  | { ok: false; retryAfterMs: number; scope: "address" | "site" };

interface AddressState {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
}

/**
 * Slows down password guessing.
 *
 * Per address: the first few wrong passwords cost nothing. From then on
 * every wrong password locks that address out for a while: 30 seconds, then
 * 1 minute, 2, 4, 8, and at most 15 minutes. The right password clears it.
 * While locked, attempts are refused without being checked, so a guess made
 * during the wait tells the guesser nothing.
 *
 * For the whole site: the address a request claims to come from can be
 * faked, so there is also one shared budget of wrong passwords for
 * everybody (30 at once, then 3 a minute). When it is used up, sign-in
 * pauses for everyone for a few seconds at a time. This caps guessing at a
 * few thousand a day whatever the guesser does.
 */
export class SignInThrottle {
  private readonly now: Clock;
  private readonly freeTries: number;
  private readonly firstLockMs: number;
  private readonly maxLockMs: number;
  private readonly forgetAfterMs: number;
  private readonly maxAddresses: number;
  private readonly siteBurst: number;
  private readonly siteRefillMs: number;

  private addresses = new Map<string, AddressState>();
  private siteTokens: number;
  private siteStamp: number;

  constructor(options: SignInThrottleOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.freeTries = options.freeTries ?? 5;
    this.firstLockMs = options.firstLockMs ?? 30 * SECOND;
    this.maxLockMs = options.maxLockMs ?? 15 * MINUTE;
    this.forgetAfterMs = options.forgetAfterMs ?? 60 * MINUTE;
    this.maxAddresses = options.maxAddresses ?? 5000;
    this.siteBurst = options.siteBurst ?? 30;
    this.siteRefillMs = options.siteRefillMs ?? 20 * SECOND;
    this.siteTokens = this.siteBurst;
    this.siteStamp = this.now();
  }

  /** Forget everything (used by the tests). */
  reset(): void {
    this.addresses.clear();
    this.siteTokens = this.siteBurst;
    this.siteStamp = this.now();
  }

  private refillSite(now: number): void {
    // The clock going backwards must not hand out or take away budget.
    if (now < this.siteStamp) this.siteStamp = now;
    const gained = Math.floor((now - this.siteStamp) / this.siteRefillMs);
    if (gained > 0) {
      this.siteTokens = Math.min(this.siteBurst, this.siteTokens + gained);
      this.siteStamp += gained * this.siteRefillMs;
    }
    if (this.siteTokens >= this.siteBurst) this.siteStamp = now;
  }

  private stateOf(address: string, now: number): AddressState | undefined {
    const state = this.addresses.get(address);
    if (!state) return undefined;
    if (
      now >= state.lockedUntil &&
      now - state.lastFailureAt >= this.forgetAfterMs
    ) {
      this.addresses.delete(address);
      return undefined;
    }
    return state;
  }

  /** May this address try a password right now? Checks, changes nothing. */
  check(address: string): ThrottleCheck {
    const now = this.now();
    const state = this.stateOf(address, now);
    if (state && now < state.lockedUntil) {
      return {
        ok: false,
        retryAfterMs: state.lockedUntil - now,
        scope: "address",
      };
    }
    this.refillSite(now);
    if (this.siteTokens < 1) {
      return {
        ok: false,
        retryAfterMs: Math.max(1, this.siteStamp + this.siteRefillMs - now),
        scope: "site",
      };
    }
    return { ok: true };
  }

  /** Record a wrong password. Returns how long the address is now locked. */
  recordFailure(address: string): { lockedForMs: number } {
    const now = this.now();
    this.refillSite(now);
    this.siteTokens = Math.max(0, this.siteTokens - 1);

    let state = this.stateOf(address, now);
    if (!state) {
      this.makeRoom(now);
      state = { failures: 0, lockedUntil: 0, lastFailureAt: now };
      this.addresses.set(address, state);
    }
    state.failures += 1;
    state.lastFailureAt = now;

    let lockedForMs = 0;
    if (state.failures >= this.freeTries) {
      const doublings = Math.min(state.failures - this.freeTries, 30);
      lockedForMs = Math.min(this.maxLockMs, this.firstLockMs * 2 ** doublings);
      state.lockedUntil = now + lockedForMs;
    }
    return { lockedForMs };
  }

  /** The right password clears that address. */
  recordSuccess(address: string): void {
    this.addresses.delete(address);
  }

  /** Keep the table small: drop what has expired, then the oldest. */
  private makeRoom(now: number): void {
    if (this.addresses.size < this.maxAddresses) return;
    for (const [address, state] of this.addresses) {
      if (
        now >= state.lockedUntil &&
        now - state.lastFailureAt >= this.forgetAfterMs
      ) {
        this.addresses.delete(address);
      }
    }
    while (this.addresses.size >= this.maxAddresses) {
      const oldest = this.addresses.keys().next();
      if (oldest.done) break;
      this.addresses.delete(oldest.value);
    }
  }
}

export interface PressLimiterOptions {
  now?: Clock;
  perMinute: number;
  perHour: number;
}

export type PressResult = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * At most `perMinute` presses in any minute and `perHour` in any hour,
 * counted for the whole company together. A refused press is not counted.
 */
export class PressLimiter {
  private readonly now: Clock;
  readonly perMinute: number;
  readonly perHour: number;
  private presses: number[] = [];

  constructor(options: PressLimiterOptions) {
    this.now = options.now ?? (() => Date.now());
    this.perMinute = options.perMinute;
    this.perHour = options.perHour;
  }

  /** Forget everything (used by the tests). */
  reset(): void {
    this.presses = [];
  }

  tryPress(): PressResult {
    const now = this.now();
    const hour = 60 * MINUTE;
    // Keep the last hour only; ignore stamps from a clock that went back.
    this.presses = this.presses.filter((t) => t <= now && now - t < hour);

    if (this.presses.length >= this.perHour) {
      const oldest = this.presses[0]!;
      return { ok: false, retryAfterMs: Math.max(1, oldest + hour - now) };
    }
    const lastMinute = this.presses.filter((t) => now - t < MINUTE);
    if (lastMinute.length >= this.perMinute) {
      const oldest = lastMinute[0]!;
      return { ok: false, retryAfterMs: Math.max(1, oldest + MINUTE - now) };
    }
    this.presses.push(now);
    return { ok: true };
  }
}
