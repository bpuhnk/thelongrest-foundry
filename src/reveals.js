/**
 * Reveals: The Long Rest → Foundry, by polling (docs/api.md, `GET /sessions/{id}/reveals?since=`).
 *
 * - Only the ACTIVE GM polls (co-GMs stay idle), and only while connected.
 * - It follows the campaign's running (ACTIVE) session: its reveals every 10 s. With no running
 *   session it only re-asks `GET /campaign` every 60 s (never polls reveals without one), and while
 *   one runs it re-asks every 5 minutes to notice it ending or changing.
 * - `since` is always the previous response's `serverTime` (never our clock), `If-None-Match` sends
 *   the last ETag, and ids are deduped (serverTime is taken before the query, so a fact can repeat).
 * - The first poll of a session (no cursor) catches up on everything; it is applied but never
 *   announced, so connecting mid-campaign doesn't flood the chat.
 * - The cursor, ETag and seen-ids advance only AFTER `onReveals` succeeds, so a failed apply is
 *   retried on the next tick instead of losing the facts. Every tick is bounded by a watchdog
 *   (window 3: a never-resolving await stopped all polling).
 */
import { escapeHtml } from "./mapper.js";

export const ACTIVE_MS = 10_000;
export const IDLE_MS = 60_000;
export const CAMPAIGN_REFRESH_MS = 5 * 60_000;
/** A tick that takes longer than this is abandoned, so one hung await can never stop the polling. */
export const TICK_TIMEOUT_MS = 30_000;
const SEEN_CAP = 500;

/**
 * `onSession` is called with the first campaign answer after (re)start, and whenever the running
 * session changes; the caller sends a fresh live-state snapshot then (so it carries the sessionId).
 * @param {{
 *   transport: { request(req: object): Promise<{ status: number, headers: Record<string,string>, body: any }> },
 *   isActiveGM: () => boolean,
 *   onReveals: (session: { id: string, number: number, title: string }, reveals: object[], opts: { initial: boolean }) => Promise<void>,
 *   onSession?: (session: object | null) => void,
 *   now?: () => number, setTimer?: (fn: () => void, ms: number) => unknown, clearTimer?: (id: unknown) => void,
 *   log?: (msg: string) => void,
 * }} deps
 */
