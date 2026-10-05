/**
 * Contractor-source matching for the Gmail poller.
 *
 * A contractor source's `value` is either an exact email address (contains
 * "@") or a domain. Matching rules (all case-insensitive):
 *   - Email value: exact match against the sender's address.
 *   - Domain value: sender's domain equals the value, or is a subdomain of
 *     it ("bids.example.com" matches "example.com"). Leading "www." and a
 *     leading "@" on the stored value are tolerated.
 *
 * This is a signal only — it never gates or filters email processing.
 */
import { eq } from "drizzle-orm";
import { db, contractorSourcesTable, type ContractorSource } from "@workspace/db";

/**
 * Extract the bare email address from a From header, which may be either
 * "Name <addr@example.com>" or a bare "addr@example.com". Returns the
 * lowercased address, or null when none is found.
 */
export function parseSenderAddress(fromHeader: string): string | null {
  const angled = fromHeader.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (angled) return angled[1]!.toLowerCase();
  const bare = fromHeader.match(/[^\s"'<>,;]+@[^\s"'<>,;]+/);
  return bare ? bare[0]!.toLowerCase() : null;
}

/** Normalize a stored value: trim, lowercase, strip leading "@" / "www.". */
function normalizeValue(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "").replace(/^www\./, "");
}

/**
 * Match a From header against a list of contractor sources. Exact email
 * matches win over domain matches. Returns the matching source or null.
 */
export function matchContractor(
  fromHeader: string,
  sources: ContractorSource[],
): ContractorSource | null {
  const address = parseSenderAddress(fromHeader);
  if (!address) return null;
  const domain = address.split("@")[1] ?? "";

  let domainMatch: ContractorSource | null = null;
  for (const source of sources) {
    if (!source.value) continue; // name-only entry — nothing to match on
    const value = normalizeValue(source.value);
    if (!value) continue;
    if (value.includes("@")) {
      if (value === address) return source; // exact email — strongest match
    } else if (!domainMatch && (domain === value || domain.endsWith(`.${value}`))) {
      domainMatch = source;
    }
  }
  return domainMatch;
}

/** Load all active contractor sources (called once per poll cycle). */
export async function loadActiveContractorSources(): Promise<ContractorSource[]> {
  return db
    .select()
    .from(contractorSourcesTable)
    .where(eq(contractorSourcesTable.active, true));
}
