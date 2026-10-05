/**
 * Nothing answers without a sign-in.
 *
 * These tests look at the app from the outside, over HTTP. They read the
 * list of routes from Express itself, so a route added later is tested
 * without anyone remembering to add it here. A new route that answers
 * without a session makes this file fail.
 *
 * No database and no outside service is used (see test/harness.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_PASSWORD,
  TEST_SECRET,
  applyTestEnv,
  cookieFrom,
  findEveryRoute,
  signIn,
  startApp,
  type FoundRoute,
  type Running,
} from "./test/harness";

/**
 * The only requests that may be answered with no session. Changing this
 * list is a decision about who can reach the client's data: think first.
 */
const OPEN = {
  healthCheck: "GET /healthz",
  signInCall: "POST /auth/sign-in",
  // Not open: without a session it only sends the browser away. Listed
  // because its refusal is a redirect, not the usual 401 (see below).
  googleCallback: "GET /gmail/oauth/callback",
};

let running: Running;
let routes: FoundRoute[];
let topLevelNames: string[];

beforeAll(async () => {
  running = await startApp();
  ({ routes, topLevelNames } = findEveryRoute(running.app));
});

afterAll(async () => {
  await running.close();
});

beforeEach(() => {
  applyTestEnv();
  running.outsideCalls.length = 0;
});

describe("walking the router", () => {
  it("finds the routes the app is known to have", () => {
    const names = routes.map((r) => `${r.method} ${r.path}`);
    // If the walk silently found nothing, every test below would pass
    // while testing nothing. These routes exist today.
    for (const known of [
      "GET /healthz",
      "GET /jobs",
      "POST /jobs",
      "DELETE /jobs/:jobId",
      "POST /jobs/:jobId/files",
      "GET /files/:fileId/download",
      "GET /files/:fileId/view",
      "GET /jobs/:jobId/proposal",
      "PUT /jobs/:jobId/takeoff",
      "GET /contractor-sources",
      "GET /gmail/status",
      "GET /gmail/activity",
      "POST /gmail/disconnect",
      "GET /gmail/oauth/callback",
      "POST /jobs/:jobId/extract-specs",
      "POST /files/:fileId/extract-prices",
    ]) {
      expect(names, `the walk should find ${known}`).toContain(known);
    }
    expect(routes.length).toBeGreaterThanOrEqual(47);
  });

  it("has one door: everything that can answer sits under /api", () => {
    // Anything registered on the app itself that is not on this list could
    // answer a visitor before the sign-in is checked.
    const harmless = new Set(["requestLogger", "cookieParser"]);
    const unknown = topLevelNames.filter(
      (name) => name !== "router:/api" && !harmless.has(name),
    );
    expect(
      unknown,
      "new middleware on the app itself: show it cannot answer without a session, then list it here",
    ).toEqual([]);
    expect(topLevelNames.filter((n) => n === "router:/api")).toHaveLength(1);
  });

  it("no longer lets any website call it (no CORS middleware)", () => {
    expect(topLevelNames).not.toContain("corsMiddleware");
  });
});

