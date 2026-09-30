// The import's upsert keys and names, against a Foundry fake that (like Foundry) cleans creation data
// in place. Window 7 questions: (a) what the keys are scoped by, (b) a renamed session, (c) two
// sessions of one campaign, (d) another campaign in the same world: never mixed.
import { describe, expect, it } from "vitest";

import { createConnector } from "../src/connector.js";
import { makePackage } from "./fixtures/package.js";

const CAMPAIGN_A = "00000000-0000-4000-8000-0000000000ca";
const CAMPAIGN_B = "00000000-0000-4000-8000-0000000000cb";

// Like foundry.utils.mergeObject for an update: nested objects merge, they don't replace.
function merge(target, u) {
  for (const [k, v] of Object.entries(u)) {
    if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object") merge(target[k], v);
    else target[k] = v;
  }
  return target;
}

function fakeWorld() {
  let n = 0;
  const id = () => `doc${(++n).toString().padStart(12, "0")}`;
  const withFlags = (d) => Object.assign(d, { getFlag: (_m, k) => d.flags?.["the-long-rest"]?.[k] });
  const coll = (arr) => Object.assign(arr, { find: arr.find.bind(arr), filter: arr.filter.bind(arr), getName: (nm) => arr.find((x) => x.name === nm), get size() { return arr.length; } });
  const folders = coll([]);
  const actors = coll([]);
  const journal = coll([]);
  const Folder = {
    create: async (data) => {
      const f = withFlags({ id: id(), ...JSON.parse(JSON.stringify(data)) });
      f.update = async (u) => void Object.assign(f, u);
      folders.push(f);
      return f;
    },
  };
  const makeItems = (list) => coll(list.map((i) => withFlags({ ...i, id: i._id ?? id(), _source: i })));
  const Actor = {
    create: async (data) => {
      const a = withFlags({ id: id(), ...JSON.parse(JSON.stringify(data)) });
      a._source = a;
      a.items = makeItems(a.items ?? []);
      a.update = async (u) => void merge(a, u);
      a.createEmbeddedDocuments = async (_t, items) => void a.items.push(...makeItems(items));
      a.deleteEmbeddedDocuments = async (_t, ids) => { for (const i of ids) a.items.splice(a.items.findIndex((x) => x.id === i), 1); };
      actors.push(a);
      return a;
    },
  };
  const page = (p) => { const kept = { ...p }; delete kept.key; delete p.key; return withFlags(kept); };
  const JournalEntry = {
    create: async ({ name, pages, flags, ownership }) => {
      const e = withFlags({ id: id(), name, flags, ownership, pages: coll(pages.map(page)) });
      e.update = async (u) => void Object.assign(e, u);
      e.createEmbeddedDocuments = async (_t, more) => void e.pages.push(...more.map(page));
      journal.push(e);
      return e;
    },
  };
  Actor.deleteDocuments = async (ids) => { for (const i of ids) actors.splice(actors.findIndex((a) => a.id === i), 1); };
  // Scenes with placed tokens: linked and unlinked tokens both carry actorId (their base actor).
  const scenes = [];
  const addScene = (name) => {
    const tokens = coll([]);
    const scene = {
      name, tokens,
      deleteEmbeddedDocuments: async (_t, ids) => { for (const i of ids) tokens.splice(tokens.findIndex((t) => t.id === i), 1); },
      updateEmbeddedDocuments: async (_t, updates) => {
        for (const { _id, ...u } of updates) merge(tokens.find((t) => t.id === _id), u);
        for (const u of updates) delete u._id; // Foundry cleans the data it was given
      },
    };
    scenes.push(scene);
    return scene;
  };
  // A placed token copies the prototype's art at placement (or the GM gives it its own).
  const place = (scene, actor, { linked = true, src } = {}) => {
    const t = { id: id(), actorId: actor.id, name: actor.name, actorLink: linked, texture: { src: src ?? actor.prototypeToken?.texture?.src } };
    scene.tokens.push(t);
    return t;
  };
  const game = { version: "14.368", system: { id: "dnd5e", version: "6.0.5" }, folders, actors, journal, scenes, user: { id: "gm", isGM: true }, users: { activeGM: { id: "gm" } } };
  return { game, Folder, Actor, JournalEntry, folders, actors, journal, scenes, addScene, place };
}

