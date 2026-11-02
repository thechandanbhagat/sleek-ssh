import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { parseHTML } from "linkedom";
import { captureWorkspace, initSavedWorkspacesIntegration, restoreWorkspace } from "../src/saved-workspaces-integration.ts";
import type { WorkspaceLayout, WorkspaceTab } from "../src/saved-workspaces.ts";
import { createTerminalGroups, initPaneDivider, type TerminalTabGroup } from "../src/terminal-panes.ts";
import * as remoteFolders from "../src/remote-folders.ts";

const SOURCE = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const WINDOW_WIDTH = 1500;
const RAIL_WIDTH = 48;
const SIDE_PANEL_WIDTH = 380;
const TERMINAL_COLUMNS = 100;
const TERMINAL_ROWS = 30;
const RESIZED_SIDEBAR_WIDTH = 320;
const WORKSPACE_STORAGE_KEY = "sleekssh_saved_workspaces";
const LAYOUT_STORAGE_KEY = "sleekssh_panel_layout";
const PROFILE = { id: "host-1", name: "API", host: "new.example.test", port: 22, username: "updated-user", key_path: "C:\\Keys\\new", password: "fictional-current-password", use_password: true };
const LAYOUT: WorkspaceLayout = { sidebarWidth: 300, sftpWidth: 340, sidebarOpen: true, sidebarView: "terminal", sidePanel: "files" };
const SSH_TAB: WorkspaceTab = { kind: "ssh", profileId: PROFILE.id, name: "Old API label", remotePath: "/srv/project's files", sftpPanelOpen: false };
const LOCAL_TAB: WorkspaceTab = { kind: "local", shell: "powershell", workingDirectory: "C:\\Projects\\O'Brien & [draft]", locationName: "App" };
type Invocation = { command: string; arguments_: Record<string, unknown> };
type Session = { id: string; kind: string; name: string; container: HTMLElement; isClosed: boolean; isClosing?: boolean; connectionId?: string; connectionError?: string; launchError?: string; terminalPath?: string | null; currentPath?: string | null; sftpPanelOpen?: boolean; workingDirectory?: string | null; connectionProfile?: typeof PROFILE };
type IntegrationOptions = Parameters<typeof initSavedWorkspacesIntegration>[0];
type PaletteItem = { id: string; title: string; group: string; run: () => unknown };

