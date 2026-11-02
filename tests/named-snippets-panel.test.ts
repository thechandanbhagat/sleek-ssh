import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { initNamedSnippetsPanel, type SnippetPreview } from "../src/named-snippets-panel.ts";
import { createNamedSnippetControls } from "../src/named-snippets-controls.ts";
import { loadSnippets, saveSnippet, renderSnippet, type NamedSnippet, type SnippetShell } from "../src/named-snippets.ts";

const STORAGE_KEY = "sleekssh_named_snippets";
const MAX_NAME_LENGTH = 120;
const MAX_PARAMETER_LENGTH = 4_000;
const SNIPPET: NamedSnippet = { id: "status", name: "Service status", template: "systemctl status {{service}}", shell: "posix" };

test("a palette can open a saved snippet directly without executing it", () => {
  const h = createHarness({ initial: [SNIPPET] });
  h.panel.openSnippet(SNIPPET.id);
  assert.equal(h.runner.hidden, false);
  assert.equal(h.parameter().value, "");
  assert.deepEqual(h.executions, []);
  assert.throws(() => h.panel.openSnippet("missing"), /no longer saved/);
  h.panel.dispose(); h.panel.openSnippet(SNIPPET.id);
  assert.deepEqual(h.executions, []);
});
type Options = Parameters<typeof initNamedSnippetsPanel>[0];

function createStorage(initial: readonly NamedSnippet[] = []) {
  const data = new Map<string, string>();
  let readFailure: Error | null = null;
  let writeFailure: Error | null = null;
  const storage = {
    data,
    getItem(key: string) { if (readFailure) throw readFailure; return data.get(key) ?? null; },
    setItem(key: string, value: string) { if (writeFailure) throw writeFailure; data.set(key, value); },
    failReads(error: Error | null) { readFailure = error; },
    failWrites(error: Error | null) { writeFailure = error; },
  };
  for (const snippet of initial) saveSnippet(storage, loadSnippets(storage), snippet);
  return storage;
}

function createHarness(configuration: Partial<Pick<Options, "preview" | "execute" | "isPreviewValid" | "confirmRemoval" | "getFolder">> & {
  storage?: ReturnType<typeof createStorage>;
  initial?: readonly NamedSnippet[];
} = {}) {
  const { document, window } = parseHTML('<html><body><div id="named-snippets-root"></div></body></html>');
  const root = document.getElementById("named-snippets-root") as HTMLElement;
  const storage = configuration.storage ?? createStorage(configuration.initial);
  const previews: Array<{ snippet: NamedSnippet; values: Readonly<Record<string, string>> }> = [];
  const executions: Array<{ preview: SnippetPreview; run: boolean }> = [];
  const removals: string[] = [];
  let valid = true;
  let sequence = 0;
  let focus: HTMLElement | null = null;
  window.HTMLElement.prototype.focus = function () { focus = this as HTMLElement; };
  const panel = initNamedSnippetsPanel({
    root, storage,
    getFolder: configuration.getFolder,
    createId: () => `snippet-${++sequence}`,
    preview(snippet, values) {
      previews.push({ snippet, values });
      return configuration.preview?.(snippet, values) ?? {
        command: renderSnippet(snippet.template, snippet.shell, values), targetLabel: "API · deploy@example.test:22", shell: snippet.shell, token: {},
      };
    },
    isPreviewValid: value => configuration.isPreviewValid?.(value) ?? valid,
    async execute(value, run) { executions.push({ preview: value, run }); await configuration.execute?.(value, run); },
    confirmRemoval(name) { removals.push(name); return configuration.confirmRemoval?.(name) ?? true; },
  });
  const control = <T extends HTMLElement>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    assert.ok(element, `Missing ${selector}`);
    return element;
  };
  const button = (text: string): HTMLButtonElement => {
    const element = [...root.querySelectorAll<HTMLButtonElement>("button")].find(node => node.getAttribute("aria-label") === text || node.textContent === text);
    assert.ok(element, `Missing button ${text}`);
    return element;
  };
  const dispatch = (element: HTMLElement, type: string) => element.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  return {
    root, panel, storage, previews, executions, removals, control, button, dispatch,
    get focus() { return focus; },
    get snippets() { return loadSnippets(storage); },
    invalidateTarget() { valid = false; },
    restoreTarget() { valid = true; },
    name: control<HTMLInputElement>("#named-snippet-name"),
    template: control<HTMLTextAreaElement>("#named-snippet-template"),
    shell: control<HTMLSelectElement>("#named-snippet-shell"),
    editor: control<HTMLFormElement>(".named-snippet-editor"),
    runner: control<HTMLFormElement>(".named-snippet-runner"),
    search: control<HTMLInputElement>("#named-snippet-search"),
    status: control<HTMLParagraphElement>('[role="status"]'),
    error: control<HTMLParagraphElement>('[role="alert"]'),
    submitEditor() { dispatch(control(".named-snippet-editor"), "submit"); },
    review() { dispatch(control(".named-snippet-runner"), "submit"); },
    use(name = SNIPPET.name) { button(`Use ${name}`).click(); },
    parameter(index = 0) { return control<HTMLInputElement>(`#named-snippet-parameter-${index}`); },
    value(value: string, index = 0) { const input = control<HTMLInputElement>(`#named-snippet-parameter-${index}`); input.value = value; dispatch(input, "input"); },
    setShell(value: SnippetShell) {
      const options = [...control<HTMLSelectElement>("select").options];
      options.forEach(option => { option.selected = false; });
      options.find(option => option.value === value)!.selected = true;
      dispatch(control("select"), "change");
    },
    escape() {
      const event = new window.Event("keydown", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "key", { value: "Escape" });
      root.dispatchEvent(event);
      return event;
    },
  };
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

