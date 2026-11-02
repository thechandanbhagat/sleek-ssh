import assert from "node:assert/strict";
import test from "node:test";
import {
  loadSavedWorkspaces,
  removeWorkspace,
  saveWorkspace,
  validateWorkspaceSnapshot,
  type SavedWorkspace,
  type WorkspaceSnapshot,
  type WorkspaceTab,
} from "../src/saved-workspaces.ts";

const STORAGE_KEY = "sleekssh_saved_workspaces";
const LEGACY_BACKUP_KEY = "sleekssh_saved_workspaces_v1_backup";
const MIN_PANE_RATIO = 0.2;
const MAX_PANE_RATIO = 0.8;
const MAX_WORKSPACES = 50;
const MAX_TABS = 50;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 120;
const MAX_PATH_LENGTH = 32_767;
const SSH_TAB: WorkspaceTab = Object.freeze({ kind: "ssh", profileId: "server", name: "API", remotePath: "/srv/app", sftpPanelOpen: true });
const LOCAL_TAB: WorkspaceTab = Object.freeze({ kind: "local", shell: "powershell", workingDirectory: "C:\\Projects\\app", locationName: "App" });
const SNAPSHOT: WorkspaceSnapshot = Object.freeze({
  tabs: Object.freeze([SSH_TAB, LOCAL_TAB]),
  activeTabIndex: 1,
  layout: Object.freeze({ sidebarWidth: 248, sftpWidth: 280, sidebarOpen: true, sidebarView: "connections", sidePanel: "files" }),
});
const WORKSPACE: SavedWorkspace = Object.freeze({ id: "daily", name: "Daily work", ...SNAPSHOT });

function createStorage(initial: string | null = null) {
  const values = new Map<string, string>();
  if (initial !== null) values.set(STORAGE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function encoded(workspaces: unknown): string {
  return JSON.stringify({ version: 1, workspaces });
}

function assertInvalidSnapshot(value: unknown): void {
  assert.throws(() => validateWorkspaceSnapshot(value));
  const storage = createStorage();
  const workspace = { ...WORKSPACE, ...(value as object) } as SavedWorkspace;
  assert.throws(() => saveWorkspace(storage, [], workspace));
  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.throws(() => loadSavedWorkspaces(createStorage(encoded([workspace]))));
}

test("empty storage and an empty versioned list load as immutable empty workspaces", () => {
  for (const storage of [createStorage(), createStorage(encoded([]))]) {
    const workspaces = loadSavedWorkspaces(storage);
    assert.deepEqual(workspaces, []);
    assert.ok(Object.isFrozen(workspaces));
  }
});

test("workspaces save, reload, update in place, and remove without mutating earlier state", () => {
  const storage = createStorage();
  const original = Object.freeze([]);
  const saved = saveWorkspace(storage, original, WORKSPACE);
  const second = { ...WORKSPACE, id: "other", name: "Other" };
  const appended = saveWorkspace(storage, saved, second);
  const updated = saveWorkspace(storage, appended, { ...WORKSPACE, name: "Renamed", activeTabIndex: 0 });
  assert.deepEqual(original, []);
  assert.deepEqual(saved, [WORKSPACE]);
  assert.deepEqual(appended, [WORKSPACE, second]);
  assert.deepEqual(updated.map(item => item.name), ["Renamed", "Other"]);
  assert.equal(updated[0].activeTabIndex, 0);
  assert.deepEqual(loadSavedWorkspaces(storage), updated);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)!), { version: 2, workspaces: updated });
  const removed = removeWorkspace(storage, updated, WORKSPACE.id);
  assert.deepEqual(removed, [second]);
  assert.deepEqual(loadSavedWorkspaces(storage), removed);
  assert.deepEqual(removeWorkspace(storage, removed, "missing"), removed);
  assert.deepEqual(removeWorkspace(storage, removed, second.id), []);
  assert.deepEqual(loadSavedWorkspaces(storage), []);
});

