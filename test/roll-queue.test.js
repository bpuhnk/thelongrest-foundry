import { describe, expect, it } from "vitest";

import { Pusher } from "../src/push.js";
import { QUEUE_CAP, QUEUE_TTL_MS, RollQueue, memoryStorage, queueKey } from "../src/roll-queue.js";

const roll = (n, o = {}) => ({ id: `msg${n}:0`, actor: "Hero", total: n, ...o });
const KEY = queueKey("world", "gm");

/** A Pusher on a fake clock whose sends are answered by `answer(kind, payload)`. */
function harness({ storage, answer = () => ({ status: 201 }), clock = { t: 0 } }) {
  const sent = [];
  const timers = [];
  const queue = new RollQueue({ storage, key: KEY, now: () => clock.t });
  const p = new Pusher({
    build: () => ({}),
    send: async (kind, payload) => (sent.push({ kind, payload }), answer(kind, payload)),
    rollQueue: queue,
    now: () => clock.t,
    setTimer: (fn, ms) => (timers.push({ at: clock.t + ms, fn }), timers.length),
    clearTimer: (id) => (timers[id - 1] = null),
  });
  const advance = async (ms) => {
    const end = clock.t + ms;
    for (;;) {
      const i = timers.findIndex((x) => x && x.at <= end);
      if (i < 0) break;
      const next = timers.reduce((a, x, j) => (x && x.at <= end && (a < 0 || x.at < timers[a].at) ? j : a), -1);
      const t = timers[next];
      timers[next] = null;
      clock.t = t.at;
      t.fn();
      await new Promise((r) => setImmediate(r));
    }
    clock.t = end;
  };
  return { p, queue, sent, advance, clock };
}

describe("RollQueue", () => {
  it("survives a reload: what was queued comes back from storage", () => {
    const storage = memoryStorage();
    new RollQueue({ storage, key: KEY }).add([roll(1), roll(2)]);
    const after = new RollQueue({ storage, key: KEY });
    expect(after.peek(40).map((e) => e.roll.total)).toEqual([1, 2]);
  });

  it("skips a roll whose id is already queued, and invalid rolls", () => {
    const q = new RollQueue();
    q.add([roll(1), roll(1), { actor: "x" }, null, { id: "y", total: 3 }]);
    expect(q.size).toBe(1);
  });

  it("caps at 200 (the oldest go) and 15 minutes", () => {
    const clock = { t: 0 };
    const q = new RollQueue({ now: () => clock.t });
    expect(q.add(Array.from({ length: QUEUE_CAP + 5 }, (_, i) => roll(i)))).toBe(5);
    expect(q.peek(1)[0].roll.total).toBe(5);
    clock.t = QUEUE_TTL_MS + 1;
    expect(q.peek(40)).toEqual([]);
  });

  it("ignores corrupt storage and keeps working when storage refuses writes", () => {
    const storage = memoryStorage();
    storage.setItem(KEY, "{not json");
    const q = new RollQueue({ storage, key: KEY });
    expect(q.size).toBe(0);
    const full = { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); }, removeItem: () => {} };
    const q2 = new RollQueue({ storage: full, key: KEY });
    q2.add([roll(1)]);
    expect(q2.peek(40)).toHaveLength(1);
  });

  it("only ever stores roll data under the documented key (no token, nothing else)", () => {
    const writes = [];
    const storage = { ...memoryStorage(), setItem: (k, v) => writes.push([k, v]) };
    new RollQueue({ storage, key: KEY }).add([roll(1)]);
    expect(writes.map(([k]) => k)).toEqual(["tlr-connector:pending-rolls:world:gm"]);
    expect(writes[0][1]).not.toMatch(/tlr_|Bearer/);
  });
});

describe("Pusher + RollQueue: nothing lost across a reload", () => {
  it("a reload inside the debounce loses no rolls, and they go after ready", async () => {
    const storage = memoryStorage();
    const a = harness({ storage });
    a.p.queueRolls([roll(1), roll(2)]);
    await a.advance(500); // the page reloads before the 1 s debounce fires
    expect(a.sent).toHaveLength(0);

    const b = harness({ storage, clock: a.clock });
    b.p.resume();
    await b.advance(2000);
    expect(b.sent.flatMap((s) => s.payload.rolls.map((r) => r.id))).toEqual(["msg1:0", "msg2:0"]);
    expect(b.queue.size).toBe(0);
    expect(new RollQueue({ storage, key: KEY }).size).toBe(0);
  });

  it("a batch leaves the queue only on 2xx: a network error or a 5xx keeps it for the resend", async () => {
    const storage = memoryStorage();
    let fail = 2;
    const h = harness({ storage, answer: () => (fail-- === 2 ? Promise.reject(new Error("offline")) : fail >= 0 ? { status: 503 } : { status: 201 }) });
    h.p.queueRolls([roll(1)]);
    await h.advance(1000);
    expect(h.queue.size).toBe(1);
    await h.advance(30_000);
    expect(h.queue.size).toBe(1);
    await h.advance(30_000);
    expect(h.queue.size).toBe(0);
    expect(h.sent.map((s) => s.payload.rolls[0].id)).toEqual(["msg1:0", "msg1:0", "msg1:0"]); // same id: readers dedupe
  });

  it("a 400 drops that batch (it would be refused forever); a 401 keeps it", async () => {
    const h400 = harness({ storage: memoryStorage(), answer: () => ({ status: 400 }) });
    h400.p.queueRolls([roll(1)]);
    await h400.advance(1000);
    expect(h400.queue.size).toBe(0);
    expect(h400.p.metrics.droppedRolls).toBe(1);

    const h401 = harness({ storage: memoryStorage(), answer: () => ({ status: 401 }) });
    h401.p.queueRolls([roll(1)]);
    await h401.advance(60_000);
    expect(h401.queue.size).toBe(1);
    expect(h401.sent).toHaveLength(1); // no retry loop against a refused token
  });
});
