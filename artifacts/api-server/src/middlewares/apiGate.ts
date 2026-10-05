/**
 * The one door in front of every /api route.
 *
 * app.ts mounts this before anything else under /api, so a route added
 * later is behind it without anyone having to remember. In order:
 *
 *   1. The health check is let through (it only says "ok").
 *   2. Not set up (APP_PASSWORD or SESSION_SECRET missing): everything else
 *      is refused with 503. The app cannot run open by forgetting a setting.
 *   3. Same site only: a request that changes something must come from this
 *      site's own pages. No other website may call the API.
 *   4. POST /auth/sign-in: the only other thing a visitor may do.
 *   5. No valid session cookie: refused with 401.
 *   6. Signed in: /auth/session, /auth/sign-out, the limit on the two AI
 *      buttons, then on to the real routes.
 *
 * The open list is matched on the exact path, so nothing that merely looks
 * like an open address gets through. Rules that refuse (same site, the AI
 * limit) are attached the way Express attaches routes, so they match every
 * spelling of the address that the route itself would answer.
 */
import express, {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { isIP } from "node:net";
import {
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  issueSession,
  passwordMatches,
  readAuthSettings,
  readSession,
  shouldRenew,
  type AuthSettings,
} from "../lib/auth";
import { OAUTH_NONCE_COOKIE } from "../lib/gmailAuth";
import { PressLimiter, SignInThrottle } from "../lib/rateLimit";

type ReadySettings = Extract<AuthSettings, { ok: true }>;

/** Wrong-password slow-down. Exported so the tests can reset it. */
export const signInThrottle = new SignInThrottle();

/**
 * The two AI buttons (Extract Specs, read a price sheet) cost money on
 * every press: 3 presses a minute and 20 an hour, for the whole company.
 */
export const aiPressLimiter = new PressLimiter({ perMinute: 3, perHour: 20 });
const AI_ROUTES = [
  "/jobs/:jobId/extract-specs",
  "/files/:fileId/extract-prices",
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The first entry of a "a, b, c" proxy header. */
function firstOf(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first ? first : undefined;
}

function isHttps(req: Request): boolean {
  return (
    req.secure ||
    firstOf(header(req, "x-forwarded-proto"))?.toLowerCase() === "https"
  );
}

/**
 * The address a sign-in attempt is counted against: the browser's address
 * as the proxy in front reports it, else the connection's own address.
 * A guesser can fake this header, which is why SignInThrottle also keeps
 * one budget for the whole site.
 */
function clientAddress(req: Request): string {
  const forwarded = firstOf(header(req, "x-forwarded-for"));
  const candidate =
    forwarded && isIP(forwarded) ? forwarded : (req.socket.remoteAddress ?? "");
  const address = candidate.replace(/^::ffff:/i, "").toLowerCase();
  return address || "unknown";
}

function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

function inWords(totalSeconds: number): string {
  if (totalSeconds < 90) return `${totalSeconds} seconds`;
  return `${Math.ceil(totalSeconds / 60)} minutes`;
}

function refuse(
  res: Response,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  res
    .status(status)
    .set("Cache-Control", "no-store")
    .json({ code, message, ...extra });
}

function cookieSettings(req: Request) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Always "https only" in production, whatever the proxy says.
    secure: process.env.NODE_ENV === "production" || isHttps(req),
    path: "/",
  };
}

// The settings read for a request, handed from the "is it set up" step to
// the steps after it. Kept here, out of sight, and not on req or res.locals
// where a later log line or page template could pick the password up.
const settingsByRequest = new WeakMap<Request, ReadySettings>();

function settingsOf(req: Request): ReadySettings {
  const settings = settingsByRequest.get(req);
  if (!settings) throw new Error("apiGate: settings were not read for this request");
  return settings;
}

// ---------------------------------------------------------------------------
// Same site only
// ---------------------------------------------------------------------------

/** The host names this request was addressed to, as the browser saw them. */
function ownHosts(req: Request): Set<string> {
  const hosts = new Set<string>();
  for (const name of ["host", "x-forwarded-host"]) {
    const host = firstOf(header(req, name))?.toLowerCase();
    if (host) hosts.add(host);
  }
  return hosts;
}

