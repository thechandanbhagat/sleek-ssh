import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { renderNamedSnippetList } from "../src/named-snippet-list.ts";
import type { NamedSnippet } from "../src/named-snippets.ts";

const FOLDER = { host: "api.test", port: 22, username: "deploy", path: "/srv/app" };
const SNIPPET: NamedSnippet = { id: "logs", name: "App logs", template: "tail app.log", shell: "posix" };

test("compact rows make the name usable and provide labeled icon actions and a scope button", () => {
  const { document } = parseHTML("<ul></ul>");
  const list = document.querySelector("ul")!;
  const actions: string[] = [];
  renderNamedSnippetList({ list, snippets: [SNIPPET], folder: FOLDER,
    use: snippet => { actions.push("use:" + snippet.id); }, edit: () => { actions.push("edit"); },
    remove: () => { actions.push("remove"); }, toggleScope: () => { actions.push("scope"); },
  });
  assert.equal(list.querySelector(".named-snippet-name")!.textContent, SNIPPET.name);
  for (const label of ["Use App logs", "Edit App logs", "Remove App logs", "Make App logs folder-specific"]) {
    const button = [...list.querySelectorAll("button")].find(element => element.getAttribute("aria-label") === label);
    assert.ok(button); button.click();
  }
  assert.deepEqual(actions, ["use:logs", "edit", "remove", "scope"]);
  assert.equal(list.querySelectorAll(".named-snippet-actions .btn").length, 0);
});

test("scope and availability remain clear without an SSH folder and user text stays literal", () => {
  const { document } = parseHTML("<ul></ul>"); const list = document.querySelector("ul")!;
  const options = { list, snippets: [{ ...SNIPPET, name: "<img src=x>", folder: FOLDER }], folder: null,
    use() {}, edit() {}, remove() {}, toggleScope() {}, };
  renderNamedSnippetList(options);
  assert.equal(list.querySelector<HTMLButtonElement>(".named-snippet-use")!.disabled, true);
  assert.equal(list.querySelector<HTMLButtonElement>(".named-snippet-scope")!.disabled, false);
  assert.equal(list.querySelector(".named-snippet-scope")!.textContent, "Folder");
  assert.equal(list.querySelector(".named-snippet-folder-path")!.textContent, FOLDER.path);
  assert.equal(list.querySelector("img"), null);
  renderNamedSnippetList({ ...options, snippets: [SNIPPET] });
  assert.equal(list.querySelector<HTMLButtonElement>(".named-snippet-scope")!.disabled, true);
  assert.equal(list.querySelector<HTMLButtonElement>(".named-snippet-use")!.disabled, false);
  renderNamedSnippetList({ ...options, snippets: [] }); assert.equal(list.children.length, 0);
});
