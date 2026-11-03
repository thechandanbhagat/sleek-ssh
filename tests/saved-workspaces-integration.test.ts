import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { captureWorkspace, initSavedWorkspacesIntegration, restoreWorkspace } from "../src/saved-workspaces-integration.ts";
import { loadSavedWorkspaces, saveWorkspace, type SavedWorkspace, type WorkspaceLayout, type WorkspaceSnapshot, type WorkspaceTab } from "../src/saved-workspaces.ts";

const STORAGE_KEY = "sleekssh_saved_workspaces";
const MAX_WORKSPACE_TABS = 50;
const LAYOUT: WorkspaceLayout = Object.freeze({
  sidebarWidth: 248, sftpWidth: 280, sidebarOpen: false, sidebarView: "terminal", sidePanel: "history",
});
const SSH: WorkspaceTab = Object.freeze({ kind: "ssh", profileId: "api", name: "API", remotePath: "/srv/api", sftpPanelOpen: false });
const LOCAL: WorkspaceTab = Object.freeze({ kind: "local", shell: "powershell", workingDirectory: "C:\\Projects\\API", locationName: "API source" });
const SNAPSHOT: WorkspaceSnapshot = Object.freeze({ tabs: [SSH, LOCAL, SSH], activeTabIndex: 2, layout: LAYOUT });
const SAVED: SavedWorkspace = Object.freeze({ id: "daily", name: "Daily", ...SNAPSHOT });
type CaptureState = Parameters<typeof captureWorkspace>[0];
type IntegrationOptions = Parameters<typeof initSavedWorkspacesIntegration>[0];

function state(overrides: Partial<CaptureState> = {}): CaptureState {
  return {
    sessions: [
      { id: "ssh-first", kind: "ssh", name: "API", connectionProfile: { id: "api" }, terminalPath: "/srv/api", sftpPanelOpen: false },
      { id: "local", kind: "local", name: "PowerShell", shell: "powershell", workingDirectory: "C:\\Projects\\API", locationName: "API source" },
      { id: "ssh-second", kind: "ssh", name: "API", connectionProfile: { id: "api" }, terminalPath: "/srv/api", sftpPanelOpen: false },
    ],
    activeSessionId: "ssh-second", profileIds: ["api"], layout: LAYOUT, ...overrides,
  };
}