function createHarness(configuration: { invoke?: (call: Invocation) => Promise<unknown> } = {}) {
  const { document } = parseHTML(HTML);
  document.getElementsByName = name => document.querySelectorAll('[name="' + name + '"]') as unknown as NodeListOf<HTMLElement>;
  const calls: Invocation[] = [];
  const notifications: string[] = [];
  const disposed: string[] = [];
  const storage = new Map<string, string>();
  let integrationOptions: IntegrationOptions | null = null;
  const find = <T extends HTMLElement>(selector: string): T => {
    const result = document.querySelector<T>(selector);
    assert.ok(result, "Missing " + selector);
    return result;
  };
  const measure = (selector: string, width: number) => {
    find(selector).getBoundingClientRect = () => ({ width }) as DOMRect;
  };
  measure(".app-container", WINDOW_WIDTH);
  measure(".activity-rail", RAIL_WIDTH);
  measure("#automation-panel", SIDE_PANEL_WIDTH);
  measure("#command-history-panel", SIDE_PANEL_WIDTH);
  const context = createContext({
    document,
    window: {
      __TAURI__: {
        core: { async invoke(command: string, arguments_: Record<string, unknown> = {}) {
          const call = { command, arguments_ };
          calls.push(call);
          if (configuration.invoke) return configuration.invoke(call);
          if (command === "load_connections") return [PROFILE];
        } },
        event: { async listen() { return () => {}; } },
      },
      SleekSshWorkspaces: { initSavedWorkspacesIntegration(options: IntegrationOptions) { integrationOptions = options; return initSavedWorkspacesIntegration(options); } },
      SleekSshPanes: { createTerminalGroups, initPaneDivider },
      SleekSshHistory: { controller: {
        close() { find("#command-history-panel").hidden = true; },
        open() { find("#command-history-panel").hidden = false; runInContext("closeAgentPanel()", context); },
        refresh() {},
      } },
      addEventListener() {}, setTimeout: () => 1, clearTimeout() {},
    },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    crypto: { randomUUID }, console: { error() {}, warn() {}, log() {} },
    setTimeout: () => 1, clearTimeout() {}, TextEncoder, TextDecoder, btoa, atob,
  });
  runInContext(SOURCE, context, { filename: "src/main.js" });
  Object.assign(context, {
    refreshWorkspaceChrome() {}, scheduleTerminalSearchRefresh() {}, fitTerminal() {}, initSessionToolbar() {}, updateSessionToolbar() {}, initSftpForSession() {},
    showNotification(message: string) { notifications.push(message); },
    initSessionPanelLayout(session: Session) { session.container.classList.toggle("sftp-collapsed", !session.sftpPanelOpen); },
    async loadSftpDirectory(session: Session, path: string) { session.currentPath = path; },
    closeAgentPanel() { find("#automation-panel").hidden = true; runInContext("agentUiState = {...agentUiState, open:false}", context); },
    openAgentPanel() { find("#automation-panel").hidden = false; find("#command-history-panel").hidden = true; runInContext("agentUiState = {...agentUiState, open:true}", context); },
    createTerminalForSession(session: Session & { term?: object; fitAddon?: object }) {
      session.term = { cols: TERMINAL_COLUMNS, rows: TERMINAL_ROWS, options: {}, focus() {}, write() {}, onData() {},
        dispose() { disposed.push(session.id); }, parser: { registerOscHandler() { return { dispose() {} }; } } };
      session.fitAddon = { fit() {} };
      return session.term;
    },
  });
  const evaluate = <T>(source: string): T => runInContext(source, context) as T;
  const call = <T>(name: string, ...arguments_: unknown[]): T => {
    context.testArguments = arguments_;
    return evaluate<T>(name + "(...testArguments)");
  };
  call("initSavedWorkspaces");
  return {
    context, document, find, calls, notifications, disposed, storage, call, evaluate,
    get integration() { assert.ok(integrationOptions); return integrationOptions; },
    get sessions() { return evaluate<Session[]>("Object.values(activeSessions)"); },
    get activeId() { return evaluate<string | null>("activeTabId"); },
    get focusedSession() { return call<Session | undefined>("getActiveSession"); },
    get groups() { return evaluate<readonly TerminalTabGroup[]>("terminalGroups.all()"); },
    get tabs() { return [...document.querySelectorAll<HTMLElement>(".terminal-tab")].map(tab => tab.dataset.id!); },
    setProfiles(profiles: readonly object[]) { context.testProfiles = profiles; evaluate("savedProfiles = testProfiles"); },
    open(tab: WorkspaceTab) { return call<Promise<{ sessionId: string; error?: string }>>("openWorkspaceTab", tab); },
    capture() { return call<Parameters<typeof captureWorkspace>[0]>("captureWorkspaceState"); },
    restore(layout: WorkspaceLayout, id: string) { call("restoreWorkspaceLayout", layout, id); },
  };
}

test("new SSH sessions start in the saved host folder while workspaces retain their own folder", async () => {
  const h = createHarness();
  h.setProfiles([PROFILE]);
  h.context.window.SleekSshRemoteFolders = remoteFolders;
  const storage = h.context.localStorage;
  remoteFolders.saveRemoteFolders(storage, PROFILE.id, { startPath: "~/app files", folders: [{ name: "Logs", path: "/var/log" }] });
  const fresh = await h.call<Promise<Session>>("connectProfile", PROFILE);
  assert.equal(fresh.terminalPath, "~/app files");
  assert.ok(h.calls.some(call => call.command === "connect_ssh" && String(call.arguments_.terminalSetup).includes('cd "$HOME"\'/app files\'')));
  await h.open(SSH_TAB);
  assert.equal(h.focusedSession?.terminalPath, SSH_TAB.remotePath);
  assert.equal(remoteFolders.loadRemoteFolders(storage, PROFILE.id).startPath, "~/app files");
});

