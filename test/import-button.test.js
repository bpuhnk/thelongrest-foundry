import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { importButtonProps } from "../src/ui/import-button.js";

const en = JSON.parse(readFileSync(new URL("../src/lang/en.json", import.meta.url), "utf8"));
const localize = (k) => en[k] ?? k;

describe("the Actors-directory Import button", () => {
  it("is short ('Import TLR') with the full description as its tooltip and accessible name", () => {
    expect(importButtonProps(localize)).toEqual({ label: "Import TLR", tooltip: "Import session prep from The Long Rest (the running session)" });
  });

  it("the Connect form keeps the long label", () => {
    expect(en["TLR.Import.Button"]).toBe("Import session prep");
    expect(readFileSync(new URL("../templates/settings.hbs", import.meta.url), "utf8")).toContain('localize "TLR.Import.Button"');
  });
});
