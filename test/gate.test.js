import { describe, expect, it } from "vitest";

import { compareVersions, versionGate } from "../src/gate.js";

const game = (version, system = "dnd5e", sys = "6.0.5") => ({ version, system: { id: system, version: sys } });

describe("versionGate", () => {
  it("Foundry 14.367+ with dnd5e 6.x is supported", () => {
    expect(versionGate(game("14.368"))).toEqual({ ok: true, foundry: "14.368", dnd5e: "6.0.5" });
    expect(versionGate(game("14.367", "dnd5e", "6.0.0")).ok).toBe(true);
    expect(versionGate(game("15.400")).ok).toBe(true);
  });

  it("refuses older Foundry, dnd5e 5.x or 7.x, and other systems, saying why", () => {
    expect(versionGate(game("14.366"))).toMatchObject({ ok: false, reason: expect.stringMatching(/14\.367 or later/) });
    expect(versionGate(game("13.351"))).toMatchObject({ ok: false });
    expect(versionGate(game("14.368", "dnd5e", "5.3.3"))).toMatchObject({ ok: false, reason: expect.stringMatching(/dnd5e 6\.x/) });
    expect(versionGate(game("14.368", "dnd5e", "7.0.0")).ok).toBe(false);
    expect(versionGate(game("14.368", "pf2e", "7.0.0"))).toMatchObject({ ok: false, reason: expect.stringMatching(/needs the dnd5e system/) });
    expect(versionGate({}).ok).toBe(false);
  });

  it("compareVersions is numeric per segment", () => {
    expect(compareVersions("14.368", "14.367")).toBe(1);
    expect(compareVersions("14.9", "14.10")).toBe(-1);
    expect(compareVersions("6.0", "6.0.0")).toBe(0);
  });
});