const FOLDER = Object.freeze({ host: "api.example.test", port: 22, username: "deploy", path: "/srv/app" });

test("an existing snippet switches Shared to Folder and back with one click and no execution", () => {
  const h = createHarness({ initial: [SNIPPET], getFolder: () => FOLDER });
  h.button(`Make ${SNIPPET.name} folder-specific`).click();
  assert.deepEqual(h.snippets, [{ ...SNIPPET, folder: FOLDER }]);
  assert.equal(h.control(".named-snippet-folder-path").textContent, FOLDER.path);
  assert.equal(h.control(".named-snippet-scope").dataset.scope, "folder");
  assert.equal(h.focus, h.control(".named-snippet-scope"));
  h.button(`Make ${SNIPPET.name} shared`).click();
  assert.deepEqual(h.snippets, [SNIPPET]);
  assert.equal(h.root.querySelector(".named-snippet-folder-path"), null);
  assert.deepEqual(h.executions, []);
});

test("editing preserves folder scope, and off-folder snippets can still be made shared", () => {
  let folder = FOLDER;
  const h = createHarness({ initial: [{ ...SNIPPET, folder: FOLDER }], getFolder: () => folder });
  h.button(`Edit ${SNIPPET.name}`).click(); h.template.value = "systemctl restart {{service}}"; h.submitEditor();
  assert.deepEqual(h.snippets[0].folder, FOLDER);
  folder = { ...FOLDER, path: "/other" }; h.panel.refresh();
  assert.equal(h.button(`Use ${SNIPPET.name}`).disabled, true);
  assert.equal(h.button(`Make ${SNIPPET.name} shared`).disabled, false);
  h.button(`Make ${SNIPPET.name} shared`).click();
  assert.equal(h.snippets[0].folder, undefined);
  assert.equal(h.button(`Use ${SNIPPET.name}`).disabled, false);
});

test("scope controls require an SSH folder, preserve storage errors and reject stale edits", () => {
  const unavailable = createHarness({ initial: [SNIPPET] });
  assert.equal(unavailable.button(`Make ${SNIPPET.name} folder-specific`).disabled, true);
  const h = createHarness({ initial: [SNIPPET], getFolder: () => FOLDER });
  h.storage.failWrites(new Error("Storage full")); h.button(`Make ${SNIPPET.name} folder-specific`).click();
  assert.match(h.error.textContent!, /Storage full/); assert.deepEqual(h.snippets, [SNIPPET]);
  h.storage.failWrites(null);
  saveSnippet(h.storage, h.snippets, { ...SNIPPET, template: "pwd" });
  h.button(`Make ${SNIPPET.name} folder-specific`).click();
  assert.match(h.error.textContent!, /snippet changed/);
  assert.equal(h.snippets[0].template, "pwd"); assert.equal(h.snippets[0].folder, undefined);
});

