import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { addImportButton, importButtonProps, wireImportButton } from "../src/ui/import-button.js";

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

// ---- a minimal fake DOM: just what addImportButton touches --------------------------------------
class El {
  constructor(tag, className = "") { Object.assign(this, { tag, className, children: [], dataset: {}, attrs: {}, listeners: {} }); }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  *walk() { for (const c of this.children) if (c instanceof El) { yield c; yield* c.walk(); } }
  querySelector(sel) {
    for (const el of this.walk()) {
      if (sel === ".header-actions" && el.className.split(" ").includes("header-actions")) return el;
      if (sel === "[data-tlr-import]" && "tlrImport" in el.dataset) return el;
    }
    return null;
  }
}
const doc = { createElement: (tag) => new El(tag) };
function directory() {
  const root = new El("section");
  const header = new El("header");
  header.append(new El("div", "header-actions action-buttons"));
  root.append(header);
  return root;
}
const buttons = (root) => [...root.walk()].filter((e) => "tlrImport" in e.dataset);

function harness({ isGM = true } = {}) {
  const handlers = [];
  const Hooks = { on: (name, fn) => handlers.push([name, fn]) };
  const state = { connector: null, root: null };
  const onClick = () => {};
  const wired = wireImportButton({
    Hooks,
    isReadyGM: () => isGM && Boolean(state.connector),
    getDirectoryRoot: () => state.root,
    doc,
    props: () => importButtonProps(localize),
    onClick,
  });
  const render = (asJquery = false) => {
    state.root ??= directory();
    for (const [name, fn] of handlers) if (name === "renderActorDirectory") fn({}, asJquery ? [state.root] : state.root);
  };
  const ready = () => { state.connector = {}; wired.onReady(); };
  return { state, render, ready, onClick };
}

describe("the Import button appears whatever the order of render and ready (v0.1.2)", () => {
  it("render BEFORE ready (a fresh world launch): present after ready, with no later render", () => {
    const h = harness();
    h.render(); // the directory's first render: the connector doesn't exist yet
    expect(buttons(h.state.root)).toHaveLength(0);
    h.ready(); // …and nothing re-renders the directory afterwards
    const [b] = buttons(h.state.root);
    expect(b).toBeTruthy();
    expect(b.children.at(-1)).toBe(" Import TLR");
    expect(b.dataset.tooltip).toBe("Import session prep from The Long Rest (the running session)");
    expect(b.attrs["aria-label"]).toBe(b.dataset.tooltip);
    expect(b.listeners.click).toBe(h.onClick);
  });

  it("ready BEFORE the first render: the render adds it (and a jQuery-style wrapper works too)", () => {
    const h = harness();
    h.ready(); // no directory yet: nothing to do, no error
    h.render(true);
    expect(buttons(h.state.root)).toHaveLength(1);
  });

  it("idempotent: re-renders and ready never add a second button", () => {
    const h = harness();
    h.render();
    h.ready();
    h.render();
    h.render();
    expect(buttons(h.state.root)).toHaveLength(1);
  });

  it("never for a player, and never before the connector exists (a failed version gate never creates it)", () => {
    const player = harness({ isGM: false });
    player.render();
    player.ready();
    expect(buttons(player.state.root)).toHaveLength(0);
    const gated = harness();
    gated.render();
    gated.render(); // ready never ran (the gate failed): no connector
    expect(buttons(gated.state.root)).toHaveLength(0);
  });

  it("addImportButton ignores a directory without a header-actions bar", () => {
    expect(addImportButton(new El("section"), { doc, props: { label: "x", tooltip: "y" }, onClick() {} })).toBe(false);
  });
});


describe("main.js wiring", () => {
  it("calls importButton.onReady() in the ready handler, only on the GM + gate-ok path", () => {
    const src = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
    const ready = src.slice(src.indexOf('Hooks.once("ready"'), src.indexOf("\n});", src.indexOf('Hooks.once("ready"')));
    const at = (needle) => ready.indexOf(needle);
    expect(at("importButton.onReady()")).toBeGreaterThan(-1);
    expect(at("importButton.onReady()")).toBeGreaterThan(at("if (!gate.ok)"));
    expect(at("importButton.onReady()")).toBeGreaterThan(at("if (!game.user.isGM) return;"));
    expect(at("importButton.onReady()")).toBeGreaterThan(at("services.connector = createConnector("));
  });
});
