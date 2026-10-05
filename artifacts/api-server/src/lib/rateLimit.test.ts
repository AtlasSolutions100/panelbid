/**
 * The two limits on their own, with a clock the test moves by hand.
 */
import { describe, expect, it } from "vitest";
import { PressLimiter, SignInThrottle } from "./rateLimit";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function clock(start = 1_000_000_000_000) {
  let t = start;
  return {
    now: () => t,
    forward(ms: number) {
      t += ms;
    },
    back(ms: number) {
      t -= ms;
    },
  };
}

describe("SignInThrottle, one address", () => {
  it("costs nothing for the first four wrong passwords", () => {
    const c = clock();
    const throttle = new SignInThrottle({ now: c.now });
    for (let i = 0; i < 4; i++) {
      expect(throttle.check("a")).toEqual({ ok: true });
      expect(throttle.recordFailure("a")).toEqual({ lockedForMs: 0 });
    }
    expect(throttle.check("a")).toEqual({ ok: true });
  });

  it("locks for 30 s on the fifth, then doubles up to 15 minutes", () => {
    const c = clock();
    const throttle = new SignInThrottle({ now: c.now, siteBurst: 1000 });
    for (let i = 0; i < 4; i++) throttle.recordFailure("a");
    const locks: number[] = [];
    for (let i = 0; i < 9; i++) {
      const { lockedForMs } = throttle.recordFailure("a");
      locks.push(lockedForMs / SECOND);
      expect(throttle.check("a")).toEqual({
        ok: false,
        retryAfterMs: lockedForMs,
        scope: "address",
      });
      c.forward(lockedForMs - 1);
      expect(throttle.check("a").ok).toBe(false);
      c.forward(1);
      expect(throttle.check("a").ok).toBe(true);
    }
    expect(locks).toEqual([30, 60, 120, 240, 480, 900, 900, 900, 900]);
  });

  it("clears on the right password", () => {
    const c = clock();
    const throttle = new SignInThrottle({ now: c.now });
    for (let i = 0; i < 5; i++) throttle.recordFailure("a");
    c.forward(30 * SECOND);
    throttle.recordSuccess("a");
    for (let i = 0; i < 4; i++) {
      expect(throttle.recordFailure("a")).toEqual({ lockedForMs: 0 });
    }
  });

  it("keeps addresses apart", () => {
    const c = clock();
    const throttle = new SignInThrottle({ now: c.now });
    for (let i = 0; i < 5; i++) throttle.recordFailure("a");
    expect(throttle.check("a").ok).toBe(false);
    expect(throttle.check("b").ok).toBe(true);
  });

  it("forgets a quiet address after an hour, but never in the middle of a lock", () => {
    const c = clock();
    const throttle = new SignInThrottle({
      now: c.now,
      maxLockMs: 3 * HOUR,
      siteBurst: 1000,
    });
    for (let i = 0; i < 4; i++) throttle.recordFailure("a");
    c.forward(HOUR);
    expect(throttle.recordFailure("a")).toEqual({ lockedForMs: 0 });

    // Twelve wrong in a row: a lock longer than the forgetting time.
    for (let i = 0; i < 11; i++) {
      const state = throttle.check("a");
      if (!state.ok) c.forward(state.retryAfterMs);
      throttle.recordFailure("a");
    }
    const locked = throttle.check("a");
    expect(locked.ok).toBe(false);
    c.forward(HOUR + MINUTE);
    expect(throttle.check("a").ok).toBe(false);
  });

  it("does not grow without bound however many addresses are tried", () => {
    const c = clock();
    const throttle = new SignInThrottle({
      now: c.now,
      maxAddresses: 100,
      siteBurst: 1_000_000,
    });
    for (let i = 0; i < 10_000; i++) throttle.recordFailure(`address-${i}`);
    const size = (throttle as unknown as { addresses: Map<string, unknown> })
      .addresses.size;
    expect(size).toBeLessThanOrEqual(100);
  });
});

