import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHTML } from "linkedom";
import { initCommandHistoryIntegration } from "../src/command-history-integration.ts";

type IntegrationOptions = Parameters<typeof initCommandHistoryIntegration>[0];
type Session = NonNullable<ReturnType<IntegrationOptions["getSession"]>>;
type MutableSession = { -readonly [Key in keyof Session]: Session[Key] };

const HISTORY_OSC = 6973;
const STORAGE_KEY = "sleekssh_command_history";
const COLUMNS = 80;
const ROWS = 12;
const CELL_WIDTH = 8;
const CELL_HEIGHT = 16;
const PROFILE = Object.freeze({ id: "profile-1", username: "deploy", port: 22 });
const SSH_CONTEXT = JSON.stringify([PROFILE.id, PROFILE.username, "example.test", PROFILE.port]);
const MARKUP = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const SNIPPET_STORAGE_KEY = "sleekssh_named_snippets";

test("the session palette lists matching folder snippets before shared snippets", () => {
  const h = createHarness();
  h.first.session.terminalPath = "/srv/app/releases";
  const base = { template: "pwd", shell: "posix" };
  const folder = { host: "example.test", username: "deploy", port: 22, path: "/srv/app" };
  h.values.set(SNIPPET_STORAGE_KEY, JSON.stringify({ version: 1, snippets: [
    { ...base, id: "shared", name: "Shared" }, { ...base, id: "app", name: "App", folder },
    { ...base, id: "other", name: "Other", folder: { ...folder, host: "other.test" } },
    { ...base, id: "sibling", name: "Sibling", folder: { ...folder, path: "/srv/app-old" } },
  ] }));
  assert.deepEqual(h.integration.listSnippets().map(snippet => snippet.id), ["app", "shared"]);
  h.first.session.terminalPath = "/srv/app-old";
  assert.deepEqual(h.integration.listSnippets().map(snippet => snippet.id), ["sibling", "shared"]);
  h.select(null);
  assert.deepEqual(h.integration.listSnippets().map(snippet => snippet.id), ["shared"]);
});

test("session palettes can list snippets and open the selected template for review", () => {
  const h = createHarness();
  assert.deepEqual(h.integration.listSnippets(), []);
  h.values.set(SNIPPET_STORAGE_KEY, JSON.stringify({ version: 1, snippets: [{ id: "status", name: "Status", template: "pwd", shell: "posix" }] }));
  assert.equal(h.integration.listSnippets()[0].name, "Status");
  h.integration.openSnippets("status");
  assert.equal(h.control("named-snippets-root").hidden, false);
  assert.equal(h.control("named-snippets-root").querySelector<HTMLElement>(".named-snippet-runner")!.hidden, false);
  assert.deepEqual(h.snippetWrites, []);
  assert.throws(() => h.integration.openSnippets("missing"), /no longer saved/);
  h.integration.dispose();
});

