/**
 * The GM-only "Connect" form (registered with game.settings.registerMenu, restricted to GMs).
 * Thin: the logic lives in connection.js / sessions.js, which are unit tested.
 */
import { MODULE_ID } from "../mapper.js";
import { disconnect, testConnection } from "../connection.js";
import { importSession, listSessions } from "../sessions.js";
import { notifyError, notifyImport } from "./notify.js";

/** @param {{ getServices: () => { transport: any, connector: any, store: any } }} deps */
export function makeSettingsApp({ getServices }) {
  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

  class TLRSettingsApp extends HandlebarsApplicationMixin(ApplicationV2) {
    status = null;

    static DEFAULT_OPTIONS = {
      id: "the-long-rest-settings",
      tag: "form",
      window: { title: "TLR.Title", icon: "fa-solid fa-campground" },
      position: { width: 560 },
      form: { handler: TLRSettingsApp.#onSubmit, closeOnSubmit: false },
      actions: { test: TLRSettingsApp.#onTest, import: TLRSettingsApp.#onImport, disconnect: TLRSettingsApp.#onDisconnect },
    };

    static PARTS = { form: { template: `modules/${MODULE_ID}/templates/settings.hbs` } };

    async _prepareContext() {
      const { store } = getServices();
      return {
        baseUrl: store.get("baseUrl"),
        hasToken: Boolean(store.get("token")),
        shareNpcHp: store.get("shareNpcHp"),
        announceReveals: store.get("announceReveals"),
        status: this.status,
        connected: Boolean(this.status?.ok),
        sessions: this.sessions ?? [],
      };
    }

    /** Test the connection, and on success offer the campaign's sessions (the running one preselected). */
    async #connect(transport, store) {
      this.status = await testConnection({ transport, store });
      this.sessions = null;
      getServices().onConnectionChanged();
      if (this.status.ok) {
        try {
          const activeId = transport.verified?.campaign?.activeSession?.id ?? null;
          this.sessions = (await listSessions(transport)).map((s) => ({ ...s, selected: s.id === activeId }));
        } catch {
          this.sessions = null; // the import still works on the running session
        }
      }
      this.render();
    }

    static async #onSubmit(_event, _form, formData) {
      const { store, transport } = getServices();
      const data = formData.object;
      await store.set("baseUrl", String(data.baseUrl ?? "").trim());
      if (data.token) await store.set("token", String(data.token).trim()); // empty keeps the saved one
      await store.set("shareNpcHp", Boolean(data.shareNpcHp));
      await store.set("announceReveals", Boolean(data.announceReveals));
      transport.reset();
      await this.#connect(transport, store);
    }

    static async #onTest() {
      const { store, transport } = getServices();
      await this.#connect(transport, store);
    }

    static async #onImport() {
      const { transport, connector } = getServices();
      const sessionId = this.element.querySelector("select[name=sessionId]")?.value || null;
      try {
        notifyImport(await importSession({ transport, connector, sessionId }));
      } catch (err) {
        notifyError(err);
      }
    }

    static async #onDisconnect() {
      const { store, transport } = getServices();
      await disconnect({ store, transport });
      getServices().onConnectionChanged();
      this.status = null;
      this.sessions = null;
      this.render();
    }
  }

  return TLRSettingsApp;
}
