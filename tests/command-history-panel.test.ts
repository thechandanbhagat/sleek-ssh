import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHTML } from "linkedom";
import { createCommandHistory, type HistoryContext } from "../src/command-history.ts";
import { initCommandHistoryPanel } from "../src/command-history-panel.ts";

const CONTEXT: HistoryContext = Object.freeze({ key: "ssh:deploy@example.test:22", label: "Production · deploy@example.test:22" });
const OTHER_CONTEXT: HistoryContext = Object.freeze({ key: "local:powershell", label: "Local PowerShell" });
const MAX_COMMAND_CHARACTERS = 16_000;
const MARKUP = `<section id="command-history-panel" aria-labelledby="command-history-title">
  <h2 id="command-history-title">History</h2>
  <button id="command-history-close" type="button" aria-label="Hide command history">Close</button>
  <p id="command-history-target"></p>
  <label for="command-history-search">Search commands</label>
  <input id="command-history-search" type="search" />
  <ul id="command-history-list"></ul>
  <p id="command-history-empty"></p>
  <p id="command-history-error" role="status" hidden></p>
</section>`;

function createHarness(configuration: {
  missingControl?: string;
  context?: HistoryContext | null;
  contextError?: Error;
  insertError?: Error;
  closeError?: Error;
} = {}) {
  const { document, window } = parseHTML(MARKUP);
  const root = document.getElementById("command-history-panel") as HTMLElement;
  if (configuration.missingControl) document.getElementById(configuration.missingControl)?.remove();
  const values = new Map<string, string>();
  const history = createCommandHistory({ storage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  }, now: () => 0 });
  let context = configuration.context === undefined ? CONTEXT : configuration.context;
  let contextError = configuration.contextError;
  const insertions: string[] = [];
  const errors: unknown[] = [];
  let closeCount = 0;
  const panel = initCommandHistoryPanel({
    root,
    history,
    getContext: () => { if (contextError) throw contextError; return context; },
    insert: command => { if (configuration.insertError) throw configuration.insertError; insertions.push(command); },
    onClose: () => { if (configuration.closeError) throw configuration.closeError; closeCount += 1; },
    onError: cause => { errors.push(cause); },
  });
  const control = <T extends HTMLElement>(id: string): T => {
    const element = document.getElementById(id);
    assert(element);
    return element as T;
  };
  return {
    root, window, history, panel, control, insertions, errors,
    get closeCount() { return closeCount; },
    select(next: HistoryContext | null) { context = next; panel.refresh(); },
    clearContextError() { contextError = undefined; panel.refresh(); },
    search(query: string) {
      const input = control<HTMLInputElement>("command-history-search");
      input.value = query;
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    button(): HTMLButtonElement {
      const button = root.querySelector<HTMLButtonElement>(".command-history-insert");
      assert(button);
      return button;
    },
  };
}

test("history panel renders an accessible empty state for a selected or absent terminal", () => {
  const harness = createHarness();
  assert.equal(harness.control("command-history-list").children.length, 0);
  assert.equal(harness.control("command-history-target").textContent, CONTEXT.label);
  assert.equal(harness.control("command-history-error").hidden, true);
  assert.equal(harness.control("command-history-empty").hidden, false);
  assert.match(harness.control("command-history-empty").textContent ?? "", /Commands you run here or through the agent/);
  harness.select(null);
  assert.equal(harness.control<HTMLInputElement>("command-history-search").disabled, true);
  assert.match(harness.control("command-history-target").textContent ?? "", /Select a connected terminal/);
  assert.match(harness.control("command-history-empty").textContent ?? "", /Connect to a terminal/);
});

test("history panel rejects a missing root and binds the labelled controls in the actual page", () => {
  assert.throws(() => initCommandHistoryPanel(null as unknown as Parameters<typeof initCommandHistoryPanel>[0]), /panel is unavailable/);
  const { document } = parseHTML(readFileSync(new URL("../src/index.html", import.meta.url), "utf8"));
  const root = document.getElementById("command-history-panel") as HTMLElement;
  assert(root);
  const history = createCommandHistory({ storage: { getItem: () => null, setItem() {} } });
  const panel = initCommandHistoryPanel({ root, history, getContext: () => null, insert() {}, onClose() {} });
  assert.equal(root.getAttribute("aria-labelledby"), "command-history-title");
  assert(root.querySelector('label[for="command-history-search"]'));
  assert.equal(root.querySelector("#command-history-error")?.getAttribute("role"), "status");
  assert(root.querySelector("#command-history-close")?.getAttribute("aria-label"));
  panel.dispose();
});

for (const id of ["command-history-search", "command-history-list", "command-history-empty", "command-history-error", "command-history-target", "command-history-close"]) {
  test(`history panel fails explicitly when ${id} is missing`, () => {
    assert.throws(() => createHarness({ missingControl: id }), new RegExp(`Missing command history control: ${id}`));
  });
}

