import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHTML } from "linkedom";
import { fuzzyScore, initCommandPalette, parseConnectTarget, rankPaletteItems, type ConnectTarget, type PaletteItem, type PaletteModifiers } from "../src/command-palette.ts";

const HTML = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");

function key(window: Window, name: string, modifiers: Partial<{ ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    key: { value: name },
    ctrlKey: { value: Boolean(modifiers.ctrlKey) },
    shiftKey: { value: Boolean(modifiers.shiftKey) },
    metaKey: { value: Boolean(modifiers.metaKey) },
  });
  return event;
}

function createHarness(configuration: { items?: PaletteItem[]; connectItems?: (target: ConnectTarget | null) => PaletteItem[]; connectNote?: string } = {}) {
  const { document, window } = parseHTML(HTML);
  const root = document.getElementById("command-palette") as HTMLElement;
  const runs: Array<{ id: string; modifiers: PaletteModifiers }> = [];
  const targets: Array<ConnectTarget | null> = [];
  const item = (id: string, group: string, title: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({
    id, group, title, icon: "server", run: modifiers => { runs.push({ id, modifiers }); }, ...extra,
  });
  const items = configuration.items ?? [
    item("host:web", "Hosts", "Web production", { subtitle: "deploy@web.test:22", detail: "Production / Web", status: "connected", hint: "Switch to tab" }),
    item("host:api", "Hosts", "API production", { subtitle: "deploy@api.test:22", detail: "Production / Services" }),
    item("host:stage", "Hosts", "Staging", { subtitle: "deploy@stage.test:22", keywords: "development" }),
    item("shell:powershell", "Local shells", "PowerShell", { icon: "terminal", shortcut: ["Ctrl", "Alt", "T"] }),
    item("action:settings", "Actions", "Settings", { icon: "gear" }),
  ];
  const palette = initCommandPalette({
    root,
    getItems: () => items,
    getConnectItems: target => {
      targets.push(target);
      if (configuration.connectItems) return configuration.connectItems(target);
      return target
        ? [item("connect:key", "Quick connect", `Connect to ${target.username ?? "?"}@${target.host}:${target.port ?? 22}`, { icon: "bolt" }), item("connect:save", "Quick connect", "Save as a new host", { icon: "plus" })]
        : [item("connect:form", "Quick connect", "Open the connection form", { icon: "form" })];
    },
    connectNote: configuration.connectNote,
  });
  const input = document.getElementById("palette-input") as HTMLInputElement;
  const type = (value: string) => {
    input.value = value;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  const options = () => [...root.querySelectorAll<HTMLElement>('[role="option"]')];
  const titles = () => options().map(option => option.querySelector(".palette-item-title")?.textContent);
  const groups = () => [...root.querySelectorAll(".palette-group-label")].map(label => label.textContent);
  const selected = () => options().find(option => option.getAttribute("aria-selected") === "true");
  return { document, window: window as unknown as Window, root, palette, input, type, options, titles, groups, selected, runs, targets };
}

test("connect targets accept user, host, port and ssh flags", () => {
  assert.deepEqual(parseConnectTarget("deploy@10.0.4.12:2222"), { username: "deploy", host: "10.0.4.12", port: 2222 });
  assert.deepEqual(parseConnectTarget("  ssh deploy@web.test -p 2200 "), { username: "deploy", host: "web.test", port: 2200 });
  assert.deepEqual(parseConnectTarget("ssh -p 2200 deploy@web.test"), { username: "deploy", host: "web.test", port: 2200 });
  assert.deepEqual(parseConnectTarget("web.test"), { username: null, host: "web.test", port: null });
  assert.deepEqual(parseConnectTarget("web.test:22"), { username: null, host: "web.test", port: 22 });
  assert.deepEqual(parseConnectTarget("localhost"), { username: null, host: "localhost", port: null });
  assert.deepEqual(parseConnectTarget("[::1]:2222"), { username: null, host: "::1", port: 2222 });
  assert.deepEqual(parseConnectTarget("root@[fe80::1]"), { username: "root", host: "fe80::1", port: null });
  assert.deepEqual(parseConnectTarget("ops@app-01"), { username: "ops", host: "app-01", port: null });
});

test("search words, broken addresses and control characters never become connections", () => {
  for (const value of ["", "web", "prod web", "deploy@", "@web.test", "deploy@web.test:0", "deploy@web.test:99999", "deploy@web_test", "a@b@c d", "deploy@web.test:22 -p 23", "deploy@web.test\u0007", "[::1", "deploy@host:22:33"]) {
    assert.equal(parseConnectTarget(value), null, value);
  }
});

test("fuzzy scoring prefers whole-word substrings and returns highlight positions", () => {
  const prefix = fuzzyScore("Web production", "web");
  const inner = fuzzyScore("Cobweb tools", "web");
  const scattered = fuzzyScore("Worker queue background", "wqb");
  assert.ok(prefix && inner && scattered);
  assert.ok(prefix.score > inner.score);
  assert.ok(inner.score > scattered.score);
  assert.deepEqual(prefix.indices, [0, 1, 2]);
  assert.equal(fuzzyScore("Staging", "xyz"), null);
});

test("every query word must match a title, subtitle, detail or keyword", () => {
  const { runs } = createHarness();
  const items: PaletteItem[] = [
    { id: "a", group: "Hosts", title: "Web production", subtitle: "deploy@web.test:22", icon: "server", run() {} },
    { id: "b", group: "Hosts", title: "Staging", keywords: "development", icon: "server", run() {} },
  ];
  assert.deepEqual(rankPaletteItems(items, "web prod").map(entry => entry.item.id), ["a"]);
  assert.deepEqual(rankPaletteItems(items, "develop").map(entry => entry.item.id), ["b"]);
  assert.deepEqual(rankPaletteItems(items, "web.test").map(entry => entry.item.id), ["a"]);
  assert.deepEqual(rankPaletteItems(items, "web prod")[0].titleIndices, [0, 1, 2, 4, 5, 6, 7]);
  assert.equal(runs.length, 0);
});

test("opening shows grouped results with the first item selected", () => {
  const harness = createHarness();
  let focused = 0;
  harness.input.focus = () => { focused += 1; };
  harness.palette.open();
  assert.equal(harness.root.hidden, false);
  assert.equal(harness.palette.isOpen(), true);
  assert.equal(focused, 1);
  assert.deepEqual(harness.groups(), ["Hosts", "Local shells", "Actions"]);
  assert.equal(harness.selected()?.querySelector(".palette-item-title")?.textContent, "Web production");
  assert.equal(harness.input.getAttribute("aria-activedescendant"), harness.selected()?.id);
  assert.equal(harness.selected()?.querySelector(".palette-status-dot.is-connected") !== null, true);
  assert.deepEqual([...harness.options()[3].querySelectorAll("kbd")].map(kbd => kbd.textContent), ["Ctrl", "Alt", "T"]);
});

test("typing filters, highlights and keeps arrow selection inside the results", () => {
  const harness = createHarness();
  harness.palette.open();
  harness.type("prod");
  assert.deepEqual(harness.titles(), ["Web production", "API production"]);
  assert.equal(harness.root.querySelector("mark")?.textContent, "prod");
  harness.input.dispatchEvent(key(harness.window, "ArrowDown"));
  assert.equal(harness.selected()?.querySelector(".palette-item-title")?.textContent, "API production");
  harness.input.dispatchEvent(key(harness.window, "ArrowDown"));
  assert.equal(harness.selected()?.querySelector(".palette-item-title")?.textContent, "Web production");
  harness.input.dispatchEvent(key(harness.window, "ArrowUp"));
  harness.input.dispatchEvent(key(harness.window, "Enter", { ctrlKey: true }));
  assert.deepEqual(harness.runs, [{ id: "host:api", modifiers: { ctrlKey: true, shiftKey: false } }]);
  assert.equal(harness.palette.isOpen(), false);
  assert.equal(harness.root.hidden, true);
});

test("user@host input puts quick connect first and passes Shift and Ctrl to it", () => {
  const harness = createHarness();
  harness.palette.open();
  harness.type("deploy@10.0.4.12:2222");
  assert.deepEqual(harness.targets.at(-1), { username: "deploy", host: "10.0.4.12", port: 2222 });
  assert.equal(harness.groups()[0], "Quick connect");
  assert.equal(harness.titles()[0], "Connect to deploy@10.0.4.12:2222");
  assert.equal(harness.root.querySelector("#palette-hint-modifier")?.hidden, true);
  assert.match(harness.root.querySelector("#palette-footer-note")?.textContent ?? "", /defaults from Settings/);
  harness.input.dispatchEvent(key(harness.window, "Enter", { shiftKey: true }));
  assert.deepEqual(harness.runs, [{ id: "connect:key", modifiers: { ctrlKey: false, shiftKey: true } }]);
});

test("an address switches the input to monospace, shows it as code, and adds the trust note", () => {
  const harness = createHarness({
    connectNote: "New servers show a fingerprint before login.",
    connectItems: target => (target
      ? [{ id: "connect:key", group: "Quick connect", title: "Connect to", code: `${target.username}@${target.host}`, icon: "bolt", run() {} }]
      : [{ id: "connect:form", group: "Quick connect", title: "Open the connection form", icon: "form", run() {} }]),
  });
  const note = harness.root.querySelector<HTMLElement>("#palette-note")!;
  harness.palette.open();
  assert.equal(harness.root.dataset.queryKind, "text");
  assert.equal(note.hidden, true);
  harness.type("deploy@web.test");
  assert.equal(harness.root.dataset.queryKind, "address");
  assert.equal(harness.titles()[0], "Connect to deploy@web.test");
  assert.equal(harness.root.querySelector(".palette-item-code")?.textContent, "deploy@web.test");
  assert.equal(note.hidden, false);
  assert.equal(note.querySelector(".palette-note-text")?.textContent, "New servers show a fingerprint before login.");
  harness.type("web");
  assert.equal(harness.root.dataset.queryKind, "text");
  assert.equal(note.hidden, true);
  harness.palette.close();
  harness.palette.open("connect");
  assert.equal(note.hidden, true);
});

test("connect mode lists only connection actions and explains the expected format", () => {
  const harness = createHarness({ connectItems: target => (target ? [] : []) });
  harness.palette.open("connect");
  assert.equal(harness.input.placeholder, "Type user@host or user@host:port");
  assert.equal(harness.options().length, 0);
  assert.match(harness.root.querySelector(".palette-empty")?.textContent ?? "", /deploy@10\.0\.4\.12/);
  const withForm = createHarness();
  withForm.palette.open("connect");
  assert.deepEqual(withForm.titles(), ["Open the connection form"]);
  withForm.type("web");
  assert.deepEqual(withForm.titles(), ["Open the connection form"]);
});

test("nothing matching keeps the palette open with a hint and Enter does nothing", () => {
  const harness = createHarness();
  harness.palette.open();
  harness.type("zzzz");
  assert.equal(harness.options().length, 0);
  assert.match(harness.root.querySelector(".palette-empty")?.textContent ?? "", /Nothing matches “zzzz”/);
  harness.input.dispatchEvent(key(harness.window, "Enter"));
  assert.equal(harness.runs.length, 0);
  assert.equal(harness.palette.isOpen(), true);
});

test("Escape and outside clicks close and restore focus; clicks run the option", () => {
  const harness = createHarness();
  let restored = 0;
  const trigger = harness.document.createElement("button");
  harness.document.body.appendChild(trigger);
  (trigger as HTMLButtonElement).focus = () => { restored += 1; };
  Object.defineProperty(harness.document, "activeElement", { configurable: true, get: () => trigger });
  harness.palette.open();
  const escape = key(harness.window, "Escape");
  harness.input.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(harness.palette.isOpen(), false);
  assert.equal(restored, 1);

  harness.palette.open();
  const outside = new harness.window.Event("mousedown", { bubbles: true });
  harness.root.dispatchEvent(outside);
  assert.equal(harness.palette.isOpen(), false);
  assert.equal(restored, 2);

  harness.palette.open();
  const option = harness.options()[2];
  option.dispatchEvent(new harness.window.Event("click", { bubbles: true }));
  assert.deepEqual(harness.runs.map(run => run.id), ["host:stage"]);
  assert.equal(restored, 2, "running an option leaves focus to the action");
});

test("long unfiltered groups are capped while searches show every match", () => {
  const items: PaletteItem[] = Array.from({ length: 12 }, (_, index) => ({ id: `host-${index}`, group: "Hosts", title: `Host ${index}`, icon: "server", run() {} }));
  const harness = createHarness({ items });
  harness.palette.open();
  assert.equal(harness.options().length, 8);
  harness.type("host");
  assert.equal(harness.options().length, 12);
});

test("result text stays literal", () => {
  const items: PaletteItem[] = [{ id: "x", group: "Hosts", title: "<img src=x onerror=alert(1)>", subtitle: "<b>bold</b>", icon: "server", run() {} }];
  const harness = createHarness({ items });
  harness.palette.open();
  assert.equal(harness.root.querySelector("#palette-results img"), null);
  assert.equal(harness.root.querySelector("#palette-results b"), null);
  assert.equal(harness.titles()[0], "<img src=x onerror=alert(1)>");
});

test("the page provides every palette control and opens from accessible buttons", () => {
  const { document } = parseHTML(HTML);
  const input = document.getElementById("palette-input");
  assert.equal(input?.getAttribute("role"), "combobox");
  assert.equal(input?.getAttribute("aria-controls"), "palette-results");
  assert.equal(document.getElementById("palette-results")?.getAttribute("role"), "listbox");
  assert.equal(document.getElementById("command-palette")?.hasAttribute("hidden"), true);
  for (const id of ["btn-command-palette", "status-palette"]) {
    assert.equal(document.getElementById(id)?.getAttribute("aria-controls"), "command-palette");
  }
});
