import type { SavedWorkspace } from "./saved-workspaces.ts";

interface SavedWorkspacesPanelOptions {
  readonly root: HTMLElement;
  readonly list: () => readonly SavedWorkspace[];
  readonly save: (name: string, id?: string) => Promise<void>;
  readonly rename: (id: string, name: string) => void;
  readonly remove: (id: string) => void;
  readonly open: (id: string) => Promise<readonly string[]>;
  readonly confirmRemoval?: (name: string) => boolean;
  readonly confirmUpdate?: (name: string) => boolean;
}

const MAX_WORKSPACE_NAME_LENGTH = 120;

export function initSavedWorkspacesPanel(options: SavedWorkspacesPanelOptions) {
  const { root } = options;
  const document = root.ownerDocument;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = "") => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };
  const button = (label: string, handler: () => void, className = "btn btn-secondary") => {
    const node = element("button", className, label);
    node.type = "button";
    node.addEventListener("click", handler);
    return node;
  };
  const saveCurrent = button("Save current workspace", () => showSave(), "btn btn-primary btn-full");
  const editor = element("form", "saved-workspace-editor");
  editor.id = "saved-workspace-editor";
  editor.hidden = true;
  saveCurrent.setAttribute("aria-expanded", "false");
  saveCurrent.setAttribute("aria-controls", editor.id);
  const label = element("label", "", "Workspace name");
  const name = element("input", "");
  name.id = "saved-workspace-name";
  name.required = true;
  name.maxLength = MAX_WORKSPACE_NAME_LENGTH;
  name.autocomplete = "off";
  label.setAttribute("for", name.id);
  const save = element("button", "btn btn-primary", "Save workspace");
  save.type = "submit";
  const cancel = button("Cancel", () => { if (!busy) closeEditor(); });
  const editorActions = element("div", "saved-workspace-actions");
  editorActions.append(save, cancel);
  editor.append(label, name, editorActions);
  const empty = element("p", "small-text", "Save your open hosts, local folders, and layout to reopen them together.");
  const list = element("ul", "saved-workspace-list");
  list.setAttribute("aria-label", "Saved workspaces");
  const status = element("p", "saved-workspace-status");
  status.setAttribute("role", "status");
  status.hidden = true;
  const error = element("p", "saved-workspace-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  root.classList.add("saved-workspaces");
  root.replaceChildren(saveCurrent, editor, status, error, empty, list);
  let busy = false;
  let readable = false;
  let editing: SavedWorkspace | null = null;
  let returnFocus: HTMLElement = saveCurrent;
  let pendingFocus: HTMLElement | null = null;
  const setStatus = (text: string) => { status.textContent = text; status.hidden = !text; };
  const showError = (cause: unknown) => {
    error.textContent = cause instanceof Error ? cause.message : String(cause);
    error.hidden = false;
  };
  const clearError = () => { error.textContent = ""; error.hidden = true; };
  const updateControls = () => {
    root.setAttribute("aria-busy", String(busy));
    root.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach(control => {
      control.disabled = busy || !readable;
    });
  };
  const closeEditor = () => {
    editor.hidden = true;
    editing = null;
    saveCurrent.setAttribute("aria-expanded", "false");
    const target = returnFocus.isConnected ? returnFocus : saveCurrent;
    if (busy) pendingFocus = target;
    else target.focus();
  };
  const beginEditor = (workspace: SavedWorkspace | null, trigger: HTMLElement) => {
    if (busy || !readable) return;
    clearError();
    setStatus("");
    editing = workspace;
    returnFocus = trigger;
    name.value = workspace?.name ?? "";
    save.textContent = workspace ? "Rename workspace" : "Save workspace";
    editor.hidden = false;
    saveCurrent.setAttribute("aria-expanded", "true");
    name.focus();
  };
  const showSave = () => beginEditor(null, saveCurrent);
  const perform = async (message: string, action: () => Promise<void>) => {
    if (busy || !readable) return;
    busy = true;
    clearError();
    setStatus(message);
    updateControls();
    try { await action(); }
    catch (cause) { setStatus(""); showError(cause); }
    finally {
      busy = false;
      updateControls();
      pendingFocus?.focus();
      pendingFocus = null;
    }
  };
  const open = async (id: string) => perform("Opening workspace…", async () => {
    const workspace = options.list().find(item => item.id === id);
    if (!workspace) throw new Error("This workspace no longer exists. Refresh the workspace list.");
    const failures = await options.open(id);
    setStatus(failures.length ? `Finished opening ${workspace.name} with issues.` : `Opened ${workspace.name}.`);
    if (failures.length) showError(failures.join("\n"));
  });
  const refresh = () => {
    try {
      const workspaces = options.list();
      const items = workspaces.map(workspace => {
        const item = element("li", "saved-workspace-item");
        const title = element("span", "saved-workspace-name", workspace.name);
        title.title = workspace.name;
        const count = element("span", "saved-workspace-count", `${workspace.tabs.length} ${workspace.tabs.length === 1 ? "tab" : "tabs"}`);
        const heading = element("div", "saved-workspace-heading");
        heading.append(title, count);
        const actions = element("div", "saved-workspace-actions");
        const openButton = button("Open", () => { void open(workspace.id); });
        const renameButton = button("Rename", () => beginEditor(workspace, renameButton));
        const updateButton = button("Update", () => { void perform("Updating workspace…", async () => {
          const confirm = options.confirmUpdate ?? (text => window.confirm(`Replace the saved tabs and layout in "${text}" with your current workspace?`));
          if (!confirm(workspace.name)) { setStatus(""); return; }
          await options.save(workspace.name, workspace.id);
          refresh();
          if (readable) { closeEditor(); setStatus(`Updated ${workspace.name}.`); }
        }); });
        const removeButton = button("Remove", () => { void perform("Removing workspace…", async () => {
          const confirm = options.confirmRemoval ?? (text => window.confirm(`Remove saved workspace "${text}"? Open terminals will stay open.`));
          if (!confirm(workspace.name)) { setStatus(""); return; }
          options.remove(workspace.id);
          refresh();
          if (readable) { closeEditor(); setStatus(`Removed ${workspace.name}.`); }
        }); });
        for (const control of [openButton, renameButton, updateButton, removeButton]) {
          control.setAttribute("aria-label", `${control.textContent} ${workspace.name}`);
        }
        actions.append(openButton, renameButton, updateButton, removeButton);
        item.append(heading, actions);
        return item;
      });
      list.replaceChildren(...items);
      empty.hidden = workspaces.length > 0;
      if (!readable) clearError();
      readable = true;
    } catch (cause) { readable = false; empty.hidden = true; setStatus(""); showError(cause); }
    updateControls();
  };
  editor.addEventListener("submit", event => {
    event.preventDefault();
    void perform(editing ? "Renaming workspace…" : "Saving workspace…", async () => {
      const workspaceName = name.value.trim();
      if (!workspaceName || workspaceName.length > MAX_WORKSPACE_NAME_LENGTH) {
        throw new Error(`Enter a workspace name between 1 and ${MAX_WORKSPACE_NAME_LENGTH} characters.`);
      }
      if (editing) options.rename(editing.id, workspaceName);
      else await options.save(workspaceName);
      refresh();
      if (readable) { closeEditor(); setStatus(`Saved ${workspaceName}.`); }
    });
  });
  editor.addEventListener("keydown", event => {
    if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopPropagation(); closeEditor(); }
  });
  refresh();
  return Object.freeze({ refresh, showSave, open });
}
