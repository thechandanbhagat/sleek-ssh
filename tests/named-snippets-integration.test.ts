import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { initNamedSnippetsIntegration, type SnippetSession } from "../src/named-snippets-integration.ts";
import { loadSnippets, saveSnippet, type NamedSnippet } from "../src/named-snippets.ts";

const SNIPPET: NamedSnippet = Object.freeze({ id: "service", name: "Service status", template: "systemctl status {{service}}", shell: "posix" });
type MutableSession = { -readonly [K in keyof SnippetSession]: SnippetSession[K] };
type Submission = Readonly<{ command: string; run: boolean; token: object }>;

function createSession(overrides: Partial<MutableSession> = {}) {
  let promptToken: object | null = Object.freeze({});
  let focusCount = 0;
  let beforeWrite: (() => void) | null = null;
  const submissions: Submission[] = [];
  const controller = {
    getPromptToken: () => promptToken,
    async sendSnippet(command: string, run: boolean, token: object, write: (text: string) => Promise<void>) {
      if (token !== promptToken || promptToken === null) throw new Error("The prompt changed.");
      promptToken = null;
      submissions.push({ command, run, token });
      beforeWrite?.();
      await write(command + (run ? "\r" : ""));
    },
  };
  const session: MutableSession = {
    id: "tab-api", kind: "ssh", name: "API", host: "api.example.test", connectionId: "transport-1",
    connectionProfile: { username: "deploy", port: 22 }, isClosed: false, isClosing: false, isConnecting: false,
    term: { focus() { focusCount += 1; } }, commandHistory: controller as SnippetSession["commandHistory"], ...overrides,
  };
  return {
    session, submissions,
    get focusCount() { return focusCount; },
    prompt() { promptToken = Object.freeze({}); },
    blockPrompt() { promptToken = null; },
    beforeWrite(callback: () => void) { beforeWrite = callback; },
  };
}

function createStorage(initial: readonly NamedSnippet[]) {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
  initial.forEach(snippet => saveSnippet(storage, loadSnippets(storage), snippet));
  return storage;
}

function createHarness(configuration: {
  readonly target?: ReturnType<typeof createSession>;
  readonly initial?: readonly NamedSnippet[];
  readonly write?: (session: SnippetSession, text: string) => Promise<void>;
} = {}) {
  const { document, window } = parseHTML('<html><body><div id="named-snippets-root"></div></body></html>');
  const root = document.getElementById("named-snippets-root") as HTMLElement;
  const target = configuration.target ?? createSession();
  let session: SnippetSession | null = target.session;
  const storage = createStorage(configuration.initial ?? [SNIPPET]);
  const writes: Array<{ session: SnippetSession; text: string }> = [];
  const integration = initNamedSnippetsIntegration({
    root, storage, getSession: () => session,
    async writeText(targetSession, text) { writes.push({ session: targetSession, text }); await configuration.write?.(targetSession, text); },
  });
  const control = <T extends HTMLElement>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    assert.ok(element, `Missing ${selector}`);
    return element;
  };
  const button = (name: string): HTMLButtonElement => {
    const node = [...root.querySelectorAll<HTMLButtonElement>("button")]
      .find(candidate => candidate.getAttribute("aria-label") === name || candidate.textContent === name);
    assert.ok(node, `Missing ${name}`);
    return node;
  };
  const dispatch = (element: HTMLElement, name: string) => element.dispatchEvent(new window.Event(name, { bubbles: true, cancelable: true }));
  return {
    root, integration, storage, target, writes, control, button, dispatch,
    error: control<HTMLElement>('[role="alert"]'),
    status: control<HTMLElement>('[role="status"]'),
    preview: control<HTMLElement>(".named-snippet-preview"),
    setSession(next: SnippetSession | null) { session = next; },
    use(name = SNIPPET.name) { button(`Use ${name}`).click(); },
    value(value: string) { const field = control<HTMLInputElement>("#named-snippet-parameter-0"); field.value = value; dispatch(field, "input"); },
    review() { dispatch(control(".named-snippet-runner"), "submit"); },
  };
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

const FOLDER = Object.freeze({ host: "api.example.test", port: 22, username: "deploy", path: "/srv/app" });

