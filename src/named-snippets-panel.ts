import { loadSnippets, saveSnippet, removeSnippet, snippetParameters, type NamedSnippet, type SnippetShell } from "./named-snippets.ts";
import { createNamedSnippetControls } from "./named-snippets-controls.ts";
import { renderNamedSnippetList } from "./named-snippet-list.ts";
import { snippetAvailableInFolder, type SnippetFolder } from "./named-snippet-scope.ts";

export type SnippetPreview = Readonly<{ command: string; targetLabel: string; shell: SnippetShell; token: object }>;
interface NamedSnippetsPanelOptions {
  readonly root: HTMLElement;
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly preview: (snippet: NamedSnippet, values: Readonly<Record<string, string>>) => SnippetPreview;
  readonly isPreviewValid: (preview: SnippetPreview) => boolean;
  readonly execute: (preview: SnippetPreview, run: boolean) => Promise<void>;
  readonly createId?: () => string;
  readonly confirmRemoval?: (name: string) => boolean;
  readonly getFolder?: () => SnippetFolder | null;
}

const MAX_PARAMETER_LENGTH = 4_000;
const SHELL_LABELS = Object.freeze({ posix: "Bash / Zsh", powershell: "PowerShell", cmd: "Command Prompt" });

export function initNamedSnippetsPanel(options: NamedSnippetsPanelOptions) {
  const { root, storage } = options;
  const ui = createNamedSnippetControls(root);
  let disposed = false;
  let busy = false;
  let readable = false;
  let editingId: string | null = null;
  let selected: NamedSnippet | null = null;
  let preview: SnippetPreview | null = null;
  let signature = "";
  let snippets: readonly NamedSnippet[] = [];
  const fields = new Map<string, HTMLInputElement>();
  const setStatus = (message: string) => { ui.status.textContent = message; ui.status.hidden = !message; };
  const clearError = () => { ui.error.textContent = ""; ui.error.hidden = true; };
  const showError = (cause: unknown) => { ui.error.textContent = cause instanceof Error ? cause.message : String(cause); ui.error.hidden = false; };
  const updateControls = () => {
    root.setAttribute("aria-busy", String(busy));
    root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>("input, button, select, textarea")
      .forEach(control => { control.disabled = disposed || busy || !readable || control.dataset.unavailable === "true"; });
    ui.insert.disabled = ui.run.disabled = disposed || busy || !readable || !preview;
  };
  const invalidate = () => {
    preview = null;
    ui.preview.hidden = true;
    ui.output.textContent = ui.target.textContent = ui.previewShell.textContent = "";
    updateControls();
  };
  const clearValues = () => { fields.forEach(field => { field.value = ""; }); fields.clear(); ui.fields.replaceChildren(); };
  const clearEditor = () => { editingId = null; ui.name.value = ui.template.value = ""; };
  const showLibrary = () => {
    if (disposed) return;
    selected = null;
    clearValues(); clearEditor(); invalidate();
    ui.library.hidden = false; ui.editor.hidden = ui.runner.hidden = true;
    if (!busy) ui.search.focus();
  };
  const beginEditor = (command: string, shell: SnippetShell, snippet?: NamedSnippet) => {
    if (disposed || busy || !readable) return;
    if (typeof command !== "string" || !Object.hasOwn(SHELL_LABELS, shell)) { showError(new Error("Choose a command and supported shell mode.")); return; }
    showLibrary(); clearError(); setStatus("");
    editingId = snippet?.id ?? null;
    ui.editorTitle.textContent = snippet ? "Edit snippet" : "Save snippet";
    ui.name.value = snippet?.name ?? "";
    ui.template.value = command;
    for (const option of ui.shell.options) option.selected = false;
    const selectedOption = [...ui.shell.options].find(option => option.value === shell);
    if (selectedOption) selectedOption.selected = true;
    ui.library.hidden = true; ui.editor.hidden = false;
    ui.name.focus();
  };
  const saveFromHistory = (command: string, shell: SnippetShell) => beginEditor(command, shell);
  const matchesSelected = (current: readonly NamedSnippet[]) => selected && current.some(snippet =>
    snippet.id === selected!.id && snippet.template === selected!.template && snippet.shell === selected!.shell && snippet.name === selected!.name
    && JSON.stringify(snippet.folder) === JSON.stringify(selected!.folder));
  const useSnippet = (snippet: NamedSnippet) => {
    if (disposed || busy || !readable) return;
    try {
      if (!snippetAvailableInFolder(snippet, options.getFolder?.() ?? null)) throw new Error("Open this snippet's server and folder before using it.");
      const parameters = snippetParameters(snippet.template, snippet.shell);
      showLibrary(); clearError(); setStatus(""); selected = snippet;
      ui.library.hidden = true; ui.runner.hidden = false;
      ui.runnerTitle.textContent = snippet.name;
      ui.runnerShell.textContent = `Shell mode: ${SHELL_LABELS[snippet.shell]}`;
      ui.cmdHelp.hidden = snippet.shell !== "cmd";
      parameters.forEach((parameter, index) => {
        const field = ui.element("input", "");
        field.type = "text";
        field.id = `named-snippet-parameter-${index}`;
        field.autocomplete = "off"; field.spellcheck = false; field.maxLength = MAX_PARAMETER_LENGTH;
        field.addEventListener("input", () => { if (!disposed && !busy) { invalidate(); setStatus(""); } });
        fields.set(parameter, field);
        ui.fields.append(ui.label(parameter, field.id), field);
      });
      (fields.values().next().value ?? ui.review).focus();
    } catch (cause) { showError(cause); }
  };
  const renderList = () => {
    const query = ui.search.value.trim().toLowerCase();
    const filtered = snippets.filter(snippet => `${snippet.name} ${snippet.template} ${SHELL_LABELS[snippet.shell]} ${snippet.folder ? `${snippet.folder.host} ${snippet.folder.path} folder` : "shared"}`.toLowerCase().includes(query));
    ui.empty.hidden = filtered.length > 0;
    ui.empty.textContent = query ? "No snippets match this search." : "Use Save as snippet on a history command to add it here.";
    renderNamedSnippetList({
      list: ui.list, snippets: filtered, folder: options.getFolder?.() ?? null,
      use: useSnippet, edit: snippet => beginEditor(snippet.template, snippet.shell, snippet),
      toggleScope(snippet) {
        if (disposed || busy || !readable) return;
        try {
          const current = loadSnippets(storage);
          const latest = current.find(item => item.id === snippet.id);
          if (!latest || JSON.stringify(latest) !== JSON.stringify(snippet)) throw new Error("This snippet changed. Refresh the list and try again.");
          const folder = latest.folder ? undefined : options.getFolder?.();
          if (!latest.folder && !folder) throw new Error("Connect to an SSH session with a known working folder first.");
          saveSnippet(storage, current, { ...latest, folder: folder ?? undefined });
          clearError(); invalidate(); refresh();
          [...ui.list.querySelectorAll<HTMLElement>(".named-snippet-item")].find(item => item.dataset.snippetId === snippet.id)
            ?.querySelector<HTMLButtonElement>(".named-snippet-scope")?.focus();
        } catch (cause) { showError(cause); }
      },
      remove(snippet) {
        if (disposed || busy || !readable) return;
        try {
          const confirm = options.confirmRemoval ?? (name => window.confirm(`Remove snippet "${name}"?`));
          if (!confirm(snippet.name)) return;
          removeSnippet(storage, loadSnippets(storage), snippet.id); clearError(); refresh();
          if (readable) { showLibrary(); setStatus(`Removed ${snippet.name}.`); }
        } catch (cause) { showError(cause); }
      },
    });
    updateControls();
  };
  function refresh() {
    if (disposed) return;
    try {
      snippets = loadSnippets(storage);
      const next = JSON.stringify([snippets, options.getFolder?.() ?? null]);
      if (!readable) clearError();
      readable = true;
      if (signature !== next) { signature = next; renderList(); }
      if (preview && (!matchesSelected(snippets) || !selected || !snippetAvailableInFolder(selected, options.getFolder?.() ?? null) || !options.isPreviewValid(preview))) {
        invalidate(); setStatus("Preview expired. Review the command again before inserting or running.");
      }
    } catch (cause) { readable = false; invalidate(); showError(cause); }
    updateControls();
  }
  const review = (event: Event) => {
    event.preventDefault();
    if (disposed || busy || !readable || !selected) return;
    invalidate(); clearError(); setStatus("");
    try {
      if (!matchesSelected(loadSnippets(storage))) throw new Error("This snippet changed. Select it again from the library.");
      if (!snippetAvailableInFolder(selected, options.getFolder?.() ?? null)) throw new Error("Open this snippet's server and folder before reviewing it.");
      const candidate = options.preview(selected, Object.freeze(Object.fromEntries([...fields].map(([key, field]) => [key, field.value]))));
      if (!options.isPreviewValid(candidate)) throw new Error("The terminal changed. Review the command again at a ready prompt.");
      preview = candidate;
      ui.target.textContent = `Target: ${candidate.targetLabel}`;
      ui.previewShell.textContent = `Shell mode: ${SHELL_LABELS[candidate.shell]}`;
      ui.output.textContent = candidate.command;
      ui.preview.hidden = false;
      updateControls();
    } catch (cause) { showError(cause); }
  };
  const execute = async (run: boolean) => {
    if (disposed || busy || !readable || !preview) return;
    const reviewed = preview;
    invalidate(); clearError();
    try {
      if (!matchesSelected(loadSnippets(storage)) || !selected || !snippetAvailableInFolder(selected, options.getFolder?.() ?? null) || !options.isPreviewValid(reviewed)) throw new Error("The preview expired. Review the command again.");
      busy = true; updateControls(); setStatus(run ? "Sending command…" : "Inserting command…");
      await options.execute(reviewed, run);
      if (!disposed) setStatus(run ? `Command sent to ${reviewed.targetLabel}.` : `Inserted into ${reviewed.targetLabel} without running.`);
    } catch (cause) { if (!disposed) { setStatus(""); showError(cause); } }
    finally { busy = false; if (!disposed) updateControls(); }
  };
  ui.editor.addEventListener("submit", event => {
    event.preventDefault();
    if (disposed || busy || !readable) return;
    try {
      const existing = loadSnippets(storage);
      if (editingId && !existing.some(snippet => snippet.id === editingId)) throw new Error("This snippet was removed. Save it as a new snippet from history.");
      const folder = existing.find(snippet => snippet.id === editingId)?.folder;
      const snippet = { id: editingId ?? (options.createId ?? (() => crypto.randomUUID()))(), name: ui.name.value, ...(folder ? { folder } : {}),
        template: ui.template.value, shell: ui.shell.value as SnippetShell };
      saveSnippet(storage, existing, snippet); clearError(); refresh();
      if (readable) { showLibrary(); setStatus(`Saved ${snippet.name.trim()}.`); }
    } catch (cause) { showError(cause); }
  });
  ui.editor.addEventListener("input", () => { if (!disposed) invalidate(); });
  ui.shell.addEventListener("change", () => { if (!disposed) invalidate(); });
  ui.search.addEventListener("input", () => { if (!disposed && !busy && readable) renderList(); });
  ui.cancel.addEventListener("click", () => { if (!busy) showLibrary(); });
  ui.back.addEventListener("click", () => { if (!busy) showLibrary(); });
  ui.runner.addEventListener("submit", review);
  ui.insert.addEventListener("click", () => { void execute(false); });
  ui.run.addEventListener("click", () => { void execute(true); });
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && (!ui.editor.hidden || !ui.runner.hidden)) {
      event.preventDefault(); event.stopPropagation(); if (!busy) showLibrary();
    }
  };
  root.addEventListener("keydown", keydown);
  refresh();
  return Object.freeze({ refresh, saveFromHistory, showLibrary, invalidate,
    openSnippet(id: string) {
      if (disposed) return;
      const snippet = loadSnippets(storage).find(item => item.id === id);
      if (!snippet) throw new Error("This snippet is no longer saved. Open the snippet library again.");
      useSnippet(snippet);
    },
    dispose() {
    if (disposed) return;
    showLibrary(); disposed = true; updateControls();
    root.removeEventListener("keydown", keydown); root.replaceChildren();
  } });
}
