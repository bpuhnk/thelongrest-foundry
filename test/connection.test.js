import { describe, expect, it, vi } from "vitest";

import { disconnect, saveAndConnect, saveForm, testConnection } from "../src/connection.js";
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

describe("saveForm / saveAndConnect: Test connection uses what's in the form (v0.1.1)", () => {
  const empty = () => { const data = { baseUrl: "https://thelongrest.app", token: "", campaignId: "", shareNpcHp: false, announceReveals: false }; return { data, get: (k) => data[k], set: vi.fn(async (k, v) => void (data[k] = v)) }; };

  it("saves the form: trims the address and token, saves the checkboxes, drops any cached check", async () => {
    const store = empty();
    const transport = { reset: vi.fn() };
    await saveForm({ store, transport, data: { baseUrl: "  https://tlr.example/  ", token: "  tlr_TEST_TOKEN_should_never_leak_0123456789abcdef ", shareNpcHp: true, announceReveals: "on" } });
    expect(store.data).toMatchObject({ baseUrl: "https://tlr.example/", token: "tlr_TEST_TOKEN_should_never_leak_0123456789abcdef", shareNpcHp: true, announceReveals: true });
    expect(transport.reset).toHaveBeenCalled();
  });

  it("an EMPTY token field keeps the saved token (the form never renders it back)", async () => {
    const store = empty();
    store.data.token = "tlr_TEST_TOKEN_should_never_leak_0123456789abcdef";
    await saveForm({ store, transport: { reset() {} }, data: { baseUrl: "https://tlr.example", token: "   " } });
    expect(store.data.token).toBe("tlr_TEST_TOKEN_should_never_leak_0123456789abcdef");
  });

  it("saveAndConnect tests the NEW values: pasting a token then clicking Test works without Save first", async () => {
    const store = empty(); // nothing saved yet, as on a fresh install
    const seen = [];
    const transport = {
      reset() {},
      check: vi.fn(async () => {
        seen.push({ url: store.get("baseUrl"), token: store.get("token") });
        if (!store.get("token")) { const e = new Error("no token"); e.code = "no-token"; throw e; }
        return verified();
      }),
    };
    const r = await saveAndConnect({ store, transport, data: { baseUrl: "https://tlr.example", token: "tlr_TEST_TOKEN_should_never_leak_0123456789abcdef" }, now: NOW });
    expect(r.ok).toBe(true);
    expect(seen).toEqual([{ url: "https://tlr.example", token: "tlr_TEST_TOKEN_should_never_leak_0123456789abcdef" }]);
    expect(store.data.campaignId).toBe(CAMPAIGN);
  });
});

