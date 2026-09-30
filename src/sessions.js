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
  return connector.importPackage(res.body);
}