test("each SSH session palette exposes only that host's saved folders and binds its actions", async () => {
  const h = createHarness();
  const other = { ...PROFILE, id: "other", name: "Other", host: "other.test" };
  h.setProfiles([PROFILE, other]); h.context.window.SleekSshRemoteFolders = remoteFolders;
  h.context.window.SleekSshHistory.controller.listSnippets = () => [];
  remoteFolders.saveRemoteFolders(h.context.localStorage, PROFILE.id, { startPath: "/app", folders: [{ name: "API logs", path: "/var/log/api" }] });
  remoteFolders.saveRemoteFolders(h.context.localStorage, other.id, { startPath: "", folders: [{ name: "Other logs", path: "/var/log/other" }] });
  await h.call("connectProfile", PROFILE);
  h.evaluate("sessionPaletteSession = getActiveSession()");
  const first = h.call<Array<{ title: string; subtitle?: string }>>("buildSessionPaletteItems");
  assert.ok(first.some(item => item.title === "API logs"));
  assert.ok(first.some(item => item.title === "Save current folder…"));
  assert.equal(first.some(item => item.title === "Other logs"), false);
  await h.call("connectProfile", other);
  h.evaluate("sessionPaletteSession = getActiveSession()");
  const second = h.call<Array<{ title: string }>>("buildSessionPaletteItems");
  assert.ok(second.some(item => item.title === "Other logs"));
  assert.equal(second.some(item => item.title === "API logs"), false);
});

test("main captures actual DOM tab order, duplicate hosts, local launch folders, and the active tab", async () => {
  const harness = createHarness();
  harness.setProfiles([PROFILE]);
  const first = await harness.open(SSH_TAB);
  const local = await harness.open(LOCAL_TAB);
  const duplicate = await harness.open({ ...SSH_TAB, remotePath: "/var/log", sftpPanelOpen: true });
  assert.notEqual(first.sessionId, duplicate.sessionId);
  const container = harness.find("#tabs-container");
  container.prepend(harness.find('.terminal-tab[data-id="' + local.sessionId + '"]'));
  harness.call("switchTab", first.sessionId);
  const state = harness.capture();
  assert.deepEqual(Array.from(state.sessions, session => session.id), [local.sessionId, first.sessionId, duplicate.sessionId]);
  const snapshot = captureWorkspace(state);
  assert.equal(snapshot.activeTabIndex, 1);
  assert.deepEqual(snapshot.tabs, [LOCAL_TAB, { ...SSH_TAB, name: PROFILE.name }, { ...SSH_TAB, name: PROFILE.name, remotePath: "/var/log", sftpPanelOpen: true }]);
  assert.equal(JSON.stringify(snapshot).includes(PROFILE.password), false);
});

test("capture distinguishes Files, History, Agent and no panel", async () => {
  const harness = createHarness();
  harness.setProfiles([PROFILE]);
  await harness.open({ ...SSH_TAB, sftpPanelOpen: true });
  assert.equal(harness.capture().layout.sidePanel, "files");
  harness.call("openAgentPanel");
  assert.equal(harness.capture().layout.sidePanel, "agent");
  harness.evaluate("window.SleekSshHistory.controller.open()");
  assert.equal(harness.capture().layout.sidePanel, "history");
  harness.evaluate("window.SleekSshHistory.controller.close(); activeSessions[activeTabId].sftpPanelOpen = false");
  assert.equal(harness.capture().layout.sidePanel, "none");
});

for (const sidePanel of ["files", "history", "agent", "none"] as const) {
  test("restoring " + sidePanel + " restores sidebar dimensions, active tab and exclusive panel visibility", async () => {
    const harness = createHarness();
    harness.setProfiles([PROFILE]);
    const saved = await harness.open({ ...SSH_TAB, sftpPanelOpen: true });
    await harness.open(LOCAL_TAB);
    harness.call("openAgentPanel");
    const layout = { ...LAYOUT, sidePanel, sidebarOpen: sidePanel !== "none" };
    harness.restore(layout, saved.sessionId);
    assert.equal(harness.activeId, saved.sessionId);
    assert.equal(harness.find(".nav-tab.active").dataset.tab, layout.sidebarView);
    assert.deepEqual(JSON.parse(harness.storage.get(LAYOUT_STORAGE_KEY)!), { sidebarWidth: layout.sidebarWidth, sftpWidth: layout.sftpWidth, sidebarOpen: layout.sidebarOpen });
    assert.equal(harness.find(".app-container").style.getPropertyValue("--sidebar-width"), layout.sidebarOpen ? String(layout.sidebarWidth) + "px" : "0px");
    assert.equal(harness.find("#automation-panel").hidden, sidePanel !== "agent");
    assert.equal(harness.find("#command-history-panel").hidden, sidePanel !== "history");
    const session = harness.sessions.find(item => item.id === saved.sessionId)!;
    assert.equal(session.container.querySelector<HTMLElement>(".sftp-panel")!.inert, sidePanel !== "files");
    if (sidePanel === "files" || sidePanel === "none") {
      assert.equal(session.sftpPanelOpen, sidePanel === "files");
      assert.equal(session.container.classList.contains("sftp-collapsed"), sidePanel === "none");
    }
  });
}