test("folder-specific snippets bind to the terminal working folder and survive scope toggles", () => {
  const target = createSession({ terminalPath: FOLDER.path });
  const h = createHarness({ target });
  h.button(`Make ${SNIPPET.name} folder-specific`).click();
  assert.deepEqual(loadSnippets(h.storage)[0].folder, FOLDER);
  h.integration.openSnippet(SNIPPET.id); h.value("worker"); h.review();
  assert.equal(h.button("Run").disabled, false);
  h.target.session.terminalPath = "/other"; h.integration.refresh();
  assert.equal(h.button("Run").disabled, true); assert.deepEqual(h.writes, []);
  h.integration.showLibrary();
  assert.equal(h.button(`Use ${SNIPPET.name}`).disabled, true);
  h.button(`Make ${SNIPPET.name} shared`).click();
  assert.equal(loadSnippets(h.storage)[0].folder, undefined);
});

test("folder changes just before a write cannot execute a reviewed folder snippet", async () => {
  const target = createSession({ terminalPath: FOLDER.path });
  const h = createHarness({ target, initial: [{ ...SNIPPET, folder: FOLDER }] });
  h.use(); h.value("nginx"); h.review();
  target.beforeWrite(() => { target.session.terminalPath = "/other"; });
  h.button("Run").click(); await nextTurn();
  assert.deepEqual(h.writes, []);
  assert.match(h.error.textContent!, /target terminal changed/);
});

test("reviewing a folder snippet in another server or sibling folder stays blocked", () => {
  for (const overrides of [{ terminalPath: "/srv/app-old" }, { terminalPath: FOLDER.path, host: "other.test" }]) {
    const h = createHarness({ target: createSession(overrides), initial: [{ ...SNIPPET, folder: FOLDER }] });
    h.integration.openSnippet(SNIPPET.id);
    assert.match(h.error.textContent!, /server and folder/);
    assert.deepEqual(h.writes, []);
  }
});

test("opening a snippet from a session palette binds its preview to that session", () => {
  const h = createHarness();
  h.integration.openSnippet(SNIPPET.id); h.value("worker"); h.review();
  assert.equal(h.control(".named-snippet-output").textContent, "systemctl status 'worker'");
  assert.match(h.control(".named-snippet-target").textContent!, /API/);
  assert.deepEqual(h.writes, []);
  assert.throws(() => h.integration.openSnippet("missing"), /no longer saved/);
  h.integration.dispose(); h.integration.openSnippet(SNIPPET.id);
  assert.deepEqual(h.writes, []);
});

test("snippet review binds exact command, target and explicit shell mode without sending", () => {
  const harness = createHarness();
  harness.use(); harness.value("worker service"); harness.review();
  assert.equal(harness.preview.hidden, false);
  assert.equal(harness.control(".named-snippet-output").textContent, "systemctl status 'worker service'");
  assert.equal(harness.control(".named-snippet-target").textContent, "Target: API · deploy@api.example.test:22");
  assert.equal(harness.control(".named-snippet-preview .small-text").textContent, "Shell mode: Bash / Zsh");
  assert.equal(harness.button("Run").disabled, false);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.target.submissions, []);
  harness.integration.refresh();
  assert.equal(harness.control<HTMLInputElement>("#named-snippet-parameter-0").value, "worker service");
  assert.equal(harness.preview.hidden, false);
});

test("Insert and Run submit once to the reviewed session with the correct terminal bytes", async () => {
  for (const run of [false, true]) {
    const harness = createHarness();
    harness.use(); harness.value("nginx"); harness.review();
    harness.button(run ? "Run" : "Insert").click();
    await nextTurn();
    assert.equal(harness.target.submissions.length, 1);
    assert.deepEqual(harness.target.submissions[0], { command: "systemctl status 'nginx'", run, token: harness.target.submissions[0].token });
    assert.deepEqual(harness.writes, [{ session: harness.target.session, text: "systemctl status 'nginx'" + (run ? "\r" : "") }]);
    assert.equal(harness.preview.hidden, true);
    assert.equal(harness.button("Run").disabled, true);
    assert.equal(harness.target.focusCount, 1);
  }
});

