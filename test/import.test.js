// The import's upsert keys and names, against a Foundry fake that (like Foundry) cleans creation data
// in place. Window 7 questions: (a) what the keys are scoped by, (b) a renamed session, (c) two
// sessions of one campaign, (d) another campaign in the same world: never mixed.
import { describe, expect, it } from "vitest";

import { createConnector } from "../src/connector.js";
import { makePackage } from "./fixtures/package.js";

const CAMPAIGN_A = "00000000-0000-4000-8000-0000000000ca";
const CAMPAIGN_B = "00000000-0000-4000-8000-0000000000cb";

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
      a.update = async (u) => void Object.assign(a, u);
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
  const game = { version: "14.368", system: { id: "dnd5e", version: "6.0.5" }, folders, actors, journal, user: { id: "gm", isGM: true }, users: { activeGM: { id: "gm" } } };
  return { game, Folder, Actor, JournalEntry, folders, actors, journal };
}

function connector(world, campaignId) {
  return createConnector({
    game: world.game, Hooks: { on: () => 0, off: () => {} }, Actor: world.Actor, Folder: world.Folder, JournalEntry: world.JournalEntry,
    transport: async () => ({ status: 201, headers: {} }), settings: () => ({ shareNpcHp: false, sessionId: null }),
    getCampaignId: () => campaignId, log: () => {},
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

