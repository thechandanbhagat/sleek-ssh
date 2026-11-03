import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { createTerminalGroups } from "../src/terminal-panes.ts";

const SOURCE = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const INITIALIZER = SOURCE.slice(SOURCE.indexOf("function initCommandHistory()"), SOURCE.indexOf("// --- PANEL LAYOUT ---"));
const FOCUS_HELPER = SOURCE.slice(SOURCE.indexOf("function getActiveSession()"), SOURCE.indexOf("function getSessionTabId("));

function createHarness(failure?: Error) {
  const calls: Array<{ command: string; sessionId: string; text: string }> = [];
  const notifications: string[] = [];
  const error = { textContent: "", hidden: true };
  const listeners = new Map<string, () => void>();
  let options: {
    sendText: (session: object, text: string) => void;
    writeSnippet: (session: object, text: string) => Promise<void>;
    getSession: () => object | null;
    onLayoutChange: () => void;
    openFiles: () => void;
  } | undefined;
  let resets = 0;
  let layouts = 0;
  const context = createContext({
    window: {
      localStorage: {},
      SleekSshHistory: {
        initCommandHistoryIntegration(value: typeof options) { options = value; return {}; },
      },
    },
    document: { getElementById: (id: string) => id === "command-history-error" ? error : {
      addEventListener: (event: string, listener: () => void) => listeners.set(event, listener),
    } },
    activeSessions: {}, activeTabId: "selected", terminalGroups: createTerminalGroups(),
    invoke: async (command: string, arguments_: { sessionId: string; dataBase64: string }) => {
      calls.push({ command, sessionId: arguments_.sessionId, text: Buffer.from(arguments_.dataBase64, "base64").toString("utf8") });
      if (failure) throw failure;
    },
    stringToBase64: (text: string) => Buffer.from(text).toString("base64"),
    closeAgentPanel() {}, openAgentPanel() {},
    refreshPanelLayout: () => { layouts += 1; }, refreshWorkspaceChrome() {},
    showNotification: (message: string) => notifications.push(message),
  });
  runInContext(FOCUS_HELPER + INITIALIZER + "; initCommandHistory();", context);
  return {
    context, calls, notifications, error, listeners,
    get options() { assert(options); return options; },
    get layouts() { return layouts; },
    get resets() { return resets; },
    session(kind: "ssh" | "local") {
      return { id: "tab-1", kind, connectionId: kind === "ssh" ? "transport-1" : null,
        commandHistory: { reset: () => { resets += 1; } }, term: { paste: () => assert.fail("Completion must use the transport once.") } };
    },
  };
}

test("main inserts historical completion once through the selected transport without Enter", async () => {
  const harness = createHarness();
  harness.options.sendText(harness.session("ssh"), " status — résumé");
  harness.options.sendText(harness.session("local"), " status");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.calls, [
    { command: "write_ssh", sessionId: "transport-1", text: " status — résumé" },
    { command: "write_local_terminal", sessionId: "tab-1", text: " status" },
  ]);
  assert.equal(harness.options.getSession(), null);
  harness.options.onLayoutChange();
  assert.equal(harness.layouts, 1);
});

test("completion transport failure is visible and resets the active prompt state", async () => {
  const harness = createHarness(new Error("Connection unavailable"));
  harness.options.sendText(harness.session("ssh"), " status");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.resets, 1);
  assert.match(harness.notifications[0], /Could not insert the historical command.*Connection unavailable/);
});

test("an old completion failure cannot reset a reconnected prompt", async () => {
  const harness = createHarness(new Error("Old connection unavailable"));
  const session = harness.session("ssh");
  harness.options.sendText(session, " status");
  session.connectionId = "replacement-transport";
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.resets, 0);
  assert.deepEqual(harness.notifications, []);
});

test("history startup errors remain visible and its trigger explains the failure", () => {
  const harness = createHarness();
  runInContext("window.SleekSshHistory.initCommandHistoryIntegration = () => { throw new Error('Invalid saved history'); }; initCommandHistory();", harness.context);
  assert.equal(harness.error.hidden, false);
  assert.match(harness.error.textContent, /Command history could not load.*Invalid saved history/);
  harness.listeners.get("click")?.();
  assert.equal(harness.notifications.length, 2);
});

test("an unavailable history bundle leaves existing terminal initialization usable", () => {
  const harness = createHarness();
  assert.doesNotThrow(() => runInContext("window.SleekSshHistory = undefined; initCommandHistory();", harness.context));
});

test("snippet writes await one native transport request and preserve the exact reviewed payload", async () => {
  for (const kind of ["ssh", "local"] as const) {
    const harness = createHarness();
    const session = { ...harness.session(kind), isReady: true };
    harness.context.selectedSession = session;
    runInContext("activeSessions.selected = selectedSession", harness.context);
    await harness.options.writeSnippet(session, "echo 'résumé'\r");
    assert.deepEqual(harness.calls, [{ command: kind === "ssh" ? "write_ssh" : "write_local_terminal",
      sessionId: kind === "ssh" ? "transport-1" : "tab-1", text: "echo 'résumé'\r" }]);
  }
});

test("snippet transport failures propagate to the preview instead of reporting success", async () => {
  const harness = createHarness(new Error("Native write failed"));
  const session = harness.session("ssh");
  harness.context.selectedSession = session;
  runInContext("activeSessions.selected = selectedSession", harness.context);
  await assert.rejects(harness.options.writeSnippet(session, "pwd\r"), /Native write failed/);
  assert.equal(harness.calls.length, 1);
});

test("snippet transport refuses changed, disconnected, connecting, and unready targets", async () => {
  const harness = createHarness();
  const session = harness.session("ssh");
  await assert.rejects(harness.options.writeSnippet(session, "pwd\r"), /target terminal changed/);
  for (const update of [{ isClosed: true }, { isClosing: true }, { isConnecting: true }, { connectionId: null }, { kind: "local", isReady: false }]) {
    const target = { ...session, ...update };
    harness.context.selectedSession = target;
    runInContext("activeSessions.selected = selectedSession", harness.context);
    await assert.rejects(harness.options.writeSnippet(target, "pwd\r"), /target terminal/);
  }
  assert.deepEqual(harness.calls, []);
});

test("history and snippet writes resolve the focused pane rather than the containing tab ID", async () => {
  const harness = createHarness();
  const primary = { ...harness.session("ssh"), id: "primary", connectionId: "transport-primary" };
  const secondary = { ...harness.session("local"), id: "secondary", isReady: true };
  Object.assign(harness.context, { primary, secondary });
  runInContext("activeSessions = { primary, secondary }; terminalGroups.add('primary'); terminalGroups.add('secondary'); terminalGroups.split('primary', 'secondary', 'right'); activeTabId = 'primary';", harness.context);
  assert.equal(harness.options.getSession(), secondary);
  await assert.rejects(harness.options.writeSnippet(primary, "pwd\r"), /target terminal changed/);
  await harness.options.writeSnippet(secondary, "Write-Output 'second'\r");
  runInContext("terminalGroups.focus('primary')", harness.context);
  assert.equal(harness.options.getSession(), primary);
  await assert.rejects(harness.options.writeSnippet(secondary, "Write-Output 'stale'\r"), /target terminal changed/);
  await harness.options.writeSnippet(primary, "printf primary\r");
  assert.deepEqual(harness.calls, [
    { command: "write_local_terminal", sessionId: "secondary", text: "Write-Output 'second'\r" },
    { command: "write_ssh", sessionId: "transport-primary", text: "printf primary\r" },
  ]);
});