function connector(world, campaignId, log = () => {}) {
  return createConnector({
    game: world.game, Hooks: { on: () => 0, off: () => {} }, Actor: world.Actor, Folder: world.Folder, JournalEntry: world.JournalEntry,
    transport: async () => ({ status: 201, headers: {} }), settings: () => ({ shareNpcHp: false, sessionId: null }),
    getCampaignId: () => campaignId, log,
  });
}
const pkgFor = (sessionId, number, title) => {
  const p = makePackage();
  return { ...p, session: { ...p.session, id: sessionId, number, title } };
};
const S1 = "00000000-0000-4000-8000-0000000000d1";
const S2 = "00000000-0000-4000-8000-0000000000d2";
const roots = (w) => w.folders.filter((f) => !f.folder);

describe("import keys and names", () => {
  it("(a) keys are scoped by campaign AND session", async () => {
    const w = fakeWorld();
    await connector(w, CAMPAIGN_A).importPackage(pkgFor(S1, 1, "One"));
    expect(roots(w).map((f) => f.getFlag("the-long-rest", "key"))).toEqual([`c:${CAMPAIGN_A}:session:${S1}`]);
    expect(w.actors.every((a) => a.getFlag("the-long-rest", "key").startsWith(`c:${CAMPAIGN_A}:session:${S1}:`))).toBe(true);
  });

  it("(b) a renamed session updates its root folder and journal names, and creates nothing new", async () => {
    const w = fakeWorld();
    const c = connector(w, CAMPAIGN_A);
    await c.importPackage(pkgFor(S1, 12, "The mayor's bargain"));
    const counts = [w.folders.length, w.actors.length, w.journal.length];
    await c.importPackage(pkgFor(S1, 1, "Spike: the mayor's bargain"));
    expect([w.folders.length, w.actors.length, w.journal.length]).toEqual(counts);
    expect(roots(w).map((f) => f.name)).toEqual(["TLR · Session 1: Spike: the mayor's bargain"]);
    expect(w.journal[0].name).toBe("TLR · Session 1: Reveals");
  });

  it("(c) two sessions of one campaign get separate roots, journals and actors, even for the same monster", async () => {
    const w = fakeWorld();
    const c = connector(w, CAMPAIGN_A);
    await c.importPackage(pkgFor(S1, 1, "One"));
    const firstActors = w.actors.length;
    await c.importPackage(pkgFor(S2, 2, "Two"));
    expect(roots(w).map((f) => f.name).sort()).toEqual(["TLR · Session 1: One", "TLR · Session 2: Two"]);
    expect(w.journal.map((j) => j.name).sort()).toEqual(["TLR · Session 1: Reveals", "TLR · Session 2: Reveals"]);
    expect(w.actors.length).toBe(2 * firstActors); // session 1's actors were not moved or reused
    const root1 = roots(w).find((f) => f.name.endsWith("One")).id;
    const inS1 = w.folders.filter((f) => f.folder === root1).map((f) => f.id);
    expect(w.actors.filter((a) => inS1.includes(a.folder)).length).toBe(firstActors);
  });

  it("(d) another campaign's prep in the same world is never touched or mixed in", async () => {
    const w = fakeWorld();
    await connector(w, CAMPAIGN_A).importPackage(pkgFor(S1, 1, "Campaign A"));
    const snapshotA = JSON.stringify(w.actors.map((a) => [a.id, a.folder, a.name]));
    await connector(w, CAMPAIGN_B).importPackage(pkgFor(S1, 1, "Campaign B")); // even the SAME session id
    expect(JSON.stringify(w.actors.slice(0, JSON.parse(snapshotA).length).map((a) => [a.id, a.folder, a.name]))).toBe(snapshotA);
    expect(roots(w).map((f) => f.name).sort()).toEqual(["TLR · Session 1: Campaign A", "TLR · Session 1: Campaign B"]);
  });

  it("refuses to import without a connected campaign", async () => {
    await expect(connector(fakeWorld(), null).importPackage(pkgFor(S1, 1, "One"))).rejects.toThrow(/campaign/i);
  });
});