test("scope changes and leaving the folder invalidate a reviewed command", () => {
  let folder = FOLDER;
  const h = createHarness({ initial: [{ ...SNIPPET, folder: FOLDER }], getFolder: () => folder });
  h.use(); h.value("nginx"); h.review(); assert.equal(h.button("Run").disabled, false);
  folder = { ...FOLDER, host: "other.test" }; h.panel.refresh();
  assert.equal(h.button("Run").disabled, true);
  folder = FOLDER; h.panel.showLibrary(); h.panel.refresh();
  h.use(); h.value("nginx"); h.review();
  saveSnippet(h.storage, h.snippets, { ...SNIPPET, folder: { ...FOLDER, path: "/other" } });
  h.panel.refresh(); assert.equal(h.button("Run").disabled, true);
  assert.deepEqual(h.executions, []);
});

test("controls require a document, label inputs, and leave execution buttons outside form submission", () => {
  assert.throws(() => createNamedSnippetControls(null as unknown as HTMLElement), /unavailable/);
  const { document } = parseHTML('<div id="root"></div>');
  const ui = createNamedSnippetControls(document.getElementById("root") as HTMLElement);
  for (const input of [ui.search, ui.name, ui.template, ui.shell]) {
    assert.ok(document.querySelector(`label[for="${input.id}"]`));
  }
  assert.equal(ui.run.type, "button");
  assert.equal(ui.insert.type, "button");
  assert.equal(ui.review.type, "submit");
  assert.equal(ui.name.maxLength, MAX_NAME_LENGTH);
});

test("an empty library explains history capture and does not save or execute", () => {
  const harness = createHarness();
  assert.match(harness.control(".named-snippet-library").textContent!, /Save as snippet/);
  assert.equal(harness.editor.hidden, true);
  assert.equal(harness.runner.hidden, true);
  assert.equal(harness.error.hidden, true);
  assert.deepEqual(harness.executions, []);
  assert.equal(harness.storage.data.size, 0);
});

test("history capture opens a named shell editor, validates and persists only the snippet definition", () => {
  const harness = createHarness();
  harness.panel.saveFromHistory("systemctl status nginx", "posix");
  assert.equal(harness.editor.hidden, false);
  assert.equal(harness.focus, harness.name);
  assert.equal(harness.template.value, "systemctl status nginx");
  harness.name.value = "  Service status  ";
  harness.template.value = SNIPPET.template;
  harness.submitEditor();
  assert.deepEqual(harness.snippets, [{ ...SNIPPET, id: "snippet-1" }]);
  assert.equal(harness.editor.hidden, true);
  assert.equal(harness.template.value, "");
  assert.equal(harness.focus, harness.search);
  assert.match(harness.status.textContent!, /Saved Service status/);
  assert.deepEqual(harness.executions, []);
  assert.deepEqual(Object.keys(harness.snippets[0]).sort(), ["id", "name", "shell", "template"]);
});

test("saved snippets load on restart and search by name, template, or shell", () => {
  const storage = createStorage([SNIPPET, { id: "ps", name: "Files", template: "Get-ChildItem", shell: "powershell" }]);
  const first = createHarness({ storage });
  first.panel.dispose();
  const harness = createHarness({ storage });
  for (const query of ["Service", "systemctl", "Bash"]) {
    harness.search.value = query;
    harness.dispatch(harness.search, "input");
    assert.equal(harness.control("ul").children.length, 1);
    assert.ok(harness.button("Use Service status"));
  }
  harness.search.value = "not present";
  harness.dispatch(harness.search, "input");
  assert.equal(harness.control("ul").children.length, 0);
  assert.match(harness.control(".named-snippet-library").textContent!, /No snippets match/);
});

