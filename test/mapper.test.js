import { describe, expect, it, test } from "vitest";

import { escapeHtml, foundryId, movementSpeeds, parseAttack, planFromPackage, reimportHp, revealPage, senseRanges, structuredAttack } from "../src/mapper.js";
import { IDS, makePackage, npcStats, withNpcStats } from "./fixtures/package.js";

const CAMPAIGN = "00000000-0000-4000-8000-0000000000ca";

const reveals = [
  { id: "r1", fact: "Mira paid the smugglers", revealedAt: "2026-01-01T20:14:00.000Z", sourceNpc: { id: IDS.mira, name: "Mira Vell" } },
  { id: "r2", fact: "<img src=x onerror=alert(1)>", revealedAt: "2026-01-01T21:00:00.000Z", sourceNpc: null },
];

describe("planFromPackage", () => {
  it("builds the session folder tree, the actors and the reveals journal", () => {
    const plan = planFromPackage(makePackage(reveals), { campaignId: CAMPAIGN });
    expect(plan.folders.map((f) => f.name)).toEqual(["TLR · Session 12: The mayor's bargain", "NPCs", "Encounter: Cult ambush"]);
    expect(plan.actors.map((a) => a.data.name)).toEqual(["Trader Wynn", "Mira Vell", "Test Goblin", "Cult Captain"]);
  });

  it("maps a stat block to a dnd5e npc, with the licence + attribution in the biography", () => {
    const goblin = planFromPackage(makePackage(), { campaignId: CAMPAIGN }).actors.find((a) => a.data.name === "Test Goblin");
    expect(goblin.data.system.attributes.hp.max).toBe(7);
    expect(goblin.data.system.details.cr).toBe(0.25);
    expect(goblin.data.system.traits.size).toBe("sm");
    expect(goblin.data.system.details.type.value).toBe("humanoid");
    expect(goblin.data.system.details.biography.value).toMatch(/CC-BY-4\.0 \(example\)/);
    expect(goblin.data.system.details.biography.value).toMatch(/Example attribution/);
    const weapon = goblin.data.items.find((i) => i.type === "weapon");
    const activity = Object.values(weapon.system.activities)[0];
    expect(activity).toMatchObject({ type: "attack", attack: { bonus: "4", flat: true } });
    expect(weapon.system.damage.base.denomination).toBe(6);
  });

  it("a typed-in combatant becomes a bare actor with its AC and HP", () => {
    const captain = planFromPackage(makePackage(), { campaignId: CAMPAIGN }).actors.find((a) => a.data.name === "Cult Captain");
    expect(captain.data.system.attributes.ac.flat).toBe(16);
    expect(captain.data.system.attributes.hp.max).toBe(44);
  });

  it("NPC visibility: CARD_ONLY carries the card line only; FULL_DETAILS adds the public sheet", () => {
    const plan = planFromPackage(makePackage(), { campaignId: CAMPAIGN });
    expect(plan.actors.find((a) => a.data.name === "Trader Wynn").data.system.details.biography.value).toBe("<p>Halfling · Commoner 2</p>");
    const mira = plan.actors.find((a) => a.data.name === "Mira Vell").data.system.details.biography.value;
    expect(mira).toMatch(/<strong>What people know:<\/strong> runs the Gilded Cup\./);
    expect(mira).toMatch(/Personality:/);
  });

  it("reveals are OBSERVER journal pages; text from The Long Rest is escaped, never live HTML", () => {
    const plan = planFromPackage(makePackage(reveals), { campaignId: CAMPAIGN });
    expect(plan.journal.ownership).toEqual({ default: 2 });
    expect(plan.journal.pages[0].text.content).toMatch(/Source: Mira Vell/);
    expect(plan.journal.pages[1].text.content).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
    expect(revealPage(reveals[1]).key).toBe("reveal:r2");
    expect(escapeHtml(`"'&<>`)).toBe("&quot;&#39;&amp;&lt;&gt;");
  });

  it("actors are GM-only by default (FULL_DETAILS NPCs: players LIMITED); keys and ids are stable across re-imports", () => {
    const a = planFromPackage(makePackage(reveals), { campaignId: CAMPAIGN });
    const b = planFromPackage(makePackage(reveals), { campaignId: CAMPAIGN });
    const limited = a.actors.filter((x) => x.data.ownership.default === 1).map((x) => x.data.name);
    expect(limited).toEqual(["Mira Vell"]);
    expect(a.actors.filter((x) => x.data.name !== "Mira Vell").every((x) => x.data.ownership.default === 0)).toBe(true);
    expect(a.actors.map((x) => x.key)).toEqual(b.actors.map((x) => x.key));
    expect(foundryId("seed")).toBe(foundryId("seed"));
    expect(foundryId("seed")).toMatch(/^[A-Za-z0-9]{16}$/);
  });
});

