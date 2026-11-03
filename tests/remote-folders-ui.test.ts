import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHTML } from "linkedom";
import { initRemoteFoldersForm } from "../src/remote-folders-form.ts";
import { initRemoteFolderDialog } from "../src/remote-folder-dialog.ts";
import { loadRemoteFolders, saveRemoteFolders, REMOTE_FOLDER_LIMITS } from "../src/remote-folders.ts";

const HTML = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
function harness() {
  const { document, window } = parseHTML(HTML);
  const values = new Map<string, string>();
  let failure = false;
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) { if (failure) throw new Error("Storage full"); values.set(key, value); },
  };
  const control = <T extends HTMLElement>(selector: string): T => {
    const found = document.querySelector<T>(selector); assert.ok(found, selector); return found;
  };
  const form = initRemoteFoldersForm(control("#prof-remote-folders-settings"), storage);
  const root = control<HTMLDialogElement>("#remote-folder-dialog");
  root.showModal = () => root.setAttribute("open", "");
  root.close = () => root.removeAttribute("open");
  let saved = 0;
  const dialog = initRemoteFolderDialog({ root, storage, onSaved() { saved += 1; } });
  return {
    document, window, control, values, storage, form, dialog, root,
    get saved() { return saved; },
    failWrites() { failure = true; },
    submit() { control("#remote-folder-dialog form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); },
  };
}

test("host folder form loads the selected host, adds labeled rows and persists edits", () => {
  const h = harness();
  const settings = { startPath: "/app", folders: [{ name: "Logs", path: "/var/log" }] };
  saveRemoteFolders(h.storage, "api", settings);
  h.form.load("api");
  assert.deepEqual(h.form.read(), settings);
  h.control<HTMLButtonElement>("#prof-add-remote-folder").click();
  const inputs = [...h.document.querySelectorAll<HTMLInputElement>(".remote-folder-row input")];
  inputs.slice(-2)[0].value = "Config"; inputs.slice(-2)[1].value = "~/config";
  inputs.forEach(input => assert.ok(h.document.querySelector(`label[for="${input.id}"]`)));
  h.form.save("api", h.form.read());
  assert.equal(loadRemoteFolders(h.storage, "api").folders.length, 2);
  h.form.load("other"); assert.deepEqual(h.form.read(), { startPath: "", folders: [] });
  h.form.load("api"); h.control<HTMLButtonElement>(".remote-folder-row button").click();
  assert.equal(h.form.read().folders[0].name, "Config");
  h.form.load(null); assert.deepEqual(h.form.read(), { startPath: "", folders: [] });
  h.form.dispose(); assert.throws(() => h.form.read(), /could not be loaded/);
});

test("form limits, invalid data and disposal prevent accidental folder loss", () => {
  const h = harness();
  saveRemoteFolders(h.storage, "api", { startPath: "", folders: Array.from({ length: REMOTE_FOLDER_LIMITS.folders }, (_, i) => ({ name: String(i), path: "/app" })) });
  h.form.load("api");
  assert.equal(h.control<HTMLButtonElement>("#prof-add-remote-folder").disabled, true);
  h.control<HTMLButtonElement>(".remote-folder-row button").click();
  assert.equal(h.control<HTMLButtonElement>("#prof-add-remote-folder").disabled, false);
  h.values.set([...h.values.keys()][0], "null");
  assert.throws(() => h.form.load("api")); assert.throws(() => h.form.read(), /could not be loaded/);
  h.form.dispose(); h.control<HTMLButtonElement>("#prof-add-remote-folder").click();
  assert.equal(h.document.querySelectorAll(".remote-folder-row").length, 0);
});

test("save folder dialog stores the location and optionally starts future connections there", () => {
  const h = harness();
  h.dialog.open("api", "API · deploy@api.test:22", "/srv/app");
  assert.equal(h.control<HTMLInputElement>("#remote-folder-name").value, "app");
  assert.equal(h.control<HTMLInputElement>("#remote-folder-path").value, "/srv/app");
  h.control<HTMLInputElement>("#remote-folder-start").checked = true;
  h.submit();
  assert.equal(h.saved, 1); assert.equal(h.root.hasAttribute("open"), false);
  assert.deepEqual(loadRemoteFolders(h.storage, "api"), { startPath: "/srv/app", folders: [{ name: "app", path: "/srv/app" }] });
  h.dialog.open("api", "API", "/var/log"); h.submit();
  assert.equal(loadRemoteFolders(h.storage, "api").startPath, "/srv/app");
  assert.deepEqual(loadRemoteFolders(h.storage, "other"), { startPath: "", folders: [] });
});

test("dialog validation and storage errors remain visible; cancel and dispose never save", () => {
  const h = harness();
  h.dialog.open("api", "API"); h.submit();
  assert.equal(h.control<HTMLElement>("#remote-folder-error").hidden, false); assert.equal(h.saved, 0);
  h.control<HTMLInputElement>("#remote-folder-path").value = "/app";
  h.control<HTMLInputElement>("#remote-folder-name").value = "App";
  h.failWrites(); h.submit();
  assert.match(h.control("#remote-folder-error").textContent!, /Storage full/);
  assert.equal(h.root.hasAttribute("open"), true);
  h.control<HTMLButtonElement>("[data-remote-folder-cancel]").click();
  assert.equal(h.root.hasAttribute("open"), false); assert.equal(h.saved, 0);
  h.dialog.dispose(); assert.throws(() => h.dialog.open("api", "API"), /no longer available/);
  h.submit(); assert.equal(h.saved, 0);
});
