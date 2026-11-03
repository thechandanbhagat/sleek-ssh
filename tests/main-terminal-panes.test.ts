import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { parseHTML } from "linkedom";
import { createTerminalGroups, initPaneDivider, type PaneDirection, type TerminalTabGroup } from "../src/terminal-panes.ts";
import { initCommandPalette } from "../src/command-palette.ts";
import { initAutomation } from "../src/automation.ts";
import { initAutomationSessions } from "../src/automation-sessions.ts";

const SOURCE = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const TERMINAL_COLUMNS = 100;
const TERMINAL_ROWS = 30;
const PROFILE = Object.freeze({ id: "pane-host", name: "API", host: "api.example.test", port: 22, username: "deploy", use_password: false });
const DIRECTORY = "C:\\Projects\\pane test";
type Invocation = Readonly<{ command: string; arguments_: Record<string, unknown> }>;
type Destination = Readonly<{ tabId: string; direction: PaneDirection }>;
type Session = {
  id: string; kind: string; name: string; container: HTMLElement; connectionId?: string | null;
  isClosed: boolean; isClosing?: boolean; isReady?: boolean; isConnecting?: boolean; connectionStatus?: string;
  paneLabel?: string; term: ReturnType<typeof terminal>; fitAddon: { fit(): void }; currentPath?: string;
  shell?: string; workingDirectory?: string | null; locationName?: string | null; terminalPath?: string | null; sftpPanelOpen?: boolean;
  commandHistory?: { reset(): void; dispose(): void; handleInput(text: string): void };
};

function terminal(document: Document, container: HTMLElement) {
  const input = document.createElement("textarea");
  input.setAttribute("aria-label", "Terminal input");
  container.querySelector(".terminal-viewport")!.append(input);
  const listeners: Array<(text: string) => void | Promise<void>> = [];
  const output: string[] = [];
  let focusCount = 0;
  let disposeCount = 0;
  return {
    cols: TERMINAL_COLUMNS, rows: TERMINAL_ROWS, options: { disableStdin: false }, input, output,
    get focusCount() { return focusCount; },
    get disposeCount() { return disposeCount; },
    focus() { focusCount += 1; input.focus(); },
    dispose() { disposeCount += 1; },
    write(text: string, callback?: () => void) { output.push(text); callback?.(); },
    getSelection: () => "",
    onData(callback: (text: string) => void | Promise<void>) { listeners.push(callback); },
    async inputText(text: string) { await Promise.all(listeners.map(callback => callback(text))); },
    onSelectionChange() { return { dispose() {} }; },
    parser: { registerOscHandler() { return { dispose() {} }; } },
  };
}