test("workspace opening uses the current SSH profile and the workspace path/Files state", async () => {
  const harness = createHarness();
  harness.setProfiles([PROFILE]);
  harness.storage.set("sleekssh_sftp_explorer_state", JSON.stringify({ [PROFILE.id]: { currentPath: "/old", sftpPanelOpen: true } }));
  const opened = await harness.open(SSH_TAB);
  assert.equal(opened.error, undefined);
  const connection = harness.calls.find(call => call.command === "connect_ssh")!;
  assert.equal(connection.arguments_.host, PROFILE.host);
  assert.equal(connection.arguments_.username, PROFILE.username);
  assert.equal(connection.arguments_.password, PROFILE.password);
  assert.equal(connection.arguments_.profileId, PROFILE.id);
  assert.equal(typeof connection.arguments_.terminalSetup, "string");
  const session = harness.sessions.find(item => item.id === opened.sessionId)!;
  assert.equal(session.name, PROFILE.name);
  assert.equal(session.terminalPath, SSH_TAB.remotePath);
  assert.equal(session.sftpPanelOpen, false);
});

test("deleted SSH profiles fail before creating a tab or native connection", async () => {
  const harness = createHarness();
  await assert.rejects(harness.open(SSH_TAB), /saved host no longer exists/);
  assert.equal(harness.sessions.length, 0);
  assert.deepEqual(harness.calls, []);
});

test("workspace local launch returns its session and forwards the literal saved folder", async () => {
  const harness = createHarness();
  const result = await harness.open(LOCAL_TAB);
  assert.equal(result.error, undefined);
  const launch = harness.calls.find(call => call.command === "start_local_terminal")!;
  assert.equal(launch.arguments_.workingDirectory, LOCAL_TAB.workingDirectory);
  assert.equal(launch.arguments_.shell, LOCAL_TAB.shell);
  assert.equal(launch.arguments_.sessionId, result.sessionId);
  assert.equal(harness.sessions[0].workingDirectory, LOCAL_TAB.workingDirectory);
});

for (const [tab, command] of [[LOCAL_TAB, "start_local_terminal"], [SSH_TAB, "connect_ssh"]] as const) {
  test(tab.kind + " launch failure returns a disconnected tab and its specific error", async () => {
    const harness = createHarness({ invoke: async call => { if (call.command === command) throw new Error("Native launch denied"); } });
    harness.setProfiles([PROFILE]);
    const result = await harness.open(tab);
    assert.match(result.error ?? "", /Native launch denied/);
    assert.equal(harness.sessions[0].id, result.sessionId);
    assert.equal(harness.sessions[0].isClosed, true);
    assert.equal(harness.find(".terminal-tab").classList.contains("connection-terminated"), true);
  });
}

test("a local tab closed during native startup is reported and its process is stopped", async () => {
  const harness = createHarness({ invoke: async call => {
    if (call.command === "start_local_terminal") harness.evaluate("delete activeSessions[activeTabId]");
  } });
  await assert.rejects(harness.open(LOCAL_TAB), /closed while opening/);
  assert.ok(harness.calls.some(call => call.command === "stop_local_terminal"));
});

test("a SSH tab closed during connection is reported instead of becoming the restored active tab", async () => {
  const harness = createHarness({ invoke: async call => {
    if (call.command === "connect_ssh") harness.evaluate("delete activeSessions[activeTabId]");
  } });
  harness.setProfiles([PROFILE]);
  await assert.rejects(harness.open(SSH_TAB), /SSH tab was closed while opening/);
  assert.ok(harness.calls.some(call => call.command === "disconnect_ssh"));
});

