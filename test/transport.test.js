import { beforeEach, describe, expect, it, vi } from "vitest";

import { TransportError, createTransport } from "../src/transport.js";

const TOKEN = "tlr_TEST_TOKEN_should_never_leak_0123456789abcdef";
const CAMPAIGN = "00000000-0000-4000-8000-0000000000c1";
const json = (status, body, headers = {}) => ({
  status,
  headers: new Headers(headers),
  text: async () => (body === undefined ? "" : JSON.stringify(body)),
});
const campaignBody = (scope, id = CAMPAIGN) => ({ schemaVersion: 1, token: { scope, expiresAt: null }, campaign: { id, name: "Test Campaign", activeSession: { id: "s1", number: 1, title: "One" } } });

let fetchImpl;
let expected;
const make = () => createTransport({ getBaseUrl: () => "https://tlr.example/", getToken: () => TOKEN, getExpectedCampaignId: () => expected, client: "the-long-rest/0.1.0", fetchImpl });

beforeEach(() => {
  expected = CAMPAIGN;
  fetchImpl = vi.fn(async (url) => (url.endsWith("/api/v1/campaign") ? json(200, campaignBody("VTT")) : json(201, { id: "x" })));
});

describe("transport", () => {
  it("verifies scope + campaign first, then sends with the bearer token and client header", async () => {
    const t = make();
    const res = await t.request({ method: "POST", path: "/api/v1/live-state", body: { kind: "HP", payload: { entries: [] } } });
    expect(res.status).toBe(201);
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(["https://tlr.example/api/v1/campaign", "https://tlr.example/api/v1/live-state"]);
    const [, init] = fetchImpl.mock.calls[1];
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, "X-TLR-Client": "the-long-rest/0.1.0", "Content-Type": "application/json" });
    expect(t.verified.campaign.name).toBe("Test Campaign");
  });

  it.each([
    ["READ", /Read only token/],
    ["READ_WRITE", /Read & write token.*VTT connector/],
    [undefined, /only accepts a VTT connector token/],
  ])("refuses a %s token with a clear message, and sends nothing else", async (scope, message) => {
    fetchImpl = vi.fn(async () => json(200, campaignBody(scope)));
    await expect(make().request({ method: "POST", path: "/api/v1/live-state", body: {} })).rejects.toMatchObject({ code: "wrong-scope", message: expect.stringMatching(message) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a token from another campaign", async () => {
    fetchImpl = vi.fn(async () => json(200, campaignBody("VTT", "00000000-0000-4000-8000-0000000000c2")));
    await expect(make().check()).rejects.toMatchObject({ code: "wrong-campaign" });
  });

  it("a 401 drops verification, so the next call re-checks", async () => {
    const t = make();
    await t.check();
    fetchImpl.mockImplementationOnce(async () => json(401, { error: "Invalid token." }));
    expect((await t.request({ method: "GET", path: "/api/v1/sessions" })).status).toBe(401);
    expect(t.verified).toBeNull();
  });

  it("NEVER puts the token in an error message, whatever fails", async () => {
    const messages = [];
    for (const impl of [
      async () => { throw new Error(`boom ${TOKEN}`); },
      async () => json(401, { error: "x" }),
      async () => json(500, { error: TOKEN }),
      async () => json(200, campaignBody("READ_WRITE")),
    ]) {
      fetchImpl = vi.fn(impl);
      try { await make().check(); } catch (e) { messages.push(String(e.message), String(e.stack)); }
    }
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.join("\n")).not.toContain(TOKEN);
  });

  it("no token or address → a settings message, no network call", async () => {
    const t = createTransport({ getBaseUrl: () => "", getToken: () => TOKEN, getExpectedCampaignId: () => null, client: "c", fetchImpl });
    await expect(t.check()).rejects.toBeInstanceOf(TransportError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("transport: a refusal is latched", () => {
  it.each([
    ["wrong scope", () => json(200, campaignBody("READ_WRITE")), "wrong-scope"],
    ["wrong campaign", () => json(200, campaignBody("VTT", "00000000-0000-4000-8000-0000000000c2")), "wrong-campaign"],
    ["revoked token", () => json(401, { error: "Unauthorized" }), "unauthorized"],
  ])("%s: later requests fail without touching the network until a re-test", async (_label, answer, code) => {
    let fixed = false;
    fetchImpl = vi.fn(async (url) => (!fixed ? answer() : url.endsWith("/api/v1/campaign") ? json(200, campaignBody("VTT")) : json(201, {})));
    const t = make();
    for (let i = 0; i < 5; i++) await expect(t.request({ method: "POST", path: "/api/v1/live-state", body: {} })).rejects.toMatchObject({ code });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(t.refused?.code).toBe(code);
    // The GM fixes it and re-tests: the latch clears.
    fixed = true;
    await t.check();
    expect((await t.request({ method: "POST", path: "/api/v1/live-state", body: {} })).status).toBe(201);
  });

  it("a network failure or a 5xx is NOT latched (it retries)", async () => {
    fetchImpl = vi.fn(async () => json(503, null));
    const t = make();
    await expect(t.check()).rejects.toMatchObject({ code: "unavailable" });
    await expect(t.request({ method: "GET", path: "/api/v1/campaign" })).rejects.toMatchObject({ code: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
