/**
 * Shared helpers for the sign-in tests.
 *
 * The tests talk to the real Express app over HTTP on 127.0.0.1. They need
 * no database and no outside service: the database address points at a
 * closed local port, the AI address too, and any call that would leave this
 * computer is caught and recorded instead of being made.
 *
 * Every value below is made up for the tests. None is a real secret.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

export const TEST_PASSWORD = "made-up test password 1";
export const TEST_SECRET = "made-up-test-session-secret-0123456789";

/** Put the made-up settings in place. Call before the app is imported. */
export function applyTestEnv(): void {
  process.env.LOG_LEVEL = "silent";
  process.env.DATABASE_URL = "postgresql://nobody:nothing@127.0.0.1:9/none";
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "http://127.0.0.1:9/no-ai";
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "made-up-not-a-key";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "made-up-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "made-up-client-secret";
  delete process.env.GOOGLE_OAUTH_REDIRECT_URL;
  process.env.APP_PASSWORD = TEST_PASSWORD;
  process.env.SESSION_SECRET = TEST_SECRET;
}

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  /** The parsed JSON body, or null when the body is not JSON. */
  json: Record<string, unknown> | null;
  /** Every Set-Cookie line of the reply. */
  setCookies: string[];
}

export interface CallOptions {
  headers?: Record<string, string>;
  /** Sent as JSON when it is an object, as is when it is a string. */
  body?: unknown;
  /** The Cookie header to send (for example "panelbid_session=..."). */
  cookie?: string;
}

export interface Running {
  app: Express;
  port: number;
  /** "127.0.0.1:<port>": what a browser on the same site would send as Host. */
  host: string;
  origin: string;
  call(method: string, path: string, options?: CallOptions): Promise<Reply>;
  /** Addresses outside this computer that the app tried to call. */
  outsideCalls: string[];
  close(): Promise<void>;
}

export interface StartOptions {
  /**
   * A throwaway PostgreSQL on this computer, for the few tests that need a
   * real database (see test/realDatabase.ts). Left out: the closed port.
   */
  databaseUrl?: string;
  /** Where the app keeps its working copies of plan files. */
  uploadDir?: string;
}

/**
 * Start the app on a free local port.
 *
 * A raw http request is used on purpose (not fetch): it sends exactly the
 * headers the test names, nothing more, and never follows a redirect.
 */
