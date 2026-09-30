/**
 * The Long Rest session package → Foundry dnd5e document data.
 *
 * Pure: no Foundry globals, so it is unit tested in Node. It returns a PLAN (folders, actors, a
 * reveals journal) plus, per actor, the `expect` list of [path, value] pairs that must survive
 * Foundry's data model. The importer checks them after creating each actor and reports mismatches
 * (fields a dnd5e version dropped, renamed or coerced).
 *
 * Everything from The Long Rest is DATA: every string is HTML-escaped before it becomes Foundry HTML
 * (biographies and journal pages are rendered as HTML for every viewer).
 */

export const MODULE_ID = "the-long-rest";

// ---- helpers --------------------------------------------------------------------------------

const SPEED_TYPES = ["walk", "burrow", "climb", "fly", "swim"];
const SENSE_TYPES = ["darkvision", "blindsight", "tremorsense", "truesight"];

/** dnd5e 6 movement.speeds: walk always (default 30), other types only when non-zero; formula strings. */
export function movementSpeeds(speed = {}) {
  const out = {};
  for (const t of SPEED_TYPES) {
    const n = Number(speed[t] ?? (t === "walk" ? 30 : 0));
    if (t === "walk" || (Number.isFinite(n) && n > 0)) out[t] = String(Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);
  }
  return out;
}

/** dnd5e 6 senses.ranges: an integer range per sense, or null when the creature doesn't have it. */
export function senseRanges(senses = {}) {
  const out = {};
  for (const t of SENSE_TYPES) {
    const n = Number(senses[t]);
    out[t] = Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
  }
  return out;
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Minimal markdown → HTML AFTER escaping: paragraphs, **bold**, *italic*. Nothing else is honoured. */
export function mdToHtml(md) {
  return String(md ?? "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const html = escapeHtml(p)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1<em>$2</em>")
        .replace(/\n/g, "<br>");
      return `<p>${html}</p>`;
    })
    .join("");
}

const SIZES = { tiny: "tiny", small: "sm", medium: "med", large: "lg", huge: "huge", gargantuan: "grg" };
const CREATURE_TYPES = new Set([
  "aberration", "beast", "celestial", "construct", "dragon", "elemental", "fey", "fiend", "giant",
  "humanoid", "monstrosity", "ooze", "plant", "undead",
]);
const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];
const SKILLS = {
  acrobatics: "acr", "animal handling": "ani", animalhandling: "ani", arcana: "arc", athletics: "ath",
  deception: "dec", history: "his", insight: "ins", intimidation: "itm", investigation: "inv",
  medicine: "med", nature: "nat", perception: "prc", performance: "prf", persuasion: "per",
  religion: "rel", "sleight of hand": "slt", sleightofhand: "slt", stealth: "ste", survival: "sur",
};
const SKILL_ABILITY = {
  acr: "dex", ani: "wis", arc: "int", ath: "str", dec: "cha", his: "int", ins: "wis", itm: "cha",
  inv: "int", med: "wis", nat: "int", prc: "wis", prf: "cha", per: "cha", rel: "int", slt: "dex",
  ste: "dex", sur: "wis",
};

const mod = (score) => Math.floor(((score ?? 10) - 10) / 2);

/** "humanoid (goblinoid)" → { value: "humanoid", subtype: "goblinoid" }; unknown → custom. */
export function creatureType(raw) {
  const m = /^\s*([a-z]+)\s*(?:\(([^)]*)\))?/i.exec(String(raw ?? ""));
  const value = m?.[1]?.toLowerCase() ?? "";
  if (CREATURE_TYPES.has(value)) return { value, subtype: m?.[2] ?? "", swarm: "", custom: "" };
  return { value: "custom", subtype: "", swarm: "", custom: String(raw ?? "") };
}

