// The live-state payload contract, re-declared from The Long Rest's public docs (docs/api.md,
// POST /api/v1/live-state): what the server accepts. Tests hold every payload the module builds to it.
const str = (v, max, min = 0) => typeof v === "string" && v.length >= min && v.length <= max;
const int = (v) => Number.isInteger(v);
const optional = (v, check) => v === undefined || check(v);
const list = (v, max, each) => Array.isArray(v) && v.length <= max && v.every(each);

const combatant = (c) =>
  str(c.name, 120, 1) && optional(c.initiative, Number.isFinite) && optional(c.hp, int) && optional(c.maxHp, int) &&
  optional(c.ac, int) && optional(c.conditions, (x) => list(x, 20, (s) => str(s, 60))) && optional(c.isPC, (b) => typeof b === "boolean") &&
  optional(c.defeated, (b) => typeof b === "boolean");

export const CONTRACT = {
  COMBAT: (p) => optional(p.encounterName, (s) => str(s, 160)) && optional(p.round, (r) => int(r) && r >= 0 && r <= 999) &&
    optional(p.activeCombatant, (s) => str(s, 120, 1)) && list(p.combatants, 60, combatant),
  INITIATIVE: (p) => list(p.order, 60, (o) => str(o.name, 120, 1) && Number.isFinite(o.initiative)),
  HP: (p) => list(p.entries, 60, (e) => str(e.name, 120, 1) && int(e.hp) && optional(e.maxHp, int)),
  SCENE: (p) => optional(p.name, (s) => str(s, 160)) && optional(p.description, (s) => str(s, 2000)) && optional(p.tags, (t) => list(t, 20, (s) => str(s, 60))),
  ROLL: (p) => list(p.rolls, 40, (r) =>
    str(r.actor, 120, 1) && Number.isFinite(r.total) && optional(r.formula, (s) => str(s, 80)) && optional(r.label, (s) => str(s, 160)) &&
    optional(r.id, (s) => str(s, 80, 1)) && optional(r.dice, (d) => list(d, 20, (x) => int(x.faces) && x.faces >= 2 && x.faces <= 1000 && list(x.results, 40, int))) &&
    optional(r.rollType, (s) => str(s, 40)) && optional(r.user, (s) => str(s, 120)) && optional(r.flavor, (s) => str(s, 200)) && optional(r.at, (s) => str(s, 40))),
  EFFECTS: (p) => optional(p.round, (r) => int(r) && r >= 0 && r <= 999) && list(p.creatures, 60, (c) =>
    str(c.actor, 120, 1) && list(c.effects, 30, (e) => str(e.name, 120, 1) && optional(e.statusId, (s) => str(s, 60)) &&
      optional(e.source, (s) => str(s, 120)) && optional(e.roundApplied, int))),
};

export const accepts = (kind, payload) => Boolean(CONTRACT[kind]?.(payload));
