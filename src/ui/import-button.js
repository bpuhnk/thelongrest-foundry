/**
 * The Actors-directory header button: a SHORT label (the header has little room) and the full
 * description as its tooltip and accessible name, so it stays self-explanatory. The Connect form's own
 * Import button keeps the long label (TLR.Import.Button).
 * @param {(key: string) => string} localize
 */
export function importButtonProps(localize) {
  return { label: localize("TLR.Import.ButtonShort"), tooltip: localize("TLR.Import.ButtonTooltip") };
}