test("editing retains identity and replaces name, template and explicit shell mode", () => {
  const harness = createHarness({ initial: [SNIPPET] });
  harness.button("Edit Service status").click();
  assert.equal(harness.name.value, SNIPPET.name);
  harness.name.value = "Windows service";
  harness.template.value = "Get-Service {{service}}";
  harness.setShell("powershell");
  harness.submitEditor();
  assert.deepEqual(harness.snippets, [{ id: SNIPPET.id, name: "Windows service", template: "Get-Service {{service}}", shell: "powershell" }]);
});

for (const name of ["", "   ", "a".repeat(MAX_NAME_LENGTH + 1)]) {
  test(`invalid snippet name of length ${name.length} leaves storage unchanged`, () => {
    const harness = createHarness();
    harness.panel.saveFromHistory("uptime", "posix"); harness.name.value = name; harness.submitEditor();
    assert.equal(harness.error.hidden, false);
    assert.equal(harness.editor.hidden, false);
    assert.equal(harness.storage.data.size, 0);
  });
}

test("maximum-length name is accepted while malformed placeholders and multiline templates are rejected", () => {
  const harness = createHarness();
  harness.panel.saveFromHistory("uptime", "posix"); harness.name.value = "a".repeat(MAX_NAME_LENGTH); harness.submitEditor();
  assert.equal(harness.snippets[0].name.length, MAX_NAME_LENGTH);
  for (const template of ["echo {{unfinished", "printf first\nprintf second", "echo \"{{quoted}}\""]) {
    harness.panel.saveFromHistory(template, "posix"); harness.name.value = "Invalid"; harness.submitEditor();
    assert.equal(harness.error.hidden, false);
    assert.equal(harness.snippets.length, 1);
  }
});

test("duplicate names and persistence failures keep the editor and original saved data", () => {
  const harness = createHarness({ initial: [SNIPPET] });
  harness.panel.saveFromHistory("uptime", "posix"); harness.name.value = "service STATUS"; harness.submitEditor();
  assert.equal(harness.error.hidden, false);
  assert.deepEqual(harness.snippets, [SNIPPET]);
  harness.name.value = "Uptime";
  harness.storage.failWrites(new Error("Disk is full")); harness.submitEditor();
  assert.match(harness.error.textContent!, /Disk is full/);
  assert.equal(harness.editor.hidden, false);
  assert.equal(harness.template.value, "uptime");
});

test("Remove requires confirmation and never changes a cancelled or failed deletion", () => {
  const cancelled = createHarness({ initial: [SNIPPET], confirmRemoval: () => false });
  cancelled.button("Remove Service status").click();
  assert.deepEqual(cancelled.removals, [SNIPPET.name]);
  assert.deepEqual(cancelled.snippets, [SNIPPET]);
  const harness = createHarness({ initial: [SNIPPET] });
  harness.storage.failWrites(new Error("No storage")); harness.button("Remove Service status").click();
  assert.match(harness.error.textContent!, /No storage/);
  assert.deepEqual(harness.snippets, [SNIPPET]);
  harness.storage.failWrites(null); harness.button("Remove Service status").click();
  assert.deepEqual(harness.snippets, []);
});

test("Use prompts once per named parameter and only Review creates exact command and target preview", () => {
  const snippet = { ...SNIPPET, template: "printf {{service}} {{service}} {{path}}" };
  const harness = createHarness({ initial: [snippet] }); harness.use();
  assert.equal(harness.root.querySelectorAll(".named-snippet-fields input").length, 2);
  assert.equal(harness.parameter().maxLength, MAX_PARAMETER_LENGTH);
  assert.equal(harness.focus, harness.parameter());
  assert.deepEqual(harness.previews, []);
  assert.equal(harness.button("Run").disabled, true);
  harness.value("nginx; echo injected"); harness.value("/srv/my app", 1); harness.review();
  assert.deepEqual(harness.previews[0].values, { service: "nginx; echo injected", path: "/srv/my app" });
  assert.equal(harness.control(".named-snippet-output").textContent, "printf 'nginx; echo injected' 'nginx; echo injected' '/srv/my app'");
  assert.match(harness.control(".named-snippet-target").textContent!, /API · deploy@example.test:22/);
  assert.equal(harness.button("Run").disabled, false);
  assert.deepEqual(harness.executions, []);
});