/** Is this Origin / Referer value one of this site's own pages? */
function isOwnPage(req: Request, value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false; // includes the literal "null" some browsers send
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  // A plain-http page has no business calling the https site.
  if (url.protocol === "http:" && isHttps(req)) return false;
  return ownHosts(req).has(url.host.toLowerCase());
}

/**
 * Did this request come from one of this site's own pages?
 *
 * Browsers say so themselves, and a page on another site cannot fake it:
 *
 * - Sec-Fetch-Site, on every request from every current browser. It is the
 *   browser's own word, so when it is there nothing else is compared. That
 *   also keeps this working behind a proxy that hides the site's public
 *   name from the server.
 * - Older browsers send Origin on every request that changes something, or
 *   Referer; those are compared with the name this request was sent to.
 *
 * A request with none of the three is not from a browser page at all (a
 * script on the owner's own computer, a health checker), so there is nobody
 * to protect.
 */
function cameFromThisSite(req: Request, allowTypedAddress: boolean): boolean {
  const site = header(req, "sec-fetch-site")?.toLowerCase();
  if (site !== undefined) {
    return site === "same-origin" || (allowTypedAddress && site === "none");
  }
  const origin = header(req, "origin");
  if (origin !== undefined) return isOwnPage(req, origin);
  const referer = header(req, "referer");
  if (referer !== undefined) return isOwnPage(req, referer);
  return true;
}

function refuseOtherSites(allowTypedAddress: boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (cameFromThisSite(req, allowTypedAddress)) {
      next();
      return;
    }
    req.log.warn({ method: req.method }, "Refused a request from another site");
    refuse(
      res,
      403,
      "cross_site",
      "This request came from another website and was refused.",
    );
  };
}

const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const gate: IRouter = Router();

// 1. The health check: open, exact address only, and it only says "ok".
gate.use((req: Request, _res: Response, next: NextFunction): void => {
  const isHealthCheck =
    (req.method === "GET" || req.method === "HEAD") && req.path === "/healthz";
  if (isHealthCheck) {
    next("router"); // leave this gate and carry on with the real routes
    return;
  }
  next();
});

// From here on nothing may be kept by a cache that other people share, and
// a browser re-checks with the server (and so with this gate) every time.
gate.use((_req: Request, res: Response, next: NextFunction): void => {
  res.set("Cache-Control", "private, no-cache");
  res.set("X-Content-Type-Options", "nosniff");
  next();
});

// 2. Fail closed when a setting is missing.
gate.use((req: Request, res: Response, next: NextFunction): void => {
  const settings = readAuthSettings();
  if (!settings.ok) {
    refuse(
      res,
      503,
      "not_configured",
      "This site is not set up yet. Nobody can sign in until the owner finishes the set-up.",
      { missing: settings.missing },
    );
    return;
  }
  settingsByRequest.set(req, settings);
  next();
});

// 3. Same site only. Everything that changes something...
const refuseOtherSitesStrict = refuseOtherSites(false);
gate.use((req: Request, res: Response, next: NextFunction): void => {
  if (READ_ONLY.has(req.method)) {
    next();
    return;
  }
  refuseOtherSitesStrict(req, res, next);
});
// ...and the one plain link that does: starting the Gmail connection.
// (A person may also type or bookmark that address, hence "true".)
gate.get("/gmail/connect", refuseOtherSites(true));

