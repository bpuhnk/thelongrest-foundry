import { describe, expect, it, vi } from "vitest";

import { createConnector } from "../src/connector.js";
import { memoryStorage, RollQueue } from "../src/roll-queue.js";
import { accepts } from "./contract.js";
import { actor, chatMessage, combatant, makeGame, makeHooks } from "./fixtures/foundry.js";

const CANARY = "HIDDEN-CANARY";

/** A connector on real timers is awkward; drive the Pusher by flushing each kind directly. */
function setup({ activeGM = true, enabled = true, shareNpcHp = false } = {}) {
  const hero = actor("a-hero", "Ada", { pc: true, hp: 21, max: 30, effects: [{ name: "Blessed", statuses: ["blessed"] }] });
  const goblin = actor("a-gob", "Goblin", { hp: 4, max: 7, effects: [{ name: "Frightened", statuses: ["frightened"], round: 2 }] });
  const lurker = actor("a-lurk", CANARY, { hp: 99, max: 99, effects: [{ name: `${CANARY}-EFFECT`, statuses: ["invisible"] }] });
  const fighters = [combatant("c-hero", hero, { initiative: 18 }), combatant("c-gob", goblin, { initiative: 12 }), combatant("c-lurk", lurker, { hidden: true, initiative: 25 })];
  const { game, JournalEntry, journal, fight } = makeGame({ activeGM, fighters });
  fight.combatant = fighters[2]; // the HIDDEN creature is the one acting
  const Hooks = makeHooks();
  const calls = [];
  const transport = vi.fn(async (req) => (calls.push(req), { status: 201, headers: {}, body: {} }));
  const queue = new RollQueue({ storage: memoryStorage() });
  const connector = createConnector({
    game, Hooks, Actor: {}, Folder: {}, JournalEntry, transport,
    settings: () => ({ shareNpcHp, sessionId: "00000000-0000-4000-8000-00000000a001" }),
    getCampaignId: () => "00000000-0000-4000-8000-0000000000ca",
    enabled: () => enabled, rollQueue: queue, moduleVersion: "0.1.0", log: () => {},
  });
  connector.registerHooks();
  return { connector, Hooks, calls, queue, journal, game };
}

/** Let every pending push go (the Pusher uses real timers with a 1 s debounce). */
async function drain() {
  await vi.advanceTimersByTimeAsync(5_000);
}