test("same-host and same-shell panes have distinct preview labels and send only to the reviewed pane", async () => {
  for (const override of [
    {},
    { kind: "local", name: "PowerShell", shell: "powershell", isReady: true, connectionId: null },
  ]) {
    const first = createSession({ ...override, paneLabel: "Pane 1" });
    const second = createSession({ ...override, id: "pane-2", paneLabel: "Pane 2", connectionId: override.kind === "local" ? null : "transport-2" });
    const snippet: NamedSnippet = override.kind === "local"
      ? { id: "message", name: "Print message", template: "Write-Output {{service}}", shell: "powershell" } : SNIPPET;
    const harness = createHarness({ target: first, initial: [snippet] });
    const expectedSession = override.kind === "local" ? "PowerShell" : "API · deploy@api.example.test:22";
    harness.use(snippet.name); harness.value("worker"); harness.review();
    assert.equal(harness.control(".named-snippet-target").textContent, `Target: Pane 1 · ${expectedSession}`);
    harness.setSession(second.session); harness.integration.refresh();
    assert.equal(harness.preview.hidden, true);
    harness.review();
    assert.equal(harness.control(".named-snippet-target").textContent, `Target: Pane 2 · ${expectedSession}`);
    harness.button("Run").click(); await nextTurn();
    assert.equal(harness.writes.length, 1);
    assert.equal(harness.writes[0].session, second.session);
    assert.deepEqual(first.submissions, []);
    assert.equal(second.submissions.length, 1);
    assert.equal(first.focusCount, 0);
    assert.equal(second.focusCount, 1);
  }
});

test("focus away and back between identical panes requires a fresh preview", async () => {
  const first = createSession({ paneLabel: "Pane 1" });
  const second = createSession({ id: "pane-2", paneLabel: "Pane 2", connectionId: "transport-2" });
  const harness = createHarness({ target: first });
  harness.use(); harness.value("worker"); harness.review();
  harness.setSession(second.session); harness.integration.refresh();
  harness.setSession(first.session); harness.integration.refresh();
  harness.button("Run").click(); await nextTurn();
  assert.equal(harness.preview.hidden, true);
  assert.deepEqual(harness.writes, []);
  harness.review(); harness.button("Run").click(); await nextTurn();
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].session, first.session);
});

test("changing a pane label expires its preview, even before refresh or after the label is restored", async () => {
  for (const update of ["refresh", "before-run", "restore-label"] as const) {
    const harness = createHarness({ target: createSession({ paneLabel: "Pane 2" }) });
    harness.use(); harness.value("worker"); harness.review();
    harness.target.session.paneLabel = undefined;
    if (update !== "before-run") harness.integration.refresh();
    if (update === "restore-label") {
      harness.target.session.paneLabel = "Pane 2";
      harness.integration.refresh();
    }
    harness.button("Run").click(); await nextTurn();
    assert.deepEqual(harness.writes, [], update);
    assert.equal(harness.preview.hidden, true, update);
    harness.review();
    const prefix = update === "restore-label" ? "Pane 2 · " : "";
    assert.equal(harness.control(".named-snippet-target").textContent, `Target: ${prefix}API · deploy@api.example.test:22`);
  }
});

test("an empty pane label keeps the unsplit preview label", () => {
  const harness = createHarness({ target: createSession({ paneLabel: "" }) });
  harness.use(); harness.value("worker"); harness.review();
  assert.equal(harness.control(".named-snippet-target").textContent, "Target: API · deploy@api.example.test:22");
});

test("tab switches and switching back expire a preview even when the original prompt stays empty", async () => {
  const harness = createHarness();
  const other = createSession({ id: "other", name: "Other", connectionId: "transport-2" });
  harness.use(); harness.value("nginx"); harness.review();
  harness.setSession(other.session); harness.integration.refresh();
  harness.setSession(harness.target.session); harness.integration.refresh();
  assert.equal(harness.preview.hidden, true);
  assert.equal(harness.button("Run").disabled, true);
  harness.button("Run").click(); await nextTurn();
  assert.deepEqual(harness.writes, []);
  harness.review(); harness.button("Run").click(); await nextTurn();
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].session, harness.target.session);
});

test("reconnecting an existing tab expires its old preview and binds the new transport on review", async () => {
  const harness = createHarness();
  harness.use(); harness.value("nginx"); harness.review();
  harness.target.session.connectionId = "transport-new";
  harness.integration.refresh();
  assert.equal(harness.preview.hidden, true);
  harness.button("Run").click(); await nextTurn();
  assert.deepEqual(harness.writes, []);
  harness.review(); harness.button("Run").click(); await nextTurn();
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].session.connectionId, "transport-new");
});