// 4. The sign-in call.
gate.post(
  "/auth/sign-in",
  express.json({ limit: "2kb" }),
  (req: Request, res: Response): void => {
    const settings = settingsOf(req);
    const address = clientAddress(req);

    // Nothing between this check and recording the result waits for
    // anything, so many attempts sent at once are still counted one by one.
    const allowed = signInThrottle.check(address);
    if (!allowed.ok) {
      const wait = seconds(allowed.retryAfterMs);
      req.log.warn(
        { address, scope: allowed.scope, waitSeconds: wait },
        "Sign-in refused: too many wrong passwords",
      );
      res.set("Retry-After", String(wait));
      refuse(
        res,
        429,
        "too_many_attempts",
        allowed.scope === "address"
          ? `Too many wrong passwords. Wait ${inWords(wait)}, then try again.`
          : `Sign-in is paused for a moment after too many wrong passwords. Try again in ${inWords(wait)}.`,
        // "address": this address typed too many. "site": guessing from
        // many addresses used up the shared budget. The page words it.
        { retryAfterSeconds: wait, scope: allowed.scope },
      );
      return;
    }

    const body = req.body as { password?: unknown } | undefined;
    const given = typeof body?.password === "string" ? body.password.trim() : "";
    if (given === "") {
      refuse(res, 400, "bad_request", "Type the password.");
      return;
    }

    if (!passwordMatches(given, settings.password)) {
      const { lockedForMs } = signInThrottle.recordFailure(address);
      const wait = lockedForMs > 0 ? seconds(lockedForMs) : 0;
      req.log.warn(
        { address, waitSeconds: wait },
        "Sign-in refused: wrong password",
      );
      if (wait > 0) res.set("Retry-After", String(wait));
      refuse(
        res,
        401,
        "wrong_password",
        wait > 0
          ? `Wrong password. Wait ${inWords(wait)} before the next try.`
          : "Wrong password.",
        wait > 0 ? { retryAfterSeconds: wait } : {},
      );
      return;
    }

    signInThrottle.recordSuccess(address);
    const { token } = issueSession(settings.key, Date.now());
    res.cookie(SESSION_COOKIE, token, {
      ...cookieSettings(req),
      maxAge: SESSION_IDLE_MS,
    });
    req.log.info({ address }, "Signed in");
    res.set("Cache-Control", "no-store").json({ signedIn: true });
  },
  // A body that cannot be read (broken JSON, far too long) gets a plain
  // answer. Nothing from the body is logged or sent back.
  (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    const unreadableBody =
      typeof err === "object" && err !== null && "type" in err;
    if (!unreadableBody) {
      next(err);
      return;
    }
    refuse(res, 400, "bad_request", "Type the password.");
  },
);

// 5. Everything else needs a session.
gate.use((req: Request, res: Response, next: NextFunction): void => {
  const settings = settingsOf(req);
  const now = Date.now();
  const cookie: unknown = req.cookies?.[SESSION_COOKIE];
  const session = readSession(settings.key, cookie, now);

  if (!session) {
    if (cookie !== undefined) res.clearCookie(SESSION_COOKIE, cookieSettings(req));

    // Google sends the person's own browser back to this address after the
    // Gmail consent screen. If that browser is not signed in here, the
    // returned code is never used: throw away the one-time cookie and show
    // the app (which will ask for the password) instead of a bare error.
    if (req.method === "GET" && req.path === "/gmail/oauth/callback") {
      res.clearCookie(OAUTH_NONCE_COOKIE, { path: "/api/gmail/oauth" });
      res.set("Cache-Control", "no-store");
      res.redirect(`/settings?gmail=${encodeURIComponent("error:signed_out")}`);
      return;
    }

    refuse(res, 401, "sign_in_required", "Sign in first.");
    return;
  }

  // In use: keep the cookie fresh so nobody is signed out in mid-work.
  if (shouldRenew(session, now)) {
    const renewed = issueSession(settings.key, now, session.start);
    res.cookie(SESSION_COOKIE, renewed.token, {
      ...cookieSettings(req),
      maxAge: Math.max(0, renewed.session.exp - now),
    });
  }
  next();
});

// 6. Signed in.
gate.get("/auth/session", (_req: Request, res: Response): void => {
  res.set("Cache-Control", "no-store").json({ signedIn: true });
});

gate.post("/auth/sign-out", (req: Request, res: Response): void => {
  res.clearCookie(SESSION_COOKIE, cookieSettings(req));
  res.set("Cache-Control", "no-store").json({ signedIn: false });
});

gate.post(AI_ROUTES, (req: Request, res: Response, next: NextFunction): void => {
  const press = aiPressLimiter.tryPress();
  if (press.ok) {
    next();
    return;
  }
  const wait = seconds(press.retryAfterMs);
  req.log.warn({ waitSeconds: wait }, "AI button refused: pressed too often");
  res.set("Retry-After", String(wait));
  refuse(
    res,
    429,
    "ai_limit",
    `The AI buttons can be pressed ${aiPressLimiter.perMinute} times a minute and ` +
      `${aiPressLimiter.perHour} times an hour, because every press costs money. ` +
      `Try again in ${inWords(wait)}.`,
    { retryAfterSeconds: wait },
  );
});

export default gate;