describe("parseAttack", () => {
  it("2014 and 2024 wording, and text without a 'Hit:' label", () => {
    expect(parseAttack("Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage.")).toEqual({
      kind: "melee", toHit: 4, damage: { number: 1, denomination: 6, bonus: "2", type: "slashing" }, reach: 5, range: null,
    });
    const r = parseAttack("Ranged Attack Roll: +4, range 80/320 ft. Hit: 5 (1d6 + 2) Piercing damage.");
    expect(r.kind).toBe("ranged");
    expect(r.range).toEqual({ value: 80, long: 320 });
    expect(parseAttack("Melee Attack Roll: +4, reach 5 ft. 5 (1d6 + 2) Slashing damage.").damage).toEqual({ number: 1, denomination: 6, bonus: "2", type: "slashing" });
    expect(parseAttack("The goblin can take the Disengage action.")).toBeNull();
  });
});

test("dnd5e 6 shapes: speeds are formula strings under movement.speeds; senses nullable ints under senses.ranges", () => {
  expect(movementSpeeds({ walk: 30, fly: 60, hover: true })).toEqual({ walk: "30", fly: "60" });
  expect(movementSpeeds({})).toEqual({ walk: "30" }); // SRD default when a stat block omits walk
  expect(movementSpeeds({ walk: 0, swim: 40 })).toEqual({ walk: "0", swim: "40" });
  expect(senseRanges({ darkvision: 60 })).toEqual({ darkvision: 60, blindsight: null, tremorsense: null, truesight: null });
  expect(senseRanges({ darkvision: 0 })).toEqual({ darkvision: null, blindsight: null, tremorsense: null, truesight: null });
});

test("a monster is written with dnd5e 6's native movement/senses paths, and verified there (window 5)", () => {
  const plan = planFromPackage(makePackage(), { campaignId: CAMPAIGN });
  const goblin = plan.actors.find((a) => a.expect.some(([p]) => p.startsWith("system.attributes.movement")));
  const attrs = goblin.data.system.attributes;
  expect(attrs.movement).not.toHaveProperty("walk"); // no legacy flat keys
  expect(attrs.senses).not.toHaveProperty("darkvision");
  expect(attrs.movement.speeds.walk).toMatch(/^\d+$/);
  const paths = goblin.expect.map(([p]) => p);
  expect(paths).toContain("system.attributes.movement.speeds.walk");
  expect(paths).toContain("system.attributes.senses.ranges.darkvision");
  expect(paths.some((p) => /movement\.walk$|senses\.darkvision$/.test(p))).toBe(false);
});

