/** One place to report an import to the GM (the settings form and the Actors-directory button share it). */
export function notifyImport(report) {
  ui.notifications.info(game.i18n.format("TLR.Import.Done", { created: report.created, updated: report.updated }));
  const misses = Object.keys(report.misses ?? {}).length;
  if (misses) ui.notifications.warn(game.i18n.format("TLR.Import.Misses", { count: misses }));
  if (report.errors?.length) ui.notifications.error(game.i18n.format("TLR.Import.Errors", { count: report.errors.length }));
}

export function notifyError(err) {
  ui.notifications.error(`The Long Rest: ${err?.message ?? err}`);
}
