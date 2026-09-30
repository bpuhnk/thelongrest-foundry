/**
 * The reload-safe roll queue (docs/api.md, "Writing a VTT connector").
 *
 * Rolls are events: a GM reload inside the push debounce would otherwise lose them. Unacknowledged
 * rolls live in `sessionStorage` (it survives a reload of the tab, not a new tab), keyed per world
 * and user, capped at 200 rolls and 15 minutes. A roll leaves the queue only after The Long Rest
 * acknowledges its batch. Resends are harmless: every roll carries a stable `id` and readers dedupe.
 * No `beforeunload` work: `sendBeacon` can't carry the Authorization header.
 */
export const QUEUE_CAP = 200;
export const QUEUE_TTL_MS = 15 * 60_000;

export const queueKey = (worldId, userId) => `tlr-connector:pending-rolls:${worldId}:${userId}`;

/** A Storage-like map, for tests and for when the browser refuses sessionStorage. */
export function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
}

const validRoll = (r) => r && typeof r === "object" && typeof r.actor === "string" && Number.isFinite(r.total);

export class RollQueue {
  /** @param {{ storage?: Storage | ReturnType<typeof memoryStorage>, key?: string, now?: () => number, cap?: number, ttlMs?: number }} [opts] */
  constructor({ storage, key = queueKey("local", "local"), now = () => Date.now(), cap = QUEUE_CAP, ttlMs = QUEUE_TTL_MS } = {}) {
    Object.assign(this, { key, now, cap, ttlMs });
    this.storage = storage ?? memoryStorage();
    this.seq = 0;
    this.dropped = 0;
    this.entries = this.#load();
    for (const e of this.entries) this.seq = Math.max(this.seq, e.seq);
  }

  #load() {
    let parsed = [];
    try {
      parsed = JSON.parse(this.storage.getItem(this.key) ?? "[]");
    } catch {
      parsed = [];
    }
    if (!Array.isArray(parsed)) parsed = [];
    const fresh = parsed.filter((e) => e && Number.isInteger(e.seq) && Number.isFinite(e.queuedAt) && validRoll(e.roll));
    return this.#prune(fresh);
  }

  #prune(entries) {
    const cutoff = this.now() - this.ttlMs;
    let kept = entries.filter((e) => e.queuedAt > cutoff);
    if (kept.length > this.cap) kept = kept.slice(kept.length - this.cap); // the oldest go first
    this.dropped += entries.length - kept.length;
    return kept;
  }

  #save() {
    try {
      if (this.entries.length) this.storage.setItem(this.key, JSON.stringify(this.entries));
      else this.storage.removeItem(this.key);
    } catch {
      // Storage full or refused: the queue still works in memory; it just won't survive a reload.
      this.storage = memoryStorage();
    }
  }

  get size() {
    return this.entries.length;
  }

  /** Queue rolls (a roll whose `id` is already queued is skipped). Returns how many were dropped by the caps. */
  add(rolls) {
    const before = this.dropped;
    const have = new Set(this.entries.map((e) => e.roll.id).filter(Boolean));
    const at = this.now();
    for (const roll of rolls) {
      if (!validRoll(roll) || (roll.id && have.has(roll.id))) continue;
      if (roll.id) have.add(roll.id);
      this.entries.push({ seq: ++this.seq, queuedAt: at, roll });
    }
    this.entries = this.#prune(this.entries);
    this.#save();
    return this.dropped - before;
  }

  /** The oldest `n` pending entries (expired ones are dropped first). They stay queued until `ack`. */
  peek(n) {
    const pruned = this.#prune(this.entries);
    if (pruned.length !== this.entries.length) {
      this.entries = pruned;
      this.#save();
    }
    return this.entries.slice(0, n);
  }

  /** The Long Rest acknowledged these entries (by `seq`): forget them. */
  ack(seqs) {
    const done = new Set(seqs);
    this.entries = this.entries.filter((e) => !done.has(e.seq));
    this.#save();
  }
}