export function createRevealPoller({ transport, isActiveGM, onReveals, onSession = () => {}, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), log = () => {} }) {
  let session = null;
  let campaignAt = -Infinity;
  let cursor = null;
  let etag = null;
  let seen = [];
  let timer = null;
  let stopped = true;
  let resolved = false; // has GET /campaign answered since (re)start? The first answer always reports.
  const metrics = { polls: 0, notModified: 0, applied: 0, campaignChecks: 0, errors: 0, stalls: 0 };
  let generation = 0; // bumped when a tick is abandoned, so its late result can't commit stale state

  function setSession(next) {
    const first = !resolved;
    resolved = true;
    if (!first && (next?.id ?? null) === (session?.id ?? null)) {
      if (next) session = next;
      return;
    }
    session = next;
    cursor = null;
    etag = null;
    seen = [];
    onSession(session);
  }

  async function refreshCampaign() {
    metrics.campaignChecks += 1;
    campaignAt = now();
    const res = await transport.request({ method: "GET", path: "/api/v1/campaign" });
    if (res.status === 200) setSession(res.body?.campaign?.activeSession ?? null);
  }

  async function pollReveals(gen) {
    metrics.polls += 1;
    const q = cursor ? `?since=${encodeURIComponent(cursor)}` : "";
    const res = await transport.request({
      method: "GET",
      path: `/api/v1/sessions/${session.id}/reveals${q}`,
      headers: etag ? { "If-None-Match": etag } : {},
    });
    if (res.status === 304) {
      metrics.notModified += 1;
      return;
    }
    if (res.status === 404) {
      campaignAt = -Infinity; // the session went away (or isn't ours): ask the campaign again
      setSession(null);
      return;
    }
    if (res.status === 429) return { retryAfterMs: Math.max(1, Number(res.headers?.["retry-after"]) || 60) * 1000 };
    if (res.status !== 200) {
      metrics.errors += 1;
      return;
    }
    const initial = cursor === null;
    const nextCursor = typeof res.body?.serverTime === "string" ? res.body.serverTime : cursor;
    const nextEtag = res.headers?.etag ?? etag;
    const have = new Set(seen);
    const fresh = (res.body?.reveals ?? []).filter((r) => r && typeof r.id === "string" && typeof r.fact === "string" && !have.has(r.id));
    const forSession = session;
    if (fresh.length) await onReveals(forSession, fresh, { initial }); // throws → nothing committed → retried
    if (gen !== generation || forSession !== session) return; // abandoned, or the session changed meanwhile
    cursor = nextCursor;
    etag = nextEtag;
    if (fresh.length) {
      seen = [...seen, ...fresh.map((r) => r.id)].slice(-SEEN_CAP);
      metrics.applied += fresh.length;
    }
  }

  async function work(gen) {
    if (!isActiveGM()) return IDLE_MS;
    if (now() - campaignAt >= (session ? CAMPAIGN_REFRESH_MS : IDLE_MS)) await refreshCampaign();
    if (!session) return IDLE_MS;
    const r = await pollReveals(gen);
    return r?.retryAfterMs ?? (session ? ACTIVE_MS : IDLE_MS);
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    let delay = IDLE_MS;
    const gen = generation;
    let watchdog = null;
    try {
      const stalled = new Promise((_, reject) => {
        watchdog = setTimer(() => reject(Object.assign(new Error("tick timed out"), { stalled: true })), TICK_TIMEOUT_MS);
      });
      delay = await Promise.race([work(gen), stalled]);
    } catch (err) {
      // Not connected, refused (latched in the transport: no network), offline, or a hung await.
      metrics.errors += 1;
      if (err?.stalled) {
        metrics.stalls += 1;
        generation += 1; // the abandoned tick may still finish later; it must not commit anything
      }
      log(`reveals: ${err?.message ?? err}`);
      // Retry soon while a session runs (a refused token is latched in the transport and costs no
      // network); back off only when there's no session. Window 3's 35 s silence was this at 60 s.
      delay = session ? ACTIVE_MS : IDLE_MS;
    } finally {
      if (watchdog) clearTimer(watchdog);
    }
    if (!stopped) timer = setTimer(tick, delay);
  }

  return {
    metrics,
    get session() {
      return session;
    },
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setTimer(tick, 0);
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    /** After the GM reconnects (new token or campaign): forget everything and start over. */
    restart() {
      this.stop();
      campaignAt = -Infinity;
      session = null;
      cursor = null;
      etag = null;
      seen = [];
      resolved = false;
      this.start();
    },
  };
}

/**
 * The optional chat card, as a best-effort side effect: `announce(reveal)` returns at once, never
 * throws, and a create that never settles is abandoned after `timeoutMs` (logged). It can't block
 * the journal page or the polling.
 */
export function makeAnnouncer({ create, warn = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), timeoutMs = 10_000 }) {
  return function announce(reveal) {
    let t = null;
    const timeout = new Promise((_, reject) => {
      t = setTimer(() => reject(new Error(`timed out after ${timeoutMs / 1000} s`)), timeoutMs);
    });
    let started;
    try {
      started = Promise.resolve(create({ content: revealCardHtml(reveal), speaker: { alias: "The Long Rest" } }));
    } catch (err) {
      started = Promise.reject(err);
    }
    return Promise.race([started, timeout])
      .then(() => true, (err) => (warn(`reveal chat card: ${err?.message ?? err}`), false))
      .finally(() => clearTimer(t));
  };
}

/** The optional public chat card for a newly revealed fact. Every string from The Long Rest is escaped. */
export function revealCardHtml(reveal) {
  const source = reveal.sourceNpc?.name ? `<p class="tlr-reveal-source">— ${escapeHtml(reveal.sourceNpc.name)}</p>` : "";
  return `<div class="tlr-reveal"><h3>${escapeHtml("Revealed")}</h3><p>${escapeHtml(reveal.fact)}</p>${source}</div>`;
}
