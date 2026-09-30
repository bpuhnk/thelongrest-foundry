import { describe, expect, it, vi } from "vitest";

import { ACTIVE_MS, CAMPAIGN_REFRESH_MS, IDLE_MS, TICK_TIMEOUT_MS, createRevealPoller, makeAnnouncer, revealCardHtml } from "../src/reveals.js";

const S1 = { id: "00000000-0000-4000-8000-00000000a001", number: 3, title: "The Pass" };
const S2 = { id: "00000000-0000-4000-8000-00000000a002", number: 4, title: "The Keep" };
const fact = (n, o = {}) => ({ id: `f${n}`, fact: `Fact ${n}`, revealedAt: "2026-09-29T20:00:00.000Z", sourceNpc: null, ...o });

/**
 * A fake clock + a scripted server. `server.active` is the running session; `server.reveals[id]` the
 * revealed facts (each with `at`, when it was revealed on the server clock).
 */
function harness({ activeGM = true } = {}) {
  const clock = { t: 0 };
  const timers = [];
  const server = { active: S1, reveals: { [S1.id]: [], [S2.id]: [] }, etagHits: 0, fail: null };
  const calls = [];
  const transport = {
    request: vi.fn(async ({ path, headers = {} }) => {
      calls.push({ at: clock.t, path, headers });
      if (server.fail) throw server.fail;
      if (path === "/api/v1/campaign") return { status: 200, headers: {}, body: { campaign: { id: "c", activeSession: server.active } } };
      const m = /^\/api\/v1\/sessions\/([^/]+)\/reveals(?:\?since=(.+))?$/.exec(path);
      if (!m) return { status: 404, headers: {}, body: null };
      const list = server.reveals[m[1]];
      if (!list) return { status: 404, headers: {}, body: null };
      const since = m[2] ? Number(new Date(decodeURIComponent(m[2]))) : -Infinity;
      const out = list.filter((r) => r.at > since);
      const etag = `W/"${list.length}"`;
      if (headers["If-None-Match"] === etag && !out.length) return (server.etagHits++, { status: 304, headers: { etag }, body: null });
      return { status: 200, headers: { etag }, body: { reveals: out.map(({ at, ...r }) => r), serverTime: new Date(clock.t).toISOString() } };
    }),
  };
  const got = [];
  const sessions = [];
  let onRevealsImpl = async (session, reveals, opts) => void got.push({ session: session.id, ids: reveals.map((r) => r.id), ...opts });
  const poller = createRevealPoller({
    transport,
    isActiveGM: () => activeGM,
    onReveals: (...a) => onRevealsImpl(...a),
    onSession: (s) => sessions.push(s?.id ?? null),
    now: () => clock.t,
    setTimer: (fn, ms) => (timers.push({ at: clock.t + ms, fn }), timers.length),
    clearTimer: (id) => (timers[id - 1] = null),
  });
  const advance = async (ms) => {
    const end = clock.t + ms;
    for (;;) {
      const i = timers.reduce((a, x, j) => (x && x.at <= end && (a < 0 || x.at < timers[a].at) ? j : a), -1);
      if (i < 0) break;
      const t = timers[i];
      timers[i] = null;
      clock.t = t.at;
      t.fn(); // not awaited: a tick may legitimately hang (the watchdog is what we test)
      for (let k = 0; k < 5; k++) await new Promise((r) => setImmediate(r));
    }
    clock.t = end;
  };
  const reveal = (sessionId, f) => server.reveals[sessionId].push({ ...f, at: clock.t });
  return { poller, server, calls, got, sessions, advance, reveal, clock, transport, setOnReveals: (fn) => (onRevealsImpl = fn) };
}