test("restoring appends duplicate host tabs in saved order and leaves existing sessions open", async () => {
  const harness = createHarness();
  harness.setProfiles([PROFILE]);
  const existing = await harness.open(LOCAL_TAB);
  const snapshot = { tabs: [SSH_TAB, LOCAL_TAB, SSH_TAB], activeTabIndex: 1, layout: LAYOUT };
  const failures = await restoreWorkspace(snapshot, harness.integration);
  assert.deepEqual(failures, []);
  assert.equal(harness.sessions.length, 4);
  assert.equal(harness.tabs[0], existing.sessionId);
  assert.deepEqual(harness.tabs.slice(1).map(id => harness.sessions.find(session => session.id === id)!.kind), ["ssh", "local", "ssh"]);
  assert.equal(harness.activeId, harness.tabs[2]);
  assert.equal(new Set(harness.tabs).size, 4);
  assert.equal(harness.calls.some(call => ["disconnect_ssh", "stop_local_terminal"].includes(call.command)), false);
});

test("initialization prepares current profiles and supplies live presence checks to restoration", async () => {
  const harness = createHarness();
  await harness.integration.prepare();
  assert.deepEqual(Array.from(harness.capture().profileIds), [PROFILE.id]);
  assert.equal(harness.calls[0].command, "load_connections");
  const opened = await harness.open(LOCAL_TAB);
  assert.equal(harness.integration.hasSession(opened.sessionId), true);
  harness.evaluate("activeSessions[activeTabId].isClosing = true");
  assert.equal(harness.integration.hasSession(opened.sessionId), false);
  assert.equal(harness.integration.hasSession("gone"), false);
});

test("Save current and Manage palette actions reveal Workspaces; saved actions reopen the chosen workspace", async () => {
  const harness = createHarness();
  harness.storage.set(WORKSPACE_STORAGE_KEY, JSON.stringify({ version: 1, workspaces: [{ id: "daily", name: "Daily", tabs: [LOCAL_TAB], activeTabIndex: 0, layout: { ...LAYOUT, sidePanel: "none" } }] }));
  const items = harness.call<PaletteItem[]>("buildCommandPaletteItems");
  const save = items.find(item => item.id === "workspace:save")!;
  const manage = items.find(item => item.id === "workspace:manage")!;
  const open = items.find(item => item.id === "workspace:daily")!;
  assert.equal(open.group, "Workspaces");
  assert.equal(open.title, "Daily");
  manage.run();
  assert.equal(harness.find(".nav-tab.active").dataset.tab, "workspaces");
  save.run();
  assert.equal(harness.find<HTMLFormElement>("#saved-workspace-editor").hidden, false);
  await open.run();
  assert.equal(harness.sessions.length, 1);
  assert.equal(harness.sessions[0].workingDirectory, LOCAL_TAB.workingDirectory);
  assert.equal(harness.notifications.at(-1), "Opened Daily.");
});

test("missing workspace bundle gives a visible startup error without preventing normal terminal launch", async () => {
  const harness = createHarness();
  harness.evaluate("window.SleekSshWorkspaces = undefined; initSavedWorkspaces()");
  assert.equal(harness.find("#saved-workspaces-panel").getAttribute("role"), "alert");
  assert.match(harness.find("#saved-workspaces-panel").textContent ?? "", /could not load/);
  await harness.open(LOCAL_TAB);
  assert.equal(harness.sessions.length, 1);
});

test("a corrupted workspace list reports a palette error and retains general actions", () => {
  const harness = createHarness();
  harness.storage.set(WORKSPACE_STORAGE_KEY, "broken");
  const items = harness.call<PaletteItem[]>("buildCommandPaletteItems");
  assert.match(harness.notifications[0], /could not be read/);
  assert.ok(items.some(item => item.id === "shell:powershell"));
  assert.ok(items.some(item => item.id === "workspace:manage"));
});

