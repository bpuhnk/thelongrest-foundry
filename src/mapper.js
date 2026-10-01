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

const ACTIVATION = { actions: "action", bonusActions: "bonus", reactions: "reaction", legendary: "legendary", lair: "lair", mythic: "mythic" };

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
    ? { number: attack.damage.number, denomination: attack.damage.denomination, bonus: attack.damage.bonus, types: attack.damage.type ? [attack.damage.type] : [] }
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

/**
 * The package's structured `attack` (TLR NPC stats, v0.1.6) → the parseAttack shape. null when there's
 * no attack roll, so the caller falls back to the rules line, then to a plain feature.
 */
export function structuredAttack(a) {
  if (!a || typeof a !== "object" || typeof a.toHit !== "number" || !Number.isFinite(a.toHit)) return null;
  const dice = /^(\d+)d(\d+)(?:\s*([+-])\s*(\d+))?$/i.exec(String(a.damage?.formula ?? "").trim());
  const type = typeof a.damage?.type === "string" ? a.damage.type.toLowerCase() : "";
  const range = a.range && Number.isFinite(Number(a.range.value))
    ? { value: Number(a.range.value), long: Number.isFinite(Number(a.range.long)) && a.range.long != null ? Number(a.range.long) : null }
    : null;
  return {
    kind: a.kind === "ranged" ? "ranged" : "melee",
    toHit: a.toHit,
    damage: dice ? { number: Number(dice[1]), denomination: Number(dice[2]), bonus: dice[3] ? `${dice[3] === "-" ? "-" : ""}${dice[4]}` : "", type } : null,
    reach: Number.isFinite(Number(a.reach)) && a.reach != null ? Number(a.reach) : null,
    range,
  };
}

function itemsFromStatblock(sb, seed) {
  const items = [];
  for (const section of ["traits", "actions", "bonusActions", "reactions"]) {
    for (const entry of sb[section] ?? []) {
      // Prefer the structured attack when the package has one; else read the rules line.
      const attack = section !== "traits" ? structuredAttack(entry.attack) ?? parseAttack(entry.description) : null;
      items.push(attack ? attackItem(entry, section, seed, attack) : featureItem(entry, section, seed));
    }
  }
  for (const entry of sb.legendaryActions?.entries ?? []) items.push(featureItem(entry, "legendary", seed));
  // v0.1.7: the rest of a full stat block (an NPC's own block from TLR's builder, or a monster's).
  for (const entry of sb.lairActions ?? []) items.push(featureItem(entry, "lair", seed));
  for (const entry of sb.mythicActions ?? []) items.push(featureItem(entry, "mythic", seed));
  for (const entry of sb.regionalEffects ?? []) items.push(featureItem(entry, "regional", seed));
  for (const entry of sb.spellcasting ?? []) items.push(featureItem(entry, "traits", seed));
  return items;
}

/**
 * dnd5e's legendary/lair resources from a stat block: legendary actions per round (`legact`), legendary
 * resistance uses from a "Legendary Resistance (N/Day)" trait (`legres`), and a lair (initiative 20).
 * Empty when the block has none of them.
 */