test("replaced sessions, terminals or prompt controllers cannot inherit a preview", async () => {
  const replacements = [
    (harness: ReturnType<typeof createHarness>) => { harness.setSession({ ...harness.target.session }); },
    (harness: ReturnType<typeof createHarness>) => { harness.target.session.term = { focus() {} }; },
    (harness: ReturnType<typeof createHarness>) => { harness.target.session.commandHistory = createSession().session.commandHistory; },
  ];
  for (const replace of replacements) {
    const harness = createHarness();
    harness.use(); harness.value("nginx"); harness.review();
    replace(harness); harness.integration.refresh();
    assert.equal(harness.preview.hidden, true);
    harness.button("Run").click(); await nextTurn();
    assert.deepEqual(harness.writes, []);
  }
});

test("Run rechecks a changed target even before the next UI refresh", async () => {
  const harness = createHarness();
  harness.use(); harness.value("nginx"); harness.review();
  harness.setSession(createSession({ id: "other", connectionId: "other" }).session);
  harness.button("Run").click(); await nextTurn();
  assert.deepEqual(harness.writes, []);
  assert.equal(harness.error.hidden, false);
  assert.match(harness.error.textContent!, /preview expired/);
});

test("connection, readiness and prompt loss prevent preview and execution", async () => {
  const unavailable = [
    createSession({ isClosed: true }), createSession({ isClosing: true }), createSession({ isConnecting: true }),
    createSession({ connectionId: null }), createSession({ kind: "settings", connectionId: "unused" }),
    createSession({ kind: "local", shell: "powershell", isReady: false }), createSession({ commandHistory: undefined }),
  ];
  for (const target of unavailable) {
    const harness = createHarness({ target });
    harness.use(); harness.value("nginx"); harness.review();
    assert.equal(harness.preview.hidden, true);
    assert.equal(harness.button("Run").disabled, true);
    assert.match(harness.error.textContent!, /connected terminal with an empty, ready shell prompt/);
    assert.deepEqual(harness.writes, []);
  }
  const harness = createHarness();
  harness.setSession(null);
  harness.use(); harness.value("nginx"); harness.review();
  assert.equal(harness.preview.hidden, true);
  harness.setSession(harness.target.session); harness.review();
  harness.target.blockPrompt(); harness.integration.refresh();
  assert.equal(harness.preview.hidden, true);
  harness.review();
  assert.match(harness.error.textContent!, /empty, ready shell prompt/);
  harness.target.prompt(); harness.button("Run").click(); await nextTurn();
  assert.deepEqual(harness.writes, []);
});

test("a fresh empty prompt cannot revive a preview from before command entry", async () => {
  const harness = createHarness();
  harness.use(); harness.value("nginx"); harness.review();
  harness.target.prompt(); harness.integration.refresh();
  assert.equal(harness.preview.hidden, true);
  harness.button("Run").click(); await nextTurn();
  assert.deepEqual(harness.writes, []);
  harness.review(); harness.button("Run").click(); await nextTurn();
  assert.equal(harness.writes.length, 1);
});

test("a lost connection invalidates a preview permanently even if the same session becomes ready again", async () => {
  const harness = createHarness();
  harness.use(); harness.value("nginx"); harness.review();
  harness.target.session.isClosed = true; harness.integration.refresh();
  harness.target.session.isClosed = false; harness.integration.refresh();
  harness.button("Run").click(); await nextTurn();
  assert.deepEqual(harness.writes, []);
  assert.equal(harness.preview.hidden, true);
});

test("the writer checks its pinned transport again immediately before sending", async () => {
  const harness = createHarness();
  harness.use(); harness.value("nginx"); harness.review();
  harness.target.beforeWrite(() => { harness.target.session.connectionId = "reconnected-during-submit"; });
  harness.button("Run").click(); await nextTurn();
  assert.deepEqual(harness.writes, []);
  assert.match(harness.error.textContent!, /target terminal changed/);
});

