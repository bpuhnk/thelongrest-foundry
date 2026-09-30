import { describe, expect, it, vi } from "vitest";

import { LAST_IMPORTED, importAndRemember, planImport, preselectSession, runDirectoryImport } from "../src/sessions.js";
import { pickerHtml, pickSessionDialog } from "../src/ui/session-picker.js";

const S = (n) => `00000000-0000-4000-8000-00000000a00${n}`;
const PKG = { schemaVersion: 1 };
const sessionsBody = (...ns) => ({ sessions: ns.map((n) => ({ id: S(n), number: n, title: `Title ${n}`, status: "PLANNED" })) });

/** A transport answering GET /campaign (running = the active session id or null), the list, and packages. */
function transport({ running = null, list = [3, 2, 1], listStatus = 200, campaignStatus = 200, verifiedRunning = null } = {}) {
  const calls = [];
  const t = {
    verified: { campaign: { activeSession: verifiedRunning ? { id: verifiedRunning } : null } },
    request: vi.fn(async ({ path }) => {
      calls.push(path);
      if (path === "/api/v1/campaign") return { status: campaignStatus, headers: {}, body: { campaign: { activeSession: running ? { id: running } : null } } };
      if (path === "/api/v1/sessions?limit=20") return { status: listStatus, headers: {}, body: sessionsBody(...list) };
      if (/\/package$/.test(path)) return { status: 200, headers: {}, body: PKG };
      return { status: 404, headers: {}, body: null };
    }),
  };
  return { t, calls };
}
const store = (init = {}) => { const data = { ...init }; return { data, get: (k) => data[k], set: vi.fn(async (k, v) => void (data[k] = v)) }; };
const connector = () => ({ importPackage: vi.fn(async () => ({ created: 1, updated: 0 })) });

describe("preselectSession: running > last imported > most recent", () => {
  const list = [{ id: S(3) }, { id: S(2) }, { id: S(1) }];
  it.each([
    [{ runningId: S(2), lastImportedId: S(1) }, S(2)],
    [{ runningId: null, lastImportedId: S(1) }, S(1)],
    [{ runningId: null, lastImportedId: "gone" }, S(3)],
    [{ runningId: "gone", lastImportedId: null }, S(3)],
    [{}, S(3)],
  ])("%j → %s", (opts, want) => expect(preselectSession(list, opts)).toBe(want));
  it("an empty list → null", () => expect(preselectSession([], {})).toBeNull());
});

