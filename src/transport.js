/**
 * The only way the module talks to The Long Rest.
 *
 * - The token lives here (read from a client-scoped setting by the caller) and goes ONLY into the
 *   `Authorization` header to the configured base URL. It never appears in an error, a log line or
 *   a notification.
 * - Nothing is sent until `GET /api/v1/campaign` proves (1) the token is a **VTT connector** token and
 *   (2) it belongs to the campaign this world is pinned to. A 401 (revoked or expired) drops the
 *   verification, so the next call re-checks.
 * - A refusal (revoked token, wrong scope, wrong campaign) is LATCHED: later requests fail at once,
 *   without touching the network, until the GM re-tests the connection (`check()` or `reset()`). A
 *   misconfigured world therefore costs The Long Rest nothing.
 */
export class TransportError extends Error {
  /** @param {string} code  @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "TransportError";
    this.code = code;
  }
}

const SCOPE_MESSAGES = {
  READ: "This is a Read only token, which can't send table state. Create a VTT connector token in The Long Rest.",
  READ_WRITE:
    "This is a Read & write token. Other modules in this world can read the token, so The Long Rest only accepts a VTT connector token here. Create one in The Long Rest and revoke this one.",
};

/**
 * @param {{
 *   getBaseUrl: () => string, getToken: () => string, getExpectedCampaignId: () => string | null,
 *   client: string, fetchImpl?: typeof fetch,
 * }} opts
 */
export function createTransport({ getBaseUrl, getToken, getExpectedCampaignId, client, fetchImpl = (...a) => fetch(...a) }) {
  /** @type {null | { campaign: { id: string, name: string, activeSession: unknown }, token: { scope: string, expiresAt: string | null } }} */
  let verified = null;
  /** @type {TransportError | null} */
  let refused = null;
  const LATCHED = new Set(["unauthorized", "wrong-scope", "wrong-campaign"]);

  async function raw({ method, path, body, headers = {} }) {
    const base = String(getBaseUrl() || "").replace(/\/+$/, "");
    const token = String(getToken() || "");
    if (!base) throw new TransportError("no-url", "Set The Long Rest's address in the module settings.");
    if (!token) throw new TransportError("no-token", "Connect The Long Rest in the module settings first.");
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, "X-TLR-Client": client, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      // Deliberately no detail from the underlying error: it can echo the request.
      throw new TransportError("network", "Couldn't reach The Long Rest. Check the address and your connection.");
    }
    const h = {};
    res.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
    const text = res.status === 304 ? "" : await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status === 401) verified = null;
    return { status: res.status, headers: h, body: json };
  }

  /** Verify the token: its scope and its campaign. Returns what the settings panel shows. */
  async function check() {
    verified = null;
    refused = null;
    try {
      const res = await raw({ method: "GET", path: "/api/v1/campaign" });
      if (res.status === 401) throw new TransportError("unauthorized", "The Long Rest didn't accept this token (it may be revoked or expired).");
      if (res.status !== 200 || !res.body?.campaign?.id) throw new TransportError("unavailable", `The Long Rest answered ${res.status}. Try again shortly.`);
      const scope = res.body.token?.scope;
      if (scope !== "VTT") throw new TransportError("wrong-scope", SCOPE_MESSAGES[scope] ?? "The Long Rest only accepts a VTT connector token here.");
      const expected = getExpectedCampaignId();
      if (expected && res.body.campaign.id !== expected) {
        throw new TransportError("wrong-campaign", `This token belongs to a different campaign ("${String(res.body.campaign.name).slice(0, 80)}") than this world is connected to.`);
      }
      verified = { campaign: { id: res.body.campaign.id, name: res.body.campaign.name, activeSession: res.body.campaign.activeSession ?? null }, token: res.body.token };
      return verified;
    } catch (err) {
      if (err instanceof TransportError && LATCHED.has(err.code)) refused = err;
      throw err;
    }
  }

  /** Any other request: only after a successful check (re-checked after a 401; a refusal is latched). */
  async function request(req) {
    if (refused) throw refused;
    if (!verified) await check();
    return raw(req);
  }

  return {
    check,
    request,
    get verified() { return verified; },
    get refused() { return refused; },
    reset: () => { verified = null; refused = null; },
  };
}