test("snapshots preserve ordered duplicate hosts, local folders, active selection, and layout", () => {
  const snapshot = {
    ...SNAPSHOT,
    tabs: [LOCAL_TAB, SSH_TAB, { ...SSH_TAB, remotePath: "/var/log", sftpPanelOpen: false }],
    activeTabIndex: 2,
    layout: { sidebarWidth: 360, sftpWidth: 420, sidebarOpen: false, sidebarView: "workspaces", sidePanel: "history" },
  };
  const validated = validateWorkspaceSnapshot(snapshot);
  assert.deepEqual(validated, snapshot);
  const workspace = { ...WORKSPACE, ...validated };
  const storage = createStorage();
  saveWorkspace(storage, [], workspace);
  assert.deepEqual(loadSavedWorkspaces(storage), [workspace]);
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.tabs));
  assert.ok(Object.isFrozen(validated.tabs[0]));
  assert.ok(Object.isFrozen(validated.layout));
  assert.notEqual(validated.tabs, snapshot.tabs);
  assert.notEqual(validated.tabs[0], snapshot.tabs[0]);
});

test("names and identifiers trim whitespace while all returned workspace data is immutable", () => {
  const workspace = {
    ...WORKSPACE,
    id: " daily ",
    name: " Daily work ",
    tabs: [{ ...SSH_TAB, profileId: " server ", name: " API " }, { ...LOCAL_TAB, locationName: " App " }],
  };
  const storage = createStorage();
  const saved = saveWorkspace(storage, [], workspace);
  assert.deepEqual(saved, [WORKSPACE]);
  const loaded = loadSavedWorkspaces(createStorage(encoded([workspace])));
  assert.deepEqual(loaded, [WORKSPACE]);
  for (const workspaces of [saved, loaded]) {
    assert.ok(Object.isFrozen(workspaces));
    assert.ok(Object.isFrozen(workspaces[0]));
    assert.ok(Object.isFrozen(workspaces[0].tabs));
    assert.ok(Object.isFrozen(workspaces[0].tabs[0]));
    assert.ok(Object.isFrozen(workspaces[0].layout));
  }
});

test("nullable startup folders and names, both shell kinds, and every sidebar and side panel are supported", () => {
  for (const shell of ["powershell", "cmd"] as const) {
    for (const sidebarView of ["connections", "terminal", "keys", "vpn", "workspaces"] as const) {
      for (const sidePanel of ["none", "files", "history", "agent"] as const) {
        const snapshot = {
          tabs: [{ kind: "ssh", profileId: "server", name: "API", remotePath: null, sftpPanelOpen: false },
            { kind: "local", shell, workingDirectory: null, locationName: null }],
          activeTabIndex: 0,
          layout: { ...SNAPSHOT.layout, sidebarView, sidePanel },
        };
        assert.deepEqual(validateWorkspaceSnapshot(snapshot), snapshot);
      }
    }
  }
});

test("absolute local folders preserve spaces, Unicode, shell characters, roots, and UNC shares", () => {
  const paths = ["C:\\", "D:/app", "C:\\Projects\\日本語 ", "C:\\Projects\\O'Brien & $app; [draft] `notes`", "\\\\server\\share\\folder", "//server/share/folder"];
  for (const path of paths) {
    const snapshot = { ...SNAPSHOT, tabs: [{ ...LOCAL_TAB, workingDirectory: path }], activeTabIndex: 0 };
    const validated = validateWorkspaceSnapshot(snapshot);
    assert.deepEqual(validated, snapshot);
    const storage = createStorage();
    saveWorkspace(storage, [], { ...WORKSPACE, ...validated });
    assert.deepEqual(loadSavedWorkspaces(storage)[0].tabs, snapshot.tabs);
  }
});

test("remote folders preserve literal paths and accept the home-directory sentinel", () => {
  for (const remotePath of ["/", ".", "/srv/My app", "/srv/ 日本語 ", "/srv/O'Brien & $app; `notes`"]) {
    const snapshot = { ...SNAPSHOT, tabs: [{ ...SSH_TAB, remotePath }], activeTabIndex: 0 };
    assert.deepEqual(validateWorkspaceSnapshot(snapshot), snapshot);
  }
});

