/**
 * Just enough of Foundry v14 + dnd5e 6 for the connector: plain objects shaped like the documents it
 * reads. Synthetic names only.
 */
export function makeHooks() {
  const handlers = new Map();
  let next = 1;
  return {
    on(name, fn) {
      const id = next++;
      if (!handlers.has(name)) handlers.set(name, new Map());
      handlers.get(name).set(id, fn);
      return id;
    },
    off(name, id) {
      handlers.get(name)?.delete(id);
    },
    call(name, ...args) {
      for (const fn of handlers.get(name)?.values() ?? []) fn(...args);
    },
  };
}

const collection = (items) => ({ contents: items, get: (id) => items.find((x) => x.id === id), find: (f) => items.find(f), size: items.length });

export function actor(id, name, { pc = false, hp = 10, max = 10, ac = 14, effects = [] } = {}) {
  return {
    id, name, type: pc ? "character" : "npc", hasPlayerOwner: pc,
    system: { attributes: { hp: { value: hp, max }, ac: { value: ac } } },
    statuses: new Set(effects.flatMap((e) => e.statuses ?? [])),
    appliedEffects: effects.map((e) => ({ name: e.name, disabled: false, statuses: new Set(e.statuses ?? []), origin: null, duration: { startRound: e.round ?? null, rounds: e.rounds ?? null } })),
  };
}

export function combatant(id, a, { hidden = false, initiative = 10, tokenHidden = false } = {}) {
  return { id, name: a.name, actor: a, token: { name: a.name, hidden: tokenHidden }, hidden, initiative, isDefeated: false };
}

/** A world: one fight on the players' scene (and an unrelated one on the scene the GM previews). */
export function makeGame({ activeGM = true, fighters = [], extraActors = [], hiddenTokenId = "tok-hidden" } = {}) {
  const tokens = collection([{ id: hiddenTokenId, name: "Hidden Watcher", hidden: true }, { id: "tok-open", name: "Open Scout", hidden: false }]);
  const playersScene = { id: "scene-play", name: "The Pass", navName: "The Pass", active: true, tokens };
  const previewScene = { id: "scene-preview", name: "Next Map", active: false, tokens: collection([]) };
  const fight = { id: "fight", active: true, scene: playersScene, round: 2, combatant: fighters[0] ?? null, combatants: collection(fighters) };
  const preview = { id: "preview", active: true, scene: previewScene, round: 1, combatant: null, combatants: collection([]) };
  const journal = [];
  const game = {
    version: "14.368",
    system: { id: "dnd5e", version: "6.0.5" },
    world: { id: "w" },
    user: { id: "gm1", isGM: true },
    users: { activeGM: { id: activeGM ? "gm1" : "gm2" } },
    combats: { contents: [preview, fight], active: preview }, // core follows the GM's VIEWED scene
    combat: preview,
    actors: collection([...fighters.map((f) => f.actor), ...extraActors]),
    scenes: { get: (id) => [playersScene, previewScene].find((s) => s.id === id), active: playersScene },
    folders: collection([]),
    journal: { find: (f) => journal.find(f), contents: journal },
  };
  // Foundry cleans creation data IN PLACE: fields a document doesn't define (like our plan's `key`)
  // are deleted from the objects the caller passed. The fake does the same, so code that reads its
  // own inputs after a create fails here as it does in Foundry (window 4).
  const clean = (p) => { const kept = { ...p }; delete p.key; delete kept.key; return kept; };
  const JournalEntry = {
    create: async ({ name, pages: raw, flags }) => {
      const pages = raw.map(clean);
      const entry = {
        id: `j${journal.length}`, name, pages: pages.map(page), flags,
        getFlag: (_m, k) => flags["the-long-rest"][k],
        createEmbeddedDocuments: async (_t, more) => void entry.pages.push(...more.map(clean).map(page)),
        update: async (u) => void Object.assign(entry, u),
      };
      journal.push(entry);
      return entry;
    },
  };
  function page(p) {
    return { ...p, getFlag: (_m, k) => p.flags["the-long-rest"][k] };
  }
  return { game, JournalEntry, journal, fight };
}

/** A chat message as dnd5e 6 creates it. */
export function chatMessage(id, { speaker = "Open Scout", token = "tok-open", whisper = [], blind = false, rolls = [{ formula: "1d20+5", total: 17, dice: [{ faces: 20, results: [{ result: 12, active: true }] }] }], type = "attack" } = {}) {
  return {
    id, whisper, blind, rolls, flavor: "Shortsword - Attack Roll", timestamp: 0,
    speaker: { alias: speaker, scene: "scene-play", token },
    author: { name: "Player One" },
    system: { roll: { type } },
  };
}