test("the writer rejects a pane relabeled while the prompt token is being consumed", async () => {
  const harness = createHarness({ target: createSession({ paneLabel: "Pane 2" }) });
  harness.use(); harness.value("worker"); harness.review();
  harness.target.beforeWrite(() => { harness.target.session.paneLabel = "Pane 1"; });
  harness.button("Run").click(); await nextTurn();
  assert.deepEqual(harness.writes, []);
  assert.match(harness.error.textContent!, /target terminal changed/);
  assert.equal(harness.target.focusCount, 0);
});

test("write rejection stays visible and retry requires a new prompt and explicit review", async () => {
  let fail = true;
  const harness = createHarness({ write: async () => { if (fail) throw new Error("SSH write failed"); } });
  harness.use(); harness.value("nginx"); harness.review();
  harness.button("Run").click(); await nextTurn();
  assert.match(harness.error.textContent!, /SSH write failed/);
  assert.equal(harness.preview.hidden, true);
  assert.equal(harness.target.focusCount, 0);
  fail = false; harness.target.prompt(); harness.button("Run").click(); await nextTurn();
  assert.equal(harness.writes.length, 1);
  harness.review(); harness.button("Run").click(); await nextTurn();
  assert.equal(harness.writes.length, 2);
  assert.equal(harness.error.hidden, true);
  assert.equal(harness.target.focusCount, 1);
});

test("a pending submission blocks duplicate clicks and does not focus a different tab on completion", async () => {
  const completion = Promise.withResolvers<void>();
  const harness = createHarness({ write: () => completion.promise });
  harness.use(); harness.value("nginx"); harness.review();
  harness.button("Run").click(); harness.button("Run").click(); harness.button("Insert").click();
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.root.getAttribute("aria-busy"), "true");
  harness.setSession(createSession({ id: "other" }).session); harness.integration.refresh();
  completion.resolve(); await nextTurn();
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.target.focusCount, 0);
  assert.equal(harness.root.getAttribute("aria-busy"), "false");
});

test("a completed write does not focus a terminal replaced, disconnected, reconnected or relabeled while pending", async () => {
  for (const change of ["term", "controller", "disconnected", "reconnected", "pane-label"]) {
    const completion = Promise.withResolvers<void>();
    const harness = createHarness({ write: () => completion.promise });
    let replacementFocus = 0;
    harness.use(); harness.value("nginx"); harness.review(); harness.button("Run").click();
    if (change === "term") harness.target.session.term = { focus() { replacementFocus += 1; } };
    if (change === "controller") harness.target.session.commandHistory = createSession().session.commandHistory;
    if (change === "disconnected") harness.target.session.isClosed = true;
    if (change === "reconnected") harness.target.session.connectionId = "transport-new";
    if (change === "pane-label") harness.target.session.paneLabel = "Pane 1";
    harness.integration.refresh();
    completion.resolve(); await nextTurn();
    assert.equal(harness.target.focusCount, 0, change);
    assert.equal(replacementFocus, 0, change);
    assert.equal(harness.writes.length, 1);
  }
});

test("disposing during a pending write suppresses completion focus and DOM updates", async () => {
  const completion = Promise.withResolvers<void>();
  const harness = createHarness({ write: () => completion.promise });
  harness.use(); harness.value("nginx"); harness.review(); harness.button("Run").click();
  harness.integration.dispose();
  completion.resolve(); await nextTurn();
  assert.equal(harness.root.childElementCount, 0);
  assert.equal(harness.target.focusCount, 0);
  assert.equal(harness.writes.length, 1);
});

test("saving from history defaults the editor to the local shell or explicit SSH Bash/Zsh mode", () => {
  for (const [override, expected] of [
    [{ kind: "local", shell: "powershell", isReady: true }, "powershell"],
    [{ kind: "local", shell: "cmd", isReady: true }, "cmd"],
    [{ kind: "ssh" }, "posix"],
  ] as const) {
    const harness = createHarness({ target: createSession(override) });
    harness.integration.saveFromHistory("echo sample");
    assert.equal(harness.control<HTMLTextAreaElement>("#named-snippet-template").value, "echo sample");
    assert.equal(harness.control<HTMLSelectElement>("#named-snippet-shell").value, expected);
    assert.equal(harness.control<HTMLElement>(".named-snippet-editor").hidden, false);
    assert.deepEqual(harness.writes, []);
  }
});

