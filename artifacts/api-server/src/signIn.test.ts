/**
 * Signing in, staying signed in, signing out, the slow-down on wrong
 * passwords and the limit on the two AI buttons, all over HTTP against the
 * real app. No database and no outside service (see test/harness.ts).
 *
 * Time is moved by faking the clock (the Date only), never by waiting.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  TEST_PASSWORD,
  TEST_SECRET,
  applyTestEnv,
  cookieFrom,
  signIn,
  startApp,
  type Reply,
  type Running,
} from "./test/harness";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let running: Running;
let gate: typeof import("./middlewares/apiGate");
const startingNodeEnv = process.env.NODE_ENV;

beforeAll(async () => {
  running = await startApp();
  gate = await import("./middlewares/apiGate");
});

afterAll(async () => {
  await running.close();
});

beforeEach(() => {
  applyTestEnv();
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  gate.signInThrottle.reset();
  gate.aiPressLimiter.reset();
});

afterEach(() => {
  vi.useRealTimers();
  process.env.NODE_ENV = startingNodeEnv;
});

/** Move the clock forward. */
function later(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

function tryPassword(
  password: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return running.call("POST", "/api/auth/sign-in", {
    body: { password },
    headers: { origin: running.origin, ...headers },
  });
}

const SESSION = "panelbid_session";

describe("signing in", () => {
  it("refuses a wrong password and hands out no cookie", async () => {
    const reply = await tryPassword("not the password");
    expect(reply.status).toBe(401);
    expect(reply.json?.code).toBe("wrong_password");
    expect(reply.setCookies).toEqual([]);
  });

  it("accepts the right password and sets a signed, http-only, same-site cookie", async () => {
    const reply = await tryPassword(TEST_PASSWORD);
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ signedIn: true });
    expect(reply.setCookies).toHaveLength(1);
    const line = reply.setCookies[0]!;
    expect(line).toMatch(/^panelbid_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/);
    expect(line).toMatch(/; HttpOnly/i);
    expect(line).toMatch(/; SameSite=Lax/i);
    expect(line).toMatch(/; Path=\/(;|$)/i);
    expect(line).toMatch(/; Max-Age=604800(;|$)/i);
    expect(line).not.toMatch(/Domain=/i);
  });

  it("marks the cookie https-only behind an https proxy and always in production", async () => {
    const plain = await tryPassword(TEST_PASSWORD);
    expect(plain.setCookies[0]).not.toMatch(/; Secure/i);

    const behindProxy = await tryPassword(TEST_PASSWORD, {
      origin: `https://${running.host}`,
      "x-forwarded-proto": "https",
      "x-forwarded-host": running.host,
    });
    expect(behindProxy.setCookies[0]).toMatch(/; Secure/i);

    process.env.NODE_ENV = "production";
    const production = await tryPassword(TEST_PASSWORD);
    expect(production.setCookies[0]).toMatch(/; Secure/i);
  });

  it("never sends the password back, right or wrong", async () => {
    const wrong = await tryPassword("a-wrong-guess-123");
    const right = await tryPassword(TEST_PASSWORD);
    for (const reply of [wrong, right]) {
      const everything = reply.text + JSON.stringify(reply.headers);
      expect(everything).not.toContain(TEST_PASSWORD);
      expect(everything).not.toContain("a-wrong-guess-123");
      expect(everything).not.toContain(TEST_SECRET);
    }
    // The cookie carries three times and a signature, nothing else.
    const value = cookieFrom(right, SESSION)!.split("=")[1]!;
    const payload = JSON.parse(
      Buffer.from(value.split(".")[0]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["e", "i", "s", "v"]);
  });

  it("ignores spaces typed around the password", async () => {
    const reply = await tryPassword(`  ${TEST_PASSWORD} `);
    expect(reply.status).toBe(200);
  });

  it("answers plainly when no password arrives, and does not count it as a guess", async () => {
    const bodies: unknown[] = [
      {},
      { password: "" },
      { password: "    " },
      { password: 12345 },
      { password: null },
      { password: ["a"] },
      "{ this is not json",
      JSON.stringify({ password: "x".repeat(5000) }),
    ];
    for (let round = 0; round < 3; round++) {
      for (const body of bodies) {
        const reply = await running.call("POST", "/api/auth/sign-in", {
          body,
          headers: { origin: running.origin, "content-type": "application/json" },
        });
        expect(reply.status, JSON.stringify(body).slice(0, 40)).toBe(400);
        expect(reply.json?.code).toBe("bad_request");
        expect(reply.setCookies).toEqual([]);
        expect(reply.text).not.toContain("not json");
      }
    }
    expect((await tryPassword(TEST_PASSWORD)).status).toBe(200);
  });

  it("only answers POST", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const reply = await running.call(method, "/api/auth/sign-in", {
        headers: { origin: running.origin },
      });
      expect(reply.status).toBe(401);
      expect(reply.setCookies).toEqual([]);
    }
  });
});