test("parameter-free snippets still require Review before Insert or Run", () => {
  const harness = createHarness({ initial: [{ ...SNIPPET, template: "uptime" }] }); harness.use();
  assert.equal(harness.focus, harness.button("Review command"));
  harness.button("Run").click(); assert.equal(harness.executions.length, 0);
  harness.review(); assert.equal(harness.control(".named-snippet-output").textContent, "uptime");
  assert.equal(harness.executions.length, 0);
});

test("parameter changes and explicit invalidation erase preview without losing typed values", () => {
  const harness = createHarness({ initial: [SNIPPET] }); harness.use(); harness.value("nginx"); harness.review();
  harness.value("redis");
  assert.equal(harness.button("Run").disabled, true);
  assert.equal(harness.control(".named-snippet-output").textContent, "");
  harness.review(); harness.panel.invalidate();
  assert.equal(harness.parameter().value, "redis");
  assert.equal(harness.control(".named-snippet-preview").hidden, true);
});

test("refresh invalidates a changed target or prompt and preserves in-progress fields", () => {
  const harness = createHarness({ initial: [SNIPPET] }); harness.use(); harness.value("nginx"); harness.review();
  const field = harness.parameter();
  harness.invalidateTarget(); harness.panel.refresh();
  assert.equal(harness.parameter(), field);
  assert.equal(field.value, "nginx");
  assert.equal(harness.button("Run").disabled, true);
  assert.match(harness.status.textContent!, /Preview expired/);
  harness.review(); assert.equal(harness.error.hidden, false); assert.equal(harness.executions.length, 0);
});

test("a changed or deleted saved template cannot run an old preview", async () => {
  const harness = createHarness({ initial: [SNIPPET] }); harness.use(); harness.value("nginx"); harness.review();
  saveSnippet(harness.storage, harness.snippets, { ...SNIPPET, template: "systemctl stop {{service}}" });
  harness.button("Run").click(); await nextTurn();
  assert.equal(harness.executions.length, 0);
  assert.match(harness.error.textContent!, /preview expired/);
  harness.review(); assert.match(harness.error.textContent!, /snippet changed/);
});

test("Insert and Run consume the preview once and do not persist entered values", async () => {
  for (const run of [false, true]) {
    const harness = createHarness({ initial: [SNIPPET] }); harness.use(); harness.value("temporary-value"); harness.review();
    const before = harness.storage.getItem(STORAGE_KEY);
    harness.button(run ? "Run" : "Insert").click(); await nextTurn();
    assert.equal(harness.executions.length, 1);
    assert.equal(harness.executions[0].run, run);
    assert.equal(harness.executions[0].preview.command, "systemctl status 'temporary-value'");
    assert.equal(harness.button("Run").disabled, true);
    assert.equal(harness.storage.getItem(STORAGE_KEY), before);
    assert.equal(before!.includes("temporary-value"), false);
  }
});

test("duplicate clicks are blocked during native writes and rejection requires a fresh review", async () => {
  const pending = Promise.withResolvers<void>();
  const harness = createHarness({ initial: [SNIPPET], execute: async () => pending.promise });
  harness.use(); harness.value("nginx"); harness.review();
  harness.button("Run").click(); harness.button("Run").click(); harness.review();
  assert.equal(harness.executions.length, 1);
  assert.equal(harness.root.getAttribute("aria-busy"), "true");
  assert.equal(harness.parameter().disabled, true);
  pending.reject(new Error("SSH write failed")); await nextTurn();
  assert.match(harness.error.textContent!, /SSH write failed/);
  assert.equal(harness.root.getAttribute("aria-busy"), "false");
  assert.equal(harness.button("Run").disabled, true);
});

test("preview and validity failures are visible and never execute", () => {
  const failure = createHarness({ initial: [SNIPPET], preview: () => { throw new Error("Prompt is busy"); } });
  failure.use(); failure.value("nginx"); failure.review();
  assert.match(failure.error.textContent!, /Prompt is busy/); assert.equal(failure.button("Run").disabled, true);
  const invalid = createHarness({ initial: [SNIPPET], isPreviewValid: () => false });
  invalid.use(); invalid.value("nginx"); invalid.review();
  assert.match(invalid.error.textContent!, /terminal changed/); assert.equal(invalid.executions.length, 0);
});

