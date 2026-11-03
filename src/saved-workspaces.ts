export type WorkspaceTerminal = Readonly<{
  kind: "ssh";
  profileId: string;
  name: string;
  remotePath: string | null;
  sftpPanelOpen: boolean;
}> | Readonly<{
  kind: "local";
  shell: "powershell" | "cmd";
  workingDirectory: string | null;
  locationName: string | null;
}>;

export type WorkspaceTab = WorkspaceTerminal & Readonly<{
  split?: Readonly<{
    direction: "right" | "below";
    ratio: number;
    activePaneIndex: 0 | 1;
    secondary: WorkspaceTerminal;
  }>;
}>;

export interface WorkspaceLayout {
  readonly sidebarWidth: number;
  readonly sftpWidth: number;
  readonly sidebarOpen: boolean;
  readonly sidebarView: "connections" | "terminal" | "keys" | "vpn" | "workspaces";
  readonly sidePanel: "none" | "files" | "history" | "agent" | "snippets";
}

export interface WorkspaceSnapshot {
  readonly tabs: readonly WorkspaceTab[];
  readonly activeTabIndex: number;
  readonly layout: WorkspaceLayout;
}

export interface SavedWorkspace extends WorkspaceSnapshot {
  readonly id: string;
  readonly name: string;
}