/** CR "1/4" → 0.25 (dnd5e stores a number). */
export function crNumber(cr) {
  if (cr == null) return null;
  const s = String(cr);
  if (s.includes("/")) {
    const [a, b] = s.split("/").map(Number);
    return b ? a / b : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * An attack line, 2014 or 2024 wording:
 *   "Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage."
 *   "Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Slashing damage."
 *   "Melee Attack Roll: +4, reach 5 ft. 5 (1d6 + 2) Slashing damage, plus …" (TLR's stored 5.2.1 text)
 */
export function parseAttack(description) {
  const text = String(description ?? "");
  const hit = /(Melee|Ranged|Melee or Ranged)\s+(?:Weapon\s+|Spell\s+)?Attack(?:\s+Roll)?:\s*([+-]\d+)/i.exec(text);
  if (!hit) return null;
  // The first "N (XdY + Z) Type" after the to-hit. TLR's stored SRD 5.2.1 text has lost its "Hit:" label.
  const dmg = /(?:Hit:\s*)?\d+\s*\((\d+)d(\d+)\s*(?:([+-])\s*(\d+))?\)\s*([a-z]+)/i.exec(text.slice(hit.index + hit[0].length));
  const reach = /reach\s+(\d+)\s*ft/i.exec(text);
  const range = /range\s+(\d+)(?:\/(\d+))?\s*ft/i.exec(text);
  return {
    kind: /ranged/i.test(hit[1]) && !/melee/i.test(hit[1]) ? "ranged" : "melee",
    toHit: Number(hit[2]),
    damage: dmg
      ? {
          number: Number(dmg[1]),
          denomination: Number(dmg[2]),
          bonus: dmg[3] ? `${dmg[3] === "-" ? "-" : ""}${dmg[4]}` : "",
          type: dmg[5].toLowerCase(),
        }
      : null,
    reach: reach ? Number(reach[1]) : null,
    range: range ? { value: Number(range[1]), long: range[2] ? Number(range[2]) : null } : null,
  };
}

// dnd5e ids are 16 alphanumerics; derive them deterministically so re-imports are stable.
export function foundryId(seed) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let out = "";
  for (let round = 0; out.length < 16; round++) {
    for (const ch of `${seed}#${round}`) {
      h1 = Math.imul(h1 ^ ch.charCodeAt(0), 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ ch.charCodeAt(0), 0x5bd1e995) >>> 0;
    }
    out += alphabet[h1 % 62] + alphabet[h2 % 62] + alphabet[(h1 >>> 8) % 62] + alphabet[(h2 >>> 8) % 62];
  }
  return out.slice(0, 16);
}

// ---- items ----------------------------------------------------------------------------------

const ACTIVATION = { actions: "action", bonusActions: "bonus", reactions: "reaction", legendary: "legendary" };

function featureItem(entry, section, seed) {
  return {
    name: String(entry.name ?? "Feature").slice(0, 120),
    type: "feat",
    img: "icons/svg/book.svg",
    system: {
      description: { value: mdToHtml(entry.description) },
      type: { value: "monster", subtype: "" },
      activation: ACTIVATION[section] ? { type: ACTIVATION[section], value: 1 } : undefined,
    },
    flags: { [MODULE_ID]: { key: `${seed}:${section}:${entry.name}` } },
  };
}

/** A natural-weapon item with a dnd5e 4.x/5.x attack Activity (flat to-hit, one damage part). */
function attackItem(entry, section, seed, attack) {
  const id = foundryId(`${seed}:${entry.name}:attack`);
  const part = attack.damage
    ? { number: attack.damage.number, denomination: attack.damage.denomination, bonus: attack.damage.bonus, types: [attack.damage.type] }
    : null;
  return {
    name: String(entry.name ?? "Attack").slice(0, 120),
    type: "weapon",
    img: "icons/svg/sword.svg",
    system: {
      description: { value: mdToHtml(entry.description) },
      type: { value: "natural", baseItem: "" },
      equipped: true,
      proficient: 1,
      range: attack.kind === "ranged" && attack.range
        ? { value: attack.range.value, long: attack.range.long, units: "ft" }
        : { reach: attack.reach ?? 5, units: "ft" },
      damage: part ? { base: part } : undefined,
      activities: {
        [id]: {
          _id: id,
          type: "attack",
          activation: { type: ACTIVATION[section] ?? "action", value: 1 },
          attack: { bonus: String(attack.toHit), flat: true, type: { value: attack.kind, classification: "weapon" } },
          damage: { includeBase: true, parts: [] },
        },
      },
    },
    flags: { [MODULE_ID]: { key: `${seed}:${section}:${entry.name}`, toHit: attack.toHit } },
  };
}

function itemsFromStatblock(sb, seed) {
  const items = [];
  for (const section of ["traits", "actions", "bonusActions", "reactions"]) {
    for (const entry of sb[section] ?? []) {
      const attack = section !== "traits" ? parseAttack(entry.description) : null;
      items.push(attack ? attackItem(entry, section, seed, attack) : featureItem(entry, section, seed));
    }
  }
  for (const entry of sb.legendaryActions?.entries ?? []) items.push(featureItem(entry, "legendary", seed));
  for (const entry of sb.spellcasting ?? []) items.push(featureItem(entry, "traits", seed));
  return items;
}

// ---- actors ---------------------------------------------------------------------------------

function attributionHtml(monster) {
  if (!monster?.license && !monster?.attribution) return "";
  return `<hr><p><em>${escapeHtml(monster.license ?? "")}</em></p><p>${escapeHtml(monster.attribution ?? "")}</p>`;
}

/**
 * A bestiary monster → an npc Actor. `expect` lists the values that must land (checked after create).
 */
export function monsterActor({ monster, name, count, encounterName, folderKey, ownership, scope = "" }) {
  const sb = monster.statblock ?? {};
  const key = `${scope ? `${scope}:` : ""}monster:${monster.id}`;
  const abilities = Object.fromEntries(
    ABILITIES.map((a) => [a, { value: sb.abilities?.[a] ?? 10, proficient: sb.savingThrows?.[a] != null ? 1 : 0 }]),
  );
  const skills = {};
  for (const [skill, bonus] of Object.entries(sb.skills ?? {})) {
    const k = SKILLS[skill.toLowerCase()];
    if (!k) continue;
    const pb = sb.proficiencyBonus ?? 2;
    const base = mod(sb.abilities?.[SKILL_ABILITY[k]]);
    skills[k] = { value: bonus - base >= 2 * pb ? 2 : 1 };
  }
  const size = SIZES[String(sb.size ?? "medium").toLowerCase()] ?? "med";
  const speed = sb.speed ?? {};
  const cr = crNumber(sb.cr ?? monster.cr);
  const senses = sb.senses ?? {};
  const bio =
    `<p>${escapeHtml(`${count}× in “${encounterName}”`)}</p>` +
    (sb.ac?.notes ? `<p>AC: ${escapeHtml(sb.ac.notes)}</p>` : "") +
    attributionHtml(monster);

  const data = {
    name: String(name).slice(0, 120),
    type: "npc",
    img: "icons/svg/mystery-man.svg",
    ownership: ownership ?? { default: 0 },
    system: {
      abilities,
      skills,
      attributes: {
        ac: { calc: "flat", flat: sb.ac?.value ?? 10 },
        hp: { value: sb.hp?.average ?? 1, max: sb.hp?.average ?? 1, formula: sb.hp?.formula ?? "" },
        // dnd5e 6 shapes (read from 6.0.5's MovementField / SensesField): speeds are FORMULA strings
        // under movement.speeds; senses are nullable integers under senses.ranges (null = none). The
        // legacy flat keys only work through dnd5e's migration shim, so we don't write them.
        movement: {
          speeds: movementSpeeds(speed),
          hover: Boolean(speed.hover),
          units: "ft",
        },
        senses: {
          ranges: senseRanges(senses),
          units: "ft",
          special: (senses.other ?? []).join(", "),
        },
      },
      details: {
        cr,
        type: creatureType(sb.type),
        alignment: String(sb.alignment ?? ""),
        biography: { value: bio, public: "" },
      },
      traits: {
        size,
        languages: { value: [], custom: (sb.languages ?? []).join("; ") },
        di: { value: [], custom: (sb.damageImmunities ?? []).join("; ") },
        dr: { value: [], custom: (sb.damageResistances ?? []).join("; ") },
        dv: { value: [], custom: (sb.damageVulnerabilities ?? []).join("; ") },
        ci: { value: [], custom: (sb.conditionImmunities ?? []).join("; ") },
      },
    },
    prototypeToken: { name: String(name).slice(0, 120), actorLink: false, disposition: -1 },
    items: itemsFromStatblock(sb, key),
    flags: { [MODULE_ID]: { key, kind: "monster", license: monster.license ?? null } },
  };

  const expect = [
    ["name", data.name],
    ["system.abilities.str.value", abilities.str.value],
    ["system.abilities.dex.value", abilities.dex.value],
    ["system.attributes.ac.flat", data.system.attributes.ac.flat],
    ["system.attributes.hp.max", data.system.attributes.hp.max],
    ["system.attributes.hp.formula", data.system.attributes.hp.formula],
    ["system.attributes.movement.speeds.walk", data.system.attributes.movement.speeds.walk],
    ["system.attributes.senses.ranges.darkvision", data.system.attributes.senses.ranges.darkvision],
    ["system.details.cr", cr],
    ["system.details.type.value", data.system.details.type.value],
    ["system.details.alignment", data.system.details.alignment],
    ["system.traits.size", size],
    ["system.traits.languages.custom", data.system.traits.languages.custom],
    ["items.length", data.items.length],
  ];
  const firstAttack = data.items.find((i) => i.type === "weapon");
  if (firstAttack) {
    expect.push([`items[${firstAttack.name}].system.damage.base.denomination`, firstAttack.system.damage?.base?.denomination ?? null]);
    expect.push([`items[${firstAttack.name}].activities.attack.bonus`, firstAttack.flags[MODULE_ID].toHit.toString()]);
  }
  return { key, folderKey, data, expect };
}

/** A typed-in combatant with no bestiary entry → a bare npc Actor (AC, HP, attacks as text). */
export function combatantActor({ name, count, encounterId, encounterName, combatant, folderKey, ownership, scope = "" }) {
  const key = `${scope ? `${scope}:` : ""}combatant:${encounterId}:${name}`;
  const attacks = (combatant.attacks ?? []).map((a) =>
    featureItem({ name: a.name, description: [a.toHit && `${a.toHit} to hit`, a.damage].filter(Boolean).join(", ") }, "actions", key),
  );
  const data = {
    name: String(name).slice(0, 120),
    type: "npc",
    img: "icons/svg/mystery-man.svg",
    ownership: ownership ?? { default: 0 },
    system: {
      attributes: {
        ac: { calc: "flat", flat: combatant.ac ?? 10 },
        hp: { value: combatant.maxHp ?? 1, max: combatant.maxHp ?? 1 },
      },
      details: { biography: { value: `<p>${escapeHtml(`${count}× in “${encounterName}” (typed in by the DM; no stat block).`)}</p>`, public: "" } },
    },
    prototypeToken: { name: String(name).slice(0, 120), actorLink: false, disposition: -1 },
    items: attacks,
    flags: { [MODULE_ID]: { key, kind: "combatant" } },
  };
  return {
    key,
    folderKey,
    data,
    expect: [
      ["system.attributes.ac.flat", data.system.attributes.ac.flat],
      ["system.attributes.hp.max", data.system.attributes.hp.max],
    ],
  };
}

function classLine(card) {
  const classes = (card?.classes ?? []).map((c) => `${c.name}${c.subclass ? ` (${c.subclass})` : ""} ${c.level}`).join(" / ");
  return [card?.race, classes || (card?.level ? `level ${card.level}` : "")].filter(Boolean).join(" · ");
}

export const DEFAULT_PORTRAIT = "icons/svg/mystery-man.svg";

/** An NPC's avatarUrl → the image Foundry shows: the URL when it is https, else Foundry's default. */
export function portraitSrc(avatarUrl) {
  return typeof avatarUrl === "string" && /^https:\/\//.test(avatarUrl) ? avatarUrl : DEFAULT_PORTRAIT;
}

/**
 * A TLR NPC → an npc Actor, honouring the package's visibility (the SERVER already filtered it):
 * CARD_ONLY → name, portrait and the card line only; FULL_DETAILS → + the player sheet's prose.
 */
export function npcActor({ npc, folderKey, ownership, scope = "" }) {
  const key = `${scope ? `${scope}:` : ""}npc:${npc.id}`;
  const card = npc.card ?? {};
  let bio = `<p>${escapeHtml(classLine(card))}</p>`;
  if (npc.visibility === "FULL_DETAILS" && npc.sheet) {
    const s = npc.sheet;
    bio += mdToHtml(s.backstory);
    for (const [label, v] of [["Personality", s.personalityTraits], ["Ideals", s.ideals], ["Bonds", s.bonds], ["Flaws", s.flaws]]) {
      if (v) bio += `<p><strong>${label}:</strong> ${escapeHtml(v)}</p>`;
    }
  }
  // The portrait is used for the actor AND its token, https only (never a data:/javascript:/relative
  // path the server didn't mean). `portrait` in our flags is what WE last set, so a re-import can tell
  // a changed portrait from art the GM put on the actor or its tokens.
  const img = portraitSrc(npc.avatarUrl);
  const data = {
    name: String(npc.name).slice(0, 120),
    type: "npc",
    img,
    ownership: ownership ?? { default: 0 },
    system: {
      details: { biography: { value: bio, public: bio } },
      attributes: npc.sheet?.armorClass ? { ac: { calc: "flat", flat: npc.sheet.armorClass } } : {},
    },
    prototypeToken: { name: String(npc.name).slice(0, 120), actorLink: true, disposition: 0, texture: { src: img } },
    items: [],
    flags: { [MODULE_ID]: { key, kind: "npc", visibility: npc.visibility, portrait: img } },
  };
  return { key, folderKey, data, expect: [["name", data.name], ["system.details.biography.value", bio]] };
}

// ---- the plan -------------------------------------------------------------------------------

/**
 * The whole package → { folders, actors, journal }. `options.actorOwnership` defaults to GM-only
 * (the DM drags them onto the map); `options.revealOwnership` defaults to OBSERVER, because a fact
 * in the package has already been revealed to the players in TLR.
 */
export function planFromPackage(pkg, options = {}) {
  const actorOwnership = options.actorOwnership ?? { default: 0 };
  const revealOwnership = options.revealOwnership ?? { default: 2 };
  // Every key is scoped by (campaign, session): two sessions, or another campaign connected to the
  // same world, never share or move each other's folders, actors or journal (window 7). Session and
  // campaign ids are uuids, and SRD monster ids are shared by every campaign, hence both.
  if (!options.campaignId) throw new Error("Import needs the connected campaign (connect The Long Rest first).");
  const s = pkg.session;
  const root = `c:${options.campaignId}:session:${s.id}`;
  const scope = root;
  const folders = [
    { key: root, name: `TLR · Session ${s.number}: ${s.title}`.slice(0, 120), type: "Actor", parentKey: null },
    { key: `${root}:npcs`, name: "NPCs", type: "Actor", parentKey: root },
  ];
  const actors = [];
  for (const npc of pkg.npcs ?? []) actors.push(npcActor({ npc, folderKey: `${root}:npcs`, ownership: actorOwnership, scope }));

  for (const enc of pkg.encounters ?? []) {
    const fk = `${root}:enc:${enc.id}`;
    folders.push({ key: fk, name: `Encounter: ${enc.name}`.slice(0, 120), type: "Actor", parentKey: root });
    for (const m of enc.monsters ?? []) {
      actors.push(
        m.monster
          ? monsterActor({ monster: m.monster, name: m.name, count: m.count, encounterName: enc.name, folderKey: fk, ownership: actorOwnership, scope })
          : combatantActor({ name: m.name, count: m.count, encounterId: enc.id, encounterName: enc.name, combatant: m.combatant ?? {}, folderKey: fk, ownership: actorOwnership, scope }),
      );
    }
  }

  const journal = {
    key: `${root}:reveals`,
    name: `TLR · Session ${s.number}: Reveals`.slice(0, 120),
    ownership: revealOwnership,
    pages: (pkg.reveals ?? []).map((r) => revealPage(r)),
  };
  return { packageVersion: pkg.packageVersion, folders, actors, journal };
}

export function revealPage(r) {
  const source = r.sourceNpc ? `<p><em>Source: ${escapeHtml(r.sourceNpc.name)}</em></p>` : "";
  return {
    key: `reveal:${r.id}`,
    name: String(r.fact).slice(0, 60),
    type: "text",
    text: { content: `<p>${escapeHtml(r.fact)}</p>${source}`, format: 1 },
    flags: { [MODULE_ID]: { key: `reveal:${r.id}`, revealedAt: r.revealedAt } },
  };
}
