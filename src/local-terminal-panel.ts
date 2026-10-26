import {
  loadLocalTerminalLocations,
  removeLocalTerminalLocation,
  saveLocalTerminalLocation,
  type LocalTerminalLocation,
} from "./local-terminal-locations.ts";

interface LocalTerminalPanelOptions {
  readonly root: HTMLElement;
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly invoke: <T>(command: string, arguments_?: Record<string, unknown>) => Promise<T>;
  readonly openTerminal: (location: LocalTerminalLocation) => Promise<void>;
  readonly createId?: () => string;
  readonly confirmRemoval?: (name: string) => boolean;
}

export function initLocalTerminalPanel(options: LocalTerminalPanelOptions): void {
  const { root, storage, invoke, openTerminal } = options;
  const document = root.ownerDocument;
  const control = <T extends HTMLElement>(id: string): T => {
    const element = root.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Missing saved location control: ${id}`);
    return element;
  };
  const list = control<HTMLUListElement>("local-locations-list");
  const empty = control<HTMLParagraphElement>("local-locations-empty");
  const error = control<HTMLParagraphElement>("local-location-error");
  const editor = control<HTMLDetailsElement>("local-location-editor");
  const toggle = control<HTMLElement>("local-location-editor-toggle");
  const form = control<HTMLFormElement>("local-location-form");
  const path = control<HTMLInputElement>("local-location-path");
  const name = control<HTMLInputElement>("local-location-name");
  const browse = control<HTMLButtonElement>("local-location-browse");
  const cancel = control<HTMLButtonElement>("local-location-cancel");
  const save = control<HTMLButtonElement>("local-location-save");
  const createId = options.createId ?? (() => crypto.randomUUID());
  const confirmRemoval = options.confirmRemoval ?? (label => window.confirm(`Remove saved location "${label}"?`));
  let locations: readonly LocalTerminalLocation[];
  let editingId: string | null = null;
  let busy = false;

  const showError = (cause: unknown) => {
    error.textContent = String(cause instanceof Error ? cause.message : cause);
    error.hidden = false;
  };
  const clearError = () => { error.hidden = true; error.textContent = ""; };
  const setBusy = (value: boolean) => {
    busy = value;
    root.setAttribute("aria-busy", String(value));
    root.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach(element => {
      element.disabled = value;
    });
  };
  const resetEditor = () => {
    editingId = null;
    path.value = "";
    name.value = "";
    toggle.textContent = "Add location";
    save.textContent = "Save location";
    editor.open = false;
  };
  const handleEdit = (location: LocalTerminalLocation) => {
    if (busy) return;
    clearError();
    editingId = location.id;
    path.value = location.path;
    name.value = location.name;
    toggle.textContent = "Edit location";
    save.textContent = "Save changes";
    editor.open = true;
    path.focus();
  };
  const handleOpen = async (location: LocalTerminalLocation) => {
    if (busy) return;
    clearError();
    setBusy(true);
    try { await openTerminal(location); }
    catch (cause) { showError(cause); }
    finally { setBusy(false); }
  };
  const handleRemove = (location: LocalTerminalLocation) => {
    if (busy || !confirmRemoval(location.name)) return;
    clearError();
    try {
      locations = removeLocalTerminalLocation(storage, locations, location.id);
      if (editingId === location.id) resetEditor();
      render();
      toggle.focus();
    } catch (cause) { showError(cause); }
  };
  const render = () => {
    list.replaceChildren();
    empty.hidden = locations.length > 0;
    for (const location of locations) {
      const item = document.createElement("li");
      item.className = "local-location-item";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "local-location-open";
      open.title = `Open PowerShell in ${location.path}`;
      open.setAttribute("aria-label", `Open PowerShell: ${location.name}, ${location.path}`);
      const label = document.createElement("span");
      label.className = "local-location-name";
      label.textContent = location.name;
      const folder = document.createElement("span");
      folder.className = "local-location-path";
      folder.textContent = location.path;
      open.append(label, folder);
      open.addEventListener("click", () => { void handleOpen(location); });
      const actions = document.createElement("div");
      actions.className = "local-location-actions";
      for (const [text, handler] of [["Edit", handleEdit], ["Remove", handleRemove]] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-secondary";
        button.textContent = text;
        button.setAttribute("aria-label", `${text} ${location.name}`);
        button.addEventListener("click", () => handler(location));
        actions.appendChild(button);
      }
      item.append(open, actions);
      list.appendChild(item);
    }
  };

  try { locations = loadLocalTerminalLocations(storage); }
  catch (cause) {
    showError(cause);
    empty.hidden = true;
    editor.hidden = true;
    return;
  }
  render();
  const handleSave = async (event: Event) => {
    event.preventDefault();
    if (busy) return;
    clearError();
    setBusy(true);
    try {
      const directory = await invoke<string>("validate_local_terminal_directory", { workingDirectory: path.value.trim() });
      const location = {
        id: editingId ?? createId(),
        name: name.value.trim() || directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || directory,
        path: directory,
      };
      locations = saveLocalTerminalLocation(storage, locations, location);
      resetEditor();
      render();
      toggle.focus();
    } catch (cause) { showError(cause); }
    finally { setBusy(false); }
  };
  const handleBrowse = async () => {
    if (busy) return;
    clearError();
    setBusy(true);
    try {
      const selected = await invoke<string | null>("select_local_terminal_directory");
      if (selected !== null) path.value = selected;
    } catch (cause) { showError(cause); }
    finally { setBusy(false); path.focus(); }
  };
  const handleCancel = () => {
    if (busy) return;
    clearError();
    resetEditor();
    toggle.focus();
  };
  form.addEventListener("submit", event => { void handleSave(event); });
  browse.addEventListener("click", () => { void handleBrowse(); });
  cancel.addEventListener("click", handleCancel);
}

declare global {
  interface Window {
    SleekSshLocalTerminals?: { initLocalTerminalPanel: typeof initLocalTerminalPanel };
  }
}

if (typeof window !== "undefined") window.SleekSshLocalTerminals = { initLocalTerminalPanel };