describe("connector: the hidden-information rules, end to end", () => {
  it("a full combat round sends only what the table may see, and every payload matches the contract", async () => {
    vi.useFakeTimers();
    try {
      const { Hooks, calls } = setup();
      Hooks.call("combatStart");
      Hooks.call("updateActor");
      Hooks.call("createActiveEffect");
      Hooks.call("createChatMessage", chatMessage("m1"));
      Hooks.call("createChatMessage", chatMessage("m2", { whisper: ["gm1"] }));
      Hooks.call("createChatMessage", chatMessage("m3", { blind: true }));
      Hooks.call("createChatMessage", chatMessage("m4", { speaker: "Hidden Watcher", token: "tok-hidden" }));
      await drain();

      const kinds = calls.map((c) => c.body.kind).sort();
      expect(kinds).toEqual(["COMBAT", "EFFECTS", "HP", "INITIATIVE", "ROLL"]);
      for (const c of calls) {
        expect(accepts(c.body.kind, c.body.payload), c.body.kind).toBe(true);
        expect(JSON.stringify(c.body), c.body.kind).not.toContain(CANARY);
        expect(c.body.sessionId).toBe("00000000-0000-4000-8000-00000000a001");
      }
      const by = Object.fromEntries(calls.map((c) => [c.body.kind, c.body.payload]));
      expect(by.COMBAT.activeCombatant).toBeUndefined(); // the acting creature is hidden
      expect(by.COMBAT.combatants.find((x) => x.name === "Goblin")).not.toHaveProperty("hp"); // NPC HP off by default
      expect(by.HP.entries).toEqual([{ name: "Ada", hp: 21, maxHp: 30 }]);
      expect(by.EFFECTS.creatures.map((x) => x.actor).sort()).toEqual(["Ada", "Goblin"]);
      expect(by.EFFECTS.round).toBe(2); // the players' fight, not the GM's previewed scene
      expect(by.ROLL.rolls.map((r) => r.id)).toEqual(["m1:0"]);
      expect(by.ROLL.rolls[0]).toMatchObject({ rollType: "attack", user: "Player One", dice: [{ faces: 20, results: [12] }] });
      expect(calls.every((c) => c.method === "POST" && c.path === "/api/v1/live-state")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("NPC HP only with the toggle", async () => {
    vi.useFakeTimers();
    try {
      const { Hooks, calls } = setup({ shareNpcHp: true });
      Hooks.call("updateActor");
      await drain();
      const hp = calls.find((c) => c.body.kind === "HP").body.payload.entries;
      expect(hp.map((e) => e.name).sort()).toEqual(["Ada", "Goblin"]); // still never the hidden one
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["a co-GM who isn't the active GM", { activeGM: false }],
    ["a world that isn't connected", { enabled: false }],
  ])("%s sends nothing and queues nothing", async (_l, opts) => {
    vi.useFakeTimers();
    try {
      const { Hooks, calls, queue } = setup(opts);
      Hooks.call("combatStart");
      Hooks.call("createChatMessage", chatMessage("m1"));
      await drain();
      expect(calls).toHaveLength(0);
      expect(queue.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose() unhooks everything", async () => {
    vi.useFakeTimers();
    try {
      const { Hooks, calls, connector } = setup();
      connector.dispose();
      Hooks.call("combatStart");
      Hooks.call("createChatMessage", chatMessage("m1"));
      await drain();
      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("connector: reveals", () => {
  const session = { id: "00000000-0000-4000-8000-00000000a001", number: 3, title: "The Pass" };
  const fact = (id, text) => ({ id, fact: text, revealedAt: "2026-09-29T20:00:00.000Z", sourceNpc: null });

  it("adds each fact once to the session's reveals journal and reports which were new", async () => {
    const { connector, journal } = setup();
    expect(await connector.applyReveals(session, [fact("f1", "One"), fact("f2", "Two")])).toEqual({ created: 2, freshIds: ["f1", "f2"] });
    expect(await connector.applyReveals(session, [fact("f2", "Two"), fact("f3", "Three")])).toEqual({ created: 1, freshIds: ["f3"] });
    expect(journal).toHaveLength(1);
    expect(journal[0].name).toBe("TLR · Session 3: Reveals");
    expect(journal[0].pages.map((p) => p.name)).toEqual(["One", "Two", "Three"]);
  });

  it("the stub's exact reveal shapes (sourceNpc null and set) survive Foundry's in-place cleaning (window 4)", async () => {
    const { connector, journal } = setup();
    const stubShape = [
      { id: "5a1c0000-0000-4000-8000-0000000000a1", fact: "Odo paid the smugglers", revealedAt: "2026-09-28T20:14:00.000Z", sourceNpc: { id: "5a1c0000-0000-4000-8000-00000000000d", name: "Mayor Odo" } },
      { id: "a08880dd-59d0-412f-83bb-5c3f102ca038", fact: "E2E reveal one", revealedAt: "2026-09-30T12:55:24.000Z", sourceNpc: null },
    ];
    // First call creates the journal (JournalEntry.create), the second adds to it (createEmbeddedDocuments):
    // both paths are cleaned in place by the fake, as by Foundry.
    expect(await connector.applyReveals(session, stubShape.slice(0, 1))).toEqual({ created: 1, freshIds: [stubShape[0].id] });
    expect(await connector.applyReveals(session, stubShape)).toEqual({ created: 1, freshIds: [stubShape[1].id] });
    expect(journal[0].pages.map((p) => p.getFlag("the-long-rest", "key"))).toEqual([`reveal:${stubShape[0].id}`, `reveal:${stubShape[1].id}`]);
    expect(journal[0].pages[0].text.content).toContain("Source: Mayor Odo");
  });

  it("never mutates the caller's reveal objects", async () => {
    const { connector } = setup();
    const r = fact("f1", "One");
    const before = JSON.stringify(r);
    await connector.applyReveals(session, [r]);
    await connector.applyReveals(session, [r, fact("f2", "Two")]);
    expect(JSON.stringify(r)).toBe(before);
  });

  it("a fact's HTML is escaped in the journal page (the XSS canary renders inert)", async () => {
    const { connector, journal } = setup();
    await connector.applyReveals(session, [fact("x", `<img src=x onerror="alert(1)">`)]);
    expect(journal[0].pages[0].text.content).not.toMatch(/<img/);
  });
});

describe("connector: reveals are scoped to the connected campaign's session journal", () => {
  it("the journal key is (campaign, session): another campaign's same-id session gets its own journal", async () => {
    const hooks = makeHooks();
    const { game, JournalEntry, journal } = makeGame({});
    const mk = (cid) => createConnector({ game, Hooks: hooks, Actor: {}, Folder: {}, JournalEntry, transport: async () => ({ status: 201, headers: {} }), settings: () => ({}), getCampaignId: () => cid, log: () => {} });
    const session = { id: "00000000-0000-4000-8000-00000000a001", number: 1, title: "One" };
    const f = (id) => ({ id, fact: id, revealedAt: "2026-09-30T00:00:00.000Z", sourceNpc: null });
    await mk("00000000-0000-4000-8000-0000000000ca").applyReveals(session, [f("a1")]);
    await mk("00000000-0000-4000-8000-0000000000cb").applyReveals(session, [f("b1")]);
    expect(journal).toHaveLength(2);
    expect(journal.map((j) => j.pages.map((p) => p.name))).toEqual([["a1"], ["b1"]]);
  });
});