describe("reveal poller", () => {
  it("catches up on the first poll (not announced), then delivers new facts within 10 s (announced)", async () => {
    const h = harness();
    h.reveal(S1.id, fact(1));
    h.clock.t = 1000;
    h.poller.start();
    await h.advance(0);
    expect(h.got).toEqual([{ session: S1.id, ids: ["f1"], initial: true }]);
    expect(h.sessions).toEqual([S1.id]);

    await h.advance(3000);
    h.reveal(S1.id, fact(2));
    await h.advance(ACTIVE_MS);
    expect(h.got.at(-1)).toEqual({ session: S1.id, ids: ["f2"], initial: false });
  });

  it("uses serverTime as `since` and sends If-None-Match; an unchanged poll is a 304", async () => {
    const h = harness();
    h.poller.start();
    await h.advance(3 * ACTIVE_MS);
    const polls = h.calls.filter((c) => c.path.includes("/reveals"));
    expect(polls[0].path).not.toContain("since=");
    expect(polls[1].path).toContain(`since=${encodeURIComponent(new Date(0).toISOString())}`);
    expect(polls[1].headers["If-None-Match"]).toBe('W/"0"');
    expect(h.server.etagHits).toBeGreaterThan(0);
  });

  it("dedupes a fact that comes back twice", async () => {
    const h = harness();
    h.poller.start();
    await h.advance(0);
    h.reveal(S1.id, fact(1));
    await h.advance(ACTIVE_MS);
    // The server repeats it (serverTime is taken before the query).
    h.server.reveals[S1.id][0].at = h.clock.t + 1;
    await h.advance(ACTIVE_MS);
    expect(h.got.flatMap((g) => g.ids)).toEqual(["f1"]);
  });

  it("with no running session: never polls reveals, asks the campaign every 60 s, and picks one up", async () => {
    const h = harness();
    h.server.active = null;
    h.poller.start();
    await h.advance(3 * IDLE_MS - 1);
    expect(h.calls.every((c) => c.path === "/api/v1/campaign")).toBe(true);
    expect(h.calls).toHaveLength(3);
    expect(h.sessions).toEqual([null]); // the first answer always reports (→ a snapshot)
    h.server.active = S1;
    await h.advance(IDLE_MS);
    expect(h.sessions).toEqual([null, S1.id]);
    expect(h.calls.at(-1).path).toContain(`/sessions/${S1.id}/reveals`);
  });

  it("while a session runs, re-checks the campaign only every 5 minutes, and follows a change", async () => {
    const h = harness();
    h.poller.start();
    await h.advance(CAMPAIGN_REFRESH_MS - 1);
    expect(h.calls.filter((c) => c.path === "/api/v1/campaign")).toHaveLength(1);
    expect(h.calls.filter((c) => c.path.includes("/reveals")).length).toBeGreaterThanOrEqual(29);
    h.server.active = S2;
    await h.advance(ACTIVE_MS + 1);
    expect(h.sessions).toEqual([S1.id, S2.id]);
    // A fresh cursor for the new session: its first poll catches up (no `since`).
    expect(h.calls.find((c) => c.path.includes(S2.id)).path).toBe(`/api/v1/sessions/${S2.id}/reveals`);
  });

  it("a co-GM who isn't the active GM makes no requests at all", async () => {
    const h = harness({ activeGM: false });
    h.poller.start();
    await h.advance(10 * IDLE_MS);
    expect(h.calls).toHaveLength(0);
  });

  it("errors back off to 60 s instead of hammering", async () => {
    const h = harness();
    h.server.fail = new Error("offline");
    h.poller.start();
    await h.advance(5 * IDLE_MS - 1);
    expect(h.calls).toHaveLength(5);
  });

  it("a 404 (session gone) drops it and asks the campaign again", async () => {
    const h = harness();
    h.poller.start();
    await h.advance(0);
    delete h.server.reveals[S1.id];
    h.server.active = null;
    await h.advance(ACTIVE_MS);
    expect(h.poller.session).toBeNull();
    await h.advance(IDLE_MS);
    expect(h.calls.at(-1).path).toBe("/api/v1/campaign");
  });

  it("stop() stops; restart() starts over with a fresh first answer", async () => {
    const h = harness();
    h.reveal(S1.id, fact(1));
    h.clock.t = 1;
    h.poller.start();
    await h.advance(0);
    h.poller.stop();
    const n = h.calls.length;
    await h.advance(5 * IDLE_MS);
    expect(h.calls).toHaveLength(n);
    h.poller.restart();
    await h.advance(0);
    expect(h.sessions).toEqual([S1.id, S1.id]);
    expect(h.got).toEqual([{ session: S1.id, ids: ["f1"], initial: true }, { session: S1.id, ids: ["f1"], initial: true }]);
  });
});