function createHarness(configuration: { invoke?: (call: Invocation) => Promise<unknown> } = {}) {
  const { document, window } = parseHTML(HTML);
  document.getElementsByName = name => document.querySelectorAll('[name="' + name + '"]') as unknown as NodeListOf<HTMLElement>;
  let focused: HTMLElement | null = null;
  window.HTMLElement.prototype.focus = function () {
    focused = this as HTMLElement;
    this.dispatchEvent(new window.Event("focusin", { bubbles: true }));
  };
  const calls: Invocation[] = [];
  const notifications: string[] = [];
  const historyTargets: Array<string | null> = [];
  const storage = new Map<string, string>();
  const timers: Array<() => void> = [];
  const fits: string[] = [];
  const windowListeners = new Map<string, Array<(event: Event) => unknown>>();
  const paneForm = document.querySelector<HTMLFormElement>("#pane-picker-form")!;
  const addFormListener = paneForm.addEventListener.bind(paneForm);
  let submitPane: ((event: Event) => unknown) | undefined;
  paneForm.addEventListener = ((type: string, listener: (event: Event) => unknown) => {
    if (type === "submit") submitPane = listener;
    addFormListener(type, listener);
  }) as typeof paneForm.addEventListener;
  const paneDialog = document.querySelector<HTMLDialogElement>("#pane-picker")!;
  paneDialog.showModal = () => { paneDialog.setAttribute("open", ""); };
  paneDialog.close = () => { paneDialog.removeAttribute("open"); };
  const context = createContext({
    document,
    window: {
      __TAURI__: {
        core: { async invoke(command: string, arguments_: Record<string, unknown> = {}) {
          const invocation = { command, arguments_: { ...arguments_ } };
          calls.push(invocation);
          return configuration.invoke?.(invocation);
        } },
        event: { async listen() { return () => {}; } },
      },
      SleekSshPanes: { createTerminalGroups, initPaneDivider },
      SleekSshHistory: { controller: { refresh() { historyTargets.push(runInContext("getActiveSession()?.id ?? null", context)); } } },
      addEventListener(type: string, listener: (event: Event) => unknown) {
        windowListeners.set(type, [...windowListeners.get(type) ?? [], listener]);
      }, setTimeout: () => 1, clearTimeout() {},
    },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    crypto: { randomUUID }, console: { error() {}, warn() {}, log() {} },
    setTimeout(callback: () => void) { timers.push(callback); return timers.length; }, clearTimeout() {},
    requestAnimationFrame(callback: () => void) { callback(); return 1; }, TextEncoder, TextDecoder, btoa, atob,
  });
  runInContext(SOURCE, context, { filename: "src/main.js" });
  Object.assign(context, {
    refreshPanelLayout() {}, scheduleTerminalSearchRefresh() {}, initSftpForSession() {}, initSessionPanelLayout() {},
    fitTerminal(session?: Session) { if (session?.term && !session.isClosing) fits.push(session.id); },
    showNotification(message: string) { notifications.push(message); },
    async loadSftpDirectory(session: Session, path: string) { session.currentPath = path; },
    createTerminalForSession(session: Session) {
      session.term = terminal(document as unknown as Document, session.container);
      session.fitAddon = { fit() { fits.push(session.id); } };
      session.commandHistory = { reset() {}, dispose() {}, handleInput() {} };
      return session.term;
    },
  });
  const evaluate = <T>(source: string): T => runInContext(source, context) as T;
  const call = <T>(name: string, ...arguments_: unknown[]): T => {
    context.testArguments = arguments_;
    return evaluate<T>(name + "(...testArguments)");
  };
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    assert.ok(element, "Missing " + selector);
    return element;
  };
  return {
    context, document, window, calls, notifications, historyTargets, fits, call, evaluate, find,
    get focused() { return focused; },
    get activeId() { return evaluate<string | null>("activeTabId"); },
    get active() { return call<Session | undefined>("getActiveSession"); },
    get sessions() { return evaluate<Session[]>("Object.values(activeSessions)"); },
    get groups() { return evaluate<readonly TerminalTabGroup[]>("terminalGroups.all()"); },
    get tabs() { return [...document.querySelectorAll<HTMLElement>(".terminal-tab")]; },
    local(shell = "powershell", destination: Destination | null = null) { return call<Promise<Session>>("openLocalTerminal", shell, DIRECTORY, "Project", destination); },
    ssh(destination: Destination | null = null) { return call<Promise<Session>>("connectProfile", PROFILE, null, destination); },
    activate(session: Session, focusTerminal = true) { call("activateSession", session.id, { focusTerminal }); },
    closePane(session: Session) { return call<Promise<void>>("closeTerminalPane", session.id); },
    closeTab(tabId: string) { return call<Promise<void>>("closeTab", tabId); },
    split(choice: string, direction: PaneDirection, tabId?: string, sourceId?: string) {
      return call<Promise<Session>>("splitActiveTerminal", choice, direction, tabId, sourceId);
    },
    async submitPane(choice: string) {
      const select = find<HTMLSelectElement>("#pane-picker-terminal");
      Object.defineProperty(select, "value", { configurable: true, value: choice });
      assert.ok(submitPane, "Pane picker is not initialized");
      await submitPane(new window.Event("submit", { cancelable: true }));
    },
    async key(code: string, modifiers: Record<string, boolean> = {}) {
      const event = new window.Event("keydown", { cancelable: true });
      Object.assign(event, { code, ctrlKey: true, altKey: true, shiftKey: false, repeat: false, ...modifiers });
      for (const listener of windowListeners.get("keydown") ?? []) await listener(event);
      return event;
    },
    flushTimers() { for (const callback of timers.splice(0)) callback(); },
  };
}

function initPalettes(harness: ReturnType<typeof createHarness>) {
  harness.context.window.SleekSshCommandPalette = { initCommandPalette };
  harness.context.window.SleekSshHistory.controller.listSnippets = () => [];
  harness.call("initCommandPaletteIntegration");
  harness.call("initSessionShortcuts");
  return harness.find<HTMLElement>("#command-palette");
}

test("the real Agent integration restores the owning pane's draft and opening a background pane cannot toggle it closed", async () => {
  const h = createHarness({ async invoke(call) {
    if (call.command === "list_automation_providers") return [{ id: "claude", name: "Claude", available: true }, { id: "codex", name: "Codex", available: true }];
    if (call.command === "list_local_agent_sessions") return { sessions: [], warnings: [], truncated: false };
  } });
  Object.defineProperty(h.window.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get() { return [...this.options].find(option => option.selected)?.value ?? this.options[0]?.value ?? ""; },
    set(value: string) { for (const option of this.options) option.selected = false; const match = [...this.options].find(option => option.value === value); if (match) match.selected = true; },
  });
  const first = await h.ssh();
  let agent: ReturnType<typeof initAutomationSessions> | undefined;
  h.context.window.SleekSshHistory.controller.close = () => { h.find("#command-history-panel").hidden = true; };
  h.context.window.SleekSshAutomation = { initAutomationSessions(options: Parameters<typeof initAutomationSessions>[0]) {
    agent = initAutomationSessions({ ...options, document: h.document as unknown as Document, storage: null }, initAutomation);
    return agent;
  } };
  h.call("initAutomationPanel");
  try {
    await new Promise(resolve => setImmediate(resolve));
    first.container.querySelector<HTMLButtonElement>(".session-agent-toggle")!.click();
    const firstPrompt = h.find<HTMLTextAreaElement>('[data-session-key="' + first.id + '"] [data-automation-control="automation-prompt"]');
    firstPrompt.value = "First pane task";
    const second = await h.ssh({ tabId: first.id, direction: "right" });
    assert.equal(h.find("#automation-panel").hidden, true);
    second.container.querySelector<HTMLButtonElement>(".session-agent-toggle")!.click();
    const secondPrompt = h.find<HTMLTextAreaElement>('[data-session-key="' + second.id + '"] [data-automation-control="automation-prompt"]');
    assert.equal(secondPrompt.value, ""); secondPrompt.value = "Second pane task";
    first.container.querySelector<HTMLButtonElement>(".session-agent-toggle")!.click();
    assert.equal(h.active, first); assert.equal(h.find("#automation-panel").hidden, false);
    assert.equal(firstPrompt.value, "First pane task"); assert.equal(secondPrompt.value, "Second pane task");
    assert.equal(first.container.querySelector(".session-agent-toggle")!.getAttribute("aria-pressed"), "true");
    assert.equal(second.container.querySelector(".session-agent-toggle")!.getAttribute("aria-pressed"), "false");
  } finally { agent?.dispose(); }
});