export async function startApp(options: StartOptions = {}): Promise<Running> {
  applyTestEnv();
  if (options.databaseUrl) process.env.DATABASE_URL = options.databaseUrl;
  if (options.uploadDir) process.env.UPLOAD_DIR = options.uploadDir;
  const { default: app } = await import("../app");

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const host = `127.0.0.1:${port}`;

  // Nothing may leave this computer during a test. A call to anywhere else
  // is written down and answered with a refusal that looks like Google's.
  const outsideCalls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (url.startsWith(`http://${host}/`)) return realFetch(url, init);
    outsideCalls.push(url);
    return new Response(JSON.stringify({ error: "blocked_in_tests" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  function call(
    method: string,
    path: string,
    options: CallOptions = {},
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      let payload: string | undefined;
      if (options.body !== undefined) {
        if (typeof options.body === "string") {
          payload = options.body;
        } else {
          payload = JSON.stringify(options.body);
          headers["content-type"] ??= "application/json";
        }
        headers["content-length"] = String(Buffer.byteLength(payload));
      }
      if (options.cookie) headers["cookie"] = options.cookie;

      const req = http.request(
        { host: "127.0.0.1", port, method, path, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: Record<string, unknown> | null = null;
            try {
              const parsed: unknown = JSON.parse(text);
              if (parsed && typeof parsed === "object") {
                json = parsed as Record<string, unknown>;
              }
            } catch {
              json = null;
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text,
              json,
              setCookies: res.headers["set-cookie"] ?? [],
            });
          });
        },
      );
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  return {
    app,
    port,
    host,
    origin: `http://${host}`,
    call,
    outsideCalls,
    close: () =>
      new Promise<void>((resolve) => {
        globalThis.fetch = realFetch;
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** "name=value" of the named cookie from a reply's Set-Cookie lines. */
export function cookieFrom(reply: Reply, name: string): string | null {
  for (const line of reply.setCookies) {
    const first = line.split(";")[0] ?? "";
    if (first.startsWith(`${name}=`) && first.length > name.length + 1) {
      return first;
    }
  }
  return null;
}

/** Sign in with the test password; returns the Cookie header to send. */
export async function signIn(running: Running): Promise<string> {
  const reply = await running.call("POST", "/api/auth/sign-in", {
    body: { password: TEST_PASSWORD },
    headers: { origin: running.origin },
  });
  const cookie = cookieFrom(reply, "panelbid_session");
  if (reply.status !== 200 || !cookie) {
    throw new Error(
      `sign-in did not work in the test (HTTP ${reply.status}, cookie ${cookie ? "set" : "missing"})`,
    );
  }
  return cookie;
}

// ---------------------------------------------------------------------------
// Walking the router
// ---------------------------------------------------------------------------

export interface FoundRoute {
  method: string;
  /** The path under /api as written in the code, e.g. "/jobs/:jobId". */
  path: string;
  /** The same path with every :name replaced, ready to request. */
  url: string;
}

interface LayerLike {
  name?: string;
  slash?: boolean;
  matchers?: Array<(path: string) => unknown>;
  route?: { path: unknown; methods: Record<string, boolean> };
  handle?: { stack?: LayerLike[]; name?: string };
}

const EVERY_METHOD = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function walkStack(stack: LayerLike[], found: Map<string, FoundRoute>): void {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path)
        ? layer.route.path
        : [layer.route.path];
      const methods = layer.route.methods._all
        ? EVERY_METHOD
        : Object.keys(layer.route.methods).map((m) => m.toUpperCase());
      for (const path of paths) {
        if (typeof path !== "string" || /[*(){}\[\]?+]/.test(path)) {
          throw new Error(
            `The router walk cannot read the route path ${String(path)}. ` +
              "Teach walkStack() about it, so the route is tested like the others.",
          );
        }
        for (const method of methods) {
          const url = "/api" + path.replace(/:[A-Za-z0-9_]+/g, "1");
          found.set(`${method} ${path}`, { method, path, url });
        }
      }
      continue;
    }
    const inner = layer.handle?.stack;
    if (Array.isArray(inner)) {
      if (!layer.slash) {
        throw new Error(
          "A router is mounted under its own path inside /api. The router walk " +
            "cannot see that path: teach walkStack() about it, so its routes are tested.",
        );
      }
      walkStack(inner, found);
    }
    // A plain middleware function answers nothing by name: nothing to list.
  }
}

/**
 * Every route the app can answer, found by walking Express's own tables
 * (not a hand-kept list): a route added later shows up here by itself.
 */
export function findEveryRoute(app: Express): {
  routes: FoundRoute[];
  topLevelNames: string[];
} {
  const top = (app as unknown as { router: { stack: LayerLike[] } }).router
    .stack;
  const found = new Map<string, FoundRoute>();
  const topLevelNames: string[] = [];
  for (const layer of top) {
    if (layer.route) {
      throw new Error(
        `A route (${String(layer.route.path)}) is registered on the app itself, outside /api. ` +
          "Put it under /api, behind the sign-in.",
      );
    }
    const inner = layer.handle?.stack;
    if (Array.isArray(inner)) {
      const matcher = layer.matchers?.[0];
      const underApi =
        typeof matcher === "function" &&
        Boolean(matcher("/api/x")) &&
        !matcher("/x");
      if (!underApi) {
        throw new Error(
          "A router is mounted somewhere other than /api. Only /api is behind the sign-in.",
        );
      }
      topLevelNames.push("router:/api");
      walkStack(inner, found);
    } else {
      // The request logger (pino-http) is a function called "result" that
      // carries its logger; give it a name that says what it is.
      const handle = layer.handle as { logger?: unknown } | undefined;
      const isRequestLogger =
        layer.name === "result" && typeof handle?.logger === "object";
      topLevelNames.push(
        isRequestLogger ? "requestLogger" : (layer.name ?? "<anonymous>"),
      );
    }
  }
  return { routes: [...found.values()], topLevelNames };
}