test("library navigation, Cancel, Escape, and disposal discard ephemeral values and drafts", () => {
  const harness = createHarness({ initial: [SNIPPET] }); harness.use(); harness.value("private-value"); harness.review();
  const field = harness.parameter(); harness.panel.showLibrary();
  assert.equal(field.value, ""); assert.equal(harness.root.textContent!.includes("private-value"), false);
  harness.panel.saveFromHistory("echo draft", "powershell"); harness.name.value = "Draft";
  const escaped = harness.escape(); assert.equal(escaped.defaultPrevented, true); assert.equal(harness.template.value, "");
  harness.panel.saveFromHistory("echo draft", "powershell"); harness.button("Cancel").click();
  assert.equal(harness.name.value, ""); assert.equal(harness.focus, harness.search);
  harness.use(); harness.value("private-value"); const disposedField = harness.parameter();
  harness.panel.dispose(); harness.panel.dispose(); harness.panel.refresh(); harness.panel.saveFromHistory("uptime", "posix");
  assert.equal(disposedField.value, ""); assert.equal(harness.root.children.length, 0);
});

test("Cmd displays its literal-value restriction and invalid parameter values cannot preview", () => {
  const harness = createHarness({ initial: [{ ...SNIPPET, template: "dir {{path}}", shell: "cmd" }] }); harness.use();
  assert.equal(harness.control(".named-snippet-runner").textContent!.includes("without spaces"), true);
  harness.value("C:\\My folder"); harness.review();
  assert.equal(harness.error.hidden, false); assert.equal(harness.button("Run").disabled, true);
  harness.value("C:\\Projects"); harness.review();
  assert.equal(harness.control(".named-snippet-output").textContent, "dir C:\\Projects");
});

test("hostile names, targets, parameter values and command previews remain literal DOM text", () => {
  const snippet = { ...SNIPPET, name: '<img src=x onerror="alert(1)">' };
  const harness = createHarness({ initial: [snippet], preview: source => ({ command: "<script>alert(1)</script>", targetLabel: "<img src=x>", shell: source.shell, token: {} }) });
  assert.equal(harness.root.querySelector("img"), null); harness.use(snippet.name); harness.value("<script>"); harness.review();
  assert.equal(harness.root.querySelector("script"), null);
  assert.equal(harness.root.querySelector("img"), null);
  assert.equal(harness.control(".named-snippet-output").textContent, "<script>alert(1)</script>");
});

test("corrupt storage disables mutations and a successful refresh recovers without overwriting it", () => {
  const storage = createStorage(); storage.data.set(STORAGE_KEY, "broken");
  const harness = createHarness({ storage });
  harness.panel.saveFromHistory("uptime", "posix");
  assert.equal(harness.editor.hidden, true); assert.equal(harness.error.hidden, false);
  assert.equal(storage.data.get(STORAGE_KEY), "broken");
  storage.data.delete(STORAGE_KEY); harness.panel.refresh(); harness.panel.saveFromHistory("uptime", "posix");
  assert.equal(harness.editor.hidden, false); assert.equal(harness.error.hidden, true);
});

test("read failure during an active preview disables execution without discarding parameter input", () => {
  const harness = createHarness({ initial: [SNIPPET] }); harness.use(); harness.value("nginx"); harness.review();
  harness.storage.failReads(new Error("Storage unavailable")); harness.panel.refresh();
  assert.match(harness.error.textContent!, /Storage unavailable/);
  assert.equal(harness.button("Run").disabled, true); assert.equal(harness.parameter().value, "nginx");
});

test("null history data and unsupported shell modes produce visible errors", () => {
  const harness = createHarness();
  harness.panel.saveFromHistory(null as unknown as string, "posix"); assert.equal(harness.error.hidden, false);
  harness.panel.saveFromHistory("uptime", "other" as SnippetShell); assert.equal(harness.error.hidden, false);
  assert.equal(harness.editor.hidden, true);
});
