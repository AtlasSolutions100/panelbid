/**
 * The starting list of contractor sources. It is EMPTY in the repository on purpose: a client's
 * own contractor list is client data and is never kept in git. An installation's list lives in its
 * database (Settings -> Contractor Sources); a new database starts empty and is filled there.
 */
export const INITIAL_CONTRACTOR_SOURCES: Array<{
  name: string;
  value?: string | null;
  notes?: string | null;
}> = [];
