/**
 * The session picker for a prep day (no session running): a small DialogV2 listing recent sessions.
 * The markup is built by a pure function that escapes every DM-authored string (session titles are
 * rendered as HTML); the DialogV2 call is a thin shell.
 */
import { escapeHtml } from "../mapper.js";

/** The dialog's body: a labelled <select>, the preselected session selected. Everything escaped. */
export function pickerHtml(sessions, preselect, label) {
  const options = sessions
    .map((s) => `<option value="${escapeHtml(s.id)}"${s.id === preselect ? " selected" : ""}>${escapeHtml(s.label)}</option>`)
    .join("");
  return `<div class="form-group"><label for="tlr-pick-session">${escapeHtml(label)}</label><select id="tlr-pick-session" name="sessionId">${options}</select></div>`;
}

/** Show the picker; resolves to the chosen session id, or null (Cancel, or the window closed). */
export async function pickSessionDialog({ sessions, preselect, i18n, DialogV2 = globalThis.foundry?.applications?.api?.DialogV2 }) {
  const result = await DialogV2.wait({
    window: { title: i18n.localize("TLR.Import.PickTitle") },
    content: pickerHtml(sessions, preselect, i18n.localize("TLR.Import.Session")),
    buttons: [
      { action: "import", label: i18n.localize("TLR.Import.PickImport"), icon: "fa-solid fa-download", default: true, callback: (_event, button) => button.form?.elements?.sessionId?.value ?? null },
      { action: "cancel", label: i18n.localize("TLR.Import.PickCancel") },
    ],
    rejectClose: false,
  });
  return sessions.some((s) => s.id === result) ? result : null;
}