test("Save current preserves the original hidden sidebar view while capturing current panel widths", async () => {
  const harness = createHarness();
  await harness.open(LOCAL_TAB);
  harness.context.testLayout = { sidebarWidth: LAYOUT.sidebarWidth, sftpWidth: LAYOUT.sftpWidth, sidebarOpen: false };
  harness.evaluate("panelLayoutPreferences = testLayout; refreshPanelLayout()");
  assert.equal(harness.find(".nav-tab.active").dataset.tab, "connections");
  assert.equal(harness.find(".app-container").classList.contains("sidebar-collapsed"), true);
  harness.call("showWorkspaceSave");
  assert.equal(harness.find(".nav-tab.active").dataset.tab, "workspaces");
  assert.equal(harness.find("#saved-workspace-editor").hidden, false);
  assert.equal(harness.find(".app-container").classList.contains("sidebar-collapsed"), false);
  harness.context.testSidebarWidth = RESIZED_SIDEBAR_WIDTH;
  harness.evaluate("panelLayoutPreferences = {...panelLayoutPreferences, sidebarWidth: testSidebarWidth}");
  const snapshot = captureWorkspace(harness.capture());
  assert.equal(snapshot.layout.sidebarView, "connections");
  assert.equal(snapshot.layout.sidebarOpen, false);
  assert.equal(snapshot.layout.sidebarWidth, RESIZED_SIDEBAR_WIDTH);
  assert.equal(snapshot.layout.sftpWidth, LAYOUT.sftpWidth);
});

test("a local terminal that exits during startup reports a failure even without a native error message", async () => {
  const harness = createHarness({ invoke: async call => {
    if (call.command === "start_local_terminal") harness.evaluate("activeSessions[activeTabId].isClosed = true");
  } });
  const result = await harness.open(LOCAL_TAB);
  assert.match(result.error ?? "", /closed|exited/i);
  assert.equal(harness.sessions[0].id, result.sessionId);
  assert.equal(harness.sessions[0].isClosed, true);
});

for (const [direction, ratio] of [["right", 0.2], ["below", 0.8]] as const) {
  for (const activePaneIndex of [0, 1] as const) {
    test(`workspace ${direction} split restores mixed panes, ratio ${ratio}, and focused pane ${activePaneIndex + 1}`, async () => {
      const harness = createHarness();
      harness.setProfiles([PROFILE]);
      const existing = await harness.open(LOCAL_TAB);
      const split = { direction, ratio, activePaneIndex, secondary: LOCAL_TAB };
      const layout = { ...LAYOUT, sidePanel: "none" as const };
      const failures = await restoreWorkspace({ tabs: [{ ...SSH_TAB, split }], activeTabIndex: 0, layout }, harness.integration);
      assert.deepEqual(failures, []);
      assert.equal(harness.sessions.length, 3);
      assert.equal(harness.tabs.length, 2);
      assert.equal(harness.tabs[0], existing.sessionId);
      const group = harness.groups[1];
      assert.deepEqual(group.sessionIds.map(id => harness.sessions.find(session => session.id === id)!.kind), ["ssh", "local"]);
      assert.equal(group.direction, direction);
      assert.equal(group.ratio, ratio);
      assert.equal(group.activeSessionId, group.sessionIds[activePaneIndex]);
      assert.equal(harness.activeId, group.id);
      assert.equal(harness.focusedSession?.id, group.sessionIds[activePaneIndex]);
      const view = harness.find('.terminal-tab-view[data-tab-id="' + group.id + '"]');
      assert.equal(view.dataset.direction, direction);
      assert.equal(view.classList.contains("is-active"), true);
      assert.equal(view.style.getPropertyValue("--pane-ratio"), `${ratio * 100}%`);
      assert.equal(view.querySelectorAll(".session-container.active").length, 2);
      const snapshot = captureWorkspace(harness.capture());
      assert.equal(snapshot.activeTabIndex, 1);
      assert.deepEqual(snapshot.tabs, [LOCAL_TAB, { ...SSH_TAB, name: PROFILE.name, split }]);
      assert.equal(harness.calls.some(call => ["disconnect_ssh", "stop_local_terminal"].includes(call.command)), false);
    });
  }
}

