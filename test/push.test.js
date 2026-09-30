import assert from "node:assert/strict";

import { test } from "vitest";

import { combatPayload, effectsPayload, hpPayload, initiativePayload, Pusher, rollsFromMessage } from "../src/push.js";
import { accepts } from "./contract.js";

const c = (id, name, o = {}) => ({
  id, name, hidden: false, initiative: 10, isPC: false, defeated: false, hp: 7, maxHp: 7, ac: 15, conditions: [], ...o,
});
const combat = {
  name: "Cult ambush", round: 3, activeId: "patron",
  combatants: [
    c("hero", "Hero", { isPC: true, hp: 40, maxHp: 50, ac: 14, initiative: 18 }),
    c("g1", "Goblin 1", { initiative: 12, hp: 2 }),
    c("patron", "The Veiled Patron", { hidden: true, initiative: 20, hp: 66, maxHp: 66 }),
    c("g2", "Goblin 2", { defeated: true, hp: 0, initiative: 9 }),
  ],
};

test("COMBAT: hidden combatants never appear (not even as the active one); NPC HP withheld by default", () => {
  const p = combatPayload(combat);
  const json = JSON.stringify(p);
  assert.doesNotMatch(json, /Veiled Patron/);
  assert.equal(p.activeCombatant, undefined);
  assert.deepEqual(p.combatants.map((x) => x.name), ["Hero", "Goblin 1", "Goblin 2"]);
  assert.equal(p.combatants[1].hp, undefined);
  assert.equal(p.combatants[2].defeated, true);
  assert.equal(p.combatants[0].hp, 40);
  assert.ok(accepts("COMBAT", p));
  assert.equal(combatPayload(combat, { shareNpcHp: true }).combatants[1].hp, 2);
  assert.deepEqual(combatPayload(null), { combatants: [] });
});

test("INITIATIVE and HP follow the same rules and pass the real schema", () => {
  const i = initiativePayload(combat);
  assert.deepEqual(i.order.map((x) => x.name), ["Hero", "Goblin 1", "Goblin 2"]);
  const h = hpPayload(combat.combatants);
  assert.deepEqual(h.entries, [{ name: "Hero", hp: 40, maxHp: 50 }]);
  assert.ok(accepts("INITIATIVE", i));
  assert.ok(accepts("HP", h));
});

const msg = (o = {}) => ({
  id: "m", whisper: [], blind: false, speakerHidden: false, speaker: "Hero", user: "Player", flavor: "<b>Greataxe</b> - Attack Roll",
  rollType: "attack", at: 0, rolls: [{ formula: "1d20 + 7", total: 19, dice: [{ faces: 20, results: [12] }] }], ...o,
});

test("ROLL: whispered, blind and hidden-speaker rolls never leave Foundry", () => {
  assert.equal(rollsFromMessage(msg({ whisper: ["gm"] })).length, 0);
  assert.equal(rollsFromMessage(msg({ blind: true })).length, 0);
  assert.equal(rollsFromMessage(msg({ speakerHidden: true, speaker: "The Veiled Patron" })).length, 0);
  assert.equal(rollsFromMessage(msg({ rolls: [] })).length, 0);
  const [r] = rollsFromMessage(msg());
  assert.equal(r.label, "Greataxe - Attack Roll");
  assert.deepEqual(r.dice, [{ faces: 20, results: [12] }]);
  assert.ok(accepts("ROLL", { rolls: [r] }));
  assert.deepEqual(Object.keys(r).sort(), ["actor", "at", "dice", "flavor", "formula", "id", "label", "rollType", "total", "user"]);
  assert.equal(r.id, "m:0");
  assert.equal(r.flavor, "Greataxe - Attack Roll");
});