describe("revealCardHtml", () => {
  it("escapes everything from The Long Rest (the XSS canary renders inert)", () => {
    const html = revealCardHtml(fact(1, { fact: `<img src=x onerror="alert(1)">`, sourceNpc: { id: "n", name: "<script>x</script>" } }));
    expect(html).not.toMatch(/<img|<script|onerror="/);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("reveal poller: a stuck or failing apply never stops polling or loses a fact (window 3)", () => {
  it("an apply that never resolves is abandoned by the watchdog; polling continues and the fact is re-applied", async () => {
    const h = harness();
    h.poller.start();
    await h.advance(0); // first poll (nothing yet)
    let hang = true;
    const applied = [];
    // Replace onReveals behaviour: hang forever on the first try, work afterwards.
    h.setOnReveals(async (session, reveals) => {
      if (hang) { hang = false; return new Promise(() => {}); }
      applied.push(...reveals.map((r) => r.id));
    });
    await h.advance(1); // a fact must be revealed strictly after the last serverTime cursor
    h.reveal(S1.id, fact(1));
    await h.advance(ACTIVE_MS); // this tick hangs inside onReveals
    await h.advance(TICK_TIMEOUT_MS); // the watchdog abandons it
    expect(h.poller.metrics.stalls).toBe(1);
    await h.advance(ACTIVE_MS + 1); // next tick: the SAME fact again (cursor wasn't committed)
    expect(applied).toEqual(["f1"]);
    await h.advance(1);
    h.reveal(S1.id, fact(2));
    await h.advance(ACTIVE_MS);
    expect(applied).toEqual(["f1", "f2"]); // and polling carries on
  });

  it("an apply that throws commits nothing: the fact comes back on the next tick", async () => {
    const h = harness();
    h.poller.start();
    await h.advance(0);
    let fail = true;
    const applied = [];
    h.setOnReveals(async (s, reveals) => {
      if (fail) { fail = false; throw new Error("journal locked"); }
      applied.push(...reveals.map((r) => r.id));
    });
    await h.advance(1); // a fact must be revealed strictly after the last serverTime cursor
    h.reveal(S1.id, fact(1));
    await h.advance(ACTIVE_MS);
    expect(applied).toEqual([]);
    await h.advance(IDLE_MS);
    expect(applied).toEqual(["f1"]);
  });

  it("an abandoned tick that finishes late can't commit stale state", async () => {
    const h = harness();
    h.poller.start();
    await h.advance(0);
    let release;
    let first = true;
    const applied = [];
    h.setOnReveals(async (s, reveals) => {
      applied.push(...reveals.map((r) => r.id));
      if (first) { first = false; await new Promise((r) => (release = r)); }
    });
    await h.advance(1); // a fact must be revealed strictly after the last serverTime cursor
    h.reveal(S1.id, fact(1));
    await h.advance(ACTIVE_MS);
    await h.advance(TICK_TIMEOUT_MS); // abandoned
    release(); // …now it finishes
    await h.advance(ACTIVE_MS + 1);
    // The fact was re-fetched and re-applied (idempotent by key downstream) rather than silently marked done.
    expect(applied).toEqual(["f1", "f1"]);
    expect(h.poller.metrics.applied).toBe(1);
  });
});

describe("makeAnnouncer: the chat card is best-effort", () => {
  it("a ChatMessage.create that never settles is abandoned after the timeout, logged, and doesn't throw", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const announce = makeAnnouncer({ create: () => new Promise(() => {}), warn, timeoutMs: 10_000 });
      const p = announce(fact(1));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await p).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/timed out/));
    } finally {
      vi.useRealTimers();
    }
  });

  it("a create that throws synchronously or rejects is logged, never thrown", async () => {
    const warn = vi.fn();
    expect(await makeAnnouncer({ create: () => { throw new Error("no permission"); }, warn })(fact(1))).toBe(false);
    expect(await makeAnnouncer({ create: async () => { throw new Error("invalid"); }, warn })(fact(1))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("posts the escaped card as The Long Rest", async () => {
    const create = vi.fn(async () => ({}));
    expect(await makeAnnouncer({ create })(fact(1, { fact: "<b>x</b>" }))).toBe(true);
    expect(create).toHaveBeenCalledWith({ content: expect.stringContaining("&lt;b&gt;x&lt;/b&gt;"), speaker: { alias: "The Long Rest" } });
  });
});

describe("reveal poller without a readable ETag (e.g. a proxy or CORS that hides it)", () => {
  it("never sends If-None-Match, and still delivers every fact exactly once", async () => {
    const h = harness();
    // Strip the ETag from every answer, as a browser does when it isn't exposed cross-origin.
    const inner = h.transport.request.getMockImplementation();
    h.transport.request.mockImplementation(async (req) => {
      const res = await inner(req);
      const { etag, ...headers } = res.headers ?? {};
      return { ...res, headers };
    });
    h.poller.start();
    await h.advance(0);
    await h.advance(1);
    h.reveal(S1.id, fact(1));
    await h.advance(ACTIVE_MS);
    await h.advance(1);
    h.reveal(S1.id, fact(2));
    await h.advance(3 * ACTIVE_MS);
    expect(h.got.flatMap((g) => g.ids)).toEqual(["f1", "f2"]);
    expect(h.calls.filter((c) => c.path.includes("/reveals")).every((c) => !("If-None-Match" in c.headers))).toBe(true);
    expect(h.poller.metrics.errors).toBe(0);
  });

  it("with a readable ETag, an unchanged repeat poll sends If-None-Match and gets a 304", async () => {
    const h = harness();
    h.poller.start();
    await h.advance(3 * ACTIVE_MS);
    const polls = h.calls.filter((c) => c.path.includes("/reveals"));
    expect(polls.at(-1).headers["If-None-Match"]).toBeTruthy();
    expect(h.poller.metrics.notModified).toBeGreaterThan(0);
  });
});