describe("every route refuses a visitor with no session", () => {
  it("answers 401 on every route except the short open list", async () => {
    const answered: string[] = [];
    for (const route of routes) {
      const name = `${route.method} ${route.path}`;
      if (Object.values(OPEN).includes(name)) continue;
      const reply = await running.call(route.method, route.url);
      if (reply.status !== 401 || reply.json?.code !== "sign_in_required") {
        answered.push(`${name} -> HTTP ${reply.status}`);
      }
    }
    expect(answered, "these routes answered a visitor with no session").toEqual(
      [],
    );
  });

  it("answers 401 with a made-up or damaged session cookie", async () => {
    const real = await signIn(running);
    // One character of the signature changed.
    const last = real.slice(-1);
    const damaged = real.slice(0, -1) + (last === "A" ? "B" : "A");
    const cookies = [
      "panelbid_session=anything",
      "panelbid_session=eyJ2IjoxfQ.c2ln",
      damaged,
      // The right cookie value under the wrong name.
      real.replace("panelbid_session=", "session="),
    ];
    const answered: string[] = [];
    for (const cookie of cookies) {
      for (const route of routes) {
        const name = `${route.method} ${route.path}`;
        if (Object.values(OPEN).includes(name)) continue;
        const reply = await running.call(route.method, route.url, { cookie });
        if (reply.status !== 401) {
          answered.push(`${name} with ${cookie.slice(0, 24)}... -> ${reply.status}`);
        }
      }
    }
    expect(answered).toEqual([]);
  });

  it("answers 401 on addresses and methods that are not routes at all", async () => {
    for (const [method, path] of [
      ["GET", "/api/no-such-thing"],
      ["GET", "/api"],
      ["GET", "/api/"],
      ["DELETE", "/api/healthz"],
      ["POST", "/api/healthz"],
      ["GET", "/api/healthz/"],
      ["GET", "/api/healthz/../jobs"],
      ["GET", "/api/HEALTHZ/../jobs"],
      ["GET", "/API/jobs"],
      ["GET", "/api/Jobs/"],
      ["GET", "/api//jobs"],
      ["GET", "/api/auth/sign-in"],
      ["OPTIONS", "/api/jobs"],
      ["HEAD", "/api/jobs"],
    ] as const) {
      const reply = await running.call(method, path);
      expect(reply.status, `${method} ${path}`).toBe(401);
    }
  });

  it("gives nothing away outside /api either", async () => {
    for (const path of ["/", "/jobs", "/uploads/1/plan.pdf", "//api/jobs"]) {
      const reply = await running.call("GET", path);
      expect(reply.status, `GET ${path}`).toBe(404);
    }
  });

  it("keeps the health check open, and only says ok", async () => {
    const reply = await running.call("GET", "/api/healthz");
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ status: "ok" });
  });

  it("lets a signed-in person through the same routes", async () => {
    const cookie = await signIn(running);
    const session = await running.call("GET", "/api/auth/session", { cookie });
    expect(session.status).toBe(200);
    expect(session.json).toEqual({ signedIn: true });
    // With no database in the tests a real route fails further in (500),
    // which still shows the sign-in let the request through.
    const jobs = await running.call("GET", "/api/jobs", { cookie });
    expect(jobs.status).not.toBe(401);
    expect(jobs.status).not.toBe(403);
  });
});

describe("a setting is missing: everything is refused", () => {
  const cases: Array<[string, () => void]> = [
    ["APP_PASSWORD is not set", () => delete process.env.APP_PASSWORD],
    ["APP_PASSWORD is empty", () => (process.env.APP_PASSWORD = "")],
    ["APP_PASSWORD is only spaces", () => (process.env.APP_PASSWORD = "      ")],
    ["APP_PASSWORD is too short to be a password", () => (process.env.APP_PASSWORD = "short")],
    ["SESSION_SECRET is not set", () => delete process.env.SESSION_SECRET],
    ["SESSION_SECRET is empty", () => (process.env.SESSION_SECRET = "")],
    ["SESSION_SECRET is too short to sign anything", () => (process.env.SESSION_SECRET = "abc")],
    [
      "both are missing",
      () => {
        delete process.env.APP_PASSWORD;
        delete process.env.SESSION_SECRET;
      },
    ],
  ];

  for (const [title, breakIt] of cases) {
    it(`refuses every route when ${title}`, async () => {
      // A session from before the setting went missing must not help.
      const cookie = await signIn(running);
      breakIt();

      const answered: string[] = [];
      for (const route of routes) {
        const name = `${route.method} ${route.path}`;
        if (name === OPEN.healthCheck) continue;
        for (const withCookie of [undefined, cookie]) {
          const reply = await running.call(route.method, route.url, {
            cookie: withCookie,
            body: name === OPEN.signInCall ? { password: TEST_PASSWORD } : undefined,
            headers: { origin: running.origin },
          });
          if (reply.status !== 503 || reply.json?.code !== "not_configured") {
            answered.push(`${name} -> HTTP ${reply.status}`);
          }
          if (cookieFrom(reply, "panelbid_session")) {
            answered.push(`${name} handed out a session`);
          }
        }
      }
      expect(answered, "these routes answered although the server is not set up").toEqual([]);

      const health = await running.call("GET", "/api/healthz");
      expect(health.status).toBe(200);
    });
  }

  it("says which setting is missing by NAME, never a value", async () => {
    process.env.APP_PASSWORD = "short";
    const reply = await running.call("GET", "/api/auth/session");
    expect(reply.status).toBe(503);
    expect(reply.json?.missing).toEqual(["APP_PASSWORD"]);
    expect(reply.text).not.toContain("short");
    expect(reply.text).not.toContain(TEST_SECRET);
  });

  it("works again once the settings are back", async () => {
    delete process.env.APP_PASSWORD;
    expect((await running.call("GET", "/api/jobs")).status).toBe(503);
    applyTestEnv();
    expect((await running.call("GET", "/api/jobs")).status).toBe(401);
  });
});