describe("staying signed in", () => {
  const whoAmI = (cookie: string) =>
    running.call("GET", "/api/auth/session", { cookie });

  it("the cookie works straight away and is not rewritten on every request", async () => {
    const cookie = await signIn(running);
    const reply = await whoAmI(cookie);
    expect(reply.status).toBe(200);
    expect(reply.setCookies).toEqual([]);
  });

  it("ends 7 days after it was last used", async () => {
    const cookie = await signIn(running);
    later(7 * DAY - MINUTE);
    expect((await whoAmI(cookie)).status).toBe(200);
    later(2 * MINUTE);
    const reply = await whoAmI(cookie);
    expect(reply.status).toBe(401);
    expect(reply.json?.code).toBe("sign_in_required");
  });

  it("stays alive while it is used, but never beyond 30 days", async () => {
    let cookie = await signIn(running);
    const first = cookie;
    for (let day = 1; day <= 29; day++) {
      later(DAY);
      const reply = await whoAmI(cookie);
      expect(reply.status, `day ${day}`).toBe(200);
      const renewed = cookieFrom(reply, SESSION);
      expect(renewed, `a fresh cookie on day ${day}`).not.toBeNull();
      cookie = renewed!;
    }
    // The very first cookie died after a week of its own.
    expect((await whoAmI(first)).status).toBe(401);
    // 30 days after the password was typed it is over, used or not.
    later(DAY + MINUTE);
    expect((await whoAmI(cookie)).status).toBe(401);
  });

  it("signs everyone out when the password is changed", async () => {
    const cookie = await signIn(running);
    process.env.APP_PASSWORD = "a brand new password 2";
    expect((await whoAmI(cookie)).status).toBe(401);
    expect((await tryPassword(TEST_PASSWORD)).status).toBe(401);
    const again = await tryPassword("a brand new password 2");
    expect(again.status).toBe(200);
    expect((await whoAmI(cookieFrom(again, SESSION)!)).status).toBe(200);
  });

  it("signs everyone out when the session secret is changed", async () => {
    const cookie = await signIn(running);
    process.env.SESSION_SECRET = "another-made-up-secret-9876543210";
    expect((await whoAmI(cookie)).status).toBe(401);
  });

  it("sign-out removes the cookie from the browser", async () => {
    const cookie = await signIn(running);
    const reply = await running.call("POST", "/api/auth/sign-out", {
      cookie,
      headers: { origin: running.origin },
    });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ signedIn: false });
    const cleared = reply.setCookies.find((c) => c.startsWith(`${SESSION}=;`));
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    // The browser now sends no cookie.
    expect((await running.call("GET", "/api/auth/session")).status).toBe(401);
  });

  it("clears a cookie that is no longer good", async () => {
    const reply = await whoAmI(`${SESSION}=left-over-from-before`);
    expect(reply.status).toBe(401);
    expect(reply.setCookies.some((c) => c.startsWith(`${SESSION}=;`))).toBe(true);
  });
});

