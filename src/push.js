/**
 * Foundry → The Long Rest live-state push.
 *
 * Pure builders over plain snapshots (no Foundry globals), unit tested in Node. The Foundry glue
 * (connector.js) turns documents into the `*View` shapes below.
 *
 * THE RULES (never broken; each has a test):
 * - hidden combatants / hidden tokens are omitted everywhere, including as the active combatant;
 * - NPC HP is omitted (only `defeated`) unless the GM turns on "share exact NPC HP";
 * - whispered and blind rolls are never sent; rolls spoken by a hidden token are never sent.
 */

import { RollQueue } from "./roll-queue.js";

const clampStr = (s, n) => String(s ?? "").slice(0, n);
const stripHtml = (s) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/**
 * @typedef {{ name: string, hidden: boolean, initiative: number|null, isPC: boolean, defeated: boolean,
 *   hp: number|null, maxHp: number|null, ac: number|null, conditions: string[] }} CombatantView
 * @typedef {{ name: string, round: number, activeId: string|null, combatants: (CombatantView & { id: string })[] }} CombatView
 */

/** COMBAT payload, or an empty fight when there is none (the AI renderer then drops it). */
export function combatPayload(combat, { shareNpcHp = false } = {}) {
  if (!combat) return { combatants: [] };
  const visible = combat.combatants.filter((c) => !c.hidden).slice(0, 60);
  const active = visible.find((c) => c.id === combat.activeId);
  return {
    encounterName: clampStr(combat.name, 160) || undefined,
    round: Math.max(0, Math.min(999, combat.round | 0)),
    activeCombatant: active ? clampStr(active.name, 120) : undefined,
    combatants: visible.map((c) => {
      const showHp = c.isPC || shareNpcHp;
      return {
        name: clampStr(c.name, 120),
        ...(c.initiative != null ? { initiative: c.initiative } : {}),
        ...(showHp && c.hp != null ? { hp: Math.trunc(c.hp) } : {}),
        ...(showHp && c.maxHp != null ? { maxHp: Math.trunc(c.maxHp) } : {}),
        ...(c.isPC && c.ac != null ? { ac: Math.trunc(c.ac) } : {}),
        conditions: (c.conditions ?? []).slice(0, 20).map((s) => clampStr(s, 60)),
        isPC: c.isPC,
        defeated: c.defeated,
      };
    }),
  };
}

export function initiativePayload(combat) {
  if (!combat) return { order: [] };
  return {
    order: combat.combatants
      .filter((c) => !c.hidden && c.initiative != null)
      .sort((a, b) => b.initiative - a.initiative)
      .slice(0, 60)
      .map((c) => ({ name: clampStr(c.name, 120), initiative: c.initiative })),
  };
}

/** HP for player characters always; NPCs only with shareNpcHp. `creatures` are visible ones only. */
export function hpPayload(creatures, { shareNpcHp = false } = {}) {
  return {
    entries: creatures
      .filter((c) => !c.hidden && c.hp != null && (c.isPC || shareNpcHp))
      .slice(0, 60)
      .map((c) => ({ name: clampStr(c.name, 120), hp: Math.trunc(c.hp), ...(c.maxHp != null ? { maxHp: Math.trunc(c.maxHp) } : {}) })),
  };
}

/**
 * @typedef {{ id: string, whisper: string[], blind: boolean, speakerHidden: boolean, speaker: string,
 *   user: string|null, flavor: string, rollType: string|null, at: number,
 *   rolls: { formula: string, total: number, dice: { faces: number, results: number[] }[] }[] }} MessageView
 */

// dnd5e's roll/activity types → The Long Rest's rollType (docs/api.md; anything else is "other").
const ROLL_TYPES = {
  attack: "attack", damage: "damage", save: "save", check: "check", ability: "check", tool: "check",
  skill: "skill", initiative: "initiative", heal: "heal", healing: "heal", death: "save", deathSave: "save", concentration: "save",
};
export const rollTypeOf = (t) => ROLL_TYPES[t] ?? "other";

/** Rolls a table may see, from one chat message. [] when the message must not leave Foundry. */
export function rollsFromMessage(m) {
  if (!m || !m.rolls?.length) return [];
  if (m.blind || (m.whisper?.length ?? 0) > 0 || m.speakerHidden) return [];
  const flavor = stripHtml(m.flavor);
  return m.rolls.map((r, i) => ({
    actor: clampStr(m.speaker || m.user || "Unknown", 120),
    formula: clampStr(r.formula, 80),
    total: Number(r.total),
    label: clampStr(flavor, 160) || undefined,
    // The Long Rest's roll fields (docs/api.md, live-state ROLL). `id` is stable across a reload, so a
    // resent batch dedupes.
    ...(m.id ? { id: clampStr(`${m.id}:${i}`, 80) } : {}),
    dice: r.dice?.slice(0, 20).filter((d) => d.faces >= 2 && d.faces <= 1000).map((d) => ({ faces: d.faces, results: d.results.slice(0, 40) })),
    rollType: rollTypeOf(m.rollType),
    user: m.user ? clampStr(m.user, 120) : undefined,
    flavor: clampStr(flavor, 200) || undefined,
    at: new Date(m.at).toISOString(),
  })).filter((r) => Number.isFinite(r.total));
}

/**
 * @typedef {{ name: string, hidden: boolean, effects: { name: string, statusId: string|null,
 *   source: string|null, startRound: number|null, rounds: number|null, seconds: number|null }[] }} EffectsView
 */