test("validation and storage discard all extra fields including credentials and runtime objects", () => {
  const untrusted = {
    ...WORKSPACE, password: "secret-one", passphrase: "secret-two", connectionProfile: { password: "secret-three" },
    tabs: [{ ...SSH_TAB, password: "secret-four", profile: { password: "secret-five" }, sessionId: "transient" },
      { ...LOCAL_TAB, environment: { API_KEY: "secret-six" } }],
    layout: { ...SNAPSHOT.layout, secret: "secret-seven" },
  };
  assert.deepEqual(validateWorkspaceSnapshot(untrusted), SNAPSHOT);
  const storage = createStorage();
  assert.deepEqual(saveWorkspace(storage, [], untrusted), [WORKSPACE]);
  assert.doesNotMatch(storage.getItem(STORAGE_KEY)!, /secret-|password|passphrase|connectionProfile|sessionId|environment|API_KEY/);
  assert.deepEqual(loadSavedWorkspaces(createStorage(encoded([untrusted]))), [WORKSPACE]);
});

test("invalid JSON, null, wrong envelopes, unsupported versions, and malformed lists fail without replacing storage", () => {
  const invalid = ["", "{", "null", "[]", '"data"', "{}", JSON.stringify({ version: 3, workspaces: [] }),
    JSON.stringify({ version: "1", workspaces: [] }), encoded(null), encoded({}), encoded([null]), encoded([[]]), encoded([{}])];
  for (const raw of invalid) {
    const storage = createStorage(raw);
    assert.throws(() => loadSavedWorkspaces(storage));
    assert.equal(storage.getItem(STORAGE_KEY), raw);
  }
});

test("snapshot validation rejects null, undefined, arrays, primitive values, and sparse tab lists", () => {
  for (const value of [null, undefined, [], "workspace", 1, true]) {
    assert.throws(() => validateWorkspaceSnapshot(value));
  }
  assertInvalidSnapshot({ ...SNAPSHOT, tabs: new Array(1), activeTabIndex: 0 });
});

test("empty, null, malformed, unsupported, and excessive tab lists fail", () => {
  for (const tabs of [[], null, undefined, {}, [null], [[]], [{}], [{ ...SSH_TAB, kind: "settings" }], Array.from({ length: MAX_TABS + 1 }, () => SSH_TAB)]) {
    assertInvalidSnapshot({ ...SNAPSHOT, tabs, activeTabIndex: 0 });
  }
});

test("the maximum number of tabs is accepted with either boundary active index", () => {
  const tabs = Array.from({ length: MAX_TABS }, () => SSH_TAB);
  for (const activeTabIndex of [0, MAX_TABS - 1]) {
    const snapshot = { ...SNAPSHOT, tabs, activeTabIndex };
    assert.deepEqual(validateWorkspaceSnapshot(snapshot), snapshot);
  }
});

test("active selection rejects missing, null, fractional, negative, out-of-bounds, and nonnumeric indices", () => {
  for (const activeTabIndex of [undefined, null, -1, 0.5, SNAPSHOT.tabs.length, Number.NaN, Infinity, "0"]) {
    assertInvalidSnapshot({ ...SNAPSHOT, activeTabIndex });
  }
});

test("all layout fields are validated including width boundaries and real booleans", () => {
  for (const layout of [null, undefined, [], {},
    { ...SNAPSHOT.layout, sidebarWidth: 199 }, { ...SNAPSHOT.layout, sidebarWidth: 361 },
    { ...SNAPSHOT.layout, sftpWidth: 219 }, { ...SNAPSHOT.layout, sftpWidth: 421 },
    { ...SNAPSHOT.layout, sidebarWidth: Number.NaN }, { ...SNAPSHOT.layout, sftpWidth: Infinity },
    { ...SNAPSHOT.layout, sidebarWidth: "248" }, { ...SNAPSHOT.layout, sftpWidth: null },
    { ...SNAPSHOT.layout, sidebarOpen: "true" }, { ...SNAPSHOT.layout, sidebarOpen: null },
    { ...SNAPSHOT.layout, sidebarView: "other" }, { ...SNAPSHOT.layout, sidePanel: "other" }]) {
    assertInvalidSnapshot({ ...SNAPSHOT, layout });
  }
  for (const [sidebarWidth, sftpWidth] of [[200, 220], [360, 420], [248.5, 280.5]]) {
    const snapshot = { ...SNAPSHOT, layout: { ...SNAPSHOT.layout, sidebarWidth, sftpWidth } };
    assert.deepEqual(validateWorkspaceSnapshot(snapshot), snapshot);
  }
});