describe("requests from another website are refused", () => {
  it("refuses a state-changing request that comes from another site, even with a valid session", async () => {
    const cookie = await signIn(running);
    const elsewhere: Array<Record<string, string>> = [
      { origin: "https://evil.example" },
      { origin: `http://evil.example:${running.port}` },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: running.origin, "sec-fetch-site": "cross-site" },
      { referer: "https://evil.example/page" },
    ];
    for (const headers of elsewhere) {
      for (const [method, path] of [
        ["POST", "/api/jobs"],
        ["DELETE", "/api/jobs/1"],
        ["PATCH", "/api/jobs/1"],
        ["PUT", "/api/jobs/1/takeoff"],
        ["POST", "/api/gmail/disconnect"],
        ["POST", "/api/auth/sign-out"],
      ] as const) {
        const reply = await running.call(method, path, { cookie, headers, body: {} });
        expect(reply.status, `${method} ${path} with ${JSON.stringify(headers)}`).toBe(403);
        expect(reply.json?.code).toBe("cross_site");
      }
    }
  });

  it("refuses a sign-in sent from another site", async () => {
    const reply = await running.call("POST", "/api/auth/sign-in", {
      body: { password: TEST_PASSWORD },
      headers: { origin: "https://evil.example" },
    });
    expect(reply.status).toBe(403);
    expect(cookieFrom(reply, "panelbid_session")).toBeNull();
  });

  it("refuses another site starting the Gmail connection in a signed-in browser", async () => {
    const cookie = await signIn(running);
    const reply = await running.call("GET", "/api/gmail/connect", {
      cookie,
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(reply.status).toBe(403);
    expect(reply.headers.location).toBeUndefined();
  });

  it("lets the same site through", async () => {
    const cookie = await signIn(running);
    const fromHere: Array<Record<string, string>> = [
      { origin: running.origin },
      { origin: running.origin, "sec-fetch-site": "same-origin" },
      { referer: `${running.origin}/settings` },
      {},
    ];
    for (const headers of fromHere) {
      const reply = await running.call("POST", "/api/auth/sign-out", { cookie, headers });
      expect(reply.status, JSON.stringify(headers)).toBe(200);
    }
  });

  it("takes the browser's own word, even behind a proxy that hides the site's name", async () => {
    // The server only sees an inside name (here 127.0.0.1) and no
    // X-Forwarded-Host. A current browser still says "same-origin" itself.
    const cookie = await signIn(running);
    const current = await running.call("POST", "/api/auth/sign-out", {
      cookie,
      headers: { origin: "https://panelbid.example", "sec-fetch-site": "same-origin" },
    });
    expect(current.status).toBe(200);
    // And a browser's "cross-site" wins over an Origin that looks right.
    const crossSite = await running.call("POST", "/api/auth/sign-out", {
      cookie,
      headers: { origin: running.origin, "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    // A browser too old to say so is refused there rather than waved through.
    const old = await running.call("POST", "/api/auth/sign-out", {
      cookie,
      headers: { origin: "https://panelbid.example" },
    });
    expect(old.status).toBe(403);
  });

  it("trusts the address the proxy says the browser used (X-Forwarded-Host)", async () => {
    const cookie = await signIn(running);
    const reply = await running.call("POST", "/api/auth/sign-out", {
      cookie,
      headers: {
        origin: "https://panelbid.example",
        "x-forwarded-host": "panelbid.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(reply.status).toBe(200);
  });

  it("never tells a browser that another site may read the answer", async () => {
    const cookie = await signIn(running);
    const replies = [
      await running.call("GET", "/api/auth/session", {
        cookie,
        headers: { origin: "https://evil.example" },
      }),
      await running.call("OPTIONS", "/api/jobs", {
        headers: {
          origin: "https://evil.example",
          "access-control-request-method": "DELETE",
        },
      }),
      await running.call("GET", "/api/healthz", {
        headers: { origin: "https://evil.example" },
      }),
    ];
    for (const reply of replies) {
      expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
      expect(reply.headers["access-control-allow-credentials"]).toBeUndefined();
    }
  });
});

describe("the Google callback", () => {
  // Google sends the person's own browser back to this address. Whoever
  // arrives must be signed in here AND be the browser that started the
  // connection (one-time signed state plus its cookie).
  async function freshState(): Promise<{ state: string; nonceCookie: string }> {
    const { createStateWithNonce, OAUTH_NONCE_COOKIE } = await import(
      "./lib/gmailAuth"
    );
    const { state, nonce } = createStateWithNonce();
    return { state, nonceCookie: `${OAUTH_NONCE_COOKIE}=${nonce}` };
  }

  const callback = (state: string) =>
    `/api/gmail/oauth/callback?code=made-up-code&state=${encodeURIComponent(state)}`;

  it("with no session: sends the browser away and never talks to Google", async () => {
    const reply = await running.call("GET", "/api/gmail/oauth/callback?code=x&state=y");
    expect(reply.status).toBe(302);
    expect(reply.headers.location).toBe("/settings?gmail=error%3Asigned_out");
    expect(running.outsideCalls).toEqual([]);
  });

  it("with a real state but no session: still refused, the code is never used", async () => {
    const { state, nonceCookie } = await freshState();
    const reply = await running.call("GET", callback(state), {
      cookie: nonceCookie,
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(reply.status).toBe(302);
    expect(reply.headers.location).toBe("/settings?gmail=error%3Asigned_out");
    expect(running.outsideCalls).toEqual([]);
    // The one-time cookie is thrown away so the state cannot be tried again.
    expect(reply.setCookies.join("\n")).toMatch(/gmail_oauth_nonce=;/);
  });

  it("with a session but no state from this browser: refused, the code is never used", async () => {
    const session = await signIn(running);
    const { state } = await freshState();
    for (const cookie of [session, `${session}; gmail_oauth_nonce=someone-elses`]) {
      const reply = await running.call("GET", callback(state), { cookie });
      expect(reply.status).toBe(302);
      expect(reply.headers.location).toBe("/settings?gmail=error%3Ainvalid_state");
    }
    expect(running.outsideCalls).toEqual([]);
  });

  it("with a session and the state this browser started with: goes on to Google", async () => {
    const session = await signIn(running);
    const { state, nonceCookie } = await freshState();
    const reply = await running.call("GET", callback(state), {
      cookie: `${session}; ${nonceCookie}`,
      // Google's redirect arrives as a navigation from another site.
      headers: { "sec-fetch-site": "cross-site" },
    });
    // The test stands in for Google and refuses the made-up code, so the
    // app reports a failed exchange. What matters: only now was it tried.
    expect(running.outsideCalls).toEqual(["https://oauth2.googleapis.com/token"]);
    expect(reply.status).toBe(302);
    expect(reply.headers.location).toBe("/settings?gmail=error%3Aexchange_failed");
  });

  it("is refused like everything else when the server is not set up", async () => {
    const session = await signIn(running);
    const { state, nonceCookie } = await freshState();
    delete process.env.APP_PASSWORD;
    const reply = await running.call("GET", callback(state), {
      cookie: `${session}; ${nonceCookie}`,
    });
    expect(reply.status).toBe(503);
    expect(running.outsideCalls).toEqual([]);
  });
});