export function resourcesFromStatblock(sb) {
  const out = {};
  const count = Number(sb.legendaryActions?.count);
  if (Number.isInteger(count) && count > 0) out.legact = { value: count, max: count };
  for (const t of sb.traits ?? []) {
    const m = /legendary resistance\s*\((\d+)\s*\/\s*day/i.exec(String(t?.name ?? ""));
    if (m) out.legres = { value: Number(m[1]), max: Number(m[1]) };
  }
  if ((sb.lairActions ?? []).length) out.lair = { value: true, initiative: 20 };
  return out;
}

/** dnd5e npc details + traits from a stat block (CR, type, alignment, size, languages, resistances). */
function detailsAndTraits(sb, fallbackCr) {
  return {
    details: { cr: crNumber(sb.cr ?? fallbackCr), type: creatureType(sb.type), alignment: String(sb.alignment ?? "") },
    traits: {
      size: SIZES[String(sb.size ?? "medium").toLowerCase()] ?? "med",
      languages: { value: [], custom: (sb.languages ?? []).join("; ") },
      di: { value: [], custom: (sb.damageImmunities ?? []).join("; ") },
      dr: { value: [], custom: (sb.damageResistances ?? []).join("; ") },
      dv: { value: [], custom: (sb.damageVulnerabilities ?? []).join("; ") },
      ci: { value: [], custom: (sb.conditionImmunities ?? []).join("; ") },
    },
  };
}

/** The CC-BY lines TLR sends with an NPC's own stat block (`stats.attribution`), as biography HTML. */
function statsAttributionHtml(lines) {
  if (!Array.isArray(lines) || !lines.length) return "";
  return (
    "<hr>" +
    lines
      .map((l) => {
        const head = [l?.license, Array.isArray(l?.monsters) && l.monsters.length ? `from ${l.monsters.join(", ")}` : ""].filter(Boolean).join(", ");
        return `<p><em>${escapeHtml(head)}${l?.modified ? " (modified)" : ""}</em></p>` + (l?.attribution ? `<p>${escapeHtml(l.attribution)}</p>` : "");
      })
      .join("")
  );
}

// ---- actors ---------------------------------------------------------------------------------

function attributionHtml(monster) {
  if (!monster?.license && !monster?.attribution) return "";
  return `<hr><p><em>${escapeHtml(monster.license ?? "")}</em></p><p>${escapeHtml(monster.attribution ?? "")}</p>`;
}

/**
 * A bestiary monster → an npc Actor. `expect` lists the values that must land (checked after create).
 */
/**
 * A stat block's mechanics → the dnd5e npc system pieces monsters and NPCs share: abilities (with save
 * proficiency), skills (proficient vs expertise from the bonus), AC, HP and dnd5e 6 movement/senses.
 * Passive Perception is derived by dnd5e from WIS + the Perception skill, so it isn't written.
 */
export function statSystem(sb) {
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
  const speed = sb.speed ?? {};
  const senses = sb.senses ?? {};
  return {
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
  };
}

/** The `expect` entries for the mechanics statSystem wrote (paths shared by monsters and NPCs). */
function statExpect(data, abilities) {
  const a = data.system.attributes;
  return [
    ["system.abilities.str.value", abilities.str.value],
    ["system.abilities.dex.value", abilities.dex.value],
    ["system.attributes.ac.flat", a.ac.flat],
    ["system.attributes.hp.max", a.hp.max],
    ["system.attributes.hp.formula", a.hp.formula],
    ["system.attributes.movement.speeds.walk", a.movement.speeds.walk],
    ["system.attributes.senses.ranges.darkvision", a.senses.ranges.darkvision],
  ];
}

function attackExpect(data) {
  const firstAttack = data.items.find((i) => i.type === "weapon");
  if (!firstAttack) return [];
  return [
    [`items[${firstAttack.name}].system.damage.base.denomination`, firstAttack.system.damage?.base?.denomination ?? null],
    [`items[${firstAttack.name}].activities.attack.bonus`, firstAttack.flags[MODULE_ID].toHit.toString()],
  ];
}

export function monsterActor({ monster, name, count, encounterName, folderKey, ownership, scope = "" }) {
  const sb = monster.statblock ?? {};
  const key = `${scope ? `${scope}:` : ""}monster:${monster.id}`;
  const { abilities, skills, attributes } = statSystem(sb);
  const { details, traits } = detailsAndTraits(sb, monster.cr);
  const size = traits.size;
  const cr = details.cr;
  const resources = resourcesFromStatblock(sb);
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
      attributes,
      details: { ...details, biography: { value: bio, public: "" } },
      traits,
      ...(Object.keys(resources).length ? { resources } : {}),
    },
    prototypeToken: { name: String(name).slice(0, 120), actorLink: false, disposition: -1 },
    items: itemsFromStatblock(sb, key),
    flags: { [MODULE_ID]: { key, kind: "monster", license: monster.license ?? null } },
  };

  const expect = [
    ["name", data.name],
    ...statExpect(data, abilities),
    ["system.details.cr", cr],
    ["system.details.type.value", data.system.details.type.value],
    ["system.details.alignment", data.system.details.alignment],
    ["system.traits.size", size],
    ["system.traits.languages.custom", data.system.traits.languages.custom],
    ["items.length", data.items.length],
    ...attackExpect(data),
    ...resourceExpect(resources),
  ];
  return { key, folderKey, data, expect };
}

