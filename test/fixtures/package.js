// A SYNTHETIC session package in The Long Rest's documented shape (docs/api.md,
// GET /api/v1/sessions/{id}/package). Invented names and ids only.
export const IDS = {
  session: "00000000-0000-4000-8000-000000000012",
  wynn: "00000000-0000-4000-8000-0000000000a1",
  mira: "00000000-0000-4000-8000-0000000000a2",
  encounter: "00000000-0000-4000-8000-0000000000e1",
  goblin: "00000000-0000-4000-8000-0000000000b1",
};

const testGoblin = {
  id: IDS.goblin,
  name: "Test Goblin",
  cr: "1/4",
  provenance: "OFFICIAL",
  rulesEdition: "2014",
  license: "CC-BY-4.0 (example)",
  attribution: "Example attribution: this statblock is test data.",
  statblock: {
    size: "Small",
    type: "humanoid (goblinoid)",
    alignment: "neutral evil",
    cr: "1/4",
    ac: { value: 15, notes: "leather armor, shield" },
    hp: { average: 7, formula: "2d6" },
    speed: { walk: 30 },
    abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
    skills: { stealth: 6 },
    senses: { darkvision: 60, passivePerception: 9 },
    languages: ["Common", "Goblin"],
    traits: [{ name: "Nimble Escape", description: "Can Disengage or Hide as a bonus action." }],
    actions: [
      { name: "Scimitar", description: "Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage." },
      { name: "Shortbow", description: "Ranged Weapon Attack: +4 to hit, range 80/320 ft., one target. Hit: 5 (1d6 + 2) piercing damage." },
    ],
  },
};

export function makePackage(reveals = []) {
  return {
    schemaVersion: 1,
    packageVersion: "sha256:0000000000000001",
    generatedAt: "2026-01-01T00:00:00.000Z",
    session: { id: IDS.session, number: 12, title: "The mayor's bargain", date: "2026-01-01", status: "ACTIVE" },
    npcs: [
      { id: IDS.wynn, name: "Trader Wynn", avatarUrl: null, visibility: "CARD_ONLY", card: { race: "Halfling", level: 2, classes: [{ name: "Commoner", subclass: null, level: 2 }] } },
      {
        id: IDS.mira, name: "Mira Vell", avatarUrl: null, visibility: "FULL_DETAILS",
        card: { race: "Human", level: 5, classes: [{ name: "Noble", subclass: null, level: 5 }] },
        sheet: { name: "Mira Vell", backstory: "**What people know:** runs the Gilded Cup.", personalityTraits: "Laughs a beat too late.", ideals: "", bonds: "", flaws: "" },
      },
    ],
    encounters: [
      {
        id: IDS.encounter, name: "Cult ambush", status: "DRAFT",
        monsters: [
          { name: "Test Goblin", count: 3, monster: testGoblin },
          { name: "Cult Captain", count: 1, monster: null, combatant: { ac: 16, maxHp: 44, attacks: [{ name: "Longsword", toHit: "+5", damage: "1d8+3 slashing" }] } },
        ],
      },
    ],
    reveals,
  };
}

// The NPC `stats` TLR sends from v0.1.6's app side (Statblock schema, numbers only). Invented values.
export function npcStats(over = {}) {
  return {
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 13, cha: 8 },
    ac: { value: 17 },
    hp: { average: 52 },
    speed: { walk: 30 },
    proficiencyBonus: 3,
    savingThrows: { str: 6 },
    skills: { athletics: 6, perception: 7 },
    senses: { passivePerception: 17 },
    level: 5,
    actions: [
      {
        name: "Longsword",
        description: "Melee Weapon Attack: +6 to hit, reach 5 ft., one target. Hit: 7 (1d8 + 3) slashing damage.",
        attack: { kind: "melee", toHit: 6, damage: { formula: "1d8 + 3", type: "slashing" }, reach: 5, range: null },
      },
    ],
    ...over,
  };
}

/** makePackage() with `stats` on both NPCs (or the given stats per NPC name). */
export function withNpcStats(p, byName = {}) {
  return { ...p, npcs: p.npcs.map((n) => ({ ...n, stats: n.name in byName ? byName[n.name] : npcStats() })) };
}

// An NPC with its OWN stat block (TLR's builder, v0.1.7): the full Statblock, rules text included,
// plus the CC-BY attribution of its copied parts. Invented values; the attribution text is a stand-in.
export function blockStats(over = {}) {
  return {
    size: "Huge", type: "dragon", alignment: "chaotic evil", cr: "14",
    abilities: { str: 23, dex: 14, con: 21, int: 14, wis: 13, cha: 17 },
    ac: { value: 19, notes: "natural armor" }, hp: { average: 195, formula: "17d12 + 85" },
    speed: { walk: 40, fly: 80, swim: 40 }, proficiencyBonus: 5,
    savingThrows: { dex: 7 }, skills: { stealth: 7 }, senses: { darkvision: 120, passivePerception: 21 },
    languages: ["Common", "Draconic"], damageImmunities: ["acid"],
    traits: [{ name: "Legendary Resistance (3/Day)", description: "If it fails a saving throw, it can choose to succeed instead." }],
    actions: [{ name: "Bite", description: "Melee Weapon Attack: +11 to hit, reach 10 ft., one target. Hit: 17 (2d10 + 6) piercing damage." }],
    legendaryActions: { count: 3, description: "It can take 3 legendary actions.", entries: [{ name: "Tail Attack", description: "It makes a tail attack." }] },
    lairActions: [{ name: "Grasping Tide", description: "A grasping tide rises." }],
    level: 5,
    attribution: [{ license: "CC-BY-4.0 (SRD 5.1)", attribution: "Stand-in SRD attribution <b>text</b>", monsters: ["Adult Black Dragon"], modified: true }],
    ...over,
  };
}