test("SSH tab fields reject missing values, blank names, invalid booleans, and nonabsolute remote paths", () => {
  for (const tab of [{ ...SSH_TAB, profileId: null }, { ...SSH_TAB, profileId: "" }, { ...SSH_TAB, name: " " },
    { ...SSH_TAB, name: undefined }, { ...SSH_TAB, sftpPanelOpen: null }, { ...SSH_TAB, sftpPanelOpen: 1 },
    { ...SSH_TAB, remotePath: undefined }, { ...SSH_TAB, remotePath: "" }, { ...SSH_TAB, remotePath: "~/app" },
    { ...SSH_TAB, remotePath: "../app" }, { ...SSH_TAB, remotePath: "var/log" }]) {
    assertInvalidSnapshot({ ...SNAPSHOT, tabs: [tab], activeTabIndex: 0 });
  }
});

test("local tab fields reject unsupported shells, blank labels, and relative or incomplete paths", () => {
  for (const tab of [{ ...LOCAL_TAB, shell: "bash" }, { ...LOCAL_TAB, shell: null },
    { ...LOCAL_TAB, locationName: "" }, { ...LOCAL_TAB, locationName: undefined },
    ...[undefined, "", "app", "C:app", "\\app", "/app", "\\\\server", "\\\\server\\", " C:\\app"].map(workingDirectory => ({ ...LOCAL_TAB, workingDirectory }))]) {
    assertInvalidSnapshot({ ...SNAPSHOT, tabs: [tab], activeTabIndex: 0 });
  }
});

test("control characters are rejected in identifiers, labels, and paths", () => {
  for (const character of ["\u0000", "\n", "\r", "\t", "\u007f"]) {
    for (const tab of [{ ...SSH_TAB, profileId: `server${character}` }, { ...SSH_TAB, name: `API${character}` },
      { ...SSH_TAB, remotePath: `/srv/app${character}` }, { ...LOCAL_TAB, locationName: `App${character}` },
      { ...LOCAL_TAB, workingDirectory: `C:\\app${character}` }]) {
      assertInvalidSnapshot({ ...SNAPSHOT, tabs: [tab], activeTabIndex: 0 });
    }
    for (const field of ["id", "name"] as const) {
      assert.throws(() => saveWorkspace(createStorage(), [], { ...WORKSPACE, [field]: `${WORKSPACE[field]}${character}` }));
    }
  }
});

test("maximum field lengths are accepted and oversized fields rejected", () => {
  const maximum = {
    id: "i".repeat(MAX_ID_LENGTH), name: "n".repeat(MAX_NAME_LENGTH), activeTabIndex: 0, layout: SNAPSHOT.layout,
    tabs: [{ ...SSH_TAB, profileId: "p".repeat(MAX_ID_LENGTH), name: "h".repeat(MAX_NAME_LENGTH), remotePath: `/${"p".repeat(MAX_PATH_LENGTH - 1)}` },
      { ...LOCAL_TAB, locationName: "l".repeat(MAX_NAME_LENGTH), workingDirectory: `C:\\${"p".repeat(MAX_PATH_LENGTH - "C:\\".length)}` }],
  };
  const storage = createStorage();
  assert.deepEqual(saveWorkspace(storage, [], maximum), [maximum]);
  assert.deepEqual(loadSavedWorkspaces(storage), [maximum]);
  for (const field of ["id", "name"] as const) {
    assert.throws(() => saveWorkspace(createStorage(), [], { ...maximum, [field]: `${maximum[field]}x` }), /at most/);
  }
  const [ssh, local] = maximum.tabs;
  for (const tab of [{ ...ssh, profileId: "p".repeat(MAX_ID_LENGTH + 1) }, { ...ssh, name: "h".repeat(MAX_NAME_LENGTH + 1) },
    { ...ssh, remotePath: `/${"p".repeat(MAX_PATH_LENGTH)}` }, { ...local, locationName: "l".repeat(MAX_NAME_LENGTH + 1) },
    { ...local, workingDirectory: `C:\\${"p".repeat(MAX_PATH_LENGTH)}` }]) {
    assertInvalidSnapshot({ ...SNAPSHOT, tabs: [tab], activeTabIndex: 0 });
  }
});

