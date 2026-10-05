import {
  pgTable,
  serial,
  text,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";

// Single-row table that holds the active Gmail connection state.
// A row is inserted on "connect" and deleted on "disconnect".
export const gmailConnectionsTable = pgTable("gmail_connections", {
  id: serial("id").primaryKey(),
  // Fixed key enforcing at most one connection row at the DB level, so
  // concurrent connects can't both insert (unique violation → 409).
  singletonKey: text("singleton_key").notNull().default("singleton").unique(),
  connectedEmail: text("connected_email").notNull(),
  isEnabled: boolean("is_enabled").notNull().default(true),
  connectedAt: timestamp("connected_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  // Gmail historyId used for efficient incremental polling.
  lastHistoryId: text("last_history_id"),

  // --- First-party Google OAuth tokens (encrypted at rest, AES-256-GCM) ---
  // NEVER return these fields from any API route.
  refreshTokenEnc: text("refresh_token_enc"),
  accessTokenEnc: text("access_token_enc"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  // Space-separated scopes actually granted on the consent screen.
  grantedScopes: text("granted_scopes"),
  // "active" — tokens usable; "invalid" — refresh token revoked/expired,
  // user must reconnect. Polling pauses while invalid.
  tokenStatus: text("token_status").notNull().default("active"),
});

export type GmailConnection = typeof gmailConnectionsTable.$inferSelect;