/** EFFECTS snapshot: the current effects of every VISIBLE creature (docs/api.md, live-state EFFECTS). */
export function effectsPayload(creatures, round) {
  return {
    ...(round != null ? { round: Math.max(0, Math.min(999, round | 0)) } : {}),
    creatures: creatures
      .filter((c) => !c.hidden)
      .slice(0, 60)
      .map((c) => ({
        actor: clampStr(c.name, 120),
        effects: c.effects.slice(0, 30).map((e) => ({
          name: clampStr(e.name, 120),
          ...(e.statusId ? { statusId: clampStr(e.statusId, 60) } : {}),
          ...(e.source ? { source: clampStr(e.source, 120) } : {}),
          ...(e.startRound != null ? { roundApplied: e.startRound | 0 } : {}),
          ...(e.rounds || e.seconds ? { duration: { ...(e.rounds ? { rounds: e.rounds | 0 } : {}), ...(e.seconds ? { seconds: e.seconds | 0 } : {}) } } : {}),
        })),
      })),
  };
}

/**
 * The coalescer. Hooks `mark(kind)`; after `debounceMs` of quiet the kind's CURRENT snapshot is
 * built and sent. Writes stay under `budgetPerMin` (a sliding minute; below the server's 60), and a
 * 429 pauses every kind until Retry-After. A kind marked while waiting is sent once, with the
 * newest snapshot, so a throttled burst loses intermediate states, never the final one.
 * ROLL is different: rolls are events, so they wait in a RollQueue (reload-safe when it is backed
 * by sessionStorage) and go in batches of ≤ 40; a batch leaves the queue only on a 2xx.
 */
export class Pusher {
  // Timers are wrapped: calling a stored `setTimeout` as a method (`this.setTimer(...)`) throws
  // "Illegal invocation" in browsers (Node tolerates it), which would silently block every push.
  constructor({ build, send, rollQueue, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), debounceMs = 1000, budgetPerMin = 50 }) {
    Object.assign(this, { build, send, now, setTimer, clearTimer, debounceMs, budgetPerMin });
    this.rolls = rollQueue ?? new RollQueue({ now });
    this.timers = new Map();
    this.dirty = new Set();
    this.sentAt = [];
    this.pausedUntil = 0;
    this.metrics = { marks: {}, sent: {}, superseded: 0, throttled: 0, rateLimited: 0, errors: 0, droppedRolls: 0 };
  }

  mark(kind) {
    this.metrics.marks[kind] = (this.metrics.marks[kind] ?? 0) + 1;
    if (this.dirty.has(kind)) this.metrics.superseded += 1;
    this.dirty.add(kind);
    this.schedule(kind, this.debounceMs);
  }

  queueRolls(rolls) {
    if (!rolls.length) return;
    this.metrics.droppedRolls += this.rolls.add(rolls);
    this.mark("ROLL");
  }

  /** After `ready`: send whatever a previous page load left unacknowledged. */
  resume() {
    this.metrics.droppedRolls += this.rolls.dropped;
    this.rolls.dropped = 0;
    if (this.rolls.size) this.mark("ROLL");
  }

  schedule(kind, delay) {
    const t = this.timers.get(kind);
    if (t) this.clearTimer(t);
    this.timers.set(kind, this.setTimer(() => this.flush(kind), Math.max(0, delay)));
  }

  /** ms until another write fits the budget (0 = now). */
  budgetWait() {
    const now = this.now();
    this.sentAt = this.sentAt.filter((t) => now - t < 60_000);
    if (now < this.pausedUntil) return this.pausedUntil - now;
    if (this.sentAt.length < this.budgetPerMin) return 0;
    return 60_000 - (now - this.sentAt[0]) + 5;
  }

  async flush(kind) {
    this.timers.delete(kind);
    if (!this.dirty.has(kind)) return;
    const wait = this.budgetWait();
    if (wait > 0) {
      this.metrics.throttled += 1;
      this.schedule(kind, wait);
      return;
    }
    this.dirty.delete(kind);
    let payload;
    let batch = null;
    if (kind === "ROLL") {
      batch = this.rolls.peek(40);
      if (!batch.length) return;
      payload = { rolls: batch.map((e) => e.roll) };
    } else {
      payload = this.build(kind);
      if (payload == null) return;
    }
    this.sentAt.push(this.now());
    let res;
    try {
      res = await this.send(kind, payload);
    } catch {
      // Network / not connected: the batch stays queued; try again later.
      this.metrics.errors += 1;
      this.dirty.add(kind);
      this.schedule(kind, 30_000);
      return;
    }
    if (res.status === 429) {
      this.metrics.rateLimited += 1;
      this.pausedUntil = this.now() + Math.max(1, Number(res.retryAfter) || 60) * 1000;
      this.dirty.add(kind);
      this.schedule(kind, this.pausedUntil - this.now());
      return;
    }
    if (res.status >= 500) {
      this.metrics.errors += 1;
      this.dirty.add(kind);
      this.schedule(kind, 30_000);
      return;
    }
    if (res.status >= 400) {
      this.metrics.errors += 1;
      // A payload the server rejects would be rejected forever: drop that batch. An auth failure
      // (401/403) keeps it for the next mark, within the queue's 15 minutes.
      if (batch && ![401, 403].includes(res.status)) {
        this.metrics.droppedRolls += batch.length;
        this.rolls.ack(batch.map((e) => e.seq));
      }
      return;
    }
    this.metrics.sent[kind] = (this.metrics.sent[kind] ?? 0) + 1;
    if (batch) this.rolls.ack(batch.map((e) => e.seq));
    if (kind === "ROLL" && this.rolls.size) this.mark("ROLL");
  }
}