test("the maximum number of workspaces permits updates but rejects additional entries", () => {
  const maximum = Array.from({ length: MAX_WORKSPACES }, (_, index) => ({ ...WORKSPACE, id: `workspace-${index}`, name: `Workspace ${index}` }));
  const storage = createStorage(encoded(maximum));
  assert.deepEqual(loadSavedWorkspaces(storage), maximum);
  const updated = saveWorkspace(storage, maximum, { ...maximum[0], name: "Renamed" });
  assert.equal(updated.length, MAX_WORKSPACES);
  assert.equal(updated[0].name, "Renamed");
  const before = storage.getItem(STORAGE_KEY);
  assert.throws(() => saveWorkspace(storage, maximum, WORKSPACE), /at most/);
  assert.equal(storage.getItem(STORAGE_KEY), before);
  assert.throws(() => loadSavedWorkspaces(createStorage(encoded([...maximum, WORKSPACE]))), /at most/);
});

test("workspace names are unique after trimming and ignoring case, including rename collisions", () => {
  const other = { ...WORKSPACE, id: "other", name: "Other" };
  for (const name of [WORKSPACE.name, "DAILY WORK", " daily work "]) {
    const collision = { ...other, name };
    assert.throws(() => saveWorkspace(createStorage(), [WORKSPACE], collision), /already exists/);
    assert.throws(() => saveWorkspace(createStorage(), [WORKSPACE, other], collision), /already exists/);
    assert.throws(() => loadSavedWorkspaces(createStorage(encoded([WORKSPACE, collision]))), /already exists/);
  }
  assert.deepEqual(saveWorkspace(createStorage(), [WORKSPACE], { ...WORKSPACE, name: "DAILY WORK" }), [{ ...WORKSPACE, name: "DAILY WORK" }]);
});

test("duplicate IDs and malformed existing collections fail on every storage operation", () => {
  const duplicate = { ...WORKSPACE, name: "Other" };
  const invalidCollections = [null, undefined, {}, [null], [WORKSPACE, duplicate], new Array(1)];
  for (const collection of invalidCollections) {
    assert.throws(() => saveWorkspace(createStorage(), collection as readonly SavedWorkspace[], WORKSPACE));
    assert.throws(() => removeWorkspace(createStorage(), collection as readonly SavedWorkspace[], WORKSPACE.id));
    assert.throws(() => loadSavedWorkspaces(createStorage(encoded(collection))));
  }
});

test("saving malformed workspace identities fails without changing storage", () => {
  for (const workspace of [null, undefined, [], { ...WORKSPACE, id: "" }, { ...WORKSPACE, id: null },
    { ...WORKSPACE, name: " " }, { ...WORKSPACE, name: null }]) {
    const raw = encoded([WORKSPACE]);
    const storage = createStorage(raw);
    assert.throws(() => saveWorkspace(storage, [WORKSPACE], workspace as SavedWorkspace));
    assert.equal(storage.getItem(STORAGE_KEY), raw);
  }
});

test("removing validates missing, empty, control-containing and oversized IDs without writing", () => {
  for (const id of [null, undefined, "", " ", "bad\n", "i".repeat(MAX_ID_LENGTH + 1)]) {
    const raw = encoded([WORKSPACE]);
    const storage = createStorage(raw);
    assert.throws(() => removeWorkspace(storage, [WORKSPACE], id as string));
    assert.equal(storage.getItem(STORAGE_KEY), raw);
  }
  const maximumId = "i".repeat(MAX_ID_LENGTH);
  assert.deepEqual(removeWorkspace(createStorage(), [{ ...WORKSPACE, id: maximumId }], maximumId), []);
  assert.deepEqual(removeWorkspace(createStorage(), [], "missing"), []);
});

test("storage read and write failures propagate without mutating input", () => {
  const failure = new Error("Storage is unavailable");
  assert.throws(() => loadSavedWorkspaces({ getItem() { throw failure; } }), error => error === failure);
  const storage = { getItem() { return null; }, setItem() { throw failure; } };
  const existing = Object.freeze([WORKSPACE]);
  assert.throws(() => saveWorkspace(storage, existing, { ...WORKSPACE, name: "Renamed" }), error => error === failure);
  assert.throws(() => removeWorkspace(storage, existing, WORKSPACE.id), error => error === failure);
  assert.deepEqual(existing, [WORKSPACE]);
});

