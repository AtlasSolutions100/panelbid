/**
 * The pieces of the sign-in on their own: reading the two settings, the
 * password comparison, and the signed session cookie.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  MIN_SECRET_LENGTH,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  SESSION_RENEW_AFTER_MS,
  issueSession,
  passwordMatches,
  readAuthSettings,
  readSession,
  shouldRenew,
} from "./auth";

const PASSWORD = "made-up test password 1";
const SECRET = "made-up-test-session-secret-0123456789";
const NOW = Date.UTC(2026, 9, 5, 18, 0, 0);
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function ready(env: Record<string, string | undefined>) {
  const settings = readAuthSettings(env as NodeJS.ProcessEnv);
  if (!settings.ok) throw new Error("settings should be complete here");
  return settings;
}

const KEY = ready({ APP_PASSWORD: PASSWORD, SESSION_SECRET: SECRET }).key;

/** Sign any payload with the real key, to try cookies the app never makes. */
function forge(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", KEY).update(body).digest("base64url");
  return `${body}.${signature}`;
}

describe("reading the settings", () => {
  it("is ready when both are set", () => {
    const settings = readAuthSettings({
      APP_PASSWORD: PASSWORD,
      SESSION_SECRET: SECRET,
    } as NodeJS.ProcessEnv);
    expect(settings.ok).toBe(true);
  });

  it("names what is missing, and only names", () => {
    const cases: Array<[Record<string, string | undefined>, string[]]> = [
      [{}, ["APP_PASSWORD", "SESSION_SECRET"]],
      [{ APP_PASSWORD: PASSWORD }, ["SESSION_SECRET"]],
      [{ SESSION_SECRET: SECRET }, ["APP_PASSWORD"]],
      [{ APP_PASSWORD: "", SESSION_SECRET: SECRET }, ["APP_PASSWORD"]],
      [{ APP_PASSWORD: " ".repeat(40), SESSION_SECRET: SECRET }, ["APP_PASSWORD"]],
      [{ APP_PASSWORD: PASSWORD, SESSION_SECRET: " ".repeat(40) }, ["SESSION_SECRET"]],
      [
        { APP_PASSWORD: "x".repeat(MIN_PASSWORD_LENGTH - 1), SESSION_SECRET: SECRET },
        ["APP_PASSWORD"],
      ],
      [
        { APP_PASSWORD: PASSWORD, SESSION_SECRET: "x".repeat(MIN_SECRET_LENGTH - 1) },
        ["SESSION_SECRET"],
      ],
    ];
    for (const [env, missing] of cases) {
      const settings = readAuthSettings(env as NodeJS.ProcessEnv);
      expect(settings).toEqual({ ok: false, missing });
    }
  });

  it("accepts the shortest allowed values", () => {
    const settings = readAuthSettings({
      APP_PASSWORD: "x".repeat(MIN_PASSWORD_LENGTH),
      SESSION_SECRET: "y".repeat(MIN_SECRET_LENGTH),
    } as NodeJS.ProcessEnv);
    expect(settings.ok).toBe(true);
  });

  it("ignores spaces around the password setting", () => {
    const settings = ready({
      APP_PASSWORD: `  ${PASSWORD}\n`,
      SESSION_SECRET: SECRET,
    });
    expect(settings.password).toBe(PASSWORD);
  });
});

describe("comparing passwords", () => {
  it("is true only for the same text", () => {
    expect(passwordMatches(PASSWORD, PASSWORD)).toBe(true);
    for (const other of [
      "",
      "x",
      PASSWORD.slice(0, -1),
      PASSWORD + "x",
      PASSWORD.toUpperCase(),
      "x".repeat(10_000),
      "pässwörd ünïcode 1",
    ]) {
      expect(passwordMatches(other, PASSWORD), other.slice(0, 20)).toBe(false);
    }
    expect(passwordMatches("pässwörd ünïcode 1", "pässwörd ünïcode 1")).toBe(true);
  });
});

