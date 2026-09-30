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
