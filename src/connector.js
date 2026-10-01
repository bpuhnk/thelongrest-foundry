/**
 * The Foundry side of the connector: reads Foundry documents into the plain views push.js expects,
 * registers the hooks, imports a session package, and applies reveals. It never holds a credential:
 * every request goes through the injected `transport` (transport.js holds the token and enforces the
 * campaign pin + scope). Counters land on `connector.metrics` for the status panel and tests.
 */
import { MODULE_ID, planFromPackage, reimportHp } from "./mapper.js";

/** Re-import: a legendary-action / legendary-resistance count the GM has spent is kept (clamped to the new max). */
export function keepSpentResources(update, actor) {
  const next = update.system?.resources;
  if (!next) return;
  for (const k of ["legact", "legres"]) {
    const cur = actor.system?.resources?.[k]?.value;
    if (next[k] && typeof cur === "number" && Number.isFinite(cur)) next[k] = { ...next[k], value: Math.min(cur, next[k].max) };
  }
}
import { versionGate } from "./gate.js";
import { combatPayload, effectsPayload, hpPayload, initiativePayload, Pusher, rollsFromMessage } from "./push.js";

export function isActiveGM(game) {
  return Boolean(game.user?.isGM && game.users?.activeGM?.id === game.user.id);
}

const getProp = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

// ---- document → view ------------------------------------------------------------------------

function creatureView(actor, token, fallbackName, hiddenFlag) {
  const hp = actor?.system?.attributes?.hp;
  return {
    name: token?.name ?? fallbackName ?? actor?.name ?? "Unknown",
    hidden: Boolean(hiddenFlag || token?.hidden),
    isPC: Boolean(actor?.hasPlayerOwner && actor?.type === "character"),
    hp: typeof hp?.value === "number" ? hp.value : null,
    maxHp: typeof hp?.max === "number" ? hp.max : null,
    ac: typeof actor?.system?.attributes?.ac?.value === "number" ? actor.system.attributes.ac.value : null,
    conditions: actor?.statuses ? [...actor.statuses] : [],
  };
}

/**
 * The fight the TABLE is in. v14's `game.combat` / `game.combats.active` follow the scene the GM is
 * VIEWING: a GM previewing another map mid-fight would otherwise read "no combat". So prefer
 * the active combat on the scene the PLAYERS are on, then an unlinked active combat, then core's pick.
 */
export function tableCombat(game) {
  const combats = game.combats?.contents ?? [];
  return combats.find((c) => c.active && c.scene?.active) ?? combats.find((c) => c.active && !c.scene) ?? game.combats?.active ?? game.combat ?? null;
}

export function combatView(game) {
  const combat = tableCombat(game);
  if (!combat) return null;
  return {
    name: combat.scene?.name ?? "Combat",
    round: combat.round ?? 0,
    activeId: combat.combatant?.id ?? null,
    combatants: combat.combatants.contents.map((c) => ({
      id: c.id,
      initiative: typeof c.initiative === "number" ? c.initiative : null,
      defeated: Boolean(c.isDefeated),
      ...creatureView(c.actor, c.token, c.name, c.hidden),
    })),
  };
}

/** The creatures the table can see: combatants (if fighting) plus every player character. */
function visibleCreatures(game) {
  const out = [];
  const seen = new Set();
  const combat = tableCombat(game);
  for (const c of combat?.combatants?.contents ?? []) {
    out.push({ actor: c.actor, view: creatureView(c.actor, c.token, c.name, c.hidden) });
    if (c.actor) seen.add(c.actor.id);
  }
  for (const a of game.actors?.contents ?? []) {
    if (a.type === "character" && a.hasPlayerOwner && !seen.has(a.id)) out.push({ actor: a, view: creatureView(a, null, a.name, false) });
  }
  return out;
}

