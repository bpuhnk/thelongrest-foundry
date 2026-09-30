import { describe, expect, it, vi } from "vitest";

import { importSession, listSessions, resolveSessionId } from "../src/sessions.js";

const S1 = "00000000-0000-4000-8000-00000000a001";
const S2 = "00000000-0000-4000-8000-00000000a002";
const PKG = { schemaVersion: 1, session: { id: S1 } };

const makeTransport = (routes, verified = null) => ({
  verified,
  request: vi.fn(async ({ method, path }) => {
    const r = routes[`${method} ${path}`];
    return r ?? { status: 404, headers: {}, body: { error: "Not found" } };
  }),
});
const ok = (body) => ({ status: 200, headers: {}, body });

describe("resolveSessionId", () => {
  it("a chosen session wins, without a request", async () => {
    const t = makeTransport({});
    expect(await resolveSessionId(t, S2)).toBe(S2);
    expect(t.request).not.toHaveBeenCalled();
  });

  it("otherwise the running session from the verified connection, without a request", async () => {
    const t = makeTransport({}, { campaign: { activeSession: { id: S1 } } });
    expect(await resolveSessionId(t)).toBe(S1);
    expect(t.request).not.toHaveBeenCalled();
  });

  it("otherwise asks GET /campaign; null when nothing is running", async () => {
    expect(await resolveSessionId(makeTransport({ "GET /api/v1/campaign": ok({ campaign: { activeSession: { id: S1 } } }) }))).toBe(S1);
    expect(await resolveSessionId(makeTransport({ "GET /api/v1/campaign": ok({ campaign: { activeSession: null } }) }))).toBeNull();
  });
});

describe("importSession", () => {
  it("fetches only the documented package endpoint and hands it to the importer", async () => {
    const t = makeTransport({ [`GET /api/v1/sessions/${S1}/package`]: ok(PKG) }, { campaign: { activeSession: { id: S1 } } });
    const connector = { importPackage: vi.fn(async () => ({ created: 2, updated: 0 })) };
    expect(await importSession({ transport: t, connector })).toEqual({ created: 2, updated: 0 });
    expect(connector.importPackage).toHaveBeenCalledWith(PKG, { sessionId: S1 });
    expect(t.request.mock.calls.map(([r]) => `${r.method} ${r.path}`)).toEqual([`GET /api/v1/sessions/${S1}/package`]);
  });

  it("imports a picked session instead of the running one", async () => {
    const t = makeTransport({ [`GET /api/v1/sessions/${S2}/package`]: ok(PKG) }, { campaign: { activeSession: { id: S1 } } });
    await importSession({ transport: t, connector: { importPackage: async () => ({}) }, sessionId: S2 });
    expect(t.request.mock.calls[0][0].path).toBe(`/api/v1/sessions/${S2}/package`);
  });

  it("refuses when nothing is running and nothing was picked", async () => {
    const t = makeTransport({ "GET /api/v1/campaign": ok({ campaign: { activeSession: null } }) });
    await expect(importSession({ transport: t, connector: {} })).rejects.toThrow(/No session is marked as running/);
  });

  it("refuses a malformed id before any path is built", async () => {
    const t = makeTransport({});
    await expect(importSession({ transport: t, connector: {}, sessionId: "../campaign" })).rejects.toThrow(/isn't a session id/);
    expect(t.request).not.toHaveBeenCalled();
  });

  it("a 404 (another campaign's session) and other failures are explained, and nothing is imported", async () => {
    const connector = { importPackage: vi.fn() };
    await expect(importSession({ transport: makeTransport({}), connector, sessionId: S2 })).rejects.toThrow(/isn't in this campaign/);
    const t = makeTransport({ [`GET /api/v1/sessions/${S1}/package`]: { status: 503, headers: {}, body: null } });
    await expect(importSession({ transport: t, connector, sessionId: S1 })).rejects.toThrow(/\(503\)/);
    expect(connector.importPackage).not.toHaveBeenCalled();
  });
});

describe("listSessions", () => {
  it("labels sessions for the picker", async () => {
    const t = makeTransport({ "GET /api/v1/sessions?limit=20": ok({ sessions: [{ id: S1, number: 3, title: "The Pass", status: "ACTIVE" }] }) });
    expect(await listSessions(t)).toEqual([{ id: S1, label: "Session 3: The Pass", status: "ACTIVE" }]);
  });
});

describe("importSession never prunes on a failed fetch", () => {
  it("a non-200 package throws before the importer runs, so nothing can be removed", async () => {
    const importPackage = vi.fn();
    const t = makeTransport({ [`GET /api/v1/sessions/${S1}/package`]: { status: 502, headers: {}, body: null } });
    await expect(importSession({ transport: t, connector: { importPackage }, sessionId: S1 })).rejects.toThrow(/\(502\)/);
    expect(importPackage).not.toHaveBeenCalled();
  });

  it("passes the REQUESTED session id to the importer (pruning needs it to match the package)", async () => {
    const importPackage = vi.fn(async () => ({}));
    const t = makeTransport({ [`GET /api/v1/sessions/${S2}/package`]: ok(PKG) });
    await importSession({ transport: t, connector: { importPackage }, sessionId: S2 });
    expect(importPackage).toHaveBeenCalledWith(PKG, { sessionId: S2 });
  });
});