test("split workspaces round-trip both directions, focused panes, and ratio boundaries immutably", () => {
  for (const direction of ["right", "below"] as const) {
    for (const ratio of [MIN_PANE_RATIO, 0.5, MAX_PANE_RATIO]) {
      for (const activePaneIndex of [0, 1] as const) {
        const workspace: SavedWorkspace = { ...WORKSPACE, tabs: [
          { ...SSH_TAB, split: { direction, ratio, activePaneIndex, secondary: LOCAL_TAB } },
          { ...LOCAL_TAB, split: { direction, ratio, activePaneIndex, secondary: SSH_TAB } },
        ] };
        const storage = createStorage();
        const saved = saveWorkspace(storage, [], workspace);
        assert.deepEqual(loadSavedWorkspaces(storage), [workspace]);
        assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)!).version, 2);
        const split = saved[0].tabs[0].split!;
        assert.ok(Object.isFrozen(split));
        assert.ok(Object.isFrozen(split.secondary));
        assert.notEqual(split, workspace.tabs[0].split);
        assert.notEqual(split.secondary, workspace.tabs[0].split!.secondary);
      }
    }
  }
});

test("split validation removes secrets and runtime fields from both panes and split metadata", () => {
  const split = { direction: "right", ratio: 0.5, activePaneIndex: 1, secondary: {
    ...SSH_TAB, password: "secondary-secret", connectionProfile: { password: "profile-secret" }, term: { output: "terminal-secret" },
  }, credentials: "split-secret" };
  const untrusted = { ...WORKSPACE, tabs: [{ ...LOCAL_TAB, split, environment: { API_KEY: "primary-secret" } }], activeTabIndex: 0 };
  const storage = createStorage();
  const saved = saveWorkspace(storage, [], untrusted as SavedWorkspace);
  assert.deepEqual(saved[0].tabs, [{ ...LOCAL_TAB, split: { direction: "right", ratio: 0.5, activePaneIndex: 1, secondary: SSH_TAB } }]);
  assert.doesNotMatch(storage.getItem(STORAGE_KEY)!, /secret|password|credentials|connectionProfile|environment|API_KEY|output/);
});

test("malformed split metadata and nested third panes fail before writing", () => {
  const split = { direction: "right", ratio: 0.5, activePaneIndex: 0, secondary: LOCAL_TAB };
  const invalid = [null, [], {}, "right", 1,
    ...[null, "", "left"].map(direction => ({ ...split, direction })),
    ...[null, "0.5", Number.NaN, Infinity, MIN_PANE_RATIO - 0.01, MAX_PANE_RATIO + 0.01].map(ratio => ({ ...split, ratio })),
    ...[null, "0", -1, 0.5, 2].map(activePaneIndex => ({ ...split, activePaneIndex })),
    ...[null, [], {}, { ...LOCAL_TAB, kind: "settings" }, { ...LOCAL_TAB, shell: "bash" }, { ...SSH_TAB, profileId: "" },
      { ...LOCAL_TAB, workingDirectory: "relative" }, { ...LOCAL_TAB, split: null },
      { ...LOCAL_TAB, split }, { ...SSH_TAB, name: "n".repeat(MAX_NAME_LENGTH + 1) }].map(secondary => ({ ...split, secondary })),
  ];
  for (const value of invalid) {
    assertInvalidSnapshot({ ...SNAPSHOT, tabs: [{ ...SSH_TAB, split: value }], activeTabIndex: 0 });
  }
  for (const tab of [{ ...SSH_TAB, split: undefined }, { ...SSH_TAB, split: { ...split, secondary: { ...LOCAL_TAB, split: undefined } } }]) {
    const snapshot = { ...SNAPSHOT, tabs: [tab], activeTabIndex: 0 };
    assert.throws(() => validateWorkspaceSnapshot(snapshot));
    assert.throws(() => saveWorkspace(createStorage(), [], { ...WORKSPACE, ...snapshot } as SavedWorkspace));
  }
});

test("the tab limit counts split groups while accepting two terminals per group", () => {
  const tab: WorkspaceTab = { ...SSH_TAB, split: { direction: "below", ratio: MAX_PANE_RATIO, activePaneIndex: 1, secondary: LOCAL_TAB } };
  const tabs = Array.from({ length: MAX_TABS }, () => tab);
  assert.deepEqual(validateWorkspaceSnapshot({ ...SNAPSHOT, tabs, activeTabIndex: MAX_TABS - 1 }).tabs, tabs);
  assertInvalidSnapshot({ ...SNAPSHOT, tabs: [...tabs, tab] });
});

