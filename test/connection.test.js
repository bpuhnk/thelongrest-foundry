import { describe, expect, it, vi } from "vitest";

import { disconnect, testConnection } from "../src/connection.js";
import { TransportError } from "../src/transport.js";

const CAMPAIGN = "00000000-0000-4000-8000-0000000000c1";
const verified = (over = {}) => ({
  token: { scope: "VTT", expiresAt: null, ...over.token },
  campaign: { id: CAMPAIGN, name: "Test Campaign", activeSession: { id: "s1", number: 3, title: "The Pass" }, ...over.campaign },
});
const makeStore = (init = {}) => {
  const data = { campaignId: "", token: "tlr_TEST_TOKEN_should_never_leak_0123456789abcdef", ...init };
  return { data, get: (k) => data[k], set: vi.fn(async (k, v) => void (data[k] = v)) };
};
const makeTransport = (check) => ({ check: vi.fn(check), reset: vi.fn() });
const NOW = new Date("2026-09-29T12:00:00Z");

describe("testConnection", () => {
  it("pins the campaign on the first successful connect and reports the running session", async () => {
    const store = makeStore();
    const r = await testConnection({ transport: makeTransport(async () => verified()), store, now: NOW });
    expect(r).toEqual({ ok: true, campaign: "Test Campaign", session: "Session 3: The Pass", expiresAt: null, warning: null });
    expect(store.data.campaignId).toBe(CAMPAIGN);
  });

  it("never re-pins: an existing pin is left alone (the transport refuses a mismatch)", async () => {
    const store = makeStore({ campaignId: "00000000-0000-4000-8000-0000000000c9" });
    await testConnection({ transport: makeTransport(async () => verified()), store, now: NOW });
    expect(store.set).not.toHaveBeenCalled();
  });

  it("no expiry means no warning; an expiry within 7 days warns; later doesn't", async () => {
    const at = (days) => new Date(NOW.getTime() + days * 86_400_000).toISOString();
    const run = (expiresAt) => testConnection({ transport: makeTransport(async () => verified({ token: { expiresAt } })), store: makeStore(), now: NOW });
    expect((await run(null)).warning).toBeNull();
    expect((await run(at(2.5))).warning).toMatch(/expires in 3 day/);
    expect((await run(at(-1))).warning).toMatch(/expires in 0 day/);
    expect((await run(at(30))).warning).toBeNull();
  });

  it("no running session is fine", async () => {
    const r = await testConnection({ transport: makeTransport(async () => verified({ campaign: { activeSession: null } })), store: makeStore(), now: NOW });
    expect(r.session).toBeNull();
  });

  it("passes the transport's refusal through, and pins nothing", async () => {
    const store = makeStore();
    const r = await testConnection({ transport: makeTransport(async () => { throw new TransportError("wrong-scope", "Create a VTT connector token."); }), store, now: NOW });
    expect(r).toEqual({ ok: false, code: "wrong-scope", message: "Create a VTT connector token." });
    expect(store.set).not.toHaveBeenCalled();
  });
});

describe("disconnect", () => {
  it("forgets the token and the pin, and drops verification", async () => {
    const store = makeStore({ campaignId: CAMPAIGN });
    const transport = makeTransport(async () => verified());
    await disconnect({ store, transport });
    expect(store.data).toMatchObject({ token: "", campaignId: "" });
    expect(transport.reset).toHaveBeenCalled();
  });
});