describe("planImport", () => {
  it("a running session → import it, without listing sessions", async () => {
    const { t, calls } = transport({ running: S(2) });
    expect(await planImport({ transport: t })).toEqual({ kind: "running", sessionId: S(2) });
    expect(calls).toEqual(["/api/v1/campaign"]);
  });

  it("reads the running session FRESH (a stale cached one is ignored)", async () => {
    const { t } = transport({ running: null, verifiedRunning: S(9) });
    expect((await planImport({ transport: t })).kind).toBe("pick");
  });

  it("nothing running → a pick of recent sessions, the last-imported preselected (else the most recent)", async () => {
    const { t } = transport();
    const p = await planImport({ transport: t, lastImportedId: S(1) });
    expect(p).toMatchObject({ kind: "pick", preselect: S(1) });
    expect(p.sessions.map((s) => s.label)).toEqual(["Session 3: Title 3", "Session 2: Title 2", "Session 1: Title 1"]);
    expect((await planImport({ transport: transport().t, lastImportedId: "not-in-list" })).preselect).toBe(S(3));
  });

  it("no sessions at all → none (no empty dialog); a failed list → throws (no half-open dialog)", async () => {
    expect(await planImport({ transport: transport({ list: [] }).t })).toEqual({ kind: "none" });
    await expect(planImport({ transport: transport({ listStatus: 503 }).t })).rejects.toThrow(/Couldn't list sessions \(503\)/);
  });
});

describe("importAndRemember", () => {
  it("remembers the session only AFTER a successful import", async () => {
    const st = store();
    await importAndRemember({ transport: transport().t, connector: connector(), store: st, sessionId: S(2) });
    expect(st.data[LAST_IMPORTED]).toBe(S(2));
  });

  it("a failed import remembers nothing", async () => {
    const st = store({ [LAST_IMPORTED]: S(1) });
    const c = { importPackage: vi.fn(async () => { throw new Error("boom"); }) };
    await expect(importAndRemember({ transport: transport().t, connector: c, store: st, sessionId: S(2) })).rejects.toThrow("boom");
    expect(st.data[LAST_IMPORTED]).toBe(S(1));
    expect(st.set).not.toHaveBeenCalled();
  });
});

describe("runDirectoryImport: the Import TLR button", () => {
  it("running → one click, no dialog; remembered", async () => {
    const pick = vi.fn();
    const st = store();
    const c = connector();
    const r = await runDirectoryImport({ transport: transport({ running: S(2) }).t, connector: c, store: st, pick });
    expect(r.outcome).toBe("imported");
    expect(pick).not.toHaveBeenCalled();
    expect(c.importPackage).toHaveBeenCalledWith(PKG, { sessionId: S(2) });
    expect(st.data[LAST_IMPORTED]).toBe(S(2));
  });

  it("prep day → the picker (preselecting the last import), then imports the choice", async () => {
    const pick = vi.fn(async (sessions, preselect) => (expect(preselect).toBe(S(1)), S(2)));
    const st = store({ [LAST_IMPORTED]: S(1) });
    const c = connector();
    const r = await runDirectoryImport({ transport: transport().t, connector: c, store: st, pick });
    expect(r.outcome).toBe("imported");
    expect(pick).toHaveBeenCalledTimes(1);
    expect(c.importPackage).toHaveBeenCalledWith(PKG, { sessionId: S(2) });
    expect(st.data[LAST_IMPORTED]).toBe(S(2));
  });

  it.each([[null], [undefined], ["cancel"], [S(9)]])("Cancel / a closed dialog / a foreign id (%s) → nothing imported, nothing remembered, no error", async (picked) => {
    const st = store({ [LAST_IMPORTED]: S(1) });
    const c = connector();
    const r = await runDirectoryImport({ transport: transport().t, connector: c, store: st, pick: async () => picked });
    expect(r).toEqual({ outcome: "cancelled" });
    expect(c.importPackage).not.toHaveBeenCalled();
    expect(st.set).not.toHaveBeenCalled();
  });

  it("no sessions → 'none' (the caller shows the clear message), no picker", async () => {
    const pick = vi.fn();
    expect(await runDirectoryImport({ transport: transport({ list: [] }).t, connector: connector(), store: store(), pick })).toEqual({ outcome: "none" });
    expect(pick).not.toHaveBeenCalled();
  });
});

describe("the picker dialog", () => {
  const sessions = [
    { id: S(2), label: `Session 2: <img src=x onerror="alert(1)"> & "quotes"` },
    { id: S(1), label: "Session 1: Plain" },
  ];

  it("escapes every DM-authored title; marks the preselected option", () => {
    const html = pickerHtml(sessions, S(1), "Session to import");
    expect(html).not.toMatch(/<img|onerror="/);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quotes&quot;");
    expect(html).toContain(`<option value="${S(1)}" selected>Session 1: Plain</option>`);
    expect(html.match(/ selected/g)).toHaveLength(1);
  });

  const fakeDialog = (answer) => ({ wait: vi.fn(async (opts) => (typeof answer === "function" ? answer(opts) : answer)) });
  const i18n = { localize: (k) => k };

  it("Import returns the selected id (via the button's form)", async () => {
    const D = fakeDialog((opts) => opts.buttons.find((b) => b.action === "import").callback({}, { form: { elements: { sessionId: { value: S(2) } } } }));
    expect(await pickSessionDialog({ sessions, preselect: S(1), i18n, DialogV2: D })).toBe(S(2));
    const opts = D.wait.mock.calls[0][0];
    expect(opts.rejectClose).toBe(false); // closing the window resolves, never throws
    expect(opts.buttons.map((b) => b.action)).toEqual(["import", "cancel"]);
  });

  it.each([["cancel"], [null], ["00000000-0000-4000-8000-0000000000ff"]])("Cancel / closed / an id not offered (%s) → null", async (answer) => {
    expect(await pickSessionDialog({ sessions, preselect: S(1), i18n, DialogV2: fakeDialog(answer) })).toBeNull();
  });
});