test("capture follows split focus changes and the original group survives closing its first pane", async () => {
  const harness = createHarness();
  harness.setProfiles([PROFILE]);
  const opened = await harness.open({ ...SSH_TAB, split: { direction: "below", ratio: 0.65, activePaneIndex: 0, secondary: LOCAL_TAB } });
  harness.restore({ ...LAYOUT, sidePanel: "history" }, opened.sessionId);
  const group = harness.groups[0];
  harness.call("activateSession", group.sessionIds[1]);
  assert.equal(harness.capture().activeSessionId, group.sessionIds[1]);
  assert.equal(captureWorkspace(harness.capture()).tabs[0].split?.activePaneIndex, 1);
  await harness.call<Promise<void>>("closeTerminalPane", group.sessionIds[0]);
  assert.equal(harness.sessions.length, 1);
  assert.deepEqual(harness.tabs, [group.id]);
  assert.equal(harness.activeId, group.id);
  assert.equal(harness.focusedSession?.id, group.sessionIds[1]);
  assert.deepEqual(captureWorkspace(harness.capture()).tabs, [LOCAL_TAB]);
  assert.equal(harness.document.querySelector(".terminal-tab-view"), null);
  assert.deepEqual(harness.disposed, [group.sessionIds[0]]);
  assert.equal(harness.calls.filter(call => call.command === "disconnect_ssh").length, 1);
  assert.equal(harness.calls.filter(call => call.command === "stop_local_terminal").length, 0);
});

for (const missingPane of [0, 1] as const) {
  test(`a missing saved SSH host in pane ${missingPane + 1} preserves the other restored pane`, async () => {
    const harness = createHarness();
    const missing = { ...SSH_TAB, profileId: "deleted" };
    const primary = missingPane === 0 ? missing : LOCAL_TAB;
    const secondary = missingPane === 0 ? LOCAL_TAB : missing;
    const result = await harness.open({ ...primary, split: { direction: "right", ratio: 0.5, activePaneIndex: missingPane, secondary } });
    assert.match(result.error ?? "", new RegExp(`Pane ${missingPane + 1}:.*saved host no longer exists`));
    assert.equal(harness.sessions.length, 1);
    assert.equal(harness.sessions[0].kind, "local");
    assert.equal(result.sessionId, harness.sessions[0].id);
    assert.equal(harness.groups[0].sessionIds.length, 1);
    assert.equal(harness.document.querySelector(".terminal-tab-view"), null);
    harness.restore({ ...LAYOUT, sidePanel: "none" }, result.sessionId);
    assert.equal(harness.focusedSession?.id, result.sessionId);
    assert.deepEqual(captureWorkspace(harness.capture()).tabs, [LOCAL_TAB]);
  });
}

test("restoration reports both missing panes without creating a terminal or changing existing tabs", async () => {
  const harness = createHarness();
  const existing = await harness.open(LOCAL_TAB);
  const missing: WorkspaceTab = { ...SSH_TAB, split: { direction: "below", ratio: 0.5, activePaneIndex: 1,
    secondary: { ...SSH_TAB, profileId: "also-deleted" } } };
  const failures = await restoreWorkspace({ tabs: [missing], activeTabIndex: 0, layout: LAYOUT }, harness.integration);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Pane 1:.*saved host no longer exists.*Pane 2:.*saved host no longer exists/);
  assert.deepEqual(harness.tabs, [existing.sessionId]);
  assert.equal(harness.focusedSession?.id, existing.sessionId);
  assert.equal(harness.calls.filter(call => call.command === "start_local_terminal").length, 1);
  assert.equal(harness.calls.filter(call => call.command === "connect_ssh").length, 0);
});