export function messageView(game, m, metrics) {
  const scene = game.scenes?.get(m.speaker?.scene);
  const token = scene?.tokens?.get(m.speaker?.token);
  // dnd5e 6.x snapshots card data on message.system (5.x used flags.dnd5e; kept as a fallback).
  const typeV6 = m.system?.roll?.type ?? m.system?.activity?.type ?? null;
  const typeV5 = m.flags?.dnd5e?.roll?.type ?? m.flags?.dnd5e?.messageType ?? null;
  if (metrics) {
    const src = typeV6 ? "system" : typeV5 ? "flags" : "none";
    metrics.rollTypeSource[src] = (metrics.rollTypeSource[src] ?? 0) + 1;
  }
  return {
    id: m.id,
    whisper: m.whisper ?? [],
    blind: Boolean(m.blind),
    speakerHidden: Boolean(token?.hidden),
    speaker: m.speaker?.alias ?? token?.name ?? "",
    user: m.author?.name ?? m.user?.name ?? null,
    flavor: m.flavor ?? "",
    rollType: typeV6 ?? typeV5,
    at: m.timestamp ?? Date.now(),
    rolls: (m.rolls ?? []).map((r) => ({
      formula: r.formula,
      total: r.total,
      dice: (r.dice ?? []).map((d) => ({ faces: d.faces, results: (d.results ?? []).filter((x) => x.active !== false).map((x) => x.result) })),
    })),
  };
}

function effectsView(game, metrics) {
  return visibleCreatures(game).map(({ actor, view }) => ({
    name: view.name,
    hidden: view.hidden,
    effects: [...(actor?.appliedEffects ?? actor?.effects ?? [])]
      .filter((e) => !e.disabled)
      .map((e) => {
        const d = e.duration ?? {};
        if (metrics && !metrics.effectDurationKeys) metrics.effectDurationKeys = Object.keys(d._source ?? d);
        return {
          name: e.name,
          statusId: e.statuses ? [...e.statuses][0] ?? null : null,
          source: e.origin ? String(e.origin) : null,
          startRound: typeof d.startRound === "number" ? d.startRound : null,
          rounds: typeof d.rounds === "number" ? d.rounds : null,
          seconds: typeof d.seconds === "number" ? d.seconds : null,
        };
      }),
  }));
}

// ---- the connector --------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.game, opts.Hooks, opts.foundry, opts.CONFIG: Foundry globals (passed in so C can inject them)
 * @param {(req: {method: string, path: string, body?: unknown, headers?: Record<string,string>}) => Promise<{status: number, headers: Record<string,string>, body: unknown}>} opts.transport
 * @param {() => {shareNpcHp: boolean, sessionId: string|null}} opts.settings
 * @param {() => boolean} [opts.enabled] false while the world isn't connected: hooks then do nothing
 * @param {import("./roll-queue.js").RollQueue} [opts.rollQueue] the reload-safe queue (sessionStorage-backed in Foundry)
 * @param {string} [opts.moduleVersion] sent in X-TLR-Client, so The Long Rest can see the version tail
 */