function resourceExpect(resources) {
  const out = [];
  if (resources.legact) out.push(["system.resources.legact.max", resources.legact.max]);
  if (resources.legres) out.push(["system.resources.legres.max", resources.legres.max]);
  if (resources.lair) out.push(["system.resources.lair.value", true]);
  return out;
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
  // Mechanics (v0.1.6): TLR sends `stats` for every NPC it packages, CARD_ONLY included. They are
  // numbers only; the biography above is still the ONLY prose, gated by visibility.
  const stats = npc.stats && typeof npc.stats === "object" ? npc.stats : null;
  const st = stats ? statSystem(stats) : null;
  // v0.1.7: an NPC with its OWN stat block (TLR's builder) also brings CR/type/size/languages/
  // resistances and legendary/lair resources; a sheet-built `stats` has none of those, so nothing is
  // written for them (a GM's own CR or size survives). Its parts' CC-BY attribution joins the biography.
  const fromBlock = Boolean(stats && (stats.cr != null || stats.type || stats.size || stats.legendaryActions || stats.lairActions || stats.languages));
  const dt = fromBlock ? detailsAndTraits(stats, null) : null;
  const resources = stats ? resourcesFromStatblock(stats) : {};
  bio += statsAttributionHtml(stats?.attribution);
  const own = ownership ?? { default: 0 };
  const data = {
    name: String(npc.name).slice(0, 120),
    type: "npc",
    img,
    ownership: own,
    system: {
      ...(st ? { abilities: st.abilities, skills: st.skills } : {}),
      details: { ...(dt ? { cr: dt.details.cr, type: dt.details.type, alignment: dt.details.alignment } : {}), biography: { value: bio, public: bio } },
      ...(dt ? { traits: dt.traits } : {}),
      ...(Object.keys(resources).length ? { resources } : {}),
      attributes: st ? st.attributes : npc.sheet?.armorClass ? { ac: { calc: "flat", flat: npc.sheet.armorClass } } : {},
    },
    prototypeToken: { name: String(npc.name).slice(0, 120), actorLink: true, disposition: 0, texture: { src: img } },
    items: stats ? itemsFromStatblock(stats, key) : [],
    flags: {
      [MODULE_ID]: {
        key, kind: "npc", visibility: npc.visibility, portrait: img,
        // What WE set, so a re-import can tell its own values from the GM's (ownership, and the max HP
        // a damaged current HP is measured against).
        ownershipDefault: own.default ?? 0,
        ...(st ? { tlrMaxHp: st.attributes.hp.max } : {}),
      },
    },
  };
  const expect = [["name", data.name], ["system.details.biography.value", bio]];
  if (st) expect.push(...statExpect(data, st.abilities), ["items.length", data.items.length], ...attackExpect(data), ...resourceExpect(resources));
  if (dt) expect.push(["system.details.cr", dt.details.cr], ["system.traits.languages.custom", dt.traits.languages.custom]);
  return { key, folderKey, data, expect };
}

/**
 * Re-import HP for an NPC with stats: max HP always follows The Long Rest; current HP is left alone
 * while the actor is damaged (the GM may be tracking it), clamped to a lowered max. An undamaged actor,
 * or one whose stats are imported for the first time (no `lastTlrMax`), goes to the new max.
 */
export function reimportHp({ current, foundryMax, lastTlrMax, newMax }) {
  if (lastTlrMax == null || typeof current !== "number" || !Number.isFinite(current)) return { value: newMax, max: newMax };
  const damaged = current < (typeof foundryMax === "number" ? foundryMax : lastTlrMax);
  return { value: damaged ? Math.min(current, newMax) : newMax, max: newMax };
}

/** dnd5e's LIMITED permission: the npc sheet's limited view (portrait + biography, no stats). */
export const LIMITED = 1;

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
  // FULL_DETAILS NPCs: players get LIMITED (they may read the biography TLR already shares with them).
  // CARD_ONLY stays at actorOwnership (GM-only by default): its stats ride along, but no sheet opens.
  const fullOwnership = { ...actorOwnership, default: Math.max(actorOwnership.default ?? 0, LIMITED) };
  for (const npc of pkg.npcs ?? []) {
    const ownership = npc.visibility === "FULL_DETAILS" ? fullOwnership : actorOwnership;
    actors.push(npcActor({ npc, folderKey: `${root}:npcs`, ownership, scope }));
  }

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