test("loading legacy data does not migrate it, and the first save preserves its exact raw backup", () => {
  const raw = JSON.stringify({ version: 1, workspaces: [WORKSPACE] }, null, 2);
  const storage = createStorage(raw);
  assert.deepEqual(loadSavedWorkspaces(storage), [WORKSPACE]);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.equal(storage.getItem(LEGACY_BACKUP_KEY), null);
  const saved = saveWorkspace(storage, [WORKSPACE], { ...WORKSPACE, name: "Renamed" });
  assert.equal(storage.getItem(LEGACY_BACKUP_KEY), raw);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)!), { version: 2, workspaces: saved });
  removeWorkspace(storage, saved, WORKSPACE.id);
  assert.equal(storage.getItem(LEGACY_BACKUP_KEY), raw);
});

test("legacy removal preserves the backup, an existing backup stays intact, and version 2 needs no backup", () => {
  const raw = encoded([WORKSPACE]);
  const storage = createStorage(raw);
  assert.deepEqual(removeWorkspace(storage, [WORKSPACE], WORKSPACE.id), []);
  assert.equal(storage.getItem(LEGACY_BACKUP_KEY), raw);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)!).version, 2);
  const existingBackup = "original-version-one-backup";
  const restored = createStorage(raw);
  restored.setItem(LEGACY_BACKUP_KEY, existingBackup);
  saveWorkspace(restored, [WORKSPACE], { ...WORKSPACE, name: "Renamed" });
  assert.equal(restored.getItem(LEGACY_BACKUP_KEY), existingBackup);
  const current = createStorage(JSON.stringify({ version: 2, workspaces: [WORKSPACE] }));
  removeWorkspace(current, [WORKSPACE], WORKSPACE.id);
  assert.equal(current.getItem(LEGACY_BACKUP_KEY), null);
});

test("migration failures preserve legacy storage and propagate the original error", () => {
  const raw = encoded([WORKSPACE]);
  const failure = new Error("Backup storage quota exceeded");
  for (const operation of ["save", "remove"] as const) {
    const data = createStorage(raw);
    const writes: string[] = [];
    const storage = { getItem: data.getItem, setItem(key: string, value: string) {
      writes.push(key);
      if (key === LEGACY_BACKUP_KEY) throw failure;
      data.setItem(key, value);
    } };
    assert.throws(() => operation === "save" ? saveWorkspace(storage, [WORKSPACE], WORKSPACE)
      : removeWorkspace(storage, [WORKSPACE], WORKSPACE.id), error => error === failure);
    assert.deepEqual(writes, [LEGACY_BACKUP_KEY]);
    assert.equal(data.getItem(STORAGE_KEY), raw);
  }
  const data = createStorage(raw);
  const storage = { getItem: data.getItem, setItem(key: string, value: string) {
    if (key === STORAGE_KEY) throw failure;
    data.setItem(key, value);
  } };
  assert.throws(() => saveWorkspace(storage, [WORKSPACE], WORKSPACE), error => error === failure);
  assert.equal(data.getItem(STORAGE_KEY), raw);
  assert.equal(data.getItem(LEGACY_BACKUP_KEY), raw);
});

test("mutation refuses unreadable or unsupported stored data rather than replacing it", () => {
  const failure = new Error("Storage read denied");
  const unreadable = { getItem() { throw failure; }, setItem() { assert.fail("No writes after a read failure"); } };
  assert.throws(() => saveWorkspace(unreadable, [], WORKSPACE), error => error === failure);
  assert.throws(() => removeWorkspace(unreadable, [WORKSPACE], WORKSPACE.id), error => error === failure);
  for (const raw of ["{", "null", JSON.stringify({ version: 3, workspaces: [] }), encoded([{}])]) {
    const storage = createStorage(raw);
    assert.throws(() => saveWorkspace(storage, [], WORKSPACE));
    assert.throws(() => removeWorkspace(storage, [WORKSPACE], WORKSPACE.id));
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.equal(storage.getItem(LEGACY_BACKUP_KEY), null);
  }
});