function createHarness(configuration: { initialStorage?: string; missingRoot?: boolean; noSession?: boolean; storageReadError?: Error } = {}) {
  const { document, window } = parseHTML(MARKUP);
  if (configuration.missingRoot) document.getElementById("command-history-panel")?.remove();
  const values = new Map<string, string>();
  if (configuration.initialStorage !== undefined) values.set(STORAGE_KEY, configuration.initialStorage);
  let writeError: Error | null = null;
  const errors: string[] = [];
  const sent: Array<{ sessionId: string; text: string }> = [];
  const snippetWrites: Array<{ sessionId: string; text: string }> = [];
  let layoutChanges = 0;
  let closeAgentCount = 0;
  let openAgentCount = 0;
  let openFilesCount = 0;
  let selected: MutableSession | null = null;

  function makeSession(update: Partial<MutableSession> = {}) {
    const container = document.createElement("div");
    container.innerHTML = '<div class="terminal-viewport"><div class="xterm"><div class="xterm-screen"></div></div></div>';
    document.querySelector(".workspace-viewport")?.append(container);
    const viewport = container.querySelector<HTMLElement>(".terminal-viewport")!;
    const element = viewport.querySelector<HTMLElement>(".xterm")!;
    const screen = element.querySelector<HTMLElement>(".xterm-screen")!;
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: COLUMNS * CELL_WIDTH, height: ROWS * CELL_HEIGHT }) as DOMRect;
    screen.getBoundingClientRect = viewport.getBoundingClientRect;
    const listeners = new Map<string, Set<() => void>>();
    const handlers = new Set<(payload: string) => boolean>();
    const register = (name: string) => (callback: () => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
      return { dispose: () => { listeners.get(name)!.delete(callback); } };
    };
    let lines: Array<{ text: string; isWrapped: boolean }> = [{ text: "$ ", isWrapped: false }];
    let focusCount = 0;
    const buffer = {
      type: "normal", baseY: 0, cursorY: 0, cursorX: 2, viewportY: 0,
      getLine(row: number) {
        const line = lines[row];
        if (!line) return undefined;
        return { isWrapped: line.isWrapped, length: COLUMNS,
          getCell(column: number) { return { getChars: () => line.text[column] ?? "", getWidth: () => 1 }; },
          translateToString(trimRight = false, startColumn = 0, endColumn = COLUMNS) {
            const value = line.text.slice(startColumn, endColumn);
            return trimRight ? value.trimEnd() : value;
          },
        };
      },
    };
    const term = {
      cols: COLUMNS, rows: ROWS, element, buffer: { active: buffer },
      options: { fontFamily: "JetBrains Mono", fontSize: 13 },
      hasSelection: () => false,
      registerMarker: () => ({ line: buffer.baseY + buffer.cursorY, dispose() {} }),
      onWriteParsed: register("parsed"), onCursorMove: register("cursor"), onRender: register("render"),
      onScroll: register("scroll"), onResize: register("resize"), onLineFeed: register("lineFeed"),
      focus: () => { focusCount += 1; },
      parser: {
        registerOscHandler(id: number, callback: (payload: string) => boolean) {
          assert.equal(id, HISTORY_OSC);
          handlers.add(callback);
          return { dispose: () => { handlers.delete(callback); } };
        },
      },
    };
    const session: MutableSession = {
      id: "ssh-tab-1", kind: "ssh", name: "Production", host: "example.test", connectionId: "transport-1",
      connectionProfile: PROFILE, isClosed: false, isClosing: false, isConnecting: false, term, container,
      ...update,
    };
    const emit = (name: string) => listeners.get(name)?.forEach(callback => callback());
    const emitOsc = (payload: string) => handlers.forEach(handler => assert.equal(handler(payload), true));
    const setInput = (text: string) => {
      const rendered = "$ " + text;
      lines = Array.from({ length: Math.max(1, Math.ceil(rendered.length / COLUMNS)) }, (_, index) => ({
        text: rendered.slice(index * COLUMNS, (index + 1) * COLUMNS), isWrapped: index !== 0,
      }));
      buffer.cursorY = Math.floor(rendered.length / COLUMNS);
      buffer.cursorX = rendered.length % COLUMNS;
      if (buffer.cursorY === lines.length) lines.push({ text: "", isWrapped: true });
    };
    return {
      session, viewport, buffer, emit, emitOsc, setInput,
      get focusCount() { return focusCount; },
      get parserListenerCount() { return handlers.size; },
      get terminalListenerCount() { return [...listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0); },
      get ghost() { return viewport.querySelector<HTMLElement>(".terminal-history-suggestion"); },
      prompt() { emitOsc("prompt-start"); setInput(""); emitOsc("prompt-end"); },
      edit(text: string) { setInput(text); emit("parsed"); },
      command(command: string) { emitOsc("command;" + Buffer.from(command, "utf8").toString("base64")); },
      lineFeed() { buffer.cursorY += 1; buffer.cursorX = 0; lines.push({ text: "", isWrapped: false }); emit("lineFeed"); },
      key(key: string) {
        let prevented = false;
        const result = session.commandHistory?.handleKeyEvent({ type: "keydown", key, ctrlKey: false, metaKey: false,
          altKey: false, shiftKey: false, isComposing: false, preventDefault() { prevented = true; }, stopPropagation() {} } as KeyboardEvent);
        return { result, prevented };
      },
    };
  }

  const first = makeSession();
  selected = configuration.noSession ? null : first.session;
  const integration = initCommandHistoryIntegration({
    document: document as unknown as Document,
    storage: {
      getItem(key) { if (configuration.storageReadError) throw configuration.storageReadError; return values.get(key) ?? null; },
      setItem(key, value) { if (writeError) throw writeError; values.set(key, value); },
    },
    getSession: () => selected,
    sendText: (session, text) => { sent.push({ sessionId: session.id, text }); },
    writeSnippet: async (session, text) => { snippetWrites.push({ sessionId: session.id, text }); },
    onLayoutChange: () => { layoutChanges += 1; },
    closeAgent: () => { closeAgentCount += 1; },
    openAgent: () => { openAgentCount += 1; },
    openFiles: () => { openFilesCount += 1; },
    onError: message => { errors.push(message); },
  });
  first.session.commandHistory = integration.attachSession(first.session);
  const control = <T extends HTMLElement>(id: string): T => {
    const element = document.getElementById(id);
    assert(element);
    return element as T;
  };
  return {
    document, window, integration, first, values, errors, sent, snippetWrites, control,
    get layoutChanges() { return layoutChanges; },
    get closeAgentCount() { return closeAgentCount; },
    get openAgentCount() { return openAgentCount; },
    get openFilesCount() { return openFilesCount; },
    select(session: MutableSession | null) { selected = session; integration.refresh(); },
    attach(update: Partial<MutableSession> = {}) {
      const created = makeSession(update);
      created.session.commandHistory = integration.attachSession(created.session);
      return created;
    },
    failWrites(cause: Error | null) { writeError = cause; },
    entry(command: string, contextKey = SSH_CONTEXT) {
      const raw = values.get(STORAGE_KEY);
      if (!raw) return undefined;
      const saved = JSON.parse(raw);
      return saved.contexts.find((context: { key: string }) => context.key === contextKey)?.entries
        .find((entry: { command: string }) => entry.command === command);
    },
    button(command: string) {
      const button = [...control("command-history-list").querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.querySelector("code")?.textContent === command);
      assert(button, `Expected history command ${command}`);
      return button;
    },
  };
}