describe("the import report says what the package contained (v0.1.1)", () => {
  it("an empty package: all counts 0 (so the GM is told why, not '0 created 0 updated')", async () => {
    const w = fakeWorld();
    const p = pkgFor(S1, 1, "Empty");
    const r = await connector(w, CAMPAIGN_A).importPackage({ ...p, npcs: [], encounters: [{ id: "00000000-0000-4000-8000-0000000000e9", name: "Unlinked", monsters: [] }], reveals: [] });
    expect(r.counts).toEqual({ npcs: 0, encounterActors: 0, basicActors: 0, reveals: 0 });
    expect(r.created).toBe(0);
  });

  it("counts NPCs, encounter creatures (incl. typed-in basic actors) and reveals", async () => {
    const w = fakeWorld();
    const p = pkgFor(S1, 1, "Full");
    const r = await connector(w, CAMPAIGN_A).importPackage(p);
    expect(r.counts.npcs).toBe(p.npcs.length);
    expect(r.counts.encounterActors).toBe(p.encounters.flatMap((e) => e.monsters).length);
    expect(r.counts.basicActors).toBe(p.encounters.flatMap((e) => e.monsters).filter((m) => !m.monster).length);
    expect(r.counts.basicActors).toBeGreaterThan(0); // the fixture has a typed-in combatant
    expect(r.counts.reveals).toBe(p.reveals.length);
  });
});

