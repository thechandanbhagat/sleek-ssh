import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const APPLICATION_SOURCE = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const PROFILE_SOURCE = APPLICATION_SOURCE.split("// --- PROFILE STORAGE & LIST ---")[1].split("// --- SSH KEYS MANAGER ---")[0];
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

type ClickHandler = (event: { preventDefault(): void; target: ElementMock }) => void;

class ElementMock {
  tagName: string;
  classes = new Set<string>();
  children: ElementMock[] = [];
  parent: ElementMock | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, ClickHandler[]>();
  textContent = "";
  markup = "";

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }

  get className() {
    return [...this.classes].join(" ");
  }

  set className(value: string) {
    this.classes.clear();
    value.split(/\s+/).filter(Boolean).forEach(name => this.classes.add(name));
  }

  classList = {
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => {
      const enabled = force ?? !this.classes.has(name);
      if (enabled) this.classes.add(name);
      else this.classes.delete(name);
      return enabled;
    }
  };

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, handler: ClickHandler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  click() {
    for (const handler of this.listeners.get("click") ?? []) {
      handler({ preventDefault() {}, target: this });
    }
  }

  appendChild(child: ElementMock) {
    if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  set innerHTML(value: string) {
    this.markup = value;
    for (const child of this.children) child.parent = null;
    this.children = [];
    if (!value) return;
    for (const child of parseHtml(value)) this.appendChild(child);
  }

  get innerHTML() {
    return this.markup;
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string) {
    const matches: ElementMock[] = [];
    const visit = (element: ElementMock) => {
      if (element.classes.has(selector.slice(1))) matches.push(element);
      element.children.forEach(visit);
    };
    this.children.forEach(visit);
    return matches;
  }
}

function parseHtml(html: string) {
  const root = new ElementMock("#root");
  const stack = [root];
  const pattern = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)>|<([a-zA-Z0-9]+)([^>]*?)(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    if (match[0].startsWith("<!--")) continue;
    if (match[1]) {
      const tag = match[1].toLowerCase();
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tagName === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    if (match[2]) {
      const tag = match[2].toLowerCase();
      const element = new ElementMock(tag);
      for (const attribute of match[3].matchAll(/\s+([^\s=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
        const name = attribute[1];
        const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
        if (name === "class") element.className = value;
        else element.setAttribute(name, value);
      }
      stack[stack.length - 1].appendChild(element);
      if (match[4] !== "/" && !VOID_TAGS.has(tag)) stack.push(element);
      continue;
    }
    const text = match[5].replace(/\s+/g, " ").trim();
    if (text) stack[stack.length - 1].textContent += text;
  }
  return root.children;
}

function createProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: "profile-1",
    name: "App",
    host: "app.example",
    port: 22,
    username: "admin",
    use_password: false,
    namespace: "Lab",
    ...overrides
  };
}

function createHarness(profiles: Array<Record<string, unknown>> = [createProfile()], savedFolders: Record<string, string> = {}) {
  const storage = new Map<string, string>(Object.entries(savedFolders));
  const profilesList = new ElementMock("div");
  const context = createContext({
    savedProfiles: profiles,
    profilesList,
    NAMESPACE_SEPARATOR: "/",
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    },
    document: {
      createElement: (tag: string) => new ElementMock(tag),
      querySelectorAll: (selector: string) => profilesList.querySelectorAll(selector)
    },
    escapeHtml: (value: unknown) => String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;")
  });
  runInContext(PROFILE_SOURCE, context);
  const render = () => runInContext("renderProfiles()", context);
  return { profilesList, storage, render };
}

function folderByName(root: ElementMock, name: string) {
  return root.querySelectorAll(".profile-folder").find(folder => folder.querySelector(".folder-name")?.textContent === name) ?? null;
}

function folderSnapshot(folder: ElementMock) {
  return {
    collapsed: folder.classList.contains("collapsed"),
    expanded: folder.querySelector(".folder-header")?.getAttribute("aria-expanded"),
    label: folder.querySelector(".folder-state")?.textContent
  };
}

test("saved session folders show and restore expanded or collapsed state", () => {
  const harness = createHarness(
    [
      createProfile({ id: "lab", name: "Lab host", namespace: "Lab" }),
      createProfile({ id: "europe", name: "Europe host", namespace: "Production/Europe" })
    ],
    { folder_collapsed_Production: "true" }
  );

  harness.render();

  const lab = folderByName(harness.profilesList, "Lab");
  const production = folderByName(harness.profilesList, "Production");
  const europe = folderByName(harness.profilesList, "Europe");
  assert.ok(lab && production && europe);
  assert.deepEqual(folderSnapshot(lab), { collapsed: false, expanded: "true", label: "Expanded" });
  assert.deepEqual(folderSnapshot(production), { collapsed: true, expanded: "false", label: "Collapsed" });
  assert.deepEqual(folderSnapshot(europe), { collapsed: false, expanded: "true", label: "Expanded" });
  assert.equal(production.querySelector(".folder-header")?.getAttribute("aria-controls"), production.querySelector(".folder-content")?.getAttribute("id"));
  assert.equal(harness.storage.has("folder_collapsed_Lab"), false);

  lab.querySelector(".folder-header")?.click();
  assert.deepEqual(folderSnapshot(lab), { collapsed: true, expanded: "false", label: "Collapsed" });
  assert.equal(harness.storage.get("folder_collapsed_Lab"), "true");
  assert.deepEqual(folderSnapshot(europe), { collapsed: false, expanded: "true", label: "Expanded" });

  harness.render();
  const restoredLab = folderByName(harness.profilesList, "Lab");
  const restoredEurope = folderByName(harness.profilesList, "Europe");
  assert.ok(restoredLab && restoredEurope);
  assert.deepEqual(folderSnapshot(restoredLab), { collapsed: true, expanded: "false", label: "Collapsed" });
  assert.deepEqual(folderSnapshot(restoredEurope), { collapsed: false, expanded: "true", label: "Expanded" });

  restoredLab.querySelector(".folder-header")?.click();
  assert.deepEqual(folderSnapshot(restoredLab), { collapsed: false, expanded: "true", label: "Expanded" });
  assert.equal(harness.storage.get("folder_collapsed_Lab"), "false");
});

test("sessions without a namespace stay directly in the saved session list", () => {
  const harness = createHarness([createProfile({ name: "Direct", namespace: null })]);
  harness.render();
  assert.equal(harness.profilesList.querySelector(".profile-folder"), null);
  assert.equal(harness.profilesList.querySelector(".profile-name")?.textContent, "Direct");
});