test("history saves a named parameter template without sending commands and the library survives reopening", () => {
  const harness = createHarness();
  harness.first.prompt();
  harness.first.command("echo hello");
  harness.integration.open();
  harness.control("command-history-list").querySelector<HTMLButtonElement>(".command-history-save-snippet")!.click();
  assert.equal(harness.control("command-history-browser").hidden, true);
  assert.equal(harness.control("named-snippets-root").hidden, false);
  assert.equal(harness.control<HTMLTextAreaElement>("named-snippet-template").value, "echo hello");
  harness.control<HTMLInputElement>("named-snippet-name").value = "Greeting";
  harness.control<HTMLTextAreaElement>("named-snippet-template").value = "echo {{message}}";
  harness.control("named-snippets-root").querySelector("form")!.dispatchEvent(new harness.window.Event("submit", { cancelable: true }));
  const saved = JSON.parse(harness.values.get(SNIPPET_STORAGE_KEY)!);
  assert.equal(saved.snippets[0].name, "Greeting");
  assert.equal(saved.snippets[0].template, "echo {{message}}");
  assert.equal(saved.snippets[0].shell, "posix");
  assert.deepEqual(harness.sent, []);
  assert.deepEqual(harness.snippetWrites, []);
  harness.integration.close();
  harness.integration.openSnippets();
  assert.equal(harness.control("command-history-panel").hidden, false);
  assert.equal(harness.control("command-history-view-snippets").getAttribute("aria-pressed"), "true");
  assert.ok(harness.control("named-snippets-root").querySelector('[aria-label="Use Greeting"]'));
});