describe("re-import prunes NPCs that are no longer player-visible (v0.1.3)", () => {
  const npcKey = (a) => a.getFlag("the-long-rest", "key");
  const npcsOf = (w, cid, sid) => w.actors.filter((a) => npcKey(a)?.startsWith(`c:${cid}:session:${sid}:npc:`));

  it("an NPC set back to Hidden: its actor AND its tokens (linked and unlinked, every scene) are removed", async () => {
    const w = fakeWorld();
    const lines = [];
    const c = connector(w, CAMPAIGN_A, (m) => lines.push(m));
    const full = pkgFor(S1, 1, "One");
    await c.importPackage(full, { sessionId: S1 });
    const [gone, kept] = npcsOf(w, CAMPAIGN_A, S1);
    const s1 = w.addScene("Tavern");
    const s2 = w.addScene("Road");
    w.place(s1, gone);
    w.place(s2, gone, { linked: false });
    w.place(s1, kept);
    const hidden = { ...full, npcs: full.npcs.filter((n) => !npcKey(gone).endsWith(n.id)) };
    const r = await c.importPackage(hidden, { sessionId: S1 });
    expect(r.removed).toEqual({ npcs: 1, tokens: 2 });
    expect(w.actors).not.toContain(gone);
    expect(w.actors).toContain(kept);
    expect([...s1.tokens, ...s2.tokens].map((t) => t.actorId)).toEqual([kept.id]);
    expect(lines.join("\n")).toContain(gone.name); // names go to the GM console only…
    expect(JSON.stringify(r)).not.toContain(gone.name); // …never into the report (the notice)
  });

  it("everything hidden (an EMPTY package) removes all of the session's NPCs", async () => {
    const w = fakeWorld();
    const c = connector(w, CAMPAIGN_A);
    const full = pkgFor(S1, 1, "One");
    await c.importPackage(full, { sessionId: S1 });
    const r = await c.importPackage({ ...full, npcs: [], encounters: [], reveals: [] }, { sessionId: S1 });
    expect(r.removed.npcs).toBe(full.npcs.length);
    expect(npcsOf(w, CAMPAIGN_A, S1)).toEqual([]);
    expect(r.counts).toMatchObject({ npcs: 0, encounterActors: 0, reveals: 0 });
  });

  it("never touches another session's, another campaign's, encounter monsters, or hand-made actors", async () => {
    const w = fakeWorld();
    const full = pkgFor(S1, 1, "One");
    await connector(w, CAMPAIGN_A).importPackage(full, { sessionId: S1 });
    await connector(w, CAMPAIGN_A).importPackage(pkgFor(S2, 2, "Two"), { sessionId: S2 });
    await connector(w, CAMPAIGN_B).importPackage(pkgFor(S1, 1, "Other campaign"), { sessionId: S1 });
    const handMade = await w.Actor.create({ name: full.npcs[0].name, type: "npc" }); // same name, no flag
    const monsters = w.actors.filter((a) => npcKey(a)?.includes(":monster:") || npcKey(a)?.includes(":combatant:"));
    const before = new Set(w.actors.map((a) => a.id));
    const r = await connector(w, CAMPAIGN_A).importPackage({ ...full, npcs: [] }, { sessionId: S1 });
    const removedIds = [...before].filter((i) => !w.actors.some((a) => a.id === i));
    expect(removedIds.length).toBe(r.removed.npcs);
    expect(npcsOf(w, CAMPAIGN_A, S2)).toHaveLength(full.npcs.length);
    expect(npcsOf(w, CAMPAIGN_B, S1)).toHaveLength(full.npcs.length);
    expect(w.actors).toContain(handMade);
    for (const m of monsters) expect(w.actors).toContain(m);
  });

  it("a mismatched session, a missing session id, or a failed actor removes nothing", async () => {
    const w = fakeWorld();
    const c = connector(w, CAMPAIGN_A);
    const full = pkgFor(S1, 1, "One");
    await c.importPackage(full, { sessionId: S1 });
    const n = w.actors.length;
    const none = { ...full, npcs: [] };
    expect((await c.importPackage(none, { sessionId: S2 })).removed.npcs).toBe(0); // the package isn't S2's
    expect((await c.importPackage(none)).removed.npcs).toBe(0); // no requested session
    const broken = { ...full, npcs: [], encounters: [{ ...full.encounters[0], monsters: [{ name: "Broken", count: 1, monster: { id: "x", statblock: null } }] }] };
    const origCreate = w.Actor.create;
    w.Actor.create = async (d) => { if (d.name === "Broken") throw new Error("boom"); return origCreate(d); };
    const r = await c.importPackage(broken, { sessionId: S1 });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.removed.npcs).toBe(0);
    expect(r.pruneSkipped).toMatch(/failed/);
    expect(npcsOf(w, CAMPAIGN_A, S1)).toHaveLength(full.npcs.length);
    expect(w.actors.length).toBeGreaterThanOrEqual(n);
  });
});