test("history panel automatically refreshes execution counts and inserts commands without executing", () => {
  const harness = createHarness();
  harness.history.record(CONTEXT, "systemctl status nginx", "terminal");
  harness.history.record(CONTEXT, "systemctl status nginx", "agent");
  const button = harness.button();
  assert.equal(button.type, "button");
  assert.equal(button.querySelector(".command-history-command")?.textContent, "systemctl status nginx");
  assert.equal(button.querySelector(".command-history-count")?.textContent, "2 runs");
  assert.equal(button.querySelector(".command-history-source")?.textContent, "1 terminal · 1 agent");
  assert.match(button.title, /without running/);
  button.click();
  assert.deepEqual(harness.insertions, ["systemctl status nginx"]);
  assert.equal(harness.history.entries(CONTEXT.key)[0].runCount, 2);
  assert.equal(harness.control("command-history-empty").hidden, true);
});

test("history panel filters command text and isolates the currently selected server or shell", () => {
  const harness = createHarness();
  harness.history.record(CONTEXT, "systemctl status nginx", "terminal");
  harness.history.record(CONTEXT, "ls -la", "terminal");
  harness.history.record(OTHER_CONTEXT, "Get-Location", "terminal");
  harness.search("NGINX");
  assert.equal(harness.control("command-history-list").children.length, 1);
  assert.equal(harness.button().querySelector("code")?.textContent, "systemctl status nginx");
  harness.search("not-found");
  assert.equal(harness.control("command-history-list").children.length, 0);
  assert.match(harness.control("command-history-empty").textContent ?? "", /No commands match/);
  harness.search("");
  harness.select(OTHER_CONTEXT);
  assert.equal(harness.control("command-history-list").children.length, 1);
  assert.equal(harness.button().querySelector("code")?.textContent, "Get-Location");
  assert.equal(harness.button().querySelector(".command-history-count")?.textContent, "1 run");
});

test("history panel renders hostile command/context text literally and accepts maximum-length commands", () => {
  const context = { key: "literal", label: '<img src=x onerror="alert(1)">' };
  const harness = createHarness({ context });
  const command = '<script>alert(1)</script> && printf "<&>"';
  harness.history.record(context, command, "agent");
  assert.equal(harness.root.querySelector("script"), null);
  assert.equal(harness.root.querySelector("img"), null);
  assert.equal(harness.control("command-history-target").textContent, context.label);
  assert.equal(harness.button().querySelector("code")?.textContent, command);
  harness.button().click();
  assert.deepEqual(harness.insertions, [command]);
  harness.history.record(context, "x".repeat(MAX_COMMAND_CHARACTERS), "terminal");
  assert.equal(harness.control("command-history-list").children.length, 2);
});

test("history panel reports context and insertion failures and recovers on refresh", () => {
  const contextFailure = new Error("Target lookup failed");
  const harness = createHarness({ contextError: contextFailure, insertError: new Error("Terminal disconnected") });
  assert.equal(harness.control("command-history-error").hidden, false);
  assert.match(harness.control("command-history-error").textContent ?? "", /Target lookup failed/);
  assert.equal(harness.errors[0], contextFailure);
  harness.clearContextError();
  assert.equal(harness.control("command-history-error").hidden, true);
  harness.history.record(CONTEXT, "pwd", "terminal");
  harness.button().click();
  assert.deepEqual(harness.insertions, []);
  assert.match(harness.control("command-history-error").textContent ?? "", /Terminal disconnected/);
  harness.panel.refresh();
  assert.equal(harness.control("command-history-error").hidden, true);
});

test("close button and Escape close history while unrelated keys leave it open", () => {
  const harness = createHarness();
  harness.control<HTMLButtonElement>("command-history-close").click();
  const escape = new harness.window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(escape, "key", { value: "Escape" });
  harness.control("command-history-search").dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(harness.closeCount, 2);
  const other = new harness.window.Event("keydown", { bubbles: true });
  Object.defineProperty(other, "key", { value: "a" });
  harness.root.dispatchEvent(other);
  assert.equal(harness.closeCount, 2);
  const failing = createHarness({ closeError: new Error("Could not hide panel") });
  failing.control<HTMLButtonElement>("command-history-close").click();
  assert.match(failing.control("command-history-error").textContent ?? "", /Could not hide panel/);
});

test("disposing history panel removes subscriptions and input/close/row actions", () => {
  const harness = createHarness();
  harness.history.record(CONTEXT, "pwd", "terminal");
  const previousButton = harness.button();
  harness.panel.dispose();
  harness.panel.dispose();
  harness.history.record(CONTEXT, "whoami", "agent");
  assert.equal(harness.control("command-history-list").children.length, 1);
  previousButton.click();
  harness.control<HTMLButtonElement>("command-history-close").click();
  harness.search("missing");
  harness.panel.refresh();
  assert.deepEqual(harness.insertions, []);
  assert.equal(harness.closeCount, 0);
  assert.equal(harness.control("command-history-list").children.length, 1);
});
