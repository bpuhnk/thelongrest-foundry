/**
 * Connecting a world to The Long Rest: test the token, pin the campaign on first success, and tell
 * the GM what they're connected to. Pure over an injected transport + settings store (unit tested).
 */
const WARN_EXPIRY_DAYS = 7;

/**
 * @param {{ transport: ReturnType<typeof import("./transport.js").createTransport>, store: { get(k: string): any, set(k: string, v: any): Promise<void> }, now?: Date }} deps
 * @returns {Promise<{ ok: true, campaign: string, session: string | null, expiresAt: string | null, warning: string | null } | { ok: false, code: string, message: string }>}
 */
export async function testConnection({ transport, store, now = new Date() }) {
  try {
    const v = await transport.check();
    // First successful connect pins this world to the token's campaign; later tokens must match it.
    if (!store.get("campaignId")) await store.set("campaignId", v.campaign.id);
    let warning = null;
    if (v.token.expiresAt) {
      const days = (Date.parse(v.token.expiresAt) - now.getTime()) / 86_400_000;
      if (days <= WARN_EXPIRY_DAYS) warning = `This token expires in ${Math.max(0, Math.ceil(days))} day(s). Make a new VTT connector token before then.`;
    }
    const s = v.campaign.activeSession;
    return { ok: true, campaign: v.campaign.name, session: s ? `Session ${s.number}: ${s.title}` : null, expiresAt: v.token.expiresAt, warning };
  } catch (err) {
    return { ok: false, code: err?.code ?? "error", message: err?.message ?? "Couldn't connect." };
  }
}

/** Disconnect: forget the token and the campaign pin (the DM can then connect another campaign). */
export async function disconnect({ store, transport }) {
  await store.set("token", "");
  await store.set("campaignId", "");
  transport.reset();
}

/**
 * Save the Connect form's values, with the rules both buttons share: the address is trimmed; an EMPTY
 * token field keeps the saved token (the form never renders it back); the checkboxes are saved as
 * booleans. Any cached verification or latched refusal is dropped, so the next request re-checks.
 * @param {{ store: { set(k: string, v: any): Promise<void> }, transport: { reset(): void },
 *   data: { baseUrl?: string, token?: string, shareNpcHp?: boolean, announceReveals?: boolean } }} deps
 */
export async function saveForm({ store, transport, data }) {
  await store.set("baseUrl", String(data.baseUrl ?? "").trim());
  const token = String(data.token ?? "").trim();
  if (token) await store.set("token", token);
  await store.set("shareNpcHp", Boolean(data.shareNpcHp));
  await store.set("announceReveals", Boolean(data.announceReveals));
  transport.reset();
}

/** Save the form, then test the connection: what BOTH Save and Test connection do. */
export async function saveAndConnect({ store, transport, data, now }) {
  await saveForm({ store, transport, data });
  return testConnection({ transport, store, now });
}

