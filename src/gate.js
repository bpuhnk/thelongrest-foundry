/**
 * Which Foundry + dnd5e this module supports. Outside the range the module does nothing and tells the
 * GM why, rather than mis-reading a data model it wasn't written for.
 */
export const MIN_FOUNDRY = "14.367";
export const VERIFIED_FOUNDRY = "14.368";
export const DND5E_MAJOR = 6;
export const MIN_DND5E = "6.0.0";
export const VERIFIED_DND5E = "6.0.5";

/** Compare dotted versions numerically: -1, 0, 1. Missing segments count as 0. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** @returns {{ ok: true, foundry: string, dnd5e: string } | { ok: false, reason: string }} */
export function versionGate(game) {
  const foundry = String(game?.version ?? "");
  const system = game?.system?.id;
  const dnd5e = String(game?.system?.version ?? "");
  if (system !== "dnd5e") return { ok: false, reason: `The Long Rest needs the dnd5e system (this world uses ${system ?? "none"}).` };
  if (!foundry || compareVersions(foundry, MIN_FOUNDRY) < 0) {
    return { ok: false, reason: `The Long Rest needs Foundry ${MIN_FOUNDRY} or later (this is ${foundry || "unknown"}).` };
  }
  if (parseInt(dnd5e, 10) !== DND5E_MAJOR) {
    return { ok: false, reason: `The Long Rest supports dnd5e ${DND5E_MAJOR}.x (this world has ${dnd5e || "unknown"}).` };
  }
  return { ok: true, foundry, dnd5e };
}
