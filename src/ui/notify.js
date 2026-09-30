import { importSummary } from "../import-summary.js";

/** One place to report an import to the GM (the settings form and the Actors-directory button share it). */
export function notifyImport(report) {
  for (const { level, key, data } of importSummary(report)) {
    ui.notifications[level](data ? game.i18n.format(key, data) : game.i18n.localize(key), level === "warn" && key === "TLR.Import.Empty" ? { permanent: true } : undefined);
  }
}

export function notifyError(err) {
  ui.notifications.error(`The Long Rest: ${err?.message ?? err}`);
}