test("Files stays available after the Agent template starts disabled and switching panels keeps its SSH run alive", async () => {
  const h = createHarness({ async invoke(call) {
    if (call.command === "list_automation_providers") return [{ id: "claude", name: "Claude", available: true }, { id: "codex", name: "Codex", available: true }];
    if (call.command === "list_local_agent_sessions") return { sessions: [], warnings: [], truncated: false };
  } });
  Object.defineProperty(h.window.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get() { return [...this.options].find(option => option.selected)?.value ?? this.options[0]?.value ?? ""; },
    set(value: string) { for (const option of this.options) option.selected = false; const match = [...this.options].find(option => option.value === value); if (match) match.selected = true; },
  });
  h.call("refreshWorkspaceChrome");
  assert.equal(h.find<HTMLButtonElement>("#automation-files-tab").disabled, true);
  let agent: ReturnType<typeof initAutomationSessions> | undefined;
  h.context.window.SleekSshHistory.controller.close = () => { h.find("#command-history-panel").hidden = true; };
  h.context.window.SleekSshAutomation = { initAutomationSessions(options: Parameters<typeof initAutomationSessions>[0]) {
    agent = initAutomationSessions({ ...options, document: h.document as unknown as Document, storage: null }, initAutomation);
    return agent;
  } };
  h.call("initAutomationPanel");
  try {
    const ssh = await h.ssh(); await new Promise(resolve => setImmediate(resolve));
    ssh.container.querySelector<HTMLButtonElement>(".session-agent-toggle")!.click();
    const files = h.find<HTMLButtonElement>('[data-session-key="' + ssh.id + '"] [data-automation-control="automation-files-tab"]');
    assert.equal(files.disabled, false); assert.equal(files.title, "Show files for this server");
    const prompt = h.find<HTMLTextAreaElement>('[data-session-key="' + ssh.id + '"] [data-automation-control="automation-prompt"]');
    prompt.value = "Inspect server"; prompt.dispatchEvent(new h.window.Event("input"));
    h.find('[data-session-key="' + ssh.id + '"] [data-automation-control="automation-form"]').dispatchEvent(new h.window.Event("submit", { cancelable: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(agent!.states()[0].running, true);
    files.click();
    assert.equal(h.find("#automation-panel").hidden, true);
    assert.equal(ssh.sftpPanelOpen, true); assert.equal(h.focused, ssh.container.querySelector(".sftp-close"));
    assert.equal(agent!.states()[0].running, true);
    assert.equal(h.calls.some(call => call.command === "stop_ssh_automation"), false);
    const local = await h.local(); assert.equal(h.active, local); assert.equal(files.disabled, true);
    h.activate(ssh); ssh.container.querySelector<HTMLButtonElement>(".session-agent-toggle")!.click();
    assert.equal(files.disabled, false); assert.equal(h.find("#automation-panel").hidden, false);
    files.click(); assert.equal(h.find("#automation-panel").hidden, true);
    assert.equal(agent!.states()[0].running, true);
  } finally { agent?.dispose(); }
});

test("Ctrl+Shift+P opens the global palette with an active SSH session", async () => {
  const h = createHarness();
  await h.ssh();
  const root = initPalettes(h);
  const event = await h.key("KeyP", { altKey: false, shiftKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(root.hidden, false);
  assert.equal(root.dataset.mode, "all");
  assert.equal(h.find<HTMLElement>("#palette-context").hidden, true);
  await h.key("KeyP", { altKey: false, shiftKey: true });
  assert.equal(root.hidden, true);
});

test("the dedicated SSH shortcut and global shortcut switch directly between their palettes", async () => {
  const h = createHarness();
  const session = await h.ssh();
  const root = initPalettes(h);
  await h.key("KeyK", { altKey: false, shiftKey: true });
  assert.equal(root.hidden, false); assert.equal(root.dataset.mode, "session");
  assert.equal(h.evaluate("sessionPaletteSession"), session);
  assert.match(h.find("#palette-context").textContent!, /API.*deploy@api.example.test/);
  await h.key("KeyP", { altKey: false, shiftKey: true });
  assert.equal(root.hidden, false); assert.equal(root.dataset.mode, "all");
  await h.key("KeyK", { ctrlKey: false, metaKey: true, altKey: false, shiftKey: true });
  assert.equal(root.hidden, false); assert.equal(root.dataset.mode, "session");
  await h.key("KeyK", { altKey: false, shiftKey: true });
  assert.equal(root.hidden, true);
});

test("the SSH shortcut leaves local shells, missing sessions and terminal Ctrl+K alone", async () => {
  for (const local of [false, true]) {
    const h = createHarness();
    if (local) await h.local();
    const root = initPalettes(h);
    const event = await h.key("KeyK", { altKey: false, shiftKey: true });
    assert.equal(event.defaultPrevented, false); assert.equal(root.hidden, true);
    await h.key("KeyP", { altKey: false, shiftKey: true });
    assert.equal(root.dataset.mode, "all"); assert.equal(root.hidden, false);
  }
  const h = createHarness(); await h.ssh(); const root = initPalettes(h);
  for (const modifiers of [
    { altKey: false, shiftKey: false },
    { altKey: false, shiftKey: true, repeat: true },
    { altKey: true, shiftKey: true },
    { ctrlKey: false, metaKey: false, altKey: false, shiftKey: true },
  ]) {
    const event = await h.key("KeyK", modifiers);
    assert.equal(event.defaultPrevented, false); assert.equal(root.hidden, true);
  }
});

test("the SSH toolbar button and global action expose the new shortcut and target its pane", async () => {
  const h = createHarness();
  const first = await h.ssh();
  const second = await h.ssh({ tabId: first.id, direction: "right" });
  const root = initPalettes(h);
  const button = first.container.querySelector<HTMLButtonElement>(".session-shortcuts")!;
  assert.equal(button.textContent, "SSH palette");
  assert.match(button.title, /Ctrl\+Shift\+K/);
  button.click();
  assert.equal(h.active, first); assert.equal(root.dataset.mode, "session");
  assert.equal(h.evaluate("sessionPaletteSession"), first);
  h.activate(second, false);
  await h.key("KeyK", { altKey: false, shiftKey: true });
  assert.equal(root.hidden, false); assert.equal(h.evaluate("sessionPaletteSession"), second);
  const items = h.call<Array<{ id: string; shortcut?: string[]; run(): void }>>("buildCommandPaletteItems");
  const action = items.find(item => item.id === "action:ssh-palette");
  assert.ok(action); assert.deepEqual(Array.from(action.shortcut!), ["Ctrl", "Shift", "K"]);
  action.run(); assert.equal(root.dataset.mode, "session");
  assert.match(h.find("#prof-remote-folders-settings").textContent!, /Ctrl\+Shift\+K/);
});

test("palette shortcuts leave a native dialog's keyboard handling intact", async () => {
  const h = createHarness(); await h.ssh(); const root = initPalettes(h);
  h.find("#remote-folder-dialog").setAttribute("open", "");
  for (const code of ["KeyP", "KeyK"]) {
    const event = await h.key(code, { altKey: false, shiftKey: true });
    assert.equal(event.defaultPrevented, false); assert.equal(root.hidden, true);
  }
});

for (const direction of ["right", "below"] as const) {
  test(`${direction} split groups independent SSH and local terminals under one tab`, async () => {
    const harness = createHarness();
    const first = direction === "right" ? await harness.local() : await harness.ssh();
    const second = direction === "right" ? await harness.ssh({ tabId: first.id, direction }) : await harness.local("powershell", { tabId: first.id, direction });
    assert.equal(harness.tabs.length, 1);
    assert.equal(harness.activeId, first.id);
    assert.equal(harness.active, second);
    assert.equal(harness.groups.length, 1);
    assert.deepEqual(harness.groups[0].sessionIds, [first.id, second.id]);
    assert.equal(harness.groups[0].direction, direction);
    assert.equal(harness.groups[0].activeSessionId, second.id);
    assert.equal(first.paneLabel, "Pane 1");
    assert.equal(second.paneLabel, "Pane 2");
    const view = harness.find('.terminal-tab-view[data-tab-id="' + first.id + '"]');
    assert.equal(view.dataset.direction, direction);
    assert.equal(view.style.getPropertyValue("--pane-ratio"), "50%");
    assert.equal(view.classList.contains("is-active"), true);
    assert.equal(first.container.parentElement, view);
    assert.equal(second.container.parentElement, view);
    assert.equal(first.container.classList.contains("active"), true);
    assert.equal(second.container.classList.contains("active"), true);
    assert.equal(second.container.classList.contains("terminal-pane-focused"), true);
    const ssh = first.kind === "ssh" ? first : second;
    const local = first.kind === "local" ? first : second;
    assert.equal(harness.calls.find(call => call.command === "connect_ssh")?.arguments_.sessionId, ssh.connectionId);
    assert.equal(harness.calls.find(call => call.command === "start_local_terminal")?.arguments_.sessionId, local.id);
    const boundary = harness.calls.length;
    await local.term.inputText("Write-Output local\r");
    await ssh.term.inputText("printf remote\r");
    assert.deepEqual(harness.calls.slice(boundary).filter(call => call.command.startsWith("write_")).map(call => ({
      command: call.command, sessionId: call.arguments_.sessionId, text: atob(call.arguments_.dataBase64 as string),
    })), [
      { command: "write_local_terminal", sessionId: local.id, text: "Write-Output local\r" },
      { command: "write_ssh", sessionId: ssh.connectionId, text: "printf remote\r" },
    ]);
  });
}

test("pointer and input focus choose the pane without moving focus to its terminal", async () => {
  const harness = createHarness();
  const first = await harness.local();
  const second = await harness.local("cmd", { tabId: first.id, direction: "right" });
  const input = harness.document.createElement("input");
  first.container.append(input);
  const priorFocus = first.term.focusCount;
  input.focus();
  assert.equal(harness.activeId, first.id);
  assert.equal(harness.active, first);
  assert.equal(harness.focused, input);
  assert.equal(first.term.focusCount, priorFocus);
  assert.equal(harness.historyTargets.at(-1), first.id);
  second.container.dispatchEvent(new harness.window.Event("pointerdown", { bubbles: true }));
  assert.equal(harness.active, second);
  assert.equal(harness.focused, input);
  harness.call("focusOtherPane");
  assert.equal(harness.active, first);
  assert.equal(harness.focused, first.term.input);
  assert.equal(first.term.focusCount, priorFocus + 1);
});

test("switching tabs restores the focused pane and refits both visible terminals", async () => {
  const harness = createHarness();
  const first = await harness.local();
  const second = await harness.local("cmd", { tabId: first.id, direction: "below" });
  const other = await harness.local();
  assert.equal(first.container.classList.contains("active"), false);
  assert.equal(second.container.classList.contains("active"), false);
  assert.equal(first.container.inert, true);
  harness.fits.length = 0;
  harness.call("switchTab", first.id);
  assert.equal(harness.active, second);
  assert.equal(harness.focused, second.term.input);
  assert.equal(other.container.inert, true);
  harness.flushTimers();
  assert.ok(harness.fits.includes(first.id));
  assert.ok(harness.fits.includes(second.id));
});

test("keyboard divider resizing updates the group's saved ratio and rendered layout without switching panes", async () => {
  const harness = createHarness();
  const first = await harness.local();
  const second = await harness.local("cmd", { tabId: first.id, direction: "right" });
  const divider = harness.find(".terminal-pane-divider");
  const event = new harness.window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value: "ArrowRight" });
  divider.dispatchEvent(event);
  assert.equal(harness.groups[0].ratio, 0.55);
  assert.equal(Number.parseFloat(harness.find(".terminal-tab-view").style.getPropertyValue("--pane-ratio")).toFixed(2), "55.00");
  assert.equal(divider.getAttribute("aria-valuenow"), "55");
  assert.equal(harness.active, second);
});

test("closing the original pane preserves its stable tab and surviving connection", async () => {
  const harness = createHarness();
  const first = await harness.local();
  const second = await harness.ssh({ tabId: first.id, direction: "right" });
  const transport = second.connectionId;
  await harness.closePane(first);
  assert.equal(harness.tabs.length, 1);
  assert.equal(harness.tabs[0].dataset.id, first.id);
  assert.equal(harness.activeId, first.id);
  assert.equal(harness.active, second);
  assert.deepEqual(harness.groups[0].sessionIds, [second.id]);
  assert.equal(harness.call("getSessionTabId", second.id), first.id);
  assert.equal(second.connectionId, transport);
  assert.equal(second.term.disposeCount, 0);
  assert.equal(first.term.disposeCount, 1);
  assert.equal(second.paneLabel, undefined);
  assert.equal(second.container.parentElement, harness.find("#workspace-viewport"));
  assert.equal(harness.document.querySelector(".terminal-tab-view"), null);
  assert.equal(harness.calls.filter(call => call.command === "disconnect_ssh").length, 0);
  assert.equal(harness.calls.filter(call => call.command === "stop_local_terminal").length, 1);
});

test("closing one pane leaves the other running and whole-tab close disposes both transports once", async () => {
  const harness = createHarness();
  const first = await harness.ssh();
  const second = await harness.local("powershell", { tabId: first.id, direction: "below" });
  const other = await harness.local();
  harness.call("switchTab", first.id);
  await Promise.all([harness.closeTab(first.id), harness.closeTab(first.id)]);
  assert.deepEqual(Array.from(harness.sessions, session => session.id), [other.id]);
  assert.equal(first.term.disposeCount, 1);
  assert.equal(second.term.disposeCount, 1);
  assert.equal(other.term.disposeCount, 0);
  assert.equal(harness.active, other);
  assert.deepEqual(harness.calls.filter(call => ["disconnect_ssh", "stop_local_terminal"].includes(call.command)).map(call => ({
    command: call.command, id: call.arguments_.sessionId,
  })), [
    { command: "disconnect_ssh", id: first.connectionId },
    { command: "stop_local_terminal", id: second.id },
  ]);
});

test("closing an inactive pane or background tab preserves the current terminal focus", async () => {
  const harness = createHarness();
  const first = await harness.local();
  const second = await harness.local("cmd", { tabId: first.id, direction: "right" });
  const active = await harness.local();
  const input = active.term.input;
  const focusCount = active.term.focusCount;
  await harness.closePane(first);
  assert.equal(harness.active, active);
  assert.equal(harness.focused, input);
  assert.equal(active.term.focusCount, focusCount);
  await harness.closeTab(first.id);
  assert.equal(second.term.disposeCount, 1);
  assert.equal(harness.active, active);
  assert.equal(harness.focused, input);
  assert.equal(active.term.focusCount, focusCount);
});

test("closing a tab while one pane is already closing disposes each native session once", async () => {
  const completion = Promise.withResolvers<void>();
  const harness = createHarness({ invoke: async call => { if (call.command === "stop_local_terminal") await completion.promise; } });
  const first = await harness.local();
  const second = await harness.ssh({ tabId: first.id, direction: "right" });
  const paneClose = harness.closePane(first);
  const tabClose = harness.closeTab(first.id);
  completion.resolve();
  await Promise.all([paneClose, tabClose]);
  assert.equal(first.term.disposeCount, 1);
  assert.equal(second.term.disposeCount, 1);
  assert.equal(harness.calls.filter(call => call.command === "stop_local_terminal").length, 1);
  assert.equal(harness.calls.filter(call => call.command === "disconnect_ssh").length, 1);
  assert.equal(harness.sessions.length, 0);
  assert.equal(harness.tabs.length, 0);
});

for (const firstCompletedKind of ["local", "ssh"] as const) {
  test(`closing both panes concurrently removes the tab when ${firstCompletedKind} disconnect completes first`, async () => {
    const completions = { local: Promise.withResolvers<void>(), ssh: Promise.withResolvers<void>() };
    const disposals = { local: Promise.withResolvers<void>(), ssh: Promise.withResolvers<void>() };
    const harness = createHarness({ invoke: async call => {
      if (call.command === "stop_local_terminal") await completions.local.promise;
      if (call.command === "disconnect_ssh") await completions.ssh.promise;
    } });
    const local = await harness.local();
    const ssh = await harness.ssh({ tabId: local.id, direction: "right" });
    const sessions = { local, ssh };
    for (const kind of ["local", "ssh"] as const) {
      const dispose = sessions[kind].term.dispose;
      sessions[kind].term.dispose = () => { dispose(); disposals[kind].resolve(); };
    }
    const localClose = harness.closePane(local);
    const sshClose = harness.closePane(ssh);
    const lastCompletedKind = firstCompletedKind === "local" ? "ssh" : "local";
    assert.equal(local.isClosing, true);
    assert.equal(ssh.isClosing, true);
    completions[firstCompletedKind].resolve();
    await disposals[firstCompletedKind].promise;
    assert.equal(sessions[firstCompletedKind].term.disposeCount, 1);
    assert.equal(sessions[lastCompletedKind].term.disposeCount, 0);
    completions[lastCompletedKind].resolve();
    await Promise.all([localClose, sshClose]);
    assert.equal(local.term.disposeCount, 1);
    assert.equal(ssh.term.disposeCount, 1);
    assert.equal(harness.calls.filter(call => call.command === "stop_local_terminal").length, 1);
    assert.equal(harness.calls.filter(call => call.command === "disconnect_ssh").length, 1);
    assert.equal(harness.sessions.length, 0);
    assert.equal(harness.groups.length, 0);
    assert.equal(harness.tabs.length, 0);
    assert.equal(harness.activeId, null);
    assert.equal(harness.active, undefined);
    assert.equal(harness.document.querySelector(".terminal-tab-view"), null);
    assert.equal(harness.find("#welcome-screen").classList.contains("hidden"), false);
  });
}

test("closing the last pane returns to the empty workspace and cleans up retained pane listeners", async () => {
  const harness = createHarness();
  const session = await harness.local();
  await harness.closePane(session);
  session.container.dispatchEvent(new harness.window.Event("pointerdown", { bubbles: true }));
  assert.equal(harness.activeId, null);
  assert.equal(harness.active, undefined);
  assert.equal(harness.sessions.length, 0);
  assert.equal(harness.groups.length, 0);
  assert.equal(harness.tabs.length, 0);
  assert.equal(harness.find("#welcome-screen").classList.contains("hidden"), false);
  await harness.closePane(session);
  await harness.closeTab(session.id);
  assert.equal(session.term.disposeCount, 1);
});

test("a pending second-pane launch reserves the slot and rejects a concurrent third terminal", async () => {
  const completion = Promise.withResolvers<void>();
  let starts = 0;
  const harness = createHarness({ invoke: async call => {
    if (call.command === "start_local_terminal" && ++starts === 2) await completion.promise;
  } });
  const first = await harness.local();
  const secondLaunch = harness.local("cmd", { tabId: first.id, direction: "right" });
  assert.equal(harness.groups[0].sessionIds.length, 2);
  await assert.rejects(harness.local("powershell", { tabId: first.id, direction: "below" }), /already has two panes/);
  assert.equal(harness.sessions.length, 2);
  assert.equal(harness.tabs.length, 1);
  assert.equal(starts, 2);
  completion.resolve();
  await secondLaunch;
});

test("pending local and SSH launches cannot steal focus from another pane on completion", async () => {
  for (const kind of ["local", "ssh"] as const) {
    const completion = Promise.withResolvers<void>();
    const harness = createHarness({ invoke: async call => {
      if ((kind === "ssh" && call.command === "connect_ssh") || (kind === "local" && call.command === "start_local_terminal" && call.arguments_.shell === "cmd")) await completion.promise;
    } });
    const first = await harness.local();
    const launch = kind === "ssh" ? harness.ssh({ tabId: first.id, direction: "right" }) : harness.local("cmd", { tabId: first.id, direction: "right" });
    harness.activate(first);
    const focusCount = first.term.focusCount;
    completion.resolve();
    const second = await launch;
    assert.equal(harness.active, first, kind);
    assert.equal(harness.focused, first.term.input, kind);
    assert.equal(first.term.focusCount, focusCount, kind);
    assert.equal(second.term.focusCount, 0, kind);
  }
});

test("closing a pane during local or SSH startup prevents its late completion from restoring the pane", async () => {
  for (const kind of ["local", "ssh"] as const) {
    const completion = Promise.withResolvers<void>();
    const harness = createHarness({ invoke: async call => {
      if ((kind === "ssh" && call.command === "connect_ssh") || (kind === "local" && call.command === "start_local_terminal" && call.arguments_.shell === "cmd")) await completion.promise;
    } });
    const first = await harness.local();
    const launch = kind === "ssh" ? harness.ssh({ tabId: first.id, direction: "below" }) : harness.local("cmd", { tabId: first.id, direction: "below" });
    const pending = harness.sessions.find(session => session.id !== first.id)!;
    await harness.closePane(pending);
    completion.resolve();
    await launch;
    assert.deepEqual(Array.from(harness.sessions, session => session.id), [first.id], kind);
    assert.equal(harness.active, first, kind);
    assert.equal(harness.tabs.length, 1, kind);
    assert.equal(pending.term.disposeCount, 1, kind);
    assert.equal(pending.term.focusCount, 0, kind);
    assert.equal(harness.document.querySelector(".terminal-tab-view"), null, kind);
  }
});

test("invalid or closed split destinations fail before allocating terminals", async () => {
  const harness = createHarness();
  assert.equal(harness.active, undefined);
  assert.doesNotThrow(() => harness.call("focusOtherPane"));
  for (const destination of [{ tabId: "missing", direction: "right" }, { tabId: "", direction: "below" }]) {
    await assert.rejects(harness.local("powershell", destination as Destination));
  }
  const first = await harness.local();
  await assert.rejects(harness.local("cmd", { tabId: first.id, direction: "invalid" as PaneDirection }), /Split right or Split below/);
  await harness.closeTab(first.id);
  const priorCalls = harness.calls.length;
  await assert.rejects(harness.ssh({ tabId: first.id, direction: "right" }), /closed/);
  assert.equal(harness.calls.length, priorCalls);
  assert.equal(harness.sessions.length, 0);
  assert.equal(harness.groups.length, 0);
});

test("disconnect failures remain visible while closing one pane preserves the survivor", async () => {
  const harness = createHarness({ invoke: async call => { if (call.command === "stop_local_terminal") throw new Error("Native stop unavailable"); } });
  const first = await harness.local();
  const second = await harness.ssh({ tabId: first.id, direction: "right" });
  await harness.closePane(first);
  assert.equal(harness.active, second);
  assert.equal(second.isClosed, false);
  assert.match(harness.notifications.at(-1)!, /Could not confirm.*Native stop unavailable/);
});

test("splitting the current terminal preserves its local folder or SSH directory with a fresh native session", async () => {
  for (const kind of ["local", "ssh"] as const) {
    const harness = createHarness();
    const first = kind === "local" ? await harness.local("cmd") : await harness.ssh();
    if (kind === "ssh") {
      first.terminalPath = "/srv/project";
      first.sftpPanelOpen = false;
    }
    const second = await harness.split("current", "right");
    assert.notEqual(second.id, first.id);
    assert.equal(second.kind, kind);
    assert.equal(harness.groups[0].sessionIds.length, 2);
    if (kind === "local") {
      assert.equal(second.shell, "cmd");
      assert.equal(second.workingDirectory, DIRECTORY);
      assert.equal(second.locationName, "Project");
    } else {
      assert.notEqual(second.connectionId, first.connectionId);
      assert.equal(second.terminalPath, "/srv/project");
      assert.equal(second.currentPath, "/srv/project");
      assert.equal(second.sftpPanelOpen, false);
    }
  }
});

test("split choices open the selected shell, saved SSH host, or saved folder", async () => {
  const location = { id: "project", name: "Project folder", path: DIRECTORY };
  for (const choice of ["powershell", "cmd", "host:" + PROFILE.id, "location:" + location.id]) {
    const harness = createHarness();
    harness.context.savedTestProfile = PROFILE;
    harness.context.savedTestLocation = location;
    harness.evaluate("savedProfiles = [savedTestProfile]; window.SleekSshLocalTerminals = { loadLocations: () => [savedTestLocation] }");
    const first = await harness.local();
    const second = await harness.split(choice, "below");
    assert.equal(harness.groups[0].direction, "below", choice);
    assert.equal(harness.activeId, first.id, choice);
    assert.equal(harness.active, second, choice);
    if (choice.startsWith("host:")) {
      assert.equal(second.kind, "ssh");
      assert.equal(harness.calls.find(call => call.command === "connect_ssh")?.arguments_.host, PROFILE.host);
    } else {
      assert.equal(second.kind, "local");
      assert.equal(second.shell, choice === "cmd" ? "cmd" : "powershell");
      assert.equal(second.workingDirectory, choice.startsWith("location:") ? DIRECTORY : null);
    }
  }
});

test("invalid split selections release the reservation and stale source panes cannot launch", async () => {
  const harness = createHarness();
  const first = await harness.local();
  for (const choice of ["", "unknown", "host:missing", "location:missing"]) {
    await assert.rejects(harness.split(choice, "right"));
    assert.equal(harness.sessions.length, 1);
    assert.equal(harness.evaluate("splittingTabs.size"), 0);
  }
  const other = await harness.local("cmd");
  await assert.rejects(harness.split("current", "right", first.id, other.id), /source terminal/);
  assert.equal(harness.sessions.length, 2);
  await harness.closeTab(first.id);
  await assert.rejects(harness.split("current", "right", first.id, first.id), /closed/);
  assert.equal(harness.active, other);
});

test("the split picker lists saved choices as text and pins the original tab until submission", async () => {
  const harness = createHarness();
  harness.call("initPanePicker");
  harness.context.savedTestProfile = { ...PROFILE, name: "API <b>host</b>" };
  harness.context.savedTestLocation = { id: "project", name: "Folder <b>name</b>", path: DIRECTORY };
  harness.evaluate("savedProfiles = [savedTestProfile]; window.SleekSshLocalTerminals = { loadLocations: () => [savedTestLocation] }");
  const first = await harness.local();
  first.container.querySelector<HTMLButtonElement>(".session-split-below")!.click();
  assert.equal(harness.find("#pane-picker").hasAttribute("open"), true);
  assert.equal(harness.find("#pane-picker-title").textContent, "Split below");
  const select = harness.find<HTMLSelectElement>("#pane-picker-terminal");
  assert.equal(harness.focused, select);
  assert.deepEqual([...select.querySelectorAll("option")].map(option => option.value), ["current", "powershell", "cmd", "host:" + PROFILE.id, "location:project"]);
  assert.match(select.textContent!, /API <b>host<\/b>/);
  assert.equal(select.querySelector("b"), null);
  const other = await harness.local("cmd");
  await harness.submitPane("powershell");
  assert.equal(harness.find("#pane-picker").hasAttribute("open"), false);
  assert.equal(harness.groups.find(group => group.id === first.id)?.sessionIds.length, 2);
  assert.equal(harness.groups.find(group => group.id === other.id)?.sessionIds.length, 1);
  assert.equal(harness.activeId, first.id);
  assert.equal(harness.groups.find(group => group.id === first.id)?.direction, "below");
  for (const session of harness.sessions.filter(session => session.id !== other.id)) {
    assert.equal(session.container.querySelector<HTMLButtonElement>(".session-split-right")!.hidden, true);
    assert.equal(session.container.querySelector<HTMLButtonElement>(".session-split-below")!.hidden, true);
    assert.equal(session.container.querySelector<HTMLButtonElement>(".session-close-pane")!.hidden, false);
  }
  harness.call("showPaneSplit", "right");
  assert.equal(harness.find("#pane-picker").hasAttribute("open"), false);
  assert.match(harness.notifications.at(-1)!, /already has two panes/);
});

test("cancelling the split picker creates no session and stale submitted destinations fail visibly", async () => {
  const harness = createHarness();
  harness.call("initPanePicker");
  harness.call("showPaneSplit", "right");
  assert.match(harness.notifications.at(-1)!, /Select a terminal/);
  const first = await harness.local();
  first.container.querySelector<HTMLButtonElement>(".session-split-right")!.click();
  assert.equal(harness.find("#pane-picker-title").textContent, "Split right");
  harness.find<HTMLButtonElement>("#pane-picker-cancel").click();
  assert.equal(harness.find("#pane-picker").hasAttribute("open"), false);
  assert.equal(harness.focused, first.term.input);
  await harness.submitPane("cmd");
  assert.equal(harness.sessions.length, 1);
  harness.call("showPaneSplit", "right");
  await harness.closeTab(first.id);
  await harness.submitPane("cmd");
  assert.equal(harness.sessions.length, 0);
  assert.equal(harness.find("#pane-picker").hasAttribute("open"), false);
  assert.match(harness.notifications.at(-1)!, /Could not split.*closed/);
});

test("pane focus shortcuts select the other pane and close shortcuts distinguish pane from tab", async () => {
  const harness = createHarness();
  harness.call("initSessionShortcuts");
  const first = await harness.local();
  const second = await harness.ssh({ tabId: first.id, direction: "right" });
  for (const code of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
    const prior = harness.active;
    const event = await harness.key(code);
    assert.equal(event.defaultPrevented, true, code);
    assert.notEqual(harness.active, prior, code);
    assert.equal(harness.focused, harness.active!.term.input, code);
  }
  assert.equal(harness.active, second);
  assert.equal((await harness.key("KeyW")).defaultPrevented, true);
  assert.equal(harness.active, first);
  assert.equal(second.term.disposeCount, 1);
  assert.equal(first.term.disposeCount, 0);
  assert.equal((await harness.key("KeyW")).defaultPrevented, false);
  assert.equal(harness.sessions.length, 1);
  assert.equal((await harness.key("KeyW", { altKey: false })).defaultPrevented, true);
  assert.equal(first.term.disposeCount, 1);
  assert.equal(harness.sessions.length, 0);
});

test("pane shortcuts ignore dialogs, repeats, shifted keys, and non-split tabs", async () => {
  const harness = createHarness();
  harness.call("initSessionShortcuts");
  const first = await harness.local();
  assert.equal((await harness.key("ArrowRight")).defaultPrevented, false);
  const second = await harness.ssh({ tabId: first.id, direction: "right" });
  for (const modifiers of [{ repeat: true }, { shiftKey: true }, { ctrlKey: false }, { altKey: false }]) {
    assert.equal((await harness.key("ArrowLeft", modifiers)).defaultPrevented, false);
    assert.equal(harness.active, second);
  }
  harness.find("#pane-picker").setAttribute("open", "");
  assert.equal((await harness.key("ArrowLeft")).defaultPrevented, false);
  assert.equal((await harness.key("KeyW")).defaultPrevented, false);
  assert.equal(harness.active, second);
  assert.equal(harness.sessions.length, 2);
  harness.find("#pane-picker").removeAttribute("open");
  assert.equal((await harness.key("ArrowLeft")).defaultPrevented, true);
  assert.equal(harness.active, first);
});