describe("slowing down guesses", () => {
  const A = { "x-forwarded-for": "203.0.113.5" };
  const B = { "x-forwarded-for": "203.0.113.6" };

  async function wrong(headers: Record<string, string>): Promise<Reply> {
    return tryPassword("a wrong guess 000", headers);
  }

  it("lets a person mistype a few times with no wait", async () => {
    for (let i = 0; i < 4; i++) {
      const reply = await wrong(A);
      expect(reply.status).toBe(401);
      expect(reply.json?.retryAfterSeconds).toBeUndefined();
    }
    expect((await tryPassword(TEST_PASSWORD, A)).status).toBe(200);
  });

  it("makes an address wait after five wrong passwords, and does not even check during the wait", async () => {
    for (let i = 0; i < 4; i++) await wrong(A);
    const fifth = await wrong(A);
    expect(fifth.status).toBe(401);
    expect(fifth.json?.retryAfterSeconds).toBe(30);
    expect(fifth.headers["retry-after"]).toBe("30");

    // The RIGHT password is refused too: nothing is checked while waiting,
    // so a guess made during the wait tells the guesser nothing.
    const during = await tryPassword(TEST_PASSWORD, A);
    expect(during.status).toBe(429);
    expect(during.json?.code).toBe("too_many_attempts");
    expect(during.headers["retry-after"]).toBe("30");
    expect(during.setCookies).toEqual([]);

    later(29 * SECOND);
    expect((await tryPassword(TEST_PASSWORD, A)).status).toBe(429);
    later(2 * SECOND);
    expect((await tryPassword(TEST_PASSWORD, A)).status).toBe(200);
  });

  it("the right password clears the count", async () => {
    for (let i = 0; i < 5; i++) await wrong(A);
    later(31 * SECOND);
    expect((await tryPassword(TEST_PASSWORD, A)).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect((await wrong(A)).json?.retryAfterSeconds).toBeUndefined();
    }
  });

  it("makes the wait grow: 30 s, 1, 2, 4, 8 minutes, then 15 minutes at most", async () => {
    for (let i = 0; i < 4; i++) await wrong(A);
    const waits: unknown[] = [];
    for (let i = 0; i < 8; i++) {
      const reply = await wrong(A);
      expect(reply.status).toBe(401);
      const wait = reply.json?.retryAfterSeconds as number;
      waits.push(wait);
      later(wait * SECOND + SECOND);
    }
    expect(waits).toEqual([30, 60, 120, 240, 480, 900, 900, 900]);
  });

  it("does not make the wait longer when someone keeps trying during it", async () => {
    for (let i = 0; i < 5; i++) await wrong(A);
    for (let i = 0; i < 20; i++) {
      expect((await wrong(A)).status).toBe(429);
    }
    later(31 * SECOND);
    expect((await tryPassword(TEST_PASSWORD, A)).status).toBe(200);
  });

  it("does not lock out a person at another address", async () => {
    for (let i = 0; i < 6; i++) await wrong(A);
    expect((await tryPassword(TEST_PASSWORD, A)).status).toBe(429);
    expect((await tryPassword(TEST_PASSWORD, B)).status).toBe(200);
  });

  it("does not disturb people who are already signed in", async () => {
    const cookie = await signIn(running);
    for (let i = 0; i < 6; i++) await wrong({});
    expect((await tryPassword(TEST_PASSWORD)).status).toBe(429);
    expect((await running.call("GET", "/api/auth/session", { cookie })).status).toBe(200);
  });

  it("forgets an address an hour after its last wrong password", async () => {
    for (let i = 0; i < 4; i++) await wrong(A);
    later(HOUR + SECOND);
    for (let i = 0; i < 4; i++) {
      expect((await wrong(A)).json?.retryAfterSeconds).toBeUndefined();
    }
  });

  it("does not take a made-up address at its word", async () => {
    // Not an address at all: counted against the real connection instead.
    for (let i = 0; i < 5; i++) {
      await wrong({ "x-forwarded-for": `not-an-address-${i}` });
    }
    expect((await tryPassword(TEST_PASSWORD)).status).toBe(429);
  });

  it("caps guessing from everywhere together, so faking addresses does not help", async () => {
    // 30 wrong passwords, each claiming a new address: none of them is
    // locked on its own, but the shared budget is now used up.
    for (let i = 0; i < 30; i++) {
      const reply = await wrong({ "x-forwarded-for": `198.51.100.${i + 1}` });
      expect(reply.status, `guess ${i + 1}`).toBe(401);
    }
    const fresh = { "x-forwarded-for": "198.51.100.200" };
    const blocked = await tryPassword(TEST_PASSWORD, fresh);
    expect(blocked.status).toBe(429);
    expect(blocked.json?.code).toBe("too_many_attempts");
    expect(Number(blocked.headers["retry-after"])).toBeLessThanOrEqual(20);

    // It opens again by itself, one try per 20 seconds.
    later(21 * SECOND);
    expect((await wrong(fresh)).status).toBe(401);
    expect((await tryPassword(TEST_PASSWORD, fresh)).status).toBe(429);
    later(21 * SECOND);
    expect((await tryPassword(TEST_PASSWORD, fresh)).status).toBe(200);
  });
});

describe("the two AI buttons", () => {
  const specs = (cookie?: string, job = 1) =>
    running.call("POST", `/api/jobs/${job}/extract-specs`, {
      cookie,
      headers: { origin: running.origin },
    });
  const prices = (cookie?: string) =>
    running.call("POST", "/api/files/1/extract-prices", {
      cookie,
      headers: { origin: running.origin },
    });

  it("allow three presses a minute between them, then ask to wait", async () => {
    const cookie = await signIn(running);
    // With no database in the tests the route itself fails further in
    // (500): reaching it at all is what counts as "the press was allowed".
    expect((await specs(cookie)).status).toBe(500);
    expect((await prices(cookie)).status).toBe(500);
    expect((await specs(cookie, 2)).status).toBe(500);

    for (const press of [specs, prices]) {
      const refused = await press(cookie);
      expect(refused.status).toBe(429);
      expect(refused.json?.code).toBe("ai_limit");
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(60);
    }

    later(61 * SECOND);
    expect((await specs(cookie)).status).toBe(500);
  });

  it("match the address however it is spelled", async () => {
    const cookie = await signIn(running);
    for (let i = 0; i < 3; i++) await specs(cookie);
    for (const path of [
      "/api/jobs/1/extract-specs/",
      "/api/JOBS/1/Extract-Specs",
      "/api/files/7/extract-prices/",
    ]) {
      const reply = await running.call("POST", path, {
        cookie,
        headers: { origin: running.origin },
      });
      expect(reply.status, path).toBe(429);
    }
  });

  it("allow twenty presses an hour", async () => {
    const cookie = await signIn(running);
    for (let i = 0; i < 20; i++) {
      expect((await specs(cookie)).status, `press ${i + 1}`).toBe(500);
      later(21 * SECOND);
    }
    const refused = await specs(cookie);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(60);
    later(HOUR);
    expect((await specs(cookie)).status).toBe(500);
  });

  it("do not count a press by someone who is not signed in", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await specs()).status).toBe(401);
    }
    const cookie = await signIn(running);
    expect((await specs(cookie)).status).toBe(500);
  });
});