export function createConnector({ game, Hooks, Actor, Folder, JournalEntry, transport, settings, getCampaignId = () => null, enabled = () => true, rollQueue, moduleVersion = "0.0.0", log = console.log }) {
  const metrics = {
    hooks: {},
    rollTypeSource: {},
    effectDurationKeys: null,
    imports: [],
    revealLatencyMs: [],
    pusher: null,
    gate: null,
  };
  const gate = versionGate(game);
  metrics.gate = gate;

  const client = `${MODULE_ID}/${moduleVersion} foundry/${game.version} dnd5e/${game.system?.version}`;
  const request = (method, path, body, headers = {}) =>
    transport({ method, path, body, headers: { "X-TLR-Client": client, ...headers } });

  const pusher = new Pusher({
    rollQueue,
    build: (kind) => {
      const s = settings();
      if (kind === "COMBAT") return combatPayload(combatView(game), s);
      if (kind === "INITIATIVE") return initiativePayload(combatView(game));
      if (kind === "HP") return hpPayload(visibleCreatures(game).map((x) => x.view), s);
      if (kind === "SCENE") {
        const scene = game.scenes?.active; // the scene the PLAYERS are on, not the one the GM is viewing
        return scene ? { name: String(scene.navName || scene.name).slice(0, 160) } : null;
      }
      if (kind === "EFFECTS") return effectsPayload(effectsView(game, metrics), tableCombat(game)?.round ?? null);
      return null;
    },
    send: async (kind, payload) => {
      const s = settings();
      const res = await request("POST", "/api/v1/live-state", { kind, ...(s.sessionId ? { sessionId: s.sessionId } : {}), payload });
      return { status: res.status, retryAfter: res.headers?.["retry-after"] };
    },
  });
  metrics.pusher = pusher.metrics;

  const count = (name) => (metrics.hooks[name] = (metrics.hooks[name] ?? 0) + 1);
  const onHook = (name, kinds, extra) =>
    Hooks.on(name, (...args) => {
      count(name);
      if (!gate.ok || !isActiveGM(game) || !enabled()) return;
      if (extra) extra(...args);
      for (const k of kinds) pusher.mark(k);
    });

  const hookIds = [];
  function registerHooks() {
    const COMBAT = ["COMBAT", "INITIATIVE", "HP", "EFFECTS"];
    for (const h of ["combatStart", "combatTurn", "combatRound", "createCombat", "updateCombat", "deleteCombat", "createCombatant", "updateCombatant", "deleteCombatant"]) {
      hookIds.push([h, onHook(h, COMBAT)]);
    }
    hookIds.push(["updateActor", onHook("updateActor", ["HP", "COMBAT"])]);
    hookIds.push(["updateToken", onHook("updateToken", ["COMBAT", "INITIATIVE", "HP", "EFFECTS"])]);
    for (const h of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) hookIds.push([h, onHook(h, ["EFFECTS", "COMBAT"])]);
    hookIds.push(["updateScene", onHook("updateScene", ["SCENE"])]);
    hookIds.push(["canvasReady", onHook("canvasReady", ["SCENE"])]);
    hookIds.push([
      "createChatMessage",
      Hooks.on("createChatMessage", (m) => {
        count("createChatMessage");
        if (!gate.ok || !isActiveGM(game) || !enabled()) return;
        pusher.queueRolls(rollsFromMessage(messageView(game, m, metrics)));
      }),
    ]);
  }

  // ---- import ----

  async function upsertFolder(f, idByKey) {
    const existing = game.folders.find((x) => x.type === f.type && x.getFlag(MODULE_ID, "key") === f.key);
    if (existing) {
      if (existing.name !== f.name) await existing.update({ name: f.name }); // a renamed session
      return existing.id;
    }
    const created = await Folder.create({ name: f.name, type: f.type, folder: f.parentKey ? idByKey.get(f.parentKey) : null, flags: { [MODULE_ID]: { key: f.key } } });
    return created.id;
  }

  function verify(actor, expect) {
    const src = actor._source ?? actor;
    const misses = [];
    for (const [path, want] of expect) {
      let got;
      const item = /^items\[(.+?)\]\.(.+)$/.exec(path);
      if (path === "items.length") got = actor.items.size;
      else if (item) {
        const it = actor.items.getName(item[1]);
        const isrc = it?._source;
        if (item[2] === "activities.attack.bonus") {
          const acts = Object.values(isrc?.system?.activities ?? {});
          got = acts.find((a) => a.type === "attack")?.attack?.bonus;
        } else got = getProp(isrc, item[2]);
      } else got = getProp(src, path);
      // dnd5e may store numbers as strings (or the reverse); record exact vs loose separately.
      if (got !== want) misses.push({ path, want, got, loose: got != null && String(got) === String(want) });
    }
    return misses;
  }

  /**
   * Remove the NPC actors THIS import's session used to have but the package no longer contains (the DM
   * set them back to Hidden, or detached them). The package can't name hidden NPCs, so absence is the
   * signal; only called after a successful create/update pass. Only our own `:npc:` actors under this
   * campaign + session's key are candidates: never encounter monsters, other sessions, other campaigns
   * or hand-made actors. Their placed tokens go first (a token keeps the name and image), on every scene.
   */
  async function pruneHiddenNpcs(plan, report) {
    const root = plan.folders.find((f) => !f.parentKey)?.key;
    if (!root) return;
    const prefix = `${root}:npc:`;
    const keep = new Set(plan.actors.filter((a) => a.key.startsWith(prefix)).map((a) => a.key));
    const stale = game.actors.filter((a) => {
      const k = a.getFlag(MODULE_ID, "key");
      return typeof k === "string" && k.startsWith(prefix) && !keep.has(k);
    });
    if (!stale.length) return;
    const ids = new Set(stale.map((a) => a.id));
    for (const scene of game.scenes ?? []) {
      // Linked and unlinked tokens both reference their base actor by actorId.
      const tokens = scene.tokens.filter((t) => ids.has(t.actorId)).map((t) => t.id);
      if (tokens.length) {
        await scene.deleteEmbeddedDocuments("Token", tokens);
        report.removed.tokens += tokens.length;
      }
    }
    const names = stale.map((a) => a.name);
    await Actor.deleteDocuments([...ids]);
    report.removed.npcs = ids.size;
    log(`${MODULE_ID} | removed ${ids.size} NPC(s) no longer visible in The Long Rest: ${names.join(", ")}`); // GM console only
  }

  /**
   * A changed TLR portrait → the tokens already PLACED for that actor (every scene, linked or not), but
   * only those still showing the OLD portrait: a token the GM gave its own art is left alone.
   * @returns {Promise<number>} how many tokens were updated
   */
  async function retexturePlacedTokens(actorId, from, to) {
    let n = 0;
    for (const scene of game.scenes ?? []) {
      const ids = scene.tokens.filter((t) => t.actorId === actorId && t.texture?.src === from).map((t) => t.id);
      if (!ids.length) continue;
      await scene.updateEmbeddedDocuments("Token", ids.map((_id) => ({ _id, texture: { src: to } })));
      n += ids.length;
    }
    return n;
  }

  /**
   * @param {object} pkg the session package (a 200 that parsed)
   * @param {{ sessionId?: string }} [opts] the session that was REQUESTED; stale NPCs are pruned only
   *   when the package is that session's (never on a mismatch, never without it)
   */
  async function importPackage(pkg, { sessionId = null } = {}) {
    if (!gate.ok) throw new Error(gate.reason);
    const started = Date.now();
    const plan = planFromPackage(pkg, { campaignId: getCampaignId() });
    const idByKey = new Map();
    for (const f of plan.folders) idByKey.set(f.key, await upsertFolder(f, idByKey));
    // What the package CONTAINED (it's the server's player-visible projection), so the GM can be told
    // why an import brought nothing, or that some combatants came in as basic actors.
    const counts = {
      npcs: plan.actors.filter((a) => a.key.includes(":npc:")).length,
      encounterActors: plan.actors.filter((a) => a.folderKey.includes(":enc:")).length,
      basicActors: plan.actors.filter((a) => a.key.includes(":combatant:")).length,
      reveals: plan.journal.pages.length,
    };
    const report = { packageVersion: plan.packageVersion, created: 0, updated: 0, misses: {}, errors: [], counts, removed: { npcs: 0, tokens: 0 }, portraits: { actors: 0, tokens: 0 }, pruneSkipped: null };
    for (const a of plan.actors) {
      try {
        const folder = idByKey.get(a.folderKey) ?? null;
        let actor = game.actors.find((x) => x.getFlag(MODULE_ID, "key") === a.key);
        const { items, ownership, ...rest } = a.data;
        if (actor) {
          const ourFlags = { ...(rest.flags?.[MODULE_ID] ?? {}) };
          const update = { ...rest, folder, flags: { ...rest.flags, [MODULE_ID]: ourFlags } };
          const portrait = ourFlags.portrait; // NPCs only
          if (ourFlags.kind === "npc") {
            // Read BEFORE the update: Foundry changes the document (and cleans the data we pass) in place.
            // Ownership follows the NPC's visibility only while it's still what WE set (pre-0.1.6 actors
            // were always created at the default 0); a GM's own choice is left alone.
            const ourLast = actor.getFlag(MODULE_ID, "ownershipDefault") ?? 0;
            if ((actor.ownership?.default ?? 0) === ourLast) update.ownership = { default: ownership.default ?? 0 };
            else ourFlags.ownershipDefault = ourLast;
            // Max HP always follows TLR; a damaged current HP is the GM's, so it's kept (clamped).
            if (ourFlags.tlrMaxHp !== undefined) {
              const hp = actor.system?.attributes?.hp ?? {};
              const next = reimportHp({ current: hp.value, foundryMax: hp.max, lastTlrMax: actor.getFlag(MODULE_ID, "tlrMaxHp"), newMax: ourFlags.tlrMaxHp });
              const attrs = update.system?.attributes ?? {};
              update.system = { ...update.system, attributes: { ...attrs, hp: { ...attrs.hp, ...next } } };
            }
          }
          // Legendary actions / resistance spent in play are the GM's (like damage): a re-import refreshes
          // the max but keeps a spent count, clamped. Read BEFORE the update (Foundry mutates in place).
          keepSpentResources(update, actor);
          // What we set LAST time (pre-0.1.5 actors have no flag, but their img was always ours). Read
          // before the update: Foundry changes the document (and cleans the data we pass) in place.
          const previous = portrait === undefined ? undefined : actor.getFlag(MODULE_ID, "portrait") ?? actor.img;
          if (portrait !== undefined && previous === portrait) {
            // Unchanged in TLR: leave the actor's image and token art alone, so a GM's own art survives.
            delete update.img;
            const { texture: _t, ...proto } = update.prototypeToken ?? {};
            update.prototypeToken = proto;
          }
          await actor.update(update);
          if (portrait !== undefined && previous !== portrait) {
            report.portraits.actors += 1;
            report.portraits.tokens += await retexturePlacedTokens(actor.id, previous, portrait);
          }
          const ours = actor.items.filter((i) => i.getFlag(MODULE_ID, "key")).map((i) => i.id);
          if (ours.length) await actor.deleteEmbeddedDocuments("Item", ours);
          if (items.length) await actor.createEmbeddedDocuments("Item", items);
          report.updated += 1;
        } else {
          actor = await Actor.create({ ...a.data, folder });
          report.created += 1;
        }
        const misses = verify(actor, a.expect);
        if (misses.length) report.misses[a.data.name] = misses;
      } catch (err) {
        report.errors.push({ actor: a.data.name, error: String(err?.message ?? err) });
      }
    }
    report.journal = await upsertJournal(plan.journal);
    // Remove last, and only when everything above succeeded for THIS session's package.
    if (!sessionId || pkg?.session?.id !== sessionId) report.pruneSkipped = "not this session's package";
    else if (report.errors.length) report.pruneSkipped = "some actors failed to import";
    else await pruneHiddenNpcs(plan, report);
    if (report.pruneSkipped && sessionId) log(`${MODULE_ID} | kept all NPCs: ${report.pruneSkipped}`);
    report.ms = Date.now() - started;
    metrics.imports.push(report);
    return report;
  }

  async function upsertJournal(j) {
    // Foundry cleans creation data IN PLACE (it deletes fields a document doesn't define, like our
    // plan's `key`), so read everything we need first and hand Foundry copies (window 4).
    const copy = (pages) => pages.map((p) => JSON.parse(JSON.stringify(p)));
    let entry = game.journal.find((x) => x.getFlag(MODULE_ID, "key") === j.key);
    if (!entry) {
      const keys = j.pages.map((p) => p.key);
      entry = await JournalEntry.create({ name: j.name, ownership: j.ownership, pages: copy(j.pages), flags: { [MODULE_ID]: { key: j.key } } });
      for (const p of j.pages) recordReveal(p);
      return { created: keys.length, entry: entry.id, fresh: keys };
    }
    if (entry.name !== j.name) await entry.update({ name: j.name }); // a renamed session
    const have = new Set(entry.pages.map((p) => p.getFlag(MODULE_ID, "key")));
    const fresh = j.pages.filter((p) => !have.has(p.key));
    const keys = fresh.map((p) => p.key);
    if (fresh.length) await entry.createEmbeddedDocuments("JournalEntryPage", copy(fresh));
    for (const p of fresh) recordReveal(p);
    return { created: keys.length, entry: entry.id, fresh: keys };
  }

  function recordReveal(page) {
    const at = Date.parse(page.flags?.[MODULE_ID]?.revealedAt ?? "");
    if (Number.isFinite(at) && Date.now() - at < 10 * 60_000) metrics.revealLatencyMs.push(Date.now() - at);
  }

  function dispose() {
    for (const [name, id] of hookIds.splice(0)) Hooks.off(name, id);
  }

  return {
    gate,
    metrics,
    registerHooks,
    importPackage,
    pushAll() {
      for (const k of ["COMBAT", "INITIATIVE", "HP", "SCENE", "EFFECTS"]) pusher.mark(k);
    },
    /** After `ready`: resend rolls a previous page load left unacknowledged. */
    resumeRolls() {
      if (gate.ok && isActiveGM(game) && enabled()) pusher.resume();
    },
    /**
     * Newly revealed facts → pages in the session's reveals journal (created once, keyed by fact id).
     * @returns {Promise<{ created: number, freshIds: string[] }>} the fact ids that got a NEW page
     */
    async applyReveals(session, reveals) {
      if (!gate.ok) throw new Error(gate.reason);
      if (!reveals.length) return { created: 0, freshIds: [] };
      const plan = planFromPackage({ session, npcs: [], encounters: [], reveals }, { campaignId: getCampaignId() });
      const r = await upsertJournal(plan.journal);
      return { created: r.created, freshIds: r.fresh.map((k) => k.replace(/^reveal:/, "")) };
    },
    dispose,
  };
}