describe("NPC stats (v0.1.6)", () => {
  const plan = (p) => planFromPackage(p, { campaignId: CAMPAIGN });
  const npcOf = (p, name) => plan(p).actors.find((a) => a.data.name === name);

  it("maps stats onto the npc actor with the monster mapper's pieces, for CARD_ONLY too", () => {
    const wynn = npcOf(withNpcStats(makePackage()), "Trader Wynn");
    const sys = wynn.data.system;
    expect(sys.abilities.str).toEqual({ value: 16, proficient: 1 });
    expect(sys.abilities.dex).toEqual({ value: 12, proficient: 0 });
    // Athletics +6 = STR +3 + pb 3 → proficient; Perception +7 = WIS +1 + 2×pb → expertise.
    expect(sys.skills).toEqual({ ath: { value: 1 }, prc: { value: 2 } });
    expect(sys.attributes.ac).toEqual({ calc: "flat", flat: 17 });
    expect(sys.attributes.hp).toMatchObject({ value: 52, max: 52 });
    expect(sys.attributes.movement.speeds).toEqual({ walk: "30" });
    expect(wynn.data.flags["the-long-rest"].tlrMaxHp).toBe(52);
    const sword = wynn.data.items.find((i) => i.name === "Longsword");
    expect(sword.type).toBe("weapon");
    expect(sword.system.damage.base).toEqual({ number: 1, denomination: 8, bonus: "3", types: ["slashing"] });
    const paths = wynn.expect.map(([p]) => p);
    expect(paths).toEqual(expect.arrayContaining(["system.attributes.hp.max", "system.attributes.ac.flat", "items.length", "items[Longsword].activities.attack.bonus"]));
  });

  it("stats never add prose: the biography is exactly what visibility allows", () => {
    const before = plan(makePackage()).actors.filter((a) => a.key.includes(":npc:")).map((a) => a.data.system.details.biography.value);
    const after = plan(withNpcStats(makePackage())).actors.filter((a) => a.key.includes(":npc:")).map((a) => a.data.system.details.biography.value);
    expect(after).toEqual(before);
    expect(after[0]).toBe("<p>Halfling · Commoner 2</p>");
  });

  it("prefers the structured attack over the rules line", () => {
    const stats = npcStats({
      actions: [{ name: "Spear", description: "Melee Weapon Attack: +2 to hit, reach 5 ft., one target. Hit: 3 (1d4 + 1) piercing damage.", attack: { kind: "ranged", toHit: 9, damage: { formula: "2d6 - 1", type: "Piercing" }, reach: null, range: { value: 20, long: 60 } } }],
    });
    const spear = npcOf(withNpcStats(makePackage(), { "Trader Wynn": stats }), "Trader Wynn").data.items[0];
    expect(spear.flags["the-long-rest"].toHit).toBe(9);
    expect(spear.system.damage.base).toEqual({ number: 2, denomination: 6, bonus: "-1", types: ["piercing"] });
    expect(spear.system.range).toEqual({ value: 20, long: 60, units: "ft" });
  });

  it("falls back to the rules line, then to a plain feature, when there's no attack roll", () => {
    expect(structuredAttack({ kind: "melee", toHit: null })).toBeNull();
    const stats = npcStats({
      actions: [
        { name: "Club", description: "Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 4 (1d4 + 2) bludgeoning damage.", attack: { kind: "melee", toHit: null } },
        { name: "Touch", description: "Melee Weapon Attack: no attack roll, reach 5 ft., one target.", attack: { kind: "melee", toHit: null, damage: null } },
      ],
    });
    const items = npcOf(withNpcStats(makePackage(), { "Trader Wynn": stats }), "Trader Wynn").data.items;
    expect(items.map((i) => [i.name, i.type])).toEqual([["Club", "weapon"], ["Touch", "feat"]]);
    expect(items[0].flags["the-long-rest"].toHit).toBe(4);
  });

  it("without stats an NPC is exactly as before (v0.1.5)", () => {
    const wynn = npcOf(makePackage(), "Trader Wynn");
    expect(wynn.data.system).toEqual({ details: { biography: { value: "<p>Halfling · Commoner 2</p>", public: "<p>Halfling · Commoner 2</p>" } }, attributes: {} });
    expect(wynn.data.items).toEqual([]);
    expect(wynn.data.flags["the-long-rest"]).not.toHaveProperty("tlrMaxHp");
    expect(npcOf(withNpcStats(makePackage(), { "Trader Wynn": null }), "Trader Wynn").data.items).toEqual([]);
  });

  it("re-import HP: damage is kept (clamped to a lower max); undamaged or first-time follows the new max", () => {
    expect(reimportHp({ current: 30, foundryMax: 52, lastTlrMax: 52, newMax: 52 })).toEqual({ value: 30, max: 52 });
    expect(reimportHp({ current: 30, foundryMax: 52, lastTlrMax: 52, newMax: 20 })).toEqual({ value: 20, max: 20 });
    expect(reimportHp({ current: 30, foundryMax: 52, lastTlrMax: 52, newMax: 60 })).toEqual({ value: 30, max: 60 });
    expect(reimportHp({ current: 52, foundryMax: 52, lastTlrMax: 52, newMax: 60 })).toEqual({ value: 60, max: 60 });
    expect(reimportHp({ current: 5, foundryMax: 10, lastTlrMax: undefined, newMax: 52 })).toEqual({ value: 52, max: 52 });
  });
});