describe("SignInThrottle, the whole site together", () => {
  it("allows a burst of 30 wrong passwords, then one more every 20 seconds", () => {
    const c = clock();
    const throttle = new SignInThrottle({ now: c.now });
    for (let i = 0; i < 30; i++) {
      expect(throttle.check(`a${i}`).ok).toBe(true);
      throttle.recordFailure(`a${i}`);
    }
    expect(throttle.check("someone-new")).toEqual({
      ok: false,
      retryAfterMs: 20 * SECOND,
      scope: "site",
    });
    c.forward(19 * SECOND);
    expect(throttle.check("someone-new").ok).toBe(false);
    c.forward(1 * SECOND);
    expect(throttle.check("someone-new").ok).toBe(true);
    throttle.recordFailure("someone-new");
    expect(throttle.check("another").ok).toBe(false);
  });

  it("caps a day of guessing at a few thousand, whatever addresses are claimed", () => {
    const c = clock();
    const throttle = new SignInThrottle({ now: c.now });
    let guesses = 0;
    for (let s = 0; s < 24 * 60 * 60; s++) {
      const address = `faked-${s}`;
      if (throttle.check(address).ok) {
        throttle.recordFailure(address);
        guesses++;
      }
      c.forward(SECOND);
    }
    expect(guesses).toBeLessThanOrEqual(30 + (24 * 60 * 60) / 20);
    expect(guesses).toBeGreaterThan(4000);
  });

  it("fills up again when it is quiet, and never above 30", () => {
    const c = clock();
    const throttle = new SignInThrottle({ now: c.now });
    for (let i = 0; i < 30; i++) throttle.recordFailure(`a${i}`);
    c.forward(24 * HOUR);
    let allowed = 0;
    for (let i = 0; i < 100; i++) {
      if (!throttle.check(`b${i}`).ok) break;
      throttle.recordFailure(`b${i}`);
      allowed++;
    }
    expect(allowed).toBe(30);
  });

  it("is not counted down by the right password", () => {
    const c = clock();
    const throttle = new SignInThrottle({ now: c.now });
    for (let i = 0; i < 29; i++) throttle.recordFailure(`a${i}`);
    for (let i = 0; i < 100; i++) {
      expect(throttle.check("office").ok).toBe(true);
      throttle.recordSuccess("office");
    }
  });

  it("is not thrown off by a clock that jumps back", () => {
    const c = clock();
    const throttle = new SignInThrottle({ now: c.now });
    for (let i = 0; i < 30; i++) throttle.recordFailure(`a${i}`);
    c.back(10 * MINUTE);
    expect(throttle.check("x").ok).toBe(false);
    c.forward(20 * SECOND);
    expect(throttle.check("x").ok).toBe(true);
  });

  it("starts afresh on reset()", () => {
    const c = clock();
    const throttle = new SignInThrottle({ now: c.now });
    for (let i = 0; i < 30; i++) throttle.recordFailure("a");
    expect(throttle.check("a").ok).toBe(false);
    expect(throttle.check("b").ok).toBe(false);
    throttle.reset();
    expect(throttle.check("a").ok).toBe(true);
    expect(throttle.check("b").ok).toBe(true);
  });
});

describe("PressLimiter", () => {
  it("allows the given number of presses in any one minute", () => {
    const c = clock();
    const limiter = new PressLimiter({ now: c.now, perMinute: 3, perHour: 20 });
    expect(limiter.tryPress()).toEqual({ ok: true });
    c.forward(10 * SECOND);
    expect(limiter.tryPress()).toEqual({ ok: true });
    c.forward(10 * SECOND);
    expect(limiter.tryPress()).toEqual({ ok: true });
    c.forward(10 * SECOND);
    // 30 s after the first press: wait for that one to be a minute old.
    expect(limiter.tryPress()).toEqual({ ok: false, retryAfterMs: 30 * SECOND });
    c.forward(30 * SECOND);
    expect(limiter.tryPress()).toEqual({ ok: true });
    expect(limiter.tryPress().ok).toBe(false);
  });

  it("does not count a refused press", () => {
    const c = clock();
    const limiter = new PressLimiter({ now: c.now, perMinute: 3, perHour: 20 });
    for (let i = 0; i < 3; i++) limiter.tryPress();
    for (let i = 0; i < 50; i++) expect(limiter.tryPress().ok).toBe(false);
    c.forward(MINUTE);
    expect(limiter.tryPress().ok).toBe(true);
  });

  it("allows the given number of presses in any one hour", () => {
    const c = clock();
    const limiter = new PressLimiter({ now: c.now, perMinute: 3, perHour: 20 });
    for (let i = 0; i < 20; i++) {
      expect(limiter.tryPress().ok, `press ${i + 1}`).toBe(true);
      c.forward(MINUTE);
    }
    // 20 minutes in: the first press leaves the hour 40 minutes from now.
    expect(limiter.tryPress()).toEqual({ ok: false, retryAfterMs: 40 * MINUTE });
    c.forward(40 * MINUTE);
    expect(limiter.tryPress().ok).toBe(true);
    expect(limiter.tryPress().ok).toBe(false);
  });

  it("starts afresh on reset()", () => {
    const c = clock();
    const limiter = new PressLimiter({ now: c.now, perMinute: 1, perHour: 1 });
    expect(limiter.tryPress().ok).toBe(true);
    expect(limiter.tryPress().ok).toBe(false);
    limiter.reset();
    expect(limiter.tryPress().ok).toBe(true);
  });
});
