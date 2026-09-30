/**
 * What to tell the GM after an import, from the import report (pure; notify.js shows it). Three cases:
 * - EMPTY: the package held no NPCs, no encounter creatures and no revealed facts. That's not an
 *   error: The Long Rest only sends what players may see, so explain what makes things visible;
 * - PARTIAL: typed-in combatants with no Bestiary entry came in as basic actors (AC, HP and attacks as
 *   text), which is what the importer always does for them. Say so, so nobody hunts for a stat block;
 * - the usual "created / updated" line, plus the existing misses/errors notices.
 * @returns {{ level: "info" | "warn" | "error", key: string, data?: object }[]}
 */
export function importSummary(report) {
  const c = report?.counts;
  const out = [];
  if (c && c.npcs === 0 && c.encounterActors === 0 && c.reveals === 0) {
    out.push({ level: "warn", key: "TLR.Import.Empty" });
  } else {
    out.push({ level: "info", key: "TLR.Import.Done", data: { created: report.created, updated: report.updated } });
    if (c?.basicActors) out.push({ level: "info", key: "TLR.Import.BasicActors", data: { count: c.basicActors } });
  }
  if (report?.removed?.npcs) out.push({ level: "info", key: "TLR.Import.Removed", data: { count: report.removed.npcs } });
  const misses = Object.keys(report?.misses ?? {}).length;
  if (misses) out.push({ level: "warn", key: "TLR.Import.Misses", data: { count: misses } });
  if (report?.errors?.length) out.push({ level: "error", key: "TLR.Import.Errors", data: { count: report.errors.length } });
  return out;
}
