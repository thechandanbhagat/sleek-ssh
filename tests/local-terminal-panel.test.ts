import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHTML } from "linkedom";
import { initLocalTerminalPanel } from "../src/local-terminal-panel.ts";
import { type LocalTerminalLocation } from "../src/local-terminal-locations.ts";

const HTML = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const STORAGE_KEY = "sleekssh_local_terminal_locations";
const LOCATION: LocalTerminalLocation = Object.freeze({ id: "project", name: "Project", path: "C:\\Projects\\app" });
type Invocation = { readonly command: string; readonly arguments_?: Record<string, unknown> };
type InvokeHandler = (invocation: Invocation) => Promise<unknown>;

function createStorage(initial: string | null = null) {
  const data = new Map<string, string>();
  if (initial !== null) data.set(STORAGE_KEY, initial);
  let writeFailure: Error | null = null;
  let writes = 0;
  return {
    data,
    get writes() { return writes; },
    failWrites(error: Error | null) { writeFailure = error; },
    getItem: (key: string) => data.get(key) ?? null,
    setItem(key: string, value: string) {
      if (writeFailure) throw writeFailure;
      writes += 1;
      data.set(key, value);
    }
  };
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function createHarness(configuration: {
  readonly storage?: ReturnType<typeof createStorage>;
  readonly invoke?: InvokeHandler;
  readonly openTerminal?: (location: LocalTerminalLocation) => Promise<void>;
  readonly confirmRemoval?: (name: string) => boolean;
  readonly missingControl?: string;
} = {}) {
  const { document, window } = parseHTML(HTML);
  const root = document.getElementById("local-locations") as HTMLElement;
  const storage = configuration.storage ?? createStorage();
  const calls: Invocation[] = [];
  const launches: LocalTerminalLocation[] = [];
  let generatedIds = 0;
  if (configuration.missingControl) root.querySelector(`#${configuration.missingControl}`)?.remove();
  initLocalTerminalPanel({
    root,
    storage,
    async invoke<T>(command: string, arguments_?: Record<string, unknown>): Promise<T> {
      const invocation = { command, arguments_ };
      calls.push(invocation);
      const result = configuration.invoke
        ? await configuration.invoke(invocation)
        : command === "validate_local_terminal_directory" ? arguments_?.workingDirectory : null;
      return result as T;
    },
    async openTerminal(location) {
      launches.push(location);
      await configuration.openTerminal?.(location);
    },
    createId: () => `location-${++generatedIds}`,
    confirmRemoval: configuration.confirmRemoval ?? (() => true)
  });
  const control = <T extends HTMLElement>(id: string): T => {
    const element = root.querySelector<T>(`#${id}`);
    assert.ok(element, `Expected control ${id}`);
    return element;
  };
  const path = control<HTMLInputElement>("local-location-path");
  const name = control<HTMLInputElement>("local-location-name");
  const editor = control<HTMLDetailsElement>("local-location-editor");
  const form = control<HTMLFormElement>("local-location-form");
  const error = control<HTMLParagraphElement>("local-location-error");
  const list = control<HTMLUListElement>("local-locations-list");
  return {
    root, storage, calls, launches, control, path, name, editor, form, error, list,
    get generatedIds() { return generatedIds; },
    submit() { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); },
    button(selector: string): HTMLButtonElement {
      const button = root.querySelector<HTMLButtonElement>(selector);
      assert.ok(button, `Expected button ${selector}`);
      return button;
    }
  };
}

test("saved location panel initially shows its empty state and validates required controls", () => {
  const panel = createHarness();
  assert.equal(panel.list.children.length, 0);
  assert.equal(panel.control("local-locations-empty").hidden, false);
  assert.equal(panel.error.hidden, true);
  assert.equal(panel.storage.writes, 0);
  assert.deepEqual(panel.calls, []);
  assert.throws(() => createHarness({ missingControl: "local-location-path" }), /Missing saved location control: local-location-path/);
});

test("saving validates the folder, derives its name and restores it after panel reload", async () => {
  const panel = createHarness({ invoke: async () => "C:\\Projects\\My app" });
  panel.editor.open = true;
  panel.path.value = "  C:\\Projects\\My app  ";
  panel.submit();
  await nextTurn();
  assert.deepEqual(panel.calls, [{ command: "validate_local_terminal_directory", arguments_: { workingDirectory: "C:\\Projects\\My app" } }]);
  const expected = { id: "location-1", name: "My app", path: "C:\\Projects\\My app" };
  assert.deepEqual(JSON.parse(panel.storage.getItem(STORAGE_KEY)!), [expected]);
  assert.equal(panel.list.children.length, 1);
  assert.equal(panel.list.querySelector(".local-location-name")?.textContent, "My app");
  assert.equal(panel.path.value, "");
  assert.equal(panel.name.value, "");
  assert.equal(panel.editor.open, false);
  assert.equal(panel.control("local-locations-empty").hidden, true);
  const reloaded = createHarness({ storage: panel.storage });
  reloaded.button(".local-location-open").click();
  await nextTurn();
  assert.deepEqual(reloaded.launches, [expected]);
  assert.deepEqual(reloaded.calls, []);
});