const STORAGE_KEY = "sleekssh_saved_workspaces";
const LEGACY_BACKUP_KEY = "sleekssh_saved_workspaces_v1_backup";
const LEGACY_STORAGE_VERSION = 1;
const STORAGE_VERSION = 2;
const MAX_WORKSPACES = 50;
const MAX_TABS = 50;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 120;
const MAX_PATH_LENGTH = 32_767;
const MIN_PANE_RATIO = 0.2;
const MAX_PANE_RATIO = 0.8;
const SIDEBAR_MINIMUM = 200;
const SIDEBAR_MAXIMUM = 360;
const SFTP_MINIMUM = 220;
const SFTP_MAXIMUM = 420;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_DRIVE_PATH = /^[a-z]:[\\/]/i;
const ABSOLUTE_NETWORK_PATH = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/;
const SIDEBAR_VIEWS = ["connections", "terminal", "keys", "vpn", "workspaces"] as const;
const SIDE_PANELS = ["none", "files", "history", "agent", "snippets"] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximumLength: number, trim = true): string {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value) || !value.trim()) {
    throw new Error(`${label} must be nonempty text without control characters.`);
  }
  const result = trim ? value.trim() : value;
  if (result.length > maximumLength) throw new Error(`${label} must be at most ${maximumLength} characters.`);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`);
  return value;
}

function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new Error(`${label} must be one of: ${choices.join(", ")}.`);
  }
  return value as T;
}

function width(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function folder(value: unknown, remote: boolean): string | null {
  if (value === null) return null;
  const label = remote ? "Remote folder" : "Local folder";
  const path = text(value, label, MAX_PATH_LENGTH, false);
  const valid = remote
    ? path === "." || path.startsWith("/")
    : ABSOLUTE_DRIVE_PATH.test(path) || ABSOLUTE_NETWORK_PATH.test(path);
  if (!valid) throw new Error(`${label} must be ${remote ? "an absolute path or '.'" : "an absolute Windows path"}.`);
  return path;
}

function validateTerminal(value: unknown): WorkspaceTerminal {
  const tab = record(value, "Workspace tab");
  if (tab.kind === "ssh") {
    return Object.freeze({
      kind: "ssh",
      profileId: text(tab.profileId, "Host profile ID", MAX_ID_LENGTH),
      name: text(tab.name, "Host name", MAX_NAME_LENGTH),
      remotePath: folder(tab.remotePath, true),
      sftpPanelOpen: boolean(tab.sftpPanelOpen, "Files panel visibility"),
    });
  }
  if (tab.kind === "local") {
    return Object.freeze({
      kind: "local",
      shell: choice(tab.shell, ["powershell", "cmd"] as const, "Local shell"),
      workingDirectory: folder(tab.workingDirectory, false),
      locationName: tab.locationName === null ? null : text(tab.locationName, "Location name", MAX_NAME_LENGTH),
    });
  }
  throw new Error("Workspace tabs must be SSH or local terminals.");
}

function validateTab(value: unknown): WorkspaceTab {
  const tab = record(value, "Workspace tab");
  const terminal = validateTerminal(tab);
  if (!Object.hasOwn(tab, "split")) return terminal;
  const split = record(tab.split, "Workspace split");
  const secondary = record(split.secondary, "Secondary terminal");
  if (Object.hasOwn(secondary, "split")) throw new Error("Workspace tabs support at most two panes; nested splits are not supported.");
  if (split.activePaneIndex !== 0 && split.activePaneIndex !== 1) throw new Error("The active pane must be 0 or 1.");
  return Object.freeze({
    ...terminal,
    split: Object.freeze({
      direction: choice(split.direction, ["right", "below"] as const, "Split direction"),
      ratio: width(split.ratio, MIN_PANE_RATIO, MAX_PANE_RATIO, "Pane ratio"),
      activePaneIndex: split.activePaneIndex,
      secondary: validateTerminal(secondary),
    }),
  });
}

function validateLayout(value: unknown): WorkspaceLayout {
  const layout = record(value, "Workspace layout");
  return Object.freeze({
    sidebarWidth: width(layout.sidebarWidth, SIDEBAR_MINIMUM, SIDEBAR_MAXIMUM, "Sidebar width"),
    sftpWidth: width(layout.sftpWidth, SFTP_MINIMUM, SFTP_MAXIMUM, "Files panel width"),
    sidebarOpen: boolean(layout.sidebarOpen, "Sidebar visibility"),
    sidebarView: choice(layout.sidebarView, SIDEBAR_VIEWS, "Sidebar view"),
    sidePanel: choice(layout.sidePanel, SIDE_PANELS, "Side panel"),
  });
}

export function validateWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  const snapshot = record(value, "Workspace");
  if (!Array.isArray(snapshot.tabs) || snapshot.tabs.length === 0 || snapshot.tabs.length > MAX_TABS) {
    throw new Error(`A workspace must contain between 1 and ${MAX_TABS} terminal tabs.`);
  }
  const tabs = Object.freeze(Array.from(snapshot.tabs, validateTab));
  if (typeof snapshot.activeTabIndex !== "number" || !Number.isInteger(snapshot.activeTabIndex)
    || snapshot.activeTabIndex < 0 || snapshot.activeTabIndex >= tabs.length) {
    throw new Error("The active tab must refer to a terminal in the workspace.");
  }
  return Object.freeze({ tabs, activeTabIndex: snapshot.activeTabIndex, layout: validateLayout(snapshot.layout) });
}

function validateWorkspace(value: unknown): SavedWorkspace {
  const workspace = record(value, "Saved workspace");
  return Object.freeze({
    id: text(workspace.id, "Workspace ID", MAX_ID_LENGTH),
    name: text(workspace.name, "Workspace name", MAX_NAME_LENGTH),
    ...validateWorkspaceSnapshot(workspace),
  });
}

function validateWorkspaces(value: unknown): readonly SavedWorkspace[] {
  if (!Array.isArray(value)) throw new Error("Saved workspaces must be a list.");
  if (value.length > MAX_WORKSPACES) throw new Error(`Save at most ${MAX_WORKSPACES} workspaces.`);
  const workspaces = Array.from(value, validateWorkspace);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const workspace of workspaces) {
    if (ids.has(workspace.id)) throw new Error("Saved workspaces contain a duplicate workspace ID.");
    const name = workspace.name.toLowerCase();
    if (names.has(name)) throw new Error("A workspace with that name already exists.");
    ids.add(workspace.id);
    names.add(name);
  }
  return Object.freeze(workspaces);
}

function parseEnvelope(saved: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(saved); }
  catch (cause) { throw new Error("Saved workspaces could not be read. Their stored data is invalid.", { cause }); }
  const envelope = record(parsed, "Saved workspace data");
  if (envelope.version !== STORAGE_VERSION && envelope.version !== LEGACY_STORAGE_VERSION) {
    throw new Error("This saved workspace format is not supported.");
  }
  return envelope;
}

export function loadSavedWorkspaces(storage: Pick<Storage, "getItem">): readonly SavedWorkspace[] {
  const saved = storage.getItem(STORAGE_KEY);
  return saved === null ? Object.freeze([]) : validateWorkspaces(parseEnvelope(saved).workspaces);
}

function writeWorkspaces(storage: Pick<Storage, "getItem" | "setItem">, workspaces: readonly SavedWorkspace[]): void {
  const saved = storage.getItem(STORAGE_KEY);
  if (saved !== null) {
    const envelope = parseEnvelope(saved);
    validateWorkspaces(envelope.workspaces);
    if (envelope.version === LEGACY_STORAGE_VERSION && storage.getItem(LEGACY_BACKUP_KEY) === null) {
      storage.setItem(LEGACY_BACKUP_KEY, saved);
    }
  }
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, workspaces }));
}

export function saveWorkspace(
  storage: Pick<Storage, "getItem" | "setItem">,
  workspaces: readonly SavedWorkspace[],
  workspace: SavedWorkspace,
): readonly SavedWorkspace[] {
  const existing = validateWorkspaces(workspaces);
  const next = validateWorkspace(workspace);
  const updated = validateWorkspaces(existing.some(item => item.id === next.id)
    ? existing.map(item => item.id === next.id ? next : item)
    : [...existing, next]);
  writeWorkspaces(storage, updated);
  return updated;
}

export function removeWorkspace(
  storage: Pick<Storage, "getItem" | "setItem">,
  workspaces: readonly SavedWorkspace[],
  id: string,
): readonly SavedWorkspace[] {
  const validatedId = text(id, "Workspace ID", MAX_ID_LENGTH);
  const updated = Object.freeze(validateWorkspaces(workspaces).filter(workspace => workspace.id !== validatedId));
  writeWorkspaces(storage, updated);
  return updated;
}