describe("NPC portraits on the actor, its prototype token and placed tokens (v0.1.5)", () => {
  const OLD = "https://cdn.example.test/portraits/old.webp";
  const NEW = "https://cdn.example.test/portraits/new.webp";
  const CUSTOM = "worlds/art/gm-own-token.webp";
  const withPortrait = (p, url) => ({ ...p, npcs: p.npcs.map((n, i) => (i === 0 ? { ...n, avatarUrl: url } : n)) });
  const npcs = (w) => w.actors.filter((a) => a.getFlag("the-long-rest", "key")?.includes(":npc:"));

  it("a new NPC actor's prototype token uses the portrait; anything not https falls back for both", async () => {
    const w = fakeWorld();
    const p = pkgFor(S1, 1, "One");
    await connector(w, CAMPAIGN_A).importPackage({ ...p, npcs: [{ ...p.npcs[0], avatarUrl: OLD }, { ...p.npcs[1], avatarUrl: "javascript:alert(1)" }] });
    const [a, b] = npcs(w);
    expect(a.img).toBe(OLD);
    expect(a.prototypeToken.texture.src).toBe(OLD);
    expect(b.img).toBe("icons/svg/mystery-man.svg");
    expect(b.prototypeToken.texture.src).toBe("icons/svg/mystery-man.svg");
    for (const bad of ["http://x.test/a.webp", "data:image/png;base64,AA", "//x.test/a.webp", 42]) {
      const w2 = fakeWorld();
      await connector(w2, CAMPAIGN_A).importPackage(withPortrait(p, bad));
      expect(npcs(w2)[0].prototypeToken.texture.src, String(bad)).toBe("icons/svg/mystery-man.svg");
    }
  });

  it("a CHANGED portrait updates the actor, its prototype token and placed tokens still showing the old one", async () => {
    const w = fakeWorld();
    const c = connector(w, CAMPAIGN_A);
    const p = pkgFor(S1, 1, "One");
    await c.importPackage(withPortrait(p, OLD), { sessionId: S1 });
    const [npc, other] = npcs(w);
    const tavern = w.addScene("Tavern");
    const road = w.addScene("Road");
    const linked = w.place(tavern, npc);
    const unlinked = w.place(road, npc, { linked: false });
    const custom = w.place(road, npc, { src: CUSTOM });
    const otherTok = w.place(tavern, other, { src: OLD }); // another actor that happens to share the old art
    const r = await c.importPackage(withPortrait(p, NEW), { sessionId: S1 });
    expect(npc.img).toBe(NEW);
    expect(npc.prototypeToken.texture.src).toBe(NEW);
    expect(npc.prototypeToken.actorLink).toBe(true); // merged, not replaced
    expect(linked.texture.src).toBe(NEW);
    expect(unlinked.texture.src).toBe(NEW);
    expect(custom.texture.src).toBe(CUSTOM); // the GM's own token art is never overwritten
    expect(otherTok.texture.src).toBe(OLD); // only THIS actor's tokens
    expect(r.portraits).toEqual({ actors: 1, tokens: 2 });
    // And a portrait REMOVED in TLR goes back to the default, for tokens that still showed it.
    const r2 = await c.importPackage(withPortrait(p, null), { sessionId: S1 });
    expect(npc.img).toBe("icons/svg/mystery-man.svg");
    expect(linked.texture.src).toBe("icons/svg/mystery-man.svg");
    expect(r2.portraits).toEqual({ actors: 1, tokens: 2 });
  });

  it("an UNCHANGED portrait leaves the GM's own actor image and token art alone", async () => {
    const w = fakeWorld();
    const c = connector(w, CAMPAIGN_A);
    const p = withPortrait(pkgFor(S1, 1, "One"), OLD);
    await c.importPackage(p, { sessionId: S1 });
    const [npc] = npcs(w);
    await npc.update({ img: CUSTOM, prototypeToken: { texture: { src: CUSTOM } } }); // the GM's edit
    const r = await c.importPackage(p, { sessionId: S1 });
    expect(npc.img).toBe(CUSTOM);
    expect(npc.prototypeToken.texture.src).toBe(CUSTOM);
    expect(r.portraits).toEqual({ actors: 0, tokens: 0 });
    expect(r.updated).toBeGreaterThan(0);
  });

  it("an actor imported before 0.1.5 (no portrait flag): its img counts as the old portrait", async () => {
    const w = fakeWorld();
    const c = connector(w, CAMPAIGN_A);
    const p = pkgFor(S1, 1, "One");
    await c.importPackage(withPortrait(p, OLD), { sessionId: S1 });
    const [npc] = npcs(w);
    delete npc.flags["the-long-rest"].portrait;
    const tok = w.place(w.addScene("Tavern"), npc, { src: OLD });
    const r = await c.importPackage(withPortrait(p, NEW), { sessionId: S1 });
    expect(tok.texture.src).toBe(NEW);
    expect(npc.getFlag("the-long-rest", "portrait")).toBe(NEW);
    expect(r.portraits).toEqual({ actors: 1, tokens: 1 });
  });
});