test("one click launches the exact saved location and renders names and special characters literally", async () => {
  const location = {
    id: "special",
    name: '<img src=x onerror="alert(1)">',
    path: "C:\\Projects\\O'Brien & $project; [draft] `notes` 日本語"
  };
  const panel = createHarness({ storage: createStorage(JSON.stringify([location])) });
  const open = panel.button(".local-location-open");
  assert.equal(open.getAttribute("aria-label"), `Open PowerShell: ${location.name}, ${location.path}`);
  assert.equal(open.title, `Open PowerShell in ${location.path}`);
  assert.equal(open.querySelector(".local-location-name")?.textContent, location.name);
  assert.equal(open.querySelector(".local-location-path")?.textContent, location.path);
  assert.equal(panel.list.querySelector("img, script"), null);
  open.click();
  await nextTurn();
  assert.deepEqual(panel.launches, [location]);
  assert.equal(panel.error.hidden, true);
});

test("editing updates the saved entry and keeps its identity", async () => {
  const panel = createHarness({ storage: createStorage(JSON.stringify([LOCATION])) });
  panel.button('[aria-label="Edit Project"]').click();
  assert.equal(panel.editor.open, true);
  assert.equal(panel.path.value, LOCATION.path);
  assert.equal(panel.name.value, LOCATION.name);
  assert.equal(panel.control("local-location-editor-toggle").textContent, "Edit location");
  panel.name.value = "  Renamed  ";
  panel.path.value = "D:\\Renamed";
  panel.submit();
  await nextTurn();
  const expected = { ...LOCATION, name: "Renamed", path: "D:\\Renamed" };
  assert.deepEqual(JSON.parse(panel.storage.getItem(STORAGE_KEY)!), [expected]);
  assert.equal(panel.list.children.length, 1);
  assert.equal(panel.generatedIds, 0);
  assert.equal(panel.control("local-location-editor-toggle").textContent, "Add location");
  panel.button(".local-location-open").click();
  await nextTurn();
  assert.deepEqual(panel.launches, [expected]);
});

test("folder browsing handles selection, cancellation and native errors without losing input", async () => {
  let result: string | null = "D:\\Selected folder";
  let failure: Error | null = null;
  const panel = createHarness({ invoke: async () => { if (failure) throw failure; return result; } });
  panel.path.value = LOCATION.path;
  panel.name.value = "Unsaved name";
  panel.control<HTMLButtonElement>("local-location-browse").click();
  await nextTurn();
  assert.equal(panel.path.value, "D:\\Selected folder");
  assert.equal(panel.name.value, "Unsaved name");
  assert.deepEqual(panel.calls, [{ command: "select_local_terminal_directory", arguments_: undefined }]);
  result = null;
  panel.control<HTMLButtonElement>("local-location-browse").click();
  await nextTurn();
  assert.equal(panel.path.value, "D:\\Selected folder");
  assert.equal(panel.error.hidden, true);
  failure = new Error("Could not open the folder picker");
  panel.control<HTMLButtonElement>("local-location-browse").click();
  await nextTurn();
  assert.equal(panel.path.value, "D:\\Selected folder");
  assert.equal(panel.error.hidden, false);
  assert.equal(panel.error.textContent, failure.message);
  assert.equal(panel.root.getAttribute("aria-busy"), "false");
  assert.equal(panel.storage.writes, 0);
});

test("removal respects cancellation and removes a confirmed location from persistent storage", () => {
  let accepted = false;
  const confirmations: string[] = [];
  const panel = createHarness({
    storage: createStorage(JSON.stringify([LOCATION])),
    confirmRemoval: name => { confirmations.push(name); return accepted; }
  });
  panel.button('[aria-label="Remove Project"]').click();
  assert.deepEqual(confirmations, ["Project"]);
  assert.equal(panel.list.children.length, 1);
  assert.equal(panel.storage.writes, 0);
  panel.button('[aria-label="Edit Project"]').click();
  accepted = true;
  panel.button('[aria-label="Remove Project"]').click();
  assert.deepEqual(confirmations, ["Project", "Project"]);
  assert.equal(panel.list.children.length, 0);
  assert.deepEqual(JSON.parse(panel.storage.getItem(STORAGE_KEY)!), []);
  assert.equal(panel.control("local-locations-empty").hidden, false);
  assert.equal(panel.path.value, "");
  assert.equal(panel.name.value, "");
  assert.equal(panel.editor.open, false);
});

test("invalid backend directories preserve the current list and form and allow a later save", async () => {
  let failure: Error | null = new Error("Folder does not exist: D:\\Missing");
  const panel = createHarness({
    storage: createStorage(JSON.stringify([LOCATION])),
    invoke: async invocation => { if (failure) throw failure; return invocation.arguments_?.workingDirectory; }
  });
  panel.editor.open = true;
  panel.path.value = "D:\\Missing";
  panel.name.value = "My new location";
  panel.submit();
  await nextTurn();
  assert.equal(panel.error.textContent, failure.message);
  assert.equal(panel.error.hidden, false);
  assert.equal(panel.list.children.length, 1);
  assert.equal(panel.path.value, "D:\\Missing");
  assert.equal(panel.name.value, "My new location");
  assert.equal(panel.editor.open, true);
  assert.deepEqual(JSON.parse(panel.storage.getItem(STORAGE_KEY)!), [LOCATION]);
  assert.equal(panel.storage.writes, 0);
  failure = null;
  panel.path.value = "D:\\Available";
  panel.submit();
  await nextTurn();
  assert.equal(panel.error.hidden, true);
  assert.equal(panel.list.children.length, 2);
});