test("snippet review and Insert do not count runs; only terminal execution reports update history", async () => {
  const harness = createHarness();
  harness.values.set(SNIPPET_STORAGE_KEY, JSON.stringify({ version: 1, snippets: [
    { id: "greeting", name: "Greeting", template: "echo {{message}}", shell: "posix" },
  ] }));
  harness.first.prompt();
  harness.integration.openSnippets();
  const root = harness.control("named-snippets-root");
  root.querySelector<HTMLButtonElement>('[aria-label="Use Greeting"]')!.click();
  const parameter = harness.control<HTMLInputElement>("named-snippet-parameter-0");
  parameter.value = "hello";
  parameter.dispatchEvent(new harness.window.Event("input"));
  const review = () => root.querySelector(".named-snippet-runner")!.dispatchEvent(new harness.window.Event("submit", { cancelable: true }));
  const click = (label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label)!.click();
  review();
  assert.equal(root.querySelector(".named-snippet-output")!.textContent, "echo 'hello'");
  assert.match(root.querySelector(".named-snippet-target")!.textContent!, /Production.*deploy@example.test:22/);
  assert.deepEqual(harness.snippetWrites, []);
  click("Insert");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.snippetWrites, [{ sessionId: harness.first.session.id, text: "echo 'hello'" }]);
  assert.equal(harness.entry("echo 'hello'"), undefined);
  harness.first.prompt();
  review();
  click("Run");
  click("Run");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.snippetWrites, [
    { sessionId: harness.first.session.id, text: "echo 'hello'" },
    { sessionId: harness.first.session.id, text: "echo 'hello'\r" },
  ]);
  assert.equal(harness.entry("echo 'hello'"), undefined);
  harness.first.command("echo 'hello'");
  harness.first.command("echo 'hello'");
  assert.equal(harness.entry("echo 'hello'")?.runCount, 1);
  assert.deepEqual(harness.sent, []);
  assert.equal(JSON.parse(harness.values.get(SNIPPET_STORAGE_KEY)!).snippets[0].values, undefined);
});

