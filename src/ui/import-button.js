/**
 * The Actors-directory header button: a SHORT label (the header has little room) and the full
 * description as its tooltip and accessible name, so it stays self-explanatory. The Connect form's own
 * Import button keeps the long label (TLR.Import.Button).
 * @param {(key: string) => string} localize
 */
export function importButtonProps(localize) {
  return { label: localize("TLR.Import.ButtonShort"), tooltip: localize("TLR.Import.ButtonTooltip") };
}

/** The directory's root element, whether Foundry passes an HTMLElement or a jQuery-like wrapper. */
const rootOf = (html) => (html && typeof html.querySelector === "function" ? html : html?.[0] ?? null);

/**
 * Add the Import button to a rendered Actors directory. Idempotent: a header that already has one is
 * left alone. Returns whether a button was added.
 */
export function addImportButton(root, { doc, props, onClick }) {
  const actions = root?.querySelector(".header-actions");
  if (!actions || actions.querySelector("[data-tlr-import]")) return false;
  const button = doc.createElement("button");
  button.type = "button";
  button.dataset.tlrImport = "";
  const icon = doc.createElement("i");
  icon.className = "fa-solid fa-campground";
  button.append(icon, ` ${props.label}`);
  button.dataset.tooltip = props.tooltip; // Foundry's tooltip convention
  button.setAttribute("aria-label", props.tooltip);
  button.addEventListener("click", onClick);
  actions.append(button);
  return true;
}

/**
 * Put the button in the Actors directory whichever comes first. The directory's FIRST render happens
 * before Hooks.once("ready"), where the connector is created, so a render-hook alone missed it (v0.1.0–
 * v0.1.1: the button only appeared after something else re-rendered the directory). The hook covers
 * renders after ready; `onReady()` covers a directory that is already rendered.
 * @param {{ Hooks: { on(name: string, fn: Function): unknown }, isReadyGM: () => boolean,
 *   getDirectoryRoot: () => unknown, doc: Document, props: () => { label: string, tooltip: string },
 *   onClick: () => void }} deps
 */
export function wireImportButton({ Hooks, isReadyGM, getDirectoryRoot, doc, props, onClick }) {
  const tryAdd = (html) => (isReadyGM() ? addImportButton(rootOf(html), { doc, props: props(), onClick }) : false);
  Hooks.on("renderActorDirectory", (_app, html) => tryAdd(html));
  return { onReady: () => tryAdd(getDirectoryRoot()) };
}