test("storage save and removal failures preserve the saved list and unsaved changes", async () => {
  const storage = createStorage(JSON.stringify([LOCATION]));
  storage.failWrites(new Error("Storage quota exceeded"));
  const panel = createHarness({ storage });
  panel.button('[aria-label="Edit Project"]').click();
  panel.path.value = "D:\\New path";
  panel.name.value = "Unsaved changes";
  panel.submit();
  await nextTurn();
  assert.equal(panel.error.textContent, "Storage quota exceeded");
  assert.equal(panel.path.value, "D:\\New path");
  assert.equal(panel.name.value, "Unsaved changes");
  assert.equal(panel.editor.open, true);
  assert.equal(panel.list.querySelector(".local-location-name")?.textContent, LOCATION.name);
  panel.button('[aria-label="Remove Project"]').click();
  assert.equal(panel.error.textContent, "Storage quota exceeded");
  assert.equal(panel.list.children.length, 1);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)!), [LOCATION]);
  panel.button(".local-location-open").click();
  await nextTurn();
  assert.deepEqual(panel.launches, [LOCATION]);
});

test("malformed saved data shows an error and prevents accidental overwrite", async () => {
  for (const raw of ["{bad", "null", JSON.stringify([{ ...LOCATION, path: null }])]) {
    const storage = createStorage(raw);
    const panel = createHarness({ storage });
    assert.equal(panel.error.hidden, false);
    assert.ok(panel.error.textContent);
    assert.equal(panel.editor.hidden, true);
    assert.equal(panel.control("local-locations-empty").hidden, true);
    panel.path.value = "D:\\Replacement";
    panel.submit();
    await nextTurn();
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.equal(storage.writes, 0);
    assert.deepEqual(panel.calls, []);
  }
});

test("pending save disables controls and ignores repeated save, launch and removal actions", async () => {
  const validation = Promise.withResolvers<unknown>();
  const panel = createHarness({
    storage: createStorage(JSON.stringify([LOCATION])),
    invoke: () => validation.promise
  });
  panel.path.value = "D:\\New location";
  panel.name.value = "New location";
  panel.submit();
  assert.equal(panel.root.getAttribute("aria-busy"), "true");
  assert.ok([...panel.root.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")].every(element => element.disabled));
  panel.submit();
  panel.button(".local-location-open").click();
  panel.button('[aria-label="Remove Project"]').click();
  assert.equal(panel.calls.length, 1);
  assert.equal(panel.launches.length, 0);
  assert.equal(panel.storage.writes, 0);
  validation.resolve("D:\\New location");
  await nextTurn();
  assert.equal(panel.list.children.length, 2);
  assert.equal(panel.storage.writes, 1);
  assert.equal(panel.root.getAttribute("aria-busy"), "false");
  assert.ok([...panel.root.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")].every(element => !element.disabled));
});

test("pending launch ignores duplicate clicks and reports launch failures with retry available", async () => {
  const launch = Promise.withResolvers<void>();
  const panel = createHarness({ storage: createStorage(JSON.stringify([LOCATION])), openTerminal: () => launch.promise });
  const open = panel.button(".local-location-open");
  open.click();
  open.click();
  panel.control<HTMLButtonElement>("local-location-browse").click();
  assert.equal(panel.root.getAttribute("aria-busy"), "true");
  assert.equal(panel.launches.length, 1);
  assert.equal(panel.calls.length, 0);
  launch.reject(new Error("Folder was moved or removed"));
  await nextTurn();
  assert.equal(panel.error.textContent, "Folder was moved or removed");
  assert.equal(panel.error.hidden, false);
  assert.equal(open.disabled, false);
  assert.equal(panel.root.getAttribute("aria-busy"), "false");
  assert.equal(panel.list.children.length, 1);
  assert.equal(panel.storage.writes, 0);
});

test("cancel discards editing values without modifying the saved location", () => {
  const panel = createHarness({ storage: createStorage(JSON.stringify([LOCATION])) });
  panel.button('[aria-label="Edit Project"]').click();
  panel.path.value = "D:\\Unsaved";
  panel.name.value = "Unsaved";
  panel.control<HTMLButtonElement>("local-location-cancel").click();
  assert.equal(panel.editor.open, false);
  assert.equal(panel.path.value, "");
  assert.equal(panel.name.value, "");
  assert.equal(panel.control("local-location-save").textContent, "Save location");
  assert.equal(panel.storage.writes, 0);
  assert.deepEqual(JSON.parse(panel.storage.getItem(STORAGE_KEY)!), [LOCATION]);
});