describe("the session cookie", () => {
  it("is accepted when this server signed it and it is in date", () => {
    const { token, session } = issueSession(KEY, NOW);
    expect(session).toEqual({ start: NOW, iat: NOW, exp: NOW + SESSION_IDLE_MS });
    expect(readSession(KEY, token, NOW)).toEqual(session);
    expect(readSession(KEY, token, NOW + SESSION_IDLE_MS - 1)).toEqual(session);
  });

  it("stops at its end time", () => {
    const { token } = issueSession(KEY, NOW);
    expect(readSession(KEY, token, NOW + SESSION_IDLE_MS)).toBeNull();
    expect(readSession(KEY, token, NOW + SESSION_IDLE_MS + DAY)).toBeNull();
  });

  it("is refused when anything in it was changed", () => {
    const { token } = issueSession(KEY, NOW);
    const [payload, signature] = token.split(".") as [string, string];
    const longer = Buffer.from(
      JSON.stringify({ v: 1, s: NOW, i: NOW, e: NOW + 365 * DAY }),
    ).toString("base64url");
    for (const changed of [
      `${longer}.${signature}`,
      `${payload}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`,
      `${payload}.`,
      `.${signature}`,
      payload,
      `${payload}.${signature}.${signature}`,
      `${payload}${signature}`,
      token.toUpperCase(),
      ` ${token}`,
    ]) {
      expect(readSession(KEY, changed, NOW), changed.slice(0, 30)).toBeNull();
    }
  });

  it("is refused when it is not a cookie value at all", () => {
    for (const junk of [undefined, null, "", 42, {}, [], "a.b", "x".repeat(600)]) {
      expect(readSession(KEY, junk, NOW)).toBeNull();
    }
  });

  it("is refused when signed with another password or another secret", () => {
    const { token } = issueSession(KEY, NOW);
    const otherPassword = ready({
      APP_PASSWORD: "a different password 2",
      SESSION_SECRET: SECRET,
    }).key;
    const otherSecret = ready({
      APP_PASSWORD: PASSWORD,
      SESSION_SECRET: "another-made-up-secret-9876543210",
    }).key;
    expect(readSession(otherPassword, token, NOW)).toBeNull();
    expect(readSession(otherSecret, token, NOW)).toBeNull();
  });

  it("is refused when the contents make no sense, even with a good signature", () => {
    const good = { v: 1, s: NOW, i: NOW, e: NOW + DAY };
    expect(readSession(KEY, forge(good), NOW)).not.toBeNull();
    for (const bad of [
      { ...good, v: 2 },
      { ...good, e: "tomorrow" },
      { ...good, e: null },
      { ...good, i: NOW + DAY }, // written in the future
      { ...good, s: NOW + 1000 }, // signed in after it was written
      { ...good, e: NOW + SESSION_MAX_MS + DAY }, // longer than any session
      { v: 1 },
      [1, 2, 3],
      "text",
      null,
    ]) {
      expect(readSession(KEY, forge(bad), NOW), JSON.stringify(bad)).toBeNull();
    }
  });

  it("does not accept the Gmail connection's signed state as a session", async () => {
    process.env.SESSION_SECRET = SECRET;
    const { createStateWithNonce } = await import("./gmailAuth");
    const { state } = createStateWithNonce();
    expect(readSession(KEY, state, Date.now())).toBeNull();
    // Even a session-shaped payload signed with the raw secret is refused.
    const body = Buffer.from(
      JSON.stringify({ v: 1, s: NOW, i: NOW, e: NOW + DAY }),
    ).toString("base64url");
    const rawSigned = `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
    expect(readSession(KEY, rawSigned, NOW)).toBeNull();
  });

  it("is renewed after an hour of age, keeping the day the password was typed", () => {
    const first = issueSession(KEY, NOW);
    expect(shouldRenew(first.session, NOW + SESSION_RENEW_AFTER_MS - 1)).toBe(false);
    expect(shouldRenew(first.session, NOW + SESSION_RENEW_AFTER_MS)).toBe(true);

    const later = NOW + 3 * DAY;
    const renewed = issueSession(KEY, later, first.session.start);
    expect(renewed.session).toEqual({
      start: NOW,
      iat: later,
      exp: later + SESSION_IDLE_MS,
    });
  });

  it("never runs past 30 days from the day the password was typed", () => {
    const late = NOW + 28 * DAY;
    const renewed = issueSession(KEY, late, NOW);
    expect(renewed.session.exp).toBe(NOW + SESSION_MAX_MS);
    expect(readSession(KEY, renewed.token, NOW + SESSION_MAX_MS - 1)).not.toBeNull();
    expect(readSession(KEY, renewed.token, NOW + SESSION_MAX_MS)).toBeNull();
    expect(shouldRenew(renewed.session, NOW + SESSION_MAX_MS)).toBe(false);
  });
});
