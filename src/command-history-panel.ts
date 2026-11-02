import { createCommandHistory, type HistoryContext } from "./command-history.ts";

type CommandHistoryPanelOptions = Readonly<{
  root: HTMLElement;
  history: ReturnType<typeof createCommandHistory>;
  getContext: () => HistoryContext | null;
  insert: (command: string) => void;
  saveSnippet?: (command: string) => void;
  onClose: () => void;
  onError?: (error: unknown) => void;
}>;

export function initCommandHistoryPanel(options: CommandHistoryPanelOptions) {
  if (!options?.root?.ownerDocument) throw new Error("Command history panel is unavailable.");
  const { root, history } = options;
  const document = root.ownerDocument;
  const control = <T extends HTMLElement>(id: string): T => {
    const element = root.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Missing command history control: ${id}`);
    return element;
  };
  const search = control<HTMLInputElement>("command-history-search");
  const list = control<HTMLUListElement>("command-history-list");
  const empty = control("command-history-empty");
  const error = control("command-history-error");
  const target = control("command-history-target");
  const close = control<HTMLButtonElement>("command-history-close");
  let disposed = false;

  function showError(cause: unknown) {
    error.textContent = `Command history: ${cause instanceof Error ? cause.message : String(cause)}`;
    error.hidden = false;
    options.onError?.(cause);
  }

  function insert(command: string) {
    if (disposed) return;
    try {
      options.insert(command);
      error.hidden = true;
      error.textContent = "";
    } catch (cause) { showError(cause); }
  }

  function refresh() {
    if (disposed) return;
    try {
      const context = options.getContext();
      target.textContent = context?.label ?? "Select a connected terminal.";
      search.disabled = !context;
      const entries = context ? history.entries(context.key, search.value) : [];
      list.replaceChildren(...entries.map(entry => {
        const item = document.createElement("li");
        item.className = "command-history-item";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "command-history-insert";
        button.title = "Insert into the terminal without running";
        const command = document.createElement("code");
        command.className = "command-history-command";
        command.textContent = entry.command;
        const count = document.createElement("span");
        count.className = "command-history-count";
        count.textContent = `${entry.runCount} ${entry.runCount === 1 ? "run" : "runs"}`;
        const source = document.createElement("span");
        source.className = "command-history-source";
        source.textContent = `${entry.terminalCount} terminal · ${entry.agentCount} agent`;
        button.append(command, count, source);
        button.addEventListener("click", () => insert(entry.command));
        item.append(button);
        if (options.saveSnippet) {
          const save = document.createElement("button");
          save.type = "button";
          save.className = "command-history-save-snippet btn btn-secondary";
          save.textContent = "Save as snippet";
          save.disabled = /[\r\n\t]/.test(entry.command);
          save.title = save.disabled ? "Snippets support single-line commands." : "Name and parameterize this command";
          save.addEventListener("click", () => {
            if (disposed) return;
            try { options.saveSnippet?.(entry.command); }
            catch (cause) { showError(cause); }
          });
          item.append(save);
        }
        return item;
      }));
      empty.hidden = entries.length > 0;
      empty.textContent = !context ? "Connect to a terminal to see its command history."
        : search.value.trim() ? "No commands match this search."
          : "Commands you run here or through the agent will appear here.";
      error.hidden = true;
      error.textContent = "";
    } catch (cause) { showError(cause); }
  }

  function handleClose() {
    if (disposed) return;
    try { options.onClose(); }
    catch (cause) { showError(cause); }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    handleClose();
  }

  search.addEventListener("input", refresh);
  close.addEventListener("click", handleClose);
  root.addEventListener("keydown", handleKeydown);
  const unsubscribe = history.subscribe(refresh);
  refresh();
  return Object.freeze({
    refresh,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      search.removeEventListener("input", refresh);
      close.removeEventListener("click", handleClose);
      root.removeEventListener("keydown", handleKeydown);
    },
  });
}

declare global {
  interface Window {
    SleekSshCommandHistory?: { createCommandHistory: typeof createCommandHistory; initCommandHistoryPanel: typeof initCommandHistoryPanel };
  }
}

if (typeof window !== "undefined") window.SleekSshCommandHistory = { createCommandHistory, initCommandHistoryPanel };
