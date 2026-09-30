/**
 * The GM-only "Connect" form (registered with game.settings.registerMenu, restricted to GMs).
 * Thin: the logic lives in connection.js / sessions.js, which are unit tested.
 */
import { MODULE_ID } from "../mapper.js";
import { disconnect, saveAndConnect } from "../connection.js";
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
    /** The form's four fields, read from the DOM (the save/test logic lives in connection.js). */
    #formData() {
      const el = this.element;
      const field = (name) => el.querySelector(`[name=${name}]`);
      return { baseUrl: field("baseUrl")?.value ?? "", token: field("token")?.value ?? "", shareNpcHp: Boolean(field("shareNpcHp")?.checked), announceReveals: Boolean(field("announceReveals")?.checked) };
    }

    /**
     * Save what's in the form, then test the connection. Save and Test connection both do this, so Test
     * never checks stale settings while the new URL/token sit unsaved in the form (the v0.1.0 report).
     */
    async #saveAndConnect(data) {
      const { store, transport } = getServices();
      this.status = await saveAndConnect({ store, transport, data });
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
      await this.#saveAndConnect(formData.object);
    }

    static async #onTest() {
      await this.#saveAndConnect(this.#formData());
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
