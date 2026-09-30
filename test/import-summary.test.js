import { describe, expect, it, vi } from "vitest";

import { importSummary } from "../src/import-summary.js";
import { notifyImport } from "../src/ui/notify.js";

const report = (counts, o = {}) => ({ created: 0, updated: 0, misses: {}, errors: [], counts, ...o });
const keys = (r) => importSummary(r).map((x) => x.key);

describe("importSummary", () => {
  it("an EMPTY package (no NPCs, no encounter creatures, no reveals) explains why instead of '0 created 0 updated'", () => {
    expect(keys(report({ npcs: 0, encounterActors: 0, basicActors: 0, reveals: 0 }))).toEqual(["TLR.Import.Empty"]);
  });

  it.each([
    ["an NPC", { npcs: 1, encounterActors: 0, basicActors: 0, reveals: 0 }],
    ["an encounter creature", { npcs: 0, encounterActors: 1, basicActors: 0, reveals: 0 }],
    ["a revealed fact", { npcs: 0, encounterActors: 0, basicActors: 0, reveals: 1 }],
  ])("anything player-visible (%s) is not 'empty'", (_l, counts) => {
    expect(keys(report(counts, { created: 1 }))[0]).toBe("TLR.Import.Done");
  });

  it("typed-in combatants without a Bestiary entry are reported as basic actors (what the importer already does)", () => {
    const s = importSummary(report({ npcs: 0, encounterActors: 3, basicActors: 1, reveals: 0 }, { created: 3 }));
    expect(s).toEqual([
      { level: "info", key: "TLR.Import.Done", data: { created: 3, updated: 0 } },
      { level: "info", key: "TLR.Import.BasicActors", data: { count: 1 } },
    ]);
  });

  it("reports removed NPCs, including on an empty import (the removal line comes after the explanation)", () => {
    expect(importSummary(report({ npcs: 0, encounterActors: 0, basicActors: 0, reveals: 0 }, { removed: { npcs: 2, tokens: 3 } }))).toEqual([
      { level: "warn", key: "TLR.Import.Empty" },
      { level: "info", key: "TLR.Import.Removed", data: { count: 2 } },
    ]);
    expect(keys(report({ npcs: 1, encounterActors: 0, basicActors: 0, reveals: 0 }, { created: 1, removed: { npcs: 1, tokens: 0 } }))).toEqual(["TLR.Import.Done", "TLR.Import.Removed"]);
    expect(keys(report({ npcs: 1, encounterActors: 0, basicActors: 0, reveals: 0 }, { removed: { npcs: 0, tokens: 0 } }))).toEqual(["TLR.Import.Done"]);
  });

  it("keeps the misses and errors notices", () => {
    expect(keys(report({ npcs: 2, encounterActors: 0, basicActors: 0, reveals: 0 }, { misses: { A: [] }, errors: [{}] }))).toEqual(["TLR.Import.Done", "TLR.Import.Misses", "TLR.Import.Errors"]);
  });

  it("a report without counts (an older caller) still gets the plain line", () => {
    expect(keys({ created: 1, updated: 2 })).toEqual(["TLR.Import.Done"]);
  });
});

describe("notifyImport shows it", () => {
  it("the empty explanation is a persistent warning; the done line is formatted", () => {
    const calls = [];
    globalThis.ui = { notifications: { info: (...a) => calls.push(["info", ...a]), warn: (...a) => calls.push(["warn", ...a]), error: (...a) => calls.push(["error", ...a]) } };
    globalThis.game = { i18n: { localize: (k) => `L:${k}`, format: (k, d) => `F:${k}:${JSON.stringify(d)}` } };
    try {
      notifyImport(report({ npcs: 0, encounterActors: 0, basicActors: 0, reveals: 0 }));
      notifyImport(report({ npcs: 1, encounterActors: 0, basicActors: 0, reveals: 0 }, { created: 1 }));
      expect(calls).toEqual([
        ["warn", "L:TLR.Import.Empty", { permanent: true }],
        ["info", 'F:TLR.Import.Done:{"created":1,"updated":0}', undefined],
      ]);
    } finally {
      delete globalThis.ui;
      delete globalThis.game;
    }
  });
});

describe("the English strings", () => {
  it("exist for every key the summary can produce, and the empty one says what to do", async () => {
    const { readFileSync } = await import("node:fs");
    const en = JSON.parse(readFileSync(new URL("../src/lang/en.json", import.meta.url), "utf8"));
    for (const k of ["TLR.Import.Empty", "TLR.Import.BasicActors", "TLR.Import.Removed", "TLR.Import.Done", "TLR.Import.Misses", "TLR.Import.Errors"]) expect(en[k], k).toBeTruthy();
    expect(en["TLR.Import.Removed"]).toMatch(/no longer visible in The Long Rest \(and their tokens\)/);
    expect(en["TLR.Import.Empty"]).toMatch(/Card only or Full details.*link combat beats to encounters.*reveal a fact/);
    expect(en["TLR.Import.Empty"]).toMatch(/add them to the session's NPC list/);
  });
});