test("EFFECTS prototype: hidden creatures omitted, optional fields only when present", () => {
  const p = effectsPayload([
    { name: "Hero", hidden: false, effects: [{ name: "Frightened", statusId: "frightened", source: null, startRound: 3, rounds: null, seconds: null }] },
    { name: "The Veiled Patron", hidden: true, effects: [{ name: "Invisible", statusId: "invisible", source: null, startRound: 1, rounds: null, seconds: null }] },
  ], 3);
  assert.deepEqual(p, { round: 3, creatures: [{ actor: "Hero", effects: [{ name: "Frightened", statusId: "frightened", roundApplied: 3 }] }] });
});

// A controllable clock for the coalescer.
function harness(sendImpl) {
  let now = 0;
  let timers = [];
  let seq = 0;
  const sent = [];
  const p = new Pusher({
    build: (kind) => ({ kind, snapshotAt: now }),
    send: async (kind, payload) => {
      sent.push({ kind, payload, at: now });
      return sendImpl ? sendImpl(kind, payload) : { status: 201 };
    },
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimer: (id) => { timers = timers.filter((t) => t.id !== id); },
    debounceMs: 1000,
    budgetPerMin: 50,
  });
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      now = next.at;
      next.fn();
      await new Promise((r) => setImmediate(r));
    }
    now = end;
  };
  return { p, sent, advance };
}

test("coalescer: a burst of marks becomes one push of the newest snapshot, after 1 s of quiet", async () => {
  const { p, sent, advance } = harness();
  for (let i = 0; i < 20; i++) { p.mark("HP"); await advance(100); }
  assert.equal(sent.length, 0);
  await advance(1000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.snapshotAt, 2900);
});

test("coalescer: never more than the budget per minute, and the final state still lands", async () => {
  const { p, sent, advance } = harness();
  for (let i = 0; i < 300; i++) { p.mark(["COMBAT", "HP", "INITIATIVE", "SCENE", "EFFECTS"][i % 5]); await advance(1100); }
  await advance(120_000);
  const windows = sent.map((s) => sent.filter((x) => x.at > s.at - 60_000 && x.at <= s.at).length);
  assert.ok(Math.max(...windows) <= 50, `peak ${Math.max(...windows)}/min`);
  assert.ok(p.metrics.throttled > 0);
  const last = sent.filter((s) => s.kind === "HP").at(-1);
  assert.ok(last.payload.snapshotAt > 300 * 1100 - 5000, "the newest HP snapshot was sent");
});

test("coalescer: a 429 pauses everything until Retry-After, then resends", async () => {
  let first = true;
  const { p, sent, advance } = harness(() => (first ? ((first = false), { status: 429, retryAfter: 20 }) : { status: 201 }));
  p.mark("COMBAT");
  await advance(1000);
  p.mark("HP");
  await advance(5000);
  assert.equal(sent.length, 1);
  await advance(20_000);
  assert.deepEqual(sent.map((s) => s.kind).sort(), ["COMBAT", "COMBAT", "HP"]);
  assert.equal(p.metrics.rateLimited, 1);
});

test("coalescer: rolls are events, batched ≤ 40 per push, none lost", async () => {
  const { p, sent, advance } = harness();
  const roll = (n) => ({ actor: "A", total: n });
  p.queueRolls(Array.from({ length: 95 }, (_, i) => roll(i)));
  await advance(10_000);
  const all = sent.filter((s) => s.kind === "ROLL").flatMap((s) => s.payload.rolls.map((r) => r.total));
  assert.equal(all.length, 95);
  assert.ok(sent.every((s) => s.payload.rolls.length <= 40));
});

test("default timers survive the browser's 'Illegal invocation' rule (setTimeout needs the global this)", async () => {
  const real = globalThis.setTimeout;
  const strict = function (fn, ms) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return real(fn, ms);
  };
  globalThis.setTimeout = strict;
  try {
    const p = new Pusher({ build: () => ({}), send: async () => ({ status: 201 }) });
    assert.doesNotThrow(() => p.mark("HP"));
  } finally {
    globalThis.setTimeout = real;
  }
});