for (const failedKind of ["local", "ssh"] as const) {
  for (const failedPane of [0, 1] as const) {
    test(`a failed ${failedKind} launch in pane ${failedPane + 1} closes only the failed pane and keeps the healthy terminal`, async () => {
      const failedCommand = failedKind === "local" ? "start_local_terminal" : "connect_ssh";
      const cleanupCommand = failedKind === "local" ? "stop_local_terminal" : "disconnect_ssh";
      const healthyKind = failedKind === "local" ? "ssh" : "local";
      const failed = failedKind === "local" ? LOCAL_TAB : SSH_TAB;
      const healthy = failedKind === "local" ? SSH_TAB : LOCAL_TAB;
      const harness = createHarness({ invoke: async call => { if (call.command === failedCommand) throw new Error("Native launch unavailable"); } });
      harness.setProfiles([PROFILE]);
      const primary = failedPane === 0 ? failed : healthy;
      const secondary = failedPane === 0 ? healthy : failed;
      const result = await harness.open({ ...primary, split: { direction: "right", ratio: 0.5, activePaneIndex: failedPane, secondary } });
      assert.match(result.error ?? "", new RegExp(`Pane ${failedPane + 1}:.*Native launch unavailable`));
      assert.equal(harness.sessions.length, 1);
      assert.equal(harness.sessions[0].kind, healthyKind);
      assert.equal(harness.sessions[0].isClosed, false);
      assert.equal(result.sessionId, harness.sessions[0].id);
      assert.equal(harness.groups.length, 1);
      assert.equal(harness.groups[0].sessionIds.length, 1);
      assert.equal(harness.tabs.length, 1);
      assert.equal(harness.disposed.length, 1);
      const failedLaunch = harness.calls.find(call => call.command === failedCommand)!;
      const cleanupCalls = harness.calls.filter(call => call.command === cleanupCommand);
      // SSH failures clean up the transport before the failed tab is disposed.
      const expectedCleanupCount = failedKind === "ssh" ? 2 : 1;
      assert.equal(cleanupCalls.length, expectedCleanupCount);
      assert.ok(cleanupCalls.every(call => call.arguments_.sessionId === failedLaunch.arguments_.sessionId));
      const healthyCleanupCommand = healthyKind === "ssh" ? "disconnect_ssh" : "stop_local_terminal";
      assert.equal(harness.calls.filter(call => call.command === healthyCleanupCommand).length, 0);
      harness.restore({ ...LAYOUT, sidePanel: "none" }, result.sessionId);
      assert.equal(harness.focusedSession?.id, result.sessionId);
    });
  }
}

test("closing the primary while the secondary launches restores only the remaining terminal", async () => {
  const ready = Promise.withResolvers<void>();
  const launch = Promise.withResolvers<void>();
  const harness = createHarness({ invoke: async call => {
    if (call.command === "start_local_terminal") { ready.resolve(); await launch.promise; }
  } });
  harness.setProfiles([PROFILE]);
  const opening = harness.open({ ...SSH_TAB, split: { direction: "below", ratio: 0.5, activePaneIndex: 0, secondary: LOCAL_TAB } });
  await ready.promise;
  const primaryId = harness.sessions.find(session => session.kind === "ssh")!.id;
  await harness.call<Promise<void>>("closeTerminalPane", primaryId);
  launch.resolve();
  const result = await opening;
  assert.equal(harness.sessions.length, 1);
  assert.equal(harness.sessions[0].kind, "local");
  assert.equal(result.sessionId, harness.sessions[0].id);
  assert.equal(harness.groups.length, 1);
  assert.equal(harness.groups[0].sessionIds.length, 1);
  assert.equal(harness.document.querySelector(".terminal-tab-view"), null);
  harness.restore({ ...LAYOUT, sidePanel: "none" }, result.sessionId);
  assert.equal(harness.focusedSession?.id, result.sessionId);
});

test("closing the secondary during launch preserves the primary and reports the interrupted pane", async () => {
  const ready = Promise.withResolvers<void>();
  const launch = Promise.withResolvers<void>();
  const harness = createHarness({ invoke: async call => {
    if (call.command === "start_local_terminal") { ready.resolve(); await launch.promise; }
  } });
  harness.setProfiles([PROFILE]);
  const opening = harness.open({ ...SSH_TAB, split: { direction: "right", ratio: 0.5, activePaneIndex: 1, secondary: LOCAL_TAB } });
  await ready.promise;
  const secondaryId = harness.sessions.find(session => session.kind === "local")!.id;
  await harness.call<Promise<void>>("closeTerminalPane", secondaryId);
  launch.resolve();
  const result = await opening;
  assert.match(result.error ?? "", /Pane 2:.*closed while opening/);
  assert.equal(harness.sessions.length, 1);
  assert.equal(harness.sessions[0].kind, "ssh");
  assert.equal(result.sessionId, harness.sessions[0].id);
  assert.equal(harness.groups[0].sessionIds.length, 1);
  assert.equal(harness.document.querySelector(".terminal-tab-view"), null);
  assert.deepEqual(harness.disposed, [secondaryId]);
  harness.restore({ ...LAYOUT, sidePanel: "none" }, result.sessionId);
  assert.equal(harness.focusedSession?.id, result.sessionId);
});
