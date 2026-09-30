/**
 * Which session to import: the campaign's ACTIVE one by default, or one the DM picks.
 */
export async function listSessions(transport) {
  const res = await transport.request({ method: "GET", path: "/api/v1/sessions?limit=20" });
  if (res.status !== 200) throw new Error(`Couldn't list sessions (${res.status}).`);
  return (res.body?.sessions ?? []).map((s) => ({ id: s.id, label: `Session ${s.number}: ${s.title}`, status: s.status }));
}

/** @returns {Promise<string | null>} the session id to import, or null when there is none to choose. */
export async function resolveSessionId(transport, chosenId = null) {
  if (chosenId) return chosenId;
  const active = transport.verified?.campaign?.activeSession;
  if (active?.id) return active.id;
  const res = await transport.request({ method: "GET", path: "/api/v1/campaign" });
  return res.body?.campaign?.activeSession?.id ?? null;
}

/** Fetch a session's package (only the documented, player-safe endpoint) and hand it to the importer. */
export async function importSession({ transport, connector, sessionId }) {
  const id = await resolveSessionId(transport, sessionId);
  if (!id) throw new Error("No session is marked as running in The Long Rest. Pick one to import.");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("That isn't a session id.");
  const res = await transport.request({ method: "GET", path: `/api/v1/sessions/${id}/package` });
  if (res.status === 404) throw new Error("That session isn't in this campaign.");
  if (res.status !== 200) throw new Error(`Couldn't fetch the session (${res.status}).`);
  // The requested id goes along: the importer only prunes NPCs when the package is this session's.
  return connector.importPackage(res.body, { sessionId: id });
}

/** The client setting remembering the last session imported in this world (per GM browser). */
export const LAST_IMPORTED = "lastImportedSessionId";

/** Which session a picker preselects: the running one, else the last imported, else the most recent. */
export function preselectSession(sessions, { runningId = null, lastImportedId = null } = {}) {
  const ids = new Set(sessions.map((s) => s.id));
  if (runningId && ids.has(runningId)) return runningId;
  if (lastImportedId && ids.has(lastImportedId)) return lastImportedId;
  return sessions[0]?.id ?? null; // the list is newest first
}

/**
 * What the Actors-directory button should do: import the RUNNING session (no dialog), offer a PICK of
 * recent sessions (a prep day: nothing running), or say there are NONE. The running session is read
 * fresh (GET /campaign), not from the cached connection check, which can predate a session starting or
 * ending. A failed list throws, so a dialog never opens half-filled.
 */
export async function planImport({ transport, lastImportedId = null }) {
  const res = await transport.request({ method: "GET", path: "/api/v1/campaign" });
  const running = res.status === 200 ? res.body?.campaign?.activeSession?.id ?? null : transport.verified?.campaign?.activeSession?.id ?? null;
  if (running) return { kind: "running", sessionId: running };
  const sessions = await listSessions(transport);
  if (!sessions.length) return { kind: "none" };
  return { kind: "pick", sessions, preselect: preselectSession(sessions, { lastImportedId }) };
}

/** Import a session and, only once that SUCCEEDED, remember it as this world's last import. */
export async function importAndRemember({ transport, connector, store, sessionId = null }) {
  const id = await resolveSessionId(transport, sessionId);
  const report = await importSession({ transport, connector, sessionId: id });
  await store.set(LAST_IMPORTED, id);
  return report;
}

/**
 * The Actors-directory button's whole flow. `pick(sessions, preselect)` shows the picker and resolves
 * to a session id, or null when cancelled.
 * @returns {Promise<{ outcome: "imported", report: object } | { outcome: "cancelled" } | { outcome: "none" }>}
 */
export async function runDirectoryImport({ transport, connector, store, pick }) {
  const plan = await planImport({ transport, lastImportedId: store.get(LAST_IMPORTED) || null });
  if (plan.kind === "none") return { outcome: "none" };
  let sessionId = plan.sessionId;
  if (plan.kind === "pick") {
    sessionId = await pick(plan.sessions, plan.preselect);
    if (!sessionId || !plan.sessions.some((s) => s.id === sessionId)) return { outcome: "cancelled" };
  }
  return { outcome: "imported", report: await importAndRemember({ transport, connector, store, sessionId }) };
}
