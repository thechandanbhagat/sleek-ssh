import {
  loadSavedWorkspaces, removeWorkspace, saveWorkspace, validateWorkspaceSnapshot,
  type SavedWorkspace, type WorkspaceLayout, type WorkspaceSnapshot, type WorkspaceTab,
} from "./saved-workspaces.ts";
import { initSavedWorkspacesPanel } from "./saved-workspaces-panel.ts";

interface WorkspaceTerminalSession {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly isClosing?: boolean;
  readonly connectionProfile?: Readonly<{ id: string }>;
  readonly terminalPath?: string | null;
  readonly currentPath?: string | null;
  readonly sftpPanelOpen?: boolean;
  readonly shell?: string;
  readonly workingDirectory?: string | null;
  readonly locationName?: string | null;
}

interface WorkspaceSession extends WorkspaceTerminalSession {
  readonly split?: Readonly<{
    direction: "right" | "below";
    ratio: number;
    activePaneIndex: 0 | 1;
    secondary: WorkspaceTerminalSession;
  }>;
}

interface WorkspaceState {
  readonly sessions: readonly WorkspaceSession[];
  readonly activeSessionId: string | null;
  readonly profileIds: readonly string[];
  readonly layout: WorkspaceLayout;
}

interface OpenedWorkspaceTab {
  readonly sessionId: string;
  readonly error?: string;
}

interface RestoreOptions {
  readonly openTab: (tab: WorkspaceTab) => Promise<OpenedWorkspaceTab>;
  readonly hasSession: (id: string) => boolean;
  readonly applyLayout: (layout: WorkspaceLayout, activeSessionId: string) => void;
}

interface IntegrationOptions extends RestoreOptions {
  readonly root: HTMLElement;
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly getState: () => WorkspaceState;
  readonly prepare: () => Promise<void>;
  readonly notify: (message: string) => void;
  readonly createId?: () => string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function captureWorkspace(state: WorkspaceState): WorkspaceSnapshot {
  const sessions = state.sessions.filter(session => !session.isClosing && (session.kind === "ssh" || session.kind === "local"));
  const panes = sessions.flatMap(session => {
    if (!Object.hasOwn(session, "split")) return [session];
    const secondary = session.split?.secondary;
    if (!secondary || Array.isArray(secondary) || typeof secondary !== "object"
      || secondary.isClosing || !["ssh", "local"].includes(secondary.kind)) {
      throw new Error("A split workspace needs an available SSH or local terminal in its second pane.");
    }
    if (Object.hasOwn(secondary, "split")) throw new Error("Workspace tabs support at most two panes; nested splits are not supported.");
    if (secondary.id === session.id) throw new Error("A split workspace needs two independent terminal sessions.");
    return [session, secondary];
  });
  const unsaved = panes.filter(session => session.kind === "ssh" && !state.profileIds.includes(session.connectionProfile?.id ?? ""));
  if (unsaved.length) throw new Error(`Save these SSH hosts in Hosts before saving a workspace: ${unsaved.map(session => session.name).join(", ")}.`);
  const terminal = (session: WorkspaceTerminalSession) => session.kind === "ssh" ? {
    kind: "ssh", profileId: session.connectionProfile!.id, name: session.name,
    remotePath: session.terminalPath || session.currentPath || null, sftpPanelOpen: session.sftpPanelOpen !== false,
  } : {
    kind: "local", shell: session.shell, workingDirectory: session.workingDirectory ?? null, locationName: session.locationName ?? null,
  };
  const tabs = sessions.map(session => ({
    ...terminal(session),
    ...(session.split ? { split: {
      direction: session.split.direction, ratio: session.split.ratio, activePaneIndex: session.split.activePaneIndex,
      secondary: terminal(session.split.secondary),
    } } : {}),
  }));
  return validateWorkspaceSnapshot({
    tabs, activeTabIndex: Math.max(0, sessions.findIndex(session => session.id === state.activeSessionId
      || session.split?.secondary.id === state.activeSessionId)), layout: state.layout,
  });
}

export async function restoreWorkspace(snapshot: WorkspaceSnapshot, options: RestoreOptions): Promise<readonly string[]> {
  const validated = validateWorkspaceSnapshot(snapshot);
  const opened: Array<OpenedWorkspaceTab | null> = [];
  const failures: string[] = [];
  for (const tab of validated.tabs) {
    const label = tab.kind === "ssh" ? tab.name : tab.locationName || tab.workingDirectory || tab.shell;
    try {
      const result = await options.openTab(tab);
      opened.push(result);
      if (result.error) failures.push(`${label}: ${result.error}`);
    } catch (error) {
      opened.push(null);
      failures.push(`${label}: ${errorMessage(error)}`);
    }
  }
  const savedActive = opened[validated.activeTabIndex];
  const active = savedActive && options.hasSession(savedActive.sessionId) ? savedActive
    : opened.find(result => result && options.hasSession(result.sessionId));
  if (active) options.applyLayout(validated.layout, active.sessionId);
  return Object.freeze(failures);
}

export function initSavedWorkspacesIntegration(options: IntegrationOptions) {
  const list = () => loadSavedWorkspaces(options.storage);
  const find = (id: string): SavedWorkspace => {
    const workspace = list().find(item => item.id === id);
    if (!workspace) throw new Error("That saved workspace no longer exists.");
    return workspace;
  };
  let restoring = false;
  const panel = initSavedWorkspacesPanel({
    root: options.root, list,
    async save(name, id) {
      await options.prepare();
      if (id) find(id);
      const snapshot = captureWorkspace(options.getState());
      saveWorkspace(options.storage, list(), { ...snapshot, id: id ?? (options.createId ?? (() => crypto.randomUUID()))(), name });
    },
    rename(id, name) { saveWorkspace(options.storage, list(), { ...find(id), name }); },
    remove(id) { removeWorkspace(options.storage, list(), find(id).id); },
    async open(id) {
      if (restoring) throw new Error("A workspace is already opening.");
      const workspace = find(id);
      restoring = true;
      try {
        await options.prepare();
        const failures = await restoreWorkspace(workspace, options);
        options.notify(failures.length
          ? `Opened ${workspace.name} with ${failures.length} issue${failures.length === 1 ? "" : "s"}. See Workspaces for details.`
          : `Opened ${workspace.name}.`);
        return failures;
      } finally { restoring = false; }
    },
  });
  return { list, open: panel.open, showSave: panel.showSave, refresh: panel.refresh };
}

declare global {
  interface Window {
    SleekSshWorkspaces?: { initSavedWorkspacesIntegration: typeof initSavedWorkspacesIntegration };
  }
}

if (typeof window !== "undefined") window.SleekSshWorkspaces = { initSavedWorkspacesIntegration };