test("typing after snippet review immediately expires the preview and changing views clears parameters", () => {
  const harness = createHarness();
  harness.values.set(SNIPPET_STORAGE_KEY, JSON.stringify({ version: 1, snippets: [
    { id: "greeting", name: "Greeting", template: "echo {{message}}", shell: "posix" },
  ] }));
  harness.first.prompt();
  harness.integration.openSnippets();
  const root = harness.control("named-snippets-root");
  root.querySelector<HTMLButtonElement>('[aria-label="Use Greeting"]')!.click();
  harness.control<HTMLInputElement>("named-snippet-parameter-0").value = "hello";
  root.querySelector(".named-snippet-runner")!.dispatchEvent(new harness.window.Event("submit", { cancelable: true }));
  assert.equal(root.querySelector<HTMLElement>(".named-snippet-preview")!.hidden, false);
  harness.first.session.commandHistory!.handleInput("x");
  assert.equal(root.querySelector<HTMLElement>(".named-snippet-preview")!.hidden, true);
  const run = [...root.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Run")!;
  assert.equal(run.disabled, true);
  run.click();
  assert.deepEqual(harness.snippetWrites, []);
  harness.control<HTMLButtonElement>("command-history-view-history").click();
  harness.control<HTMLButtonElement>("command-history-view-snippets").click();
  assert.equal(root.querySelector("#named-snippet-parameter-0"), null);
  harness.integration.dispose();
  harness.integration.openSnippets();
  assert.equal(root.children.length, 0);
});

test("terminal and agent executions merge by stable server context and count once per prompt", () => {
  const harness = createHarness();
  const command = "systemctl status nginx";
  harness.first.prompt();
  harness.first.edit(command);
  harness.first.command(command);
  harness.first.emitOsc("busy");
  harness.first.command(command);
  assert.equal(harness.entry(command)?.runCount, 1);
  harness.first.prompt();
  harness.first.edit(command);
  harness.first.command(command);
  harness.first.emitOsc("busy");
  harness.integration.recordAgentCommand({ sessionId: "different-transport", contextKey: SSH_CONTEXT, label: "Production" }, command);
  assert.deepEqual({ ...harness.entry(command), lastRunAt: 0 }, {
    command, runCount: 3, terminalCount: 2, agentCount: 1, lastRunAt: 0,
  });
  assert.equal(harness.button(command).querySelector(".command-history-count")?.textContent, "3 runs");
  assert.equal(harness.button(command).querySelector(".command-history-source")?.textContent, "2 terminal · 1 agent");
});

test("a reconnect reuses server history while pinned agent targets stay separate from the selected server", () => {
  const harness = createHarness();
  harness.first.prompt();
  harness.first.command("uptime");
  const reconnected = harness.attach({ id: "ssh-tab-reconnected", connectionId: "new-transport" });
  harness.select(reconnected.session);
  reconnected.prompt();
  reconnected.command("uptime");
  assert.equal(harness.entry("uptime")?.runCount, 2);
  const other = harness.attach({ id: "other-tab", host: "other.test", connectionId: "other-transport" });
  harness.select(other.session);
  harness.integration.recordAgentCommand({ sessionId: "old-transport", contextKey: SSH_CONTEXT, label: "Pinned Production" }, "uptime");
  assert.equal(harness.entry("uptime")?.runCount, 3);
  assert.equal(harness.control("command-history-list").children.length, 0);
  harness.select(reconnected.session);
  assert.equal(harness.button("uptime").querySelector(".command-history-count")?.textContent, "3 runs");
  harness.integration.recordAgentCommand({ sessionId: "legacy-agent-session", label: "Legacy agent" }, "pwd");
  assert.equal(harness.entry("pwd", "legacy-agent-session")?.agentCount, 1);
});

test("restored history feeds inline completion and combined counts after integration reinitialization", () => {
  const first = createHarness();
  first.first.prompt();
  first.first.command("git status");
  first.integration.recordAgentCommand({ sessionId: "codex-transport", contextKey: SSH_CONTEXT, label: "Codex on Production" }, "git status");
  const saved = first.values.get(STORAGE_KEY);
  assert(saved);
  first.integration.dispose();
  const reopened = createHarness({ initialStorage: saved });
  assert.equal(reopened.entry("git status")?.runCount, 2);
  assert.equal(reopened.button("git status").querySelector(".command-history-count")?.textContent, "2 runs");
  reopened.first.prompt();
  reopened.first.edit("git s");
  assert.equal(reopened.first.ghost?.textContent, "tatus");
  reopened.integration.recordAgentCommand({ sessionId: "claude-transport", contextKey: SSH_CONTEXT, label: "Claude on Production" }, "git status");
  assert.equal(reopened.entry("git status")?.runCount, 3);
  assert.equal(reopened.entry("git status")?.agentCount, 2);
});

test("pane focus routes history insertion to the selected terminal while identical hosts share history", () => {
  const harness = createHarness();
  const second = harness.attach({ id: "ssh-pane-2", connectionId: "transport-2" });
  const command = "printf pane-check";
  harness.first.prompt();
  harness.first.command(command);
  harness.first.prompt();
  second.prompt();
  harness.select(second.session);
  harness.button(command).click();
  assert.deepEqual(harness.sent, [{ sessionId: second.session.id, text: command }]);
  assert.equal(second.focusCount, 1);
  assert.equal(harness.first.focusCount, 0);
  second.command(command);
  assert.equal(harness.entry(command)?.runCount, 2);
  harness.select(harness.first.session);
  harness.button(command).click();
  assert.deepEqual(harness.sent, [
    { sessionId: second.session.id, text: command },
    { sessionId: harness.first.session.id, text: command },
  ]);
  assert.equal(harness.first.focusCount, 1);
  const saved = JSON.parse(harness.values.get(STORAGE_KEY)!);
  assert.equal(saved.contexts.length, 1);
  assert.equal(saved.contexts[0].key, SSH_CONTEXT);
  assert.equal(harness.entry(command)?.runCount, 2);
});

test("local histories are scoped by shell and Command Prompt line-feed fallback records one submitted command", () => {
  const harness = createHarness();
  const powershell = harness.attach({ id: "ps-tab", kind: "local", shell: "powershell", name: "PowerShell", isReady: true, connectionId: null });
  const cmd = harness.attach({ id: "cmd-tab", kind: "local", shell: "cmd", name: "Command Prompt", isReady: true, connectionId: null });
  harness.select(powershell.session);
  powershell.prompt();
  powershell.command("Get-Location");
  const powershellKey = JSON.stringify(["local", "powershell"]);
  assert.equal(harness.entry("Get-Location", powershellKey)?.terminalCount, 1);
  harness.select(cmd.session);
  cmd.prompt();
  cmd.edit("dir /a");
  assert.equal(cmd.key("Enter").result, true);
  cmd.lineFeed();
  cmd.lineFeed();
  assert.equal(harness.entry("dir /a", JSON.stringify(["local", "cmd"]))?.runCount, 1);
  assert.equal(harness.entry("dir /a", powershellKey), undefined);
  assert.equal(harness.control("command-history-list").children.length, 1);
});

for (const state of [{ isClosed: true }, { isClosing: true }, { isConnecting: true }, { connectionId: null }]) {
  test(`disconnected or unavailable terminals cannot record or complete commands ${JSON.stringify(state)}`, () => {
    const harness = createHarness();
    Object.assign(harness.first.session, state);
    harness.first.prompt();
    harness.first.command("pwd");
    harness.first.edit("pwd");
    harness.first.emitOsc("busy");
    assert.equal(harness.entry("pwd"), undefined);
    assert.equal(harness.first.ghost?.hidden, true);
    assert.deepEqual(harness.sent, []);
  });
}

test("initial prompt markers received while connecting still enable completion after connection succeeds", () => {
  const harness = createHarness();
  harness.integration.recordAgentCommand({ sessionId: "transport-1", contextKey: SSH_CONTEXT, label: "Production" }, "git status");
  harness.first.session.isConnecting = true;
  harness.first.session.isClosed = true;
  harness.first.prompt();
  harness.first.session.isConnecting = false;
  harness.first.session.isClosed = false;
  harness.integration.refresh();
  harness.first.edit("git s");
  assert.equal(harness.first.ghost?.textContent, "tatus");
  assert.equal(harness.first.ghost?.hidden, false);
  assert.deepEqual(harness.first.key("Tab"), { result: false, prevented: true });
  assert.deepEqual(harness.sent, [{ sessionId: harness.first.session.id, text: "tatus" }]);
  assert.equal(harness.entry("git status")?.runCount, 1);
});

test("opening history updates layout and exclusive panel callbacks; close and navigation restore the workspace", () => {
  const harness = createHarness();
  const root = harness.control("command-history-panel");
  assert.equal(root.hidden, true);
  harness.control<HTMLButtonElement>("btn-command-history-toggle").click();
  assert.equal(root.hidden, false);
  assert.equal(harness.closeAgentCount, 1);
  assert.equal(harness.layoutChanges, 1);
  assert.equal(harness.control("btn-command-history-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(harness.document.querySelector(".app-container")?.classList.contains("history-open"), true);
  harness.integration.open();
  assert.equal(harness.layoutChanges, 1);
  harness.control<HTMLButtonElement>("command-history-close").click();
  assert.equal(root.hidden, true);
  assert.equal(harness.first.focusCount, 1);
  harness.integration.open();
  harness.control<HTMLButtonElement>("command-history-agent-tab").click();
  assert.equal(root.hidden, true);
  assert.equal(harness.openAgentCount, 1);
  harness.integration.open();
  harness.control<HTMLButtonElement>("command-history-files-tab").click();
  assert.equal(root.hidden, true);
  assert.equal(harness.openFilesCount, 1);
  harness.select(null);
  assert.equal(harness.control<HTMLButtonElement>("command-history-files-tab").disabled, true);
  assert.equal(harness.control<HTMLButtonElement>("command-history-agent-tab").disabled, true);
});

test("history opens and closes safely when the selected settings tab has no terminal", () => {
  const harness = createHarness();
  harness.select({ ...harness.first.session, id: "settings-tab", kind: "settings", name: "Settings",
    term: undefined, commandHistory: undefined });
  assert.doesNotThrow(() => harness.integration.open());
  assert.equal(harness.control("command-history-panel").hidden, false);
  assert.match(harness.control("command-history-target").textContent ?? "", /Select a connected terminal/);
  assert.equal(harness.control("command-history-list").children.length, 0);
  assert.doesNotThrow(() => harness.control<HTMLButtonElement>("command-history-close").click());
  assert.equal(harness.control("command-history-panel").hidden, true);
  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.sent, []);
});

test("clicking historical commands inserts text without Enter, execution, or count increments", () => {
  const harness = createHarness();
  harness.integration.recordAgentCommand({ sessionId: "transport-1", contextKey: SSH_CONTEXT, label: "Production" }, "git status");
  harness.first.prompt();
  harness.integration.open();
  harness.button("git status").click();
  assert.deepEqual(harness.sent, [{ sessionId: harness.first.session.id, text: "git status" }]);
  assert.equal(harness.entry("git status")?.runCount, 1);
  harness.first.edit("git status");
  harness.first.prompt();
  harness.first.edit("different command");
  harness.button("git status").click();
  assert.equal(harness.sent.length, 1);
  assert.match(harness.control("command-history-error").textContent ?? "", /empty shell prompt|finish editing/);
});

for (const command of ["printf first\nprintf second", "printf\tvalue"]) {
  test(`history refuses terminal insertion of ${command.includes("\n") ? "multiline" : "tabbed"} commands with review guidance`, () => {
    const harness = createHarness();
    harness.integration.recordAgentCommand({ sessionId: "agent-transport", contextKey: SSH_CONTEXT, label: "Production" }, command);
    harness.first.prompt();
    harness.integration.open();
    harness.button(command).click();
    assert.deepEqual(harness.sent, []);
    assert.equal(harness.entry(command)?.runCount, 1);
    assert.match(harness.control("command-history-error").textContent ?? "", /spans multiple lines or contains tabs.*Review and copy/);
    assert.equal(harness.errors.length, 1);
  });
}

test("canonical shell reports normalize Windows newlines and preserve literal Unicode text", () => {
  const harness = createHarness();
  harness.first.prompt();
  harness.first.command("printf café\r\nprintf 世界");
  assert.equal(harness.entry("printf café\nprintf 世界")?.runCount, 1);
  assert.equal(harness.button("printf café\nprintf 世界").querySelector("code")?.textContent, "printf café\nprintf 世界");
});

for (const payload of ["command;", "command;?invalid", "command;A", "command;/w==", "command;" + "A".repeat(100_001)]) {
  test(`malformed shell report ${payload.slice(0, 18)} fails visibly without recording`, () => {
    const harness = createHarness();
    harness.first.prompt();
    harness.first.emitOsc(payload);
    assert.equal(harness.values.has(STORAGE_KEY), false);
    assert.equal(harness.control("command-history-error").hidden, false);
    assert.equal(harness.errors.length, 1);
  });
}

test("storage failures surface through panel and callback without changing the recorded count", () => {
  const harness = createHarness();
  harness.integration.recordAgentCommand({ sessionId: "transport-1", contextKey: SSH_CONTEXT, label: "Production" }, "pwd");
  harness.failWrites(new Error("Quota reached"));
  harness.first.prompt();
  harness.first.command("pwd");
  assert.equal(harness.entry("pwd")?.runCount, 1);
  assert.match(harness.control("command-history-error").textContent ?? "", /Quota reached/);
  assert.match(harness.errors[0], /Quota reached/);
  harness.failWrites(null);
  harness.first.prompt();
  harness.first.command("pwd");
  assert.equal(harness.entry("pwd")?.runCount, 2);
  assert.equal(harness.control("command-history-error").hidden, true);
});

test("missing panel, null options, invalid stored data, and blocked reads fail at initialization", () => {
  assert.throws(() => createHarness({ missingRoot: true }), /panel is missing/);
  assert.throws(() => initCommandHistoryIntegration(null as unknown as IntegrationOptions));
  assert.throws(() => createHarness({ initialStorage: "{" }), /invalid JSON/);
  assert.throws(() => createHarness({ storageReadError: new Error("Read blocked") }), /Read blocked/);
  const harness = createHarness({ noSession: true });
  assert.match(harness.control("command-history-target").textContent ?? "", /Select a connected terminal/);
});

test("session disposal and integration disposal remove OSC listeners, terminal subscriptions, and controls", () => {
  const harness = createHarness();
  const other = harness.attach({ id: "other-tab", connectionId: "other-transport" });
  assert.equal(harness.first.parserListenerCount, 1);
  assert.equal(other.parserListenerCount, 1);
  assert(harness.first.terminalListenerCount > 0);
  other.session.commandHistory?.dispose();
  assert.equal(other.parserListenerCount, 0);
  assert.equal(other.terminalListenerCount, 0);
  harness.integration.dispose();
  harness.integration.dispose();
  assert.equal(harness.first.terminalListenerCount, 0);
  assert.equal(harness.first.parserListenerCount, 0);
  assert.equal(harness.first.ghost, null);
  harness.control<HTMLButtonElement>("btn-command-history-toggle").click();
  harness.integration.open();
  harness.integration.refresh();
  harness.integration.recordAgentCommand({ sessionId: "x", contextKey: SSH_CONTEXT, label: "Production" }, "pwd");
  assert.equal(harness.control("command-history-panel").hidden, true);
  assert.equal(harness.layoutChanges, 0);
  assert.equal(harness.values.has(STORAGE_KEY), false);
});