test("PowerShell and Cmd previews preserve the snippet's explicit mode and target label", () => {
  const definitions: ReadonlyArray<Readonly<{ snippet: NamedSnippet; value: string; expected: string; label: string }>> = [
    { snippet: { id: "ps", name: "Files", template: "Get-ChildItem {{path}}", shell: "powershell" }, value: "C:\\O'Brien", expected: "Get-ChildItem 'C:\\O''Brien'", label: "PowerShell" },
    { snippet: { id: "cmd", name: "Folder", template: "dir {{path}}", shell: "cmd" }, value: "C:\\Projects", expected: "dir C:\\Projects", label: "Command Prompt" },
  ];
  for (const { snippet, value, expected, label } of definitions) {
    const harness = createHarness({ initial: [snippet], target: createSession({ kind: "local", name: "Project shell", shell: snippet.shell, isReady: true }) });
    harness.use(snippet.name); harness.value(value); harness.review();
    assert.equal(harness.preview.hidden, false);
    assert.match(harness.preview.textContent!, /Target: Project shell/);
    assert.ok(harness.preview.textContent!.includes(expected));
    assert.ok(harness.preview.textContent!.includes(`Shell mode: ${label}`));
    assert.deepEqual(harness.writes, []);
  }
});

test("editing parameter values clears review and never persists entered values", async () => {
  const harness = createHarness();
  harness.use(); harness.value("original"); harness.review();
  harness.value("new value");
  assert.equal(harness.preview.hidden, true);
  harness.button("Run").click(); await nextTurn();
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(loadSnippets(harness.storage), [SNIPPET]);
  harness.review();
  assert.ok(harness.preview.textContent!.includes("systemctl status 'new value'"));
  harness.integration.showLibrary();
  assert.equal(harness.root.querySelector("#named-snippet-parameter-0"), null);
  assert.equal(harness.control<HTMLElement>(".named-snippet-library").hidden, false);
});

test("explicit invalidation clears preview without losing entered values", () => {
  const harness = createHarness();
  harness.use(); harness.value("nginx"); harness.review();
  harness.integration.invalidate();
  assert.equal(harness.preview.hidden, true);
  assert.equal(harness.control<HTMLInputElement>("#named-snippet-parameter-0").value, "nginx");
  assert.equal(harness.button("Run").disabled, true);
  harness.review();
  assert.equal(harness.preview.hidden, false);
});

test("changing a saved snippet expires its preview and requires selecting its latest definition", async () => {
  const harness = createHarness();
  harness.use(); harness.value("nginx"); harness.review();
  const changed = { ...SNIPPET, template: "systemctl is-active {{service}}" };
  saveSnippet(harness.storage, loadSnippets(harness.storage), changed);
  harness.button("Run").click(); await nextTurn();
  assert.deepEqual(harness.writes, []);
  assert.match(harness.error.textContent!, /preview expired/);
  harness.review();
  assert.match(harness.error.textContent!, /snippet changed/);
  harness.integration.showLibrary(); harness.integration.refresh(); harness.use(); harness.value("nginx"); harness.review();
  assert.ok(harness.preview.textContent!.includes("systemctl is-active 'nginx'"));
});

test("a refreshed library detects persisted snippet changes while retaining an unedited parameter form", () => {
  const harness = createHarness();
  harness.use(); harness.value("nginx"); harness.review();
  saveSnippet(harness.storage, loadSnippets(harness.storage), { ...SNIPPET, name: "Service availability" });
  harness.integration.refresh();
  assert.equal(harness.preview.hidden, true);
  assert.equal(harness.control<HTMLInputElement>("#named-snippet-parameter-0").value, "nginx");
  assert.match(harness.status.textContent!, /Preview expired/);
});

test("disposal clears fields and prevents retained controls or public methods from submitting", async () => {
  const harness = createHarness();
  harness.use(); harness.value("nginx"); harness.review();
  const run = harness.button("Run");
  harness.integration.dispose(); harness.integration.dispose();
  harness.integration.invalidate(); harness.integration.refresh(); harness.integration.showLibrary(); harness.integration.saveFromHistory("pwd");
  run.click(); await nextTurn();
  assert.equal(harness.root.childElementCount, 0);
  assert.deepEqual(harness.writes, []);
});