function storage(initial: readonly SavedWorkspace[] = []) {
  const data = new Map<string, string>();
  let writes = 0;
  let writeFailure: Error | null = null;
  const result = {
    data,
    get writes() { return writes; },
    failWrites(error: Error | null) { writeFailure = error; },
    getItem: (key: string) => data.get(key) ?? null,
    setItem(key: string, value: string) {
      if (writeFailure) throw writeFailure;
      writes += 1;
      data.set(key, value);
    },
  };
  for (const workspace of initial) saveWorkspace(result, loadSavedWorkspaces(result), workspace);
  writes = 0;
  return result;
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function createHarness(context: TestContext, overrides: {
  initial?: readonly SavedWorkspace[];
  prepare?: IntegrationOptions["prepare"];
  getState?: IntegrationOptions["getState"];
  openTab?: IntegrationOptions["openTab"];
  storage?: ReturnType<typeof storage>;
} = {}) {
  const { document, window } = parseHTML("<!doctype html><html><body><div id='workspaces'></div></body></html>");
  const root = document.getElementById("workspaces")!;
  const previousWindow = Reflect.get(globalThis, "window");
  Reflect.set(globalThis, "window", { confirm: () => true });
  context.after(() => {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Reflect.set(globalThis, "window", previousWindow);
  });
  const saved = overrides.storage ?? storage(overrides.initial ?? []);
  const calls: string[] = [];
  const opened: WorkspaceTab[] = [];
  const layouts: Array<{ layout: WorkspaceLayout; activeSessionId: string }> = [];
  const notifications: string[] = [];
  const controller = initSavedWorkspacesIntegration({
    root, storage: saved, createId: () => "created-workspace",
    getState() { calls.push("capture"); return overrides.getState?.() ?? state(); },
    async prepare() { calls.push("prepare"); await overrides.prepare?.(); },
    async openTab(tab) {
      calls.push("open");
      opened.push(tab);
      return overrides.openTab ? await overrides.openTab(tab) : { sessionId: `opened-${opened.length}` };
    },
    hasSession: () => true,
    applyLayout(layout, activeSessionId) { calls.push("layout"); layouts.push({ layout, activeSessionId }); },
    notify(message) { notifications.push(message); },
  });
  const button = (label: string): HTMLButtonElement => {
    const result = [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === label || item.textContent === label);
    assert.ok(result, `Missing button: ${label}`);
    return result;
  };
  const submit = async (name: string) => {
    root.querySelector<HTMLInputElement>("#saved-workspace-name")!.value = name;
    root.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await nextTurn();
  };
  return {
    root, saved, calls, opened, layouts, notifications, controller, button, submit,
    get error() { return root.querySelector<HTMLElement>('[role="alert"]')!; },
    get status() { return root.querySelector<HTMLElement>('[role="status"]')!; },
  };
}

test("capture keeps supplied visual order, intentional duplicates, launch folders, and active index", () => {
  const original = state();
  const result = captureWorkspace(original);
  assert.deepEqual(result, SNAPSHOT);
  assert.equal(result.tabs[0].kind, "ssh");
  assert.equal(result.tabs[1].kind, "local");
  assert.equal(result.tabs[2].kind, "ssh");
  assert.notEqual(result.layout, original.layout);
});

test("capture filters utility and closing tabs before mapping the active tab", () => {
  const sessions = state().sessions;
  assert.deepEqual(captureWorkspace(state({
    sessions: [
      { id: "settings", kind: "settings", name: "Settings" }, sessions[0],
      { ...sessions[1], id: "closing", isClosing: true },
      { id: "ports", kind: "ports", name: "Ports" }, sessions[1], sessions[2],
    ],
  })), SNAPSHOT);
  assert.equal(captureWorkspace(state({ activeSessionId: "settings" })).activeTabIndex, 0);
  assert.equal(captureWorkspace(state({ activeSessionId: null })).activeTabIndex, 0);
});

test("capture stores only allowlisted fields and never stores SSH secrets or runtime state", () => {
  const secret = "private-password-never-store";
  const sessions = state().sessions.map(session => ({
    ...session, password: secret, passphrase: secret, connectionId: "transient-id", term: { output: secret },
    connectionProfile: session.kind === "ssh" ? { id: "api", password: secret, passphrase: secret, sudo_password: secret } : undefined,
  }));
  const result = captureWorkspace(state({ sessions }));
  const serialized = JSON.stringify(result);
  assert.deepEqual(result, SNAPSHOT);
  for (const forbidden of [secret, "password", "passphrase", "connectionId", "transient-id", "term"]) {
    assert.equal(serialized.includes(`"${forbidden}"`), false);
  }
});

test("capture uses explorer directory when terminal directory is unavailable and retains shell defaults", () => {
  const result = captureWorkspace(state({
    sessions: [
      { id: "ssh", kind: "ssh", name: "API", connectionProfile: { id: "api" }, currentPath: "/var/log" },
      { id: "local", kind: "local", name: "Command Prompt", shell: "cmd" },
    ], activeSessionId: "local",
  }));
  assert.deepEqual(result.tabs, [
    { kind: "ssh", profileId: "api", name: "API", remotePath: "/var/log", sftpPanelOpen: true },
    { kind: "local", shell: "cmd", workingDirectory: null, locationName: null },
  ]);
});

test("capture rejects unsaved hosts, empty terminal sets, unsupported shells, and excessive tabs", () => {
  assert.throws(() => captureWorkspace(state({ profileIds: [] })), /Save these SSH hosts in Hosts.*API/);
  assert.throws(() => captureWorkspace(state({ sessions: [{ id: "quick", kind: "ssh", name: "Quick host" }] })), /Quick host/);
  assert.throws(() => captureWorkspace(state({ sessions: [] })), /between 1 and 50/);
  assert.throws(() => captureWorkspace(state({ sessions: [{ id: "settings", kind: "settings", name: "Settings" }] })), /between 1 and 50/);
  assert.throws(() => captureWorkspace(state({ sessions: [{ id: "local", kind: "local", name: "Bash", shell: "bash" }] })), /Local shell/);
  const maximum = Array.from({ length: MAX_WORKSPACE_TABS }, (_, index) => ({ ...state().sessions[0], id: `ssh-${index}` }));
  assert.equal(captureWorkspace(state({ sessions: maximum })).tabs.length, MAX_WORKSPACE_TABS);
  assert.throws(() => captureWorkspace(state({ sessions: [...maximum, maximum[0]] })), /between 1 and 50/);
});

test("capture keeps split geometry, independent pane details, and a secondary active pane", () => {
  const [primary, secondary, other] = state().sessions;
  for (const direction of ["right", "below"] as const) {
    for (const ratio of [0.2, 0.8]) {
      const split = { direction, ratio, activePaneIndex: 1 as const, secondary };
      const captured = captureWorkspace(state({ sessions: [other, { ...primary, split }], activeSessionId: secondary.id }));
      assert.deepEqual(captured, { ...SNAPSHOT, tabs: [SSH, { ...SSH, split: { direction, ratio, activePaneIndex: 1, secondary: LOCAL } }], activeTabIndex: 1 });
      assert.ok(Object.isFrozen(captured.tabs[1].split));
      assert.ok(Object.isFrozen(captured.tabs[1].split!.secondary));
    }
  }
});

test("capture allowlists secondary fields and rejects an unsaved SSH host in either pane", () => {
  const [ssh, local] = state().sessions;
  const secondary = { ...ssh, id: "secondary", password: "secondary-secret", connectionId: "ephemeral", term: {},
    connectionProfile: { id: "api", password: "profile-secret" } };
  const split = { direction: "right" as const, ratio: 0.5, activePaneIndex: 0 as const, secondary };
  const captured = captureWorkspace(state({ sessions: [{ ...local, split }], activeSessionId: local.id }));
  assert.deepEqual(captured.tabs, [{ ...LOCAL, split: { direction: "right", ratio: 0.5, activePaneIndex: 0, secondary: SSH } }]);
  assert.doesNotMatch(JSON.stringify(captured), /secret|password|connectionId|ephemeral|term"/);
  assert.throws(() => captureWorkspace(state({ sessions: [{ ...local, split }], profileIds: [] })), /Save these SSH hosts in Hosts.*API/);
  assert.throws(() => captureWorkspace(state({ sessions: [{ ...ssh, split: { ...split, secondary: local } }], profileIds: [] })), /Save these SSH hosts in Hosts.*API/);
});

test("capture rejects malformed, closing, duplicate, and nested secondary panes", () => {
  const [primary, secondary] = state().sessions;
  const split = { direction: "right", ratio: 0.5, activePaneIndex: 0, secondary };
  for (const invalid of [null, undefined, {}, "right", { ...split, ratio: null }, { ...split, ratio: Infinity },
    { ...split, ratio: 0.19 }, { ...split, ratio: 0.81 }, { ...split, direction: "left" }, { ...split, activePaneIndex: 2 },
    ...[null, [], {}, { ...secondary, isClosing: true }, { ...secondary, id: primary.id }, { ...secondary, kind: "settings" },
      { ...secondary, shell: "unknown" }, { ...secondary, split }, { ...secondary, split: undefined }].map(secondary => ({ ...split, secondary }))]) {
    assert.throws(() => captureWorkspace(state({ sessions: [{ ...primary, split: invalid }] } as unknown as Partial<CaptureState>)));
  }
});

test("capture accepts fifty two-pane groups and rejects a fifty-first group", () => {
  const [ssh, local] = state().sessions;
  const sessions = Array.from({ length: MAX_WORKSPACE_TABS }, (_, index) => ({ ...ssh, id: `primary-${index}`,
    split: { direction: "below" as const, ratio: 0.5, activePaneIndex: 1 as const, secondary: { ...local, id: `secondary-${index}` } },
  }));
  const captured = captureWorkspace(state({ sessions, activeSessionId: `secondary-${MAX_WORKSPACE_TABS - 1}` }));
  assert.equal(captured.tabs.length, MAX_WORKSPACE_TABS);
  assert.equal(captured.activeTabIndex, MAX_WORKSPACE_TABS - 1);
  assert.ok(captured.tabs.every(tab => tab.split?.activePaneIndex === 1));
  assert.throws(() => captureWorkspace(state({ sessions: [...sessions, sessions[0]] })), /between 1 and 50/);
});

test("restore forwards split metadata and applies layout to the focused or surviving pane returned by the opener", async () => {
  const tab: WorkspaceTab = { ...SSH, split: { direction: "below", ratio: 0.7, activePaneIndex: 1, secondary: LOCAL } };
  const snapshot = { ...SNAPSHOT, tabs: [tab], activeTabIndex: 0 };
  for (const result of [{ sessionId: "focused-secondary" }, { sessionId: "surviving-primary", error: "Secondary pane: Missing folder" }]) {
    const selected: string[] = [];
    const failures = await restoreWorkspace(snapshot, {
      async openTab(received) { assert.deepEqual(received, tab); return result; },
      hasSession: id => id === result.sessionId,
      applyLayout(layout, id) { assert.deepEqual(layout, LAYOUT); selected.push(id); },
    });
    assert.deepEqual(selected, [result.sessionId]);
    assert.deepEqual(failures, result.error ? ["API: " + result.error] : []);
  }
});

test("restore opens in order without racing launches and applies layout after the saved active tab exists", async () => {
  const gate = Promise.withResolvers<void>();
  const opened: WorkspaceTab[] = [];
  const calls: string[] = [];
  const restoring = restoreWorkspace(SNAPSHOT, {
    async openTab(tab) {
      opened.push(tab);
      calls.push(`open-${opened.length}`);
      if (opened.length === 1) await gate.promise;
      return { sessionId: `session-${opened.length}` };
    },
    hasSession: () => true,
    applyLayout(layout, id) { assert.deepEqual(layout, LAYOUT); calls.push(`layout-${id}`); },
  });
  assert.deepEqual(opened, [SSH]);
  assert.deepEqual(calls, ["open-1"]);
  gate.resolve();
  assert.deepEqual(await restoring, []);
  assert.deepEqual(opened, SNAPSHOT.tabs);
  assert.deepEqual(calls, ["open-1", "open-2", "open-3", "layout-session-3"]);
});

test("restore continues after a deleted host and a retained failed local tab without shifting active mapping", async () => {
  const selected: string[] = [];
  let index = 0;
  const failures = await restoreWorkspace(SNAPSHOT, {
    async openTab() {
      index += 1;
      if (index === 1) throw new Error("Host profile no longer exists.");
      return { sessionId: `session-${index}`, ...(index === 2 ? { error: "Folder does not exist." } : {}) };
    },
    hasSession: () => true,
    applyLayout(_layout, id) { selected.push(id); },
  });
  assert.deepEqual(failures, ["API: Host profile no longer exists.", "API source: Folder does not exist."]);
  assert.deepEqual(selected, ["session-3"]);
  assert.equal(Object.isFrozen(failures), true);
});

test("restore selects the first remaining restored tab when the saved active host is missing", async () => {
  const selected: string[] = [];
  let index = 0;
  await restoreWorkspace(SNAPSHOT, {
    async openTab() {
      index += 1;
      if (index === 3) throw new Error("Deleted host");
      return { sessionId: `session-${index}` };
    },
    hasSession: id => id !== "session-1",
    applyLayout(_layout, id) { selected.push(id); },
  });
  assert.deepEqual(selected, ["session-2"]);
});

test("restore does not select a restored tab that was closed while another tab opened", async () => {
  const selected: string[] = [];
  let index = 0;
  await restoreWorkspace(SNAPSHOT, {
    async openTab() { return { sessionId: `session-${++index}` }; },
    hasSession: id => id === "session-2",
    applyLayout(_layout, id) { selected.push(id); },
  });
  assert.deepEqual(selected, ["session-2"]);
});

test("restore leaves existing layout and active selection alone if all entries fail or are closed", async () => {
  const applyLayout = () => assert.fail("Existing workspace layout should remain untouched.");
  const failures = await restoreWorkspace(SNAPSHOT, {
    async openTab() { throw "Unavailable"; }, hasSession: () => false, applyLayout,
  });
  assert.equal(failures.length, SNAPSHOT.tabs.length);
  assert.match(failures[0], /Unavailable/);
  await restoreWorkspace(SNAPSHOT, { async openTab() { return { sessionId: "closed" }; }, hasSession: () => false, applyLayout });
});

test("restore rejects malformed snapshots before creating terminals or changing layout", async () => {
  for (const malformed of [null, { ...SNAPSHOT, tabs: [] }, { ...SNAPSHOT, activeTabIndex: SNAPSHOT.tabs.length }]) {
    await assert.rejects(restoreWorkspace(malformed as WorkspaceSnapshot, {
      async openTab() { assert.fail("No terminal should start from invalid saved data."); },
      hasSession: () => { assert.fail("No session lookup should occur."); },
      applyLayout: () => { assert.fail("No layout should be applied."); },
    }));
  }
});

test("integration saves after catalog preparation and persists only the captured snapshot", async context => {
  let catalogReady = false;
  const harness = createHarness(context, {
    async prepare() { catalogReady = true; },
    getState() { assert.equal(catalogReady, true); return state(); },
  });
  harness.controller.showSave();
  assert.equal(harness.root.querySelector<HTMLFormElement>("form")!.hidden, false);
  await harness.submit("Morning");
  assert.deepEqual(harness.calls, ["prepare", "capture"]);
  assert.deepEqual(harness.controller.list(), [{ id: "created-workspace", name: "Morning", ...SNAPSHOT }]);
  assert.equal(harness.saved.writes, 1);
  assert.equal(harness.error.hidden, true);
});

test("integration preserves stored data when catalog preparation or workspace capture fails", async context => {
  const saved = storage([SAVED]);
  const before = saved.getItem(STORAGE_KEY);
  const harness = createHarness(context, { storage: saved, async prepare() { throw new Error("Could not read host profiles."); } });
  harness.controller.showSave();
  await harness.submit("Morning");
  assert.equal(saved.getItem(STORAGE_KEY), before);
  assert.equal(saved.writes, 0);
  assert.deepEqual(harness.calls, ["prepare"]);
  assert.match(harness.error.textContent!, /Could not read host profiles/);
});

test("integration surfaces unsaved-host capture failures without saving a partial workspace", async context => {
  const harness = createHarness(context, { getState: () => state({ profileIds: [] }) });
  harness.controller.showSave();
  await harness.submit("Morning");
  assert.equal(harness.saved.writes, 0);
  assert.deepEqual(harness.controller.list(), []);
  assert.match(harness.error.textContent!, /Save these SSH hosts/);
});

test("integration rename preserves its saved tabs even when current sessions are different", async context => {
  const harness = createHarness(context, { initial: [SAVED], getState() { assert.fail("Renaming must not capture current sessions."); } });
  harness.button("Rename Daily").click();
  await harness.submit("Production");
  assert.deepEqual(harness.controller.list(), [{ ...SAVED, name: "Production" }]);
  assert.deepEqual(harness.calls, []);
});

test("integration update replaces the snapshot while retaining workspace identity and name", async context => {
  const updatedState = state({ sessions: [state().sessions[1]], activeSessionId: "local" });
  const harness = createHarness(context, { initial: [SAVED], getState: () => updatedState });
  harness.button("Update Daily").click();
  await nextTurn();
  assert.deepEqual(harness.controller.list(), [{ id: SAVED.id, name: SAVED.name, ...captureWorkspace(updatedState) }]);
  assert.deepEqual(harness.calls, ["prepare", "capture"]);
});

test("integration removal edits only saved metadata and does not launch or change active sessions", async context => {
  const harness = createHarness(context, { initial: [SAVED] });
  harness.button("Remove Daily").click();
  await nextTurn();
  assert.deepEqual(harness.controller.list(), []);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.layouts, []);
});

test("integration reports partial native launch failures after reopening the remaining tabs", async context => {
  let launch = 0;
  const harness = createHarness(context, {
    initial: [SAVED],
    async openTab() { launch += 1; return { sessionId: `native-${launch}`, ...(launch === 2 ? { error: "Missing folder" } : {}) }; },
  });
  await harness.controller.open(SAVED.id);
  assert.deepEqual(harness.calls, ["prepare", "open", "open", "open", "layout"]);
  assert.deepEqual(harness.opened, SNAPSHOT.tabs);
  assert.deepEqual(harness.layouts, [{ layout: LAYOUT, activeSessionId: "native-3" }]);
  assert.deepEqual(harness.notifications, ["Opened Daily with 1 issue. See Workspaces for details."]);
  assert.match(harness.error.textContent!, /API source: Missing folder/);
  assert.equal(harness.saved.writes, 0);
});

test("integration open waits for preparation, refuses overlapping opens, and can retry after preparation failure", async context => {
  const gate = Promise.withResolvers<void>();
  let failed = false;
  const harness = createHarness(context, {
    initial: [SAVED],
    async prepare() { if (!failed) { await gate.promise; failed = true; throw new Error("Catalog unavailable"); } },
  });
  const first = harness.controller.open(SAVED.id);
  await harness.controller.open(SAVED.id);
  assert.deepEqual(harness.calls, ["prepare"]);
  assert.deepEqual(harness.opened, []);
  gate.resolve();
  await first;
  assert.match(harness.error.textContent!, /Catalog unavailable/);
  assert.deepEqual(harness.layouts, []);
  await harness.controller.open(SAVED.id);
  assert.equal(harness.opened.length, SNAPSHOT.tabs.length);
  assert.deepEqual(harness.notifications, ["Opened Daily."]);
});

test("integration refresh and list use current storage rather than a stale cached workspace", async context => {
  const harness = createHarness(context);
  saveWorkspace(harness.saved, [], SAVED);
  assert.deepEqual(harness.controller.list(), [SAVED]);
  harness.controller.refresh();
  assert.equal(harness.button("Open Daily").disabled, false);
  harness.saved.data.set(STORAGE_KEY, JSON.stringify({ version: 1, workspaces: [] }));
  await harness.controller.open(SAVED.id);
  assert.match(harness.error.textContent!, /no longer exists/);
  assert.deepEqual(harness.opened, []);
});

test("integration exposes storage write errors and preserves the previously saved workspace", async context => {
  const harness = createHarness(context, { initial: [SAVED] });
  const before = harness.saved.getItem(STORAGE_KEY);
  harness.saved.failWrites(new Error("Storage quota exceeded"));
  harness.button("Rename Daily").click();
  await harness.submit("Renamed");
  assert.equal(harness.saved.getItem(STORAGE_KEY), before);
  assert.equal(harness.saved.writes, 0);
  assert.match(harness.error.textContent!, /Storage quota exceeded/);
});
