import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { initSavedWorkspacesPanel } from "../src/saved-workspaces-panel.ts";
import type { SavedWorkspace } from "../src/saved-workspaces.ts";

const MAX_NAME_LENGTH = 120;
const WORKSPACE: SavedWorkspace = {
  id: "daily",
  name: "Daily work",
  tabs: [{ kind: "local", shell: "powershell", workingDirectory: "C:\\Projects", locationName: "Projects" }],
  activeTabIndex: 0,
  layout: { sidebarWidth: 248, sftpWidth: 280, sidebarOpen: true, sidebarView: "connections", sidePanel: "none" },
};
type Options = Parameters<typeof initSavedWorkspacesPanel>[0];

function createHarness(configuration: Partial<Omit<Options, "root">> & { initial?: readonly SavedWorkspace[] } = {}) {
  const { document, window } = parseHTML('<html><body><div id="saved-workspaces-panel"></div></body></html>');
  const root = document.getElementById("saved-workspaces-panel") as HTMLElement;
  const saves: Array<{ name: string; id?: string }> = [];
  const renames: Array<{ id: string; name: string }> = [];
  const removes: string[] = [];
  const opens: string[] = [];
  const confirmations: Array<{ kind: string; name: string }> = [];
  let workspaces = configuration.initial ?? [];
  let listFailure: Error | null = null;
  let focus: HTMLElement | null = null;
  window.HTMLElement.prototype.focus = function () { focus = this as HTMLElement; };
  const panel = initSavedWorkspacesPanel({
    root,
    list: configuration.list ?? (() => { if (listFailure) throw listFailure; return workspaces; }),
    async save(name, id) {
      saves.push({ name, id });
      if (configuration.save) await configuration.save(name, id);
      else {
        const saved = { ...WORKSPACE, id: id ?? `saved-${saves.length}`, name };
        workspaces = id ? workspaces.map(item => item.id === id ? saved : item) : [...workspaces, saved];
      }
    },
    rename(id, name) {
      renames.push({ id, name });
      if (configuration.rename) configuration.rename(id, name);
      else workspaces = workspaces.map(item => item.id === id ? { ...item, name } : item);
    },
    remove(id) {
      removes.push(id);
      if (configuration.remove) configuration.remove(id);
      else workspaces = workspaces.filter(item => item.id !== id);
    },
    async open(id) { opens.push(id); return configuration.open ? await configuration.open(id) : []; },
    confirmRemoval(name) { confirmations.push({ kind: "remove", name }); return configuration.confirmRemoval?.(name) ?? true; },
    confirmUpdate(name) { confirmations.push({ kind: "update", name }); return configuration.confirmUpdate?.(name) ?? true; },
  });
  const find = <T extends HTMLElement>(selector: string): T => {
    const node = root.querySelector<T>(selector);
    assert.ok(node, `Missing ${selector}`);
    return node;
  };
  const button = (name: string): HTMLButtonElement => {
    const node = [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === name);
    assert.ok(node, `Missing button ${name}`);
    return node;
  };
  return {
    panel, root, saves, renames, removes, opens, confirmations, find, button,
    get focus() { return focus; },
    get workspaces() { return workspaces; },
    setWorkspaces(value: readonly SavedWorkspace[]) { workspaces = value; },
    failList(value: Error | null) { listFailure = value; },
    name: find<HTMLInputElement>("input"),
    editor: find<HTMLFormElement>("form"),
    status: find<HTMLParagraphElement>('[role="status"]'),
    error: find<HTMLParagraphElement>('[role="alert"]'),
    submit() { find("form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); },
    escape() {
      const event = new window.Event("keydown", { cancelable: true, bubbles: true });
      Object.defineProperty(event, "key", { value: "Escape" });
      find("form").dispatchEvent(event);
      return event;
    },
  };
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

test("initial empty panel has a labeled editor and no mutations", () => {
  const harness = createHarness();
  assert.equal(harness.find("ul").children.length, 0);
  assert.equal(harness.find(".small-text").hidden, false);
  assert.equal(harness.editor.hidden, true);
  assert.equal(harness.error.hidden, true);
  assert.equal(harness.status.hidden, true);
  assert.equal(harness.find("label").getAttribute("for"), harness.name.id);
  assert.equal(harness.name.maxLength, MAX_NAME_LENGTH);
  assert.deepEqual(harness.saves, []);
});

test("showSave opens and focuses the form; Cancel and Escape restore focus", () => {
  const harness = createHarness();
  const trigger = harness.button("Save current workspace");
  harness.panel.showSave();
  assert.equal(harness.editor.hidden, false);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(harness.focus, harness.name);
  harness.name.value = "Discarded";
  harness.button("Cancel").click();
  assert.equal(harness.editor.hidden, true);
  assert.equal(harness.focus, trigger);
  trigger.click();
  assert.equal(harness.name.value, "");
  const event = harness.escape();
  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.editor.hidden, true);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("saving captures a trimmed name, refreshes the list and restores focus", async () => {
  const harness = createHarness();
  harness.panel.showSave();
  harness.name.value = "  Development  ";
  harness.submit();
  await nextTurn();
  assert.deepEqual(harness.saves, [{ name: "Development", id: undefined }]);
  assert.equal(harness.find(".saved-workspace-name").textContent, "Development");
  assert.equal(harness.find(".saved-workspace-count").textContent, "1 tab");
  assert.equal(harness.editor.hidden, true);
  assert.equal(harness.focus, harness.button("Save current workspace"));
  assert.equal(harness.status.textContent, "Saved Development.");
});

for (const name of ["", "   ", "a".repeat(MAX_NAME_LENGTH + 1)]) {
  test(`invalid name length ${name.length} never reaches persistence`, async () => {
    const harness = createHarness();
    harness.panel.showSave();
    harness.name.value = name;
    harness.submit();
    await nextTurn();
    assert.deepEqual(harness.saves, []);
    assert.match(harness.error.textContent ?? "", /between 1 and 120/);
    assert.equal(harness.editor.hidden, false);
  });
}

test("maximum length name reaches persistence", async () => {
  const harness = createHarness();
  harness.panel.showSave();
  harness.name.value = "a".repeat(MAX_NAME_LENGTH);
  harness.submit();
  await nextTurn();
  assert.equal(harness.saves[0].name.length, MAX_NAME_LENGTH);
});

test("save failure remains visible and leaves the editor available for correction", async () => {
  const harness = createHarness({ save: async () => { throw new Error("A workspace already has this name."); } });
  harness.panel.showSave();
  harness.name.value = "Duplicate";
  harness.submit();
  await nextTurn();
  assert.equal(harness.error.textContent, "A workspace already has this name.");
  assert.equal(harness.editor.hidden, false);
  assert.equal(harness.name.disabled, false);
  assert.equal(harness.status.hidden, true);
});

test("rename changes only the name without capturing current tabs", async () => {
  const harness = createHarness({ initial: [WORKSPACE] });
  harness.button("Rename").click();
  assert.equal(harness.name.value, WORKSPACE.name);
  assert.equal(harness.button("Rename workspace").type, "submit");
  harness.name.value = "Release";
  harness.submit();
  await nextTurn();
  assert.deepEqual(harness.renames, [{ id: WORKSPACE.id, name: "Release" }]);
  assert.deepEqual(harness.saves, []);
  assert.equal(harness.workspaces[0].tabs, WORKSPACE.tabs);
  assert.equal(harness.find(".saved-workspace-name").textContent, "Release");
});

test("rename cancellation returns focus to its original action", () => {
  const harness = createHarness({ initial: [WORKSPACE] });
  const trigger = harness.button("Rename");
  trigger.click();
  harness.button("Cancel").click();
  assert.equal(harness.focus, trigger);
  assert.deepEqual(harness.renames, []);
});

test("rename failure leaves existing data and an editable name", async () => {
  const harness = createHarness({ initial: [WORKSPACE], rename: () => { throw new Error("Rename denied"); } });
  harness.button("Rename").click();
  harness.name.value = "Changed";
  harness.submit();
  await nextTurn();
  assert.equal(harness.error.textContent, "Rename denied");
  assert.equal(harness.find(".saved-workspace-name").textContent, WORKSPACE.name);
  assert.equal(harness.editor.hidden, false);
});

test("update confirms and captures a new snapshot under the same name and ID", async () => {
  const harness = createHarness({ initial: [WORKSPACE] });
  harness.button("Update").click();
  await nextTurn();
  assert.deepEqual(harness.confirmations, [{ kind: "update", name: WORKSPACE.name }]);
  assert.deepEqual(harness.saves, [{ name: WORKSPACE.name, id: WORKSPACE.id }]);
  assert.equal(harness.status.textContent, `Updated ${WORKSPACE.name}.`);
});

test("declining update preserves the saved workspace", async () => {
  const harness = createHarness({ initial: [WORKSPACE], confirmUpdate: () => false });
  harness.button("Update").click();
  await nextTurn();
  assert.deepEqual(harness.saves, []);
  assert.equal(harness.status.hidden, true);
  assert.equal(harness.error.hidden, true);
});

test("update failure preserves the list and reports its cause", async () => {
  const harness = createHarness({ initial: [WORKSPACE], save: async () => { throw new Error("No open terminal tabs"); } });
  harness.button("Update").click();
  await nextTurn();
  assert.equal(harness.error.textContent, "No open terminal tabs");
  assert.equal(harness.find("ul").children.length, 1);
});

test("remove confirms, refreshes empty state, and focuses Save current", async () => {
  const harness = createHarness({ initial: [WORKSPACE] });
  harness.button("Remove").click();
  await nextTurn();
  assert.deepEqual(harness.confirmations, [{ kind: "remove", name: WORKSPACE.name }]);
  assert.deepEqual(harness.removes, [WORKSPACE.id]);
  assert.equal(harness.find("ul").children.length, 0);
  assert.equal(harness.find(".small-text").hidden, false);
  assert.equal(harness.focus, harness.button("Save current workspace"));
});

test("declining removal does not mutate metadata", async () => {
  const harness = createHarness({ initial: [WORKSPACE], confirmRemoval: () => false });
  harness.button("Remove").click();
  await nextTurn();
  assert.deepEqual(harness.removes, []);
  assert.equal(harness.find("ul").children.length, 1);
});

test("removal failure is visible without hiding the saved workspace", async () => {
  const harness = createHarness({ initial: [WORKSPACE], remove: () => { throw new Error("Storage is unavailable"); } });
  harness.button("Remove").click();
  await nextTurn();
  assert.equal(harness.error.textContent, "Storage is unavailable");
  assert.equal(harness.find("ul").children.length, 1);
});

test("open returns only after restoration and displays every partial failure literally", async () => {
  const failures = ["Deleted host: production", "Missing folder: <C:\\gone>"];
  const harness = createHarness({ initial: [WORKSPACE], open: async () => failures });
  await harness.panel.open(WORKSPACE.id);
  assert.deepEqual(harness.opens, [WORKSPACE.id]);
  assert.equal(harness.error.textContent, failures.join("\n"));
  assert.equal(harness.error.children.length, 0);
  assert.equal(harness.status.textContent, `Finished opening ${WORKSPACE.name} with issues.`);
});

test("Open button shows completion and a later successful open clears prior errors", async () => {
  let first = true;
  const harness = createHarness({ initial: [WORKSPACE], open: async () => { if (first) { first = false; throw new Error("Failed to open"); } return []; } });
  await harness.panel.open(WORKSPACE.id);
  assert.equal(harness.error.textContent, "Failed to open");
  harness.button("Open").click();
  await nextTurn();
  assert.equal(harness.error.hidden, true);
  assert.equal(harness.status.textContent, `Opened ${WORKSPACE.name}.`);
});

test("a missing saved ID reports an error without launching", async () => {
  const harness = createHarness();
  await harness.panel.open("deleted");
  assert.deepEqual(harness.opens, []);
  assert.match(harness.error.textContent ?? "", /no longer exists/);
});

test("while opening, every control is disabled and reentrant operations are ignored", async () => {
  let complete!: (failures: readonly string[]) => void;
  const pending = new Promise<readonly string[]>(resolve => { complete = resolve; });
  const harness = createHarness({ initial: [WORKSPACE], open: async () => pending });
  const opening = harness.panel.open(WORKSPACE.id);
  assert.equal(harness.root.getAttribute("aria-busy"), "true");
  for (const control of harness.root.querySelectorAll<HTMLInputElement>("button,input")) assert.equal(control.disabled, true);
  await harness.panel.open(WORKSPACE.id);
  harness.panel.showSave();
  harness.button("Remove").click();
  assert.deepEqual(harness.opens, [WORKSPACE.id]);
  assert.deepEqual(harness.removes, []);
  assert.equal(harness.editor.hidden, true);
  complete([]);
  await opening;
  assert.equal(harness.root.getAttribute("aria-busy"), "false");
  assert.equal(harness.button("Open").disabled, false);
});

test("saving is single-flight even for repeated submit events", async () => {
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  const harness = createHarness({ save: async () => pending });
  harness.panel.showSave();
  harness.name.value = "New";
  harness.submit();
  harness.submit();
  harness.escape();
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.editor.hidden, false);
  complete();
  await nextTurn();
  assert.equal(harness.editor.hidden, true);
  assert.equal(harness.focus, harness.button("Save current workspace"));
});

test("refresh reflects current data including plural counts and never evaluates host text", () => {
  const harness = createHarness();
  const hostile = '<img src=x onerror="alert(1)">';
  harness.setWorkspaces([{ ...WORKSPACE, name: hostile, tabs: [...WORKSPACE.tabs, ...WORKSPACE.tabs] }]);
  harness.panel.refresh();
  assert.equal(harness.find(".saved-workspace-name").textContent, hostile);
  assert.equal(harness.find(".saved-workspace-count").textContent, "2 tabs");
  assert.equal(harness.root.querySelector("img"), null);
  assert.equal(harness.button("Open").getAttribute("aria-label"), `Open ${hostile}`);
});

test("a failed refresh retains existing rows and disables all mutations until recovery", () => {
  const harness = createHarness({ initial: [WORKSPACE] });
  harness.failList(new Error("Saved workspaces are corrupt"));
  harness.panel.refresh();
  assert.equal(harness.find("ul").children.length, 1);
  assert.equal(harness.error.textContent, "Saved workspaces are corrupt");
  assert.equal(harness.button("Save current workspace").disabled, true);
  harness.panel.showSave();
  assert.equal(harness.editor.hidden, true);
  harness.failList(null);
  harness.panel.refresh();
  assert.equal(harness.error.hidden, true);
  assert.equal(harness.button("Save current workspace").disabled, false);
});

test("initial read failure cannot overwrite saved data", async () => {
  const harness = createHarness({ list: () => { throw new Error("Storage read failed"); } });
  assert.equal(harness.error.textContent, "Storage read failed");
  assert.equal(harness.button("Save current workspace").disabled, true);
  harness.name.value = "Replacement";
  harness.submit();
  await harness.panel.open(WORKSPACE.id);
  await nextTurn();
  assert.deepEqual(harness.saves, []);
  assert.deepEqual(harness.opens, []);
});

test("post-save read failure stays visible instead of claiming successful persistence", async () => {
  const harness = createHarness({ save: async () => { harness.failList(new Error("Reload failed")); } });
  harness.panel.showSave();
  harness.name.value = "New";
  harness.submit();
  await nextTurn();
  assert.equal(harness.error.textContent, "Reload failed");
  assert.equal(harness.status.hidden, true);
  assert.equal(harness.name.disabled, true);
});
