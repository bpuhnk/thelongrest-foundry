/**
 * The Long Rest: Foundry module entry point.
 *
 * The TLR token is kept in a CLIENT-scoped setting (this browser only). It is never a world setting:
 * world settings are sent to every connected player. Everything that reaches The Long Rest goes
 * through transport.js (VTT tokens only, pinned to one campaign).
 */
import { createConnector, isActiveGM } from "./connector.js";
import { versionGate } from "./gate.js";
import { MODULE_ID } from "./mapper.js";
import { createRevealPoller, makeAnnouncer } from "./reveals.js";
import { RollQueue, queueKey } from "./roll-queue.js";
import { importSession } from "./sessions.js";
import { createTransport } from "./transport.js";
import { importButtonProps, wireImportButton } from "./ui/import-button.js";
import { notifyError, notifyImport } from "./ui/notify.js";
import { makeSettingsApp } from "./ui/settings-app.js";

const services = { transport: null, connector: null, store: null, poller: null, onConnectionChanged: () => {} };

const store = {
  get: (key) => game.settings.get(MODULE_ID, key),
  set: (key, value) => game.settings.set(MODULE_ID, key, value),
};

/** sessionStorage, or undefined when the browser refuses it (the roll queue then lives in memory). */
function tabStorage() {
  try {
    return window.sessionStorage ?? undefined;
  } catch {
    return undefined;
  }
}

Hooks.once("init", () => {
  const register = (key, data) => game.settings.register(MODULE_ID, key, { scope: "client", config: false, ...data });
  register("baseUrl", { type: String, default: "https://thelongrest.app" });
  register("token", { type: String, default: "" }); // never shown as a plain settings row
  register("campaignId", { type: String, default: "" }); // the pin, set on the first successful connection
  register("shareNpcHp", { type: Boolean, default: false });
  register("announceReveals", { type: Boolean, default: false });

  game.settings.registerMenu(MODULE_ID, "connect", {
    name: "TLR.Settings.Menu",
    label: "TLR.Settings.Menu",
    hint: "TLR.Settings.MenuHint",
    icon: "fa-solid fa-campground",
    type: makeSettingsApp({ getServices: () => services }),
    restricted: true, // GMs only
  });
});

Hooks.once("ready", () => {
  const gate = versionGate(game);
  if (!gate.ok) {
    if (game.user.isGM) ui.notifications.warn(game.i18n.format("TLR.Disabled", { reason: gate.reason }), { permanent: true });
    return;
  }
  if (!game.user.isGM) return; // players never talk to The Long Rest

  const version = game.modules.get(MODULE_ID)?.version ?? "0.0.0";
  services.store = store;
  services.transport = createTransport({
    getBaseUrl: () => store.get("baseUrl"),
    getToken: () => store.get("token"),
    getExpectedCampaignId: () => store.get("campaignId") || null,
    client: `${MODULE_ID}/${version} foundry/${game.version} dnd5e/${game.system.version}`,
  });
  // Connected = a token, a pinned campaign, and no latched refusal (see transport.js).
  const connected = () => Boolean(store.get("token") && store.get("campaignId") && !services.transport.refused);
  const activeSessionId = () => services.poller?.session?.id ?? services.transport.verified?.campaign?.activeSession?.id ?? null;

  services.connector = createConnector({
    game, Hooks, Actor, Folder, JournalEntry,
    transport: (req) => services.transport.request(req),
    settings: () => ({ shareNpcHp: Boolean(store.get("shareNpcHp")), sessionId: activeSessionId() }),
    getCampaignId: () => store.get("campaignId") || null, // imports are scoped to the pinned campaign
    enabled: connected,
    rollQueue: new RollQueue({ storage: tabStorage(), key: queueKey(game.world.id, game.user.id) }),
    moduleVersion: version,
  });

  const announceReveal = makeAnnouncer({
    create: (data) => ChatMessage.create(data),
    warn: (m) => console.warn(`${MODULE_ID} | ${m}`),
  });
  services.poller = createRevealPoller({
    transport: services.transport,
    isActiveGM: () => isActiveGM(game) && connected(),
    onReveals: async (session, reveals, { initial }) => {
      const { freshIds } = await services.connector.applyReveals(session, reveals);
      // The first poll of a session only catches up; announcing is for facts revealed from now on.
      if (initial || !store.get("announceReveals")) return;
      // The chat card never blocks the journal or the polling: not awaited, bounded, and logged.
      for (const r of reveals.filter((x) => freshIds.includes(x.id))) announceReveal(r);
    },
    // A fresh snapshot once we know the running session (and whenever it changes), so it carries the sessionId.
    onSession: () => {
      if (isActiveGM(game) && connected()) services.connector.pushAll();
    },
    log: (m) => console.warn(`${MODULE_ID} | ${m}`),
  });

  services.onConnectionChanged = () => services.poller.restart(); // → onSession → snapshot

  services.connector.registerHooks();
  services.connector.resumeRolls(); // what a reload left unacknowledged
  services.poller.start();
  // GM handover: when THIS GM becomes the active one, it sends a fresh snapshot and its pending rolls.
  // (userConnected also fires for every player joining; only a change of active GM matters.)
  let wasActive = isActiveGM(game);
  Hooks.on("userConnected", () => {
    const active = isActiveGM(game);
    if (active && !wasActive && connected()) {
      services.connector.resumeRolls();
      services.connector.pushAll();
    }
    wasActive = active;
  });
  game.modules.get(MODULE_ID).api = { gate, metrics: () => services.connector.metrics, revealMetrics: () => ({ ...services.poller.metrics }) };
  // The Actors directory rendered before "ready" (before the connector existed): add the button now.
  importButton.onReady();
});

// "Import TLR" in the Actors directory header (GMs only, once connected services exist). Wired at load
// so later renders get it; `importButton.onReady()` below adds it to a directory already rendered
// before "ready" (the first render always is).
const importButton = wireImportButton({
  Hooks,
  isReadyGM: () => Boolean(game.user?.isGM && services.connector),
  getDirectoryRoot: () => ui.actors?.element ?? null,
  doc: document,
  props: () => importButtonProps((k) => game.i18n.localize(k)),
  onClick: async () => {
    try {
      notifyImport(await importSession({ transport: services.transport, connector: services.connector }));
    } catch (err) {
      notifyError(err);
    }
  },
});
