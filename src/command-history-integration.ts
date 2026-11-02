import { createCommandHistory, type HistoryContext } from "./command-history.ts";
import { initCommandHistoryPanel } from "./command-history-panel.ts";
import { initTerminalSuggestions } from "./terminal-suggestions.ts";
import { SSH_COMMAND_HISTORY_SCRIPT } from "./shell-integration.ts";
import { initNamedSnippetsIntegration, type SnippetSession } from "./named-snippets-integration.ts";
import { loadSnippets } from "./named-snippets.ts";
import { snippetsForFolder, snippetFolderForSession } from "./named-snippet-scope.ts";

type SuggestionTerminal = Parameters<typeof initTerminalSuggestions>[0]["term"];
type HistorySession = Readonly<{
  id: string;
  kind: string;
  name: string;
  shell?: string;
  host?: string;
  terminalPath?: string | null;
  connectionId?: string | null;
  connectionProfile?: Readonly<{ id?: string; username: string; port: number }>;
  isClosed?: boolean;
  isClosing?: boolean;
  isConnecting?: boolean;
  isReady?: boolean;
  term?: SuggestionTerminal & { focus?: () => void };
  container: HTMLElement;
  commandHistory?: ReturnType<typeof initTerminalSuggestions>;
}>;
type IntegrationOptions = Readonly<{
  document: Document;
  storage: Pick<Storage, "getItem" | "setItem">;
  getSession: () => HistorySession | null;
  sendText: (session: HistorySession, text: string) => void;
  writeSnippet?: (session: SnippetSession, text: string) => Promise<void>;
  onLayoutChange: () => void;
  closeAgent: () => void;
  openAgent: () => void;
  openFiles: () => void;
  onError: (message: string) => void;
}>;
type AgentTarget = Readonly<{ sessionId: string; label: string; contextKey?: string }>;

const HISTORY_OSC = 6973;
const COMMAND_PAYLOAD_PREFIX = "command;";
const MAX_COMMAND_PAYLOAD_CHARACTERS = 100_000;

function sessionContext(session: HistorySession | null): HistoryContext | null {
  if (!session) return null;
  if (session.kind === "local" && session.shell) return { key: JSON.stringify(["local", session.shell]), label: session.name };
  const profile = session.connectionProfile;
  if (session.kind !== "ssh" || !profile || !session.host) return null;
  return {
    key: JSON.stringify([profile.id || "", profile.username, session.host, profile.port]),
    label: `${session.name} · ${profile.username}@${session.host}:${profile.port}`,
  };
}

function connected(session: HistorySession): boolean {
  return !session.isClosed && !session.isClosing && !session.isConnecting
    && (session.kind === "local" ? Boolean(session.isReady) : Boolean(session.connectionId));
}

export function initCommandHistoryIntegration(options: IntegrationOptions) {
  const document = options.document;
  const root = document.getElementById("command-history-panel");
  if (!root) throw new Error("Command history panel is missing.");
  const history = createCommandHistory({ storage: options.storage });
  const bindings: Array<() => void> = [];
  const controllers = new Set<Readonly<{ refresh: () => void; dispose: () => void }>>();
  let disposed = false;
  let snippets: ReturnType<typeof initNamedSnippetsIntegration> | null = null;
  let snippetView = false;

  function showError(cause: unknown) {
    const message = `Could not use command history: ${cause instanceof Error ? cause.message : String(cause)}`;
    const error = root!.querySelector<HTMLElement>("#command-history-error");
    if (error) { error.textContent = message; error.hidden = false; }
    options.onError(message);
  }

  function refresh() {
    if (disposed) return;
    panel.refresh();
    const session = options.getSession();
    const open = !root!.hidden;
    document.querySelector(".app-container")?.classList.toggle("history-open", open);
    document.querySelectorAll(".session-history-toggle, #btn-command-history-toggle").forEach(button => {
      button.setAttribute("aria-expanded", String(open && !snippetView));
      button.setAttribute("aria-pressed", String(open && !snippetView));
    });
    const files = document.getElementById("command-history-files-tab") as HTMLButtonElement | null;
    const agent = document.getElementById("command-history-agent-tab") as HTMLButtonElement | null;
    if (files) files.disabled = session?.kind !== "ssh";
    if (agent) agent.disabled = session?.kind !== "ssh";
    controllers.forEach(controller => controller.refresh());
    snippets?.refresh();
  }

  function setOpen(open: boolean, focus = true) {
    if (disposed || root!.hidden === !open) return;
    // Agent refreshes can close this panel while the previous tab is still active.
    if (open) options.closeAgent();
    root!.hidden = !open;
    if (!open) { snippets?.showLibrary(); snippetView = false; updateView(); }
    refresh();
    options.onLayoutChange();
    if (focus) {
      if (open) root!.querySelector<HTMLInputElement>(snippetView ? "#named-snippet-search" : "#command-history-search")?.focus();
      else options.getSession()?.term?.focus?.();
    }
  }

  const panel = initCommandHistoryPanel({
    root,
    history,
    getContext: () => sessionContext(options.getSession()),
    insert(command) {
      if (/[\r\n\t]/.test(command)) throw new Error("This command spans multiple lines or contains tabs. Review and copy its text before using it in the terminal.");
      const session = options.getSession();
      if (!session || !connected(session) || !session.commandHistory?.insert(command)) {
        throw new Error("Use an empty shell prompt, or finish editing the current command, before inserting history.");
      }
      session.term?.focus?.();
    },
    saveSnippet(command) { selectView(true); snippets?.saveFromHistory(command); },
    onClose: () => setOpen(false),
    onError: showError,
  });

  function bind(id: string, handler: () => void) {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener("click", handler);
    bindings.push(() => element.removeEventListener("click", handler));
  }
  function updateView() {
    const browser = document.getElementById("command-history-browser");
    const snippetRoot = document.getElementById("named-snippets-root");
    if (browser) browser.hidden = snippetView;
    if (snippetRoot) snippetRoot.hidden = !snippetView;
    root!.dataset.view = snippetView ? "snippets" : "history";
    root!.setAttribute("aria-labelledby", snippetView ? "command-history-view-snippets" : "command-history-title");
    document.getElementById("command-history-view-history")?.setAttribute("aria-pressed", String(!snippetView));
    document.getElementById("command-history-view-snippets")?.setAttribute("aria-pressed", String(snippetView));
    document.getElementById("command-history-view-history")?.classList.toggle("is-active", !snippetView);
    document.getElementById("command-history-view-snippets")?.classList.toggle("is-active", snippetView);
    const close = document.getElementById("command-history-close");
    const closeLabel = snippetView ? "Hide snippets" : "Hide command history";
    close?.setAttribute("aria-label", closeLabel);
    close?.setAttribute("title", closeLabel);
  }
  function selectView(showSnippets: boolean) {
    if (disposed) return;
    const changed = snippetView !== showSnippets;
    const wasOpen = !root!.hidden;
    snippetView = showSnippets;
    if (!showSnippets) snippets?.showLibrary();
    updateView();
    setOpen(true, false);
    if (wasOpen && changed) { refresh(); options.onLayoutChange(); }
    if (showSnippets) snippets?.showLibrary();
    else root!.querySelector<HTMLInputElement>("#command-history-search")?.focus();
  }
  const snippetRoot = document.getElementById("named-snippets-root");
  if (snippetRoot) snippets = initNamedSnippetsIntegration({
    root: snippetRoot, storage: options.storage, getSession: options.getSession,
    async writeText(session, text) {
      if (!options.writeSnippet) throw new Error("Snippet execution is unavailable. Restart SleekSSH and try again.");
      await options.writeSnippet(session, text);
    },
  });
  bind("command-history-view-history", () => selectView(false));
  bind("command-history-view-snippets", () => selectView(true));
  bind("btn-command-history-toggle", () => { if (!root.hidden && !snippetView) setOpen(false); else selectView(false); });
  bind("automation-history-tab", () => selectView(false));
  bind("automation-snippets-tab", () => selectView(true));
  bind("command-history-agent-tab", () => { setOpen(false, false); options.openAgent(); });
  bind("command-history-files-tab", () => { setOpen(false, false); options.openFiles(); });

  function record(context: HistoryContext, command: string, source: "terminal" | "agent") {
    if (disposed) return;
    try { history.record(context, command.replace(/\r\n/g, "\n"), source); }
    catch (error) { showError(error); }
  }

  function attachSession(session: HistorySession & { term: NonNullable<HistorySession["term"]> }) {
    let reported = false;
    const controller = initTerminalSuggestions({
      term: session.term,
      container: session.container.querySelector<HTMLElement>(".terminal-viewport") ?? session.container,
      captureOnEnter: session.kind === "local" && session.shell === "cmd",
      getCommands() {
        const context = sessionContext(session);
        return !disposed && options.getSession()?.id === session.id && connected(session) && context
          ? history.entries(context.key).map(entry => entry.command) : [];
      },
      sendText: text => { if (connected(session)) options.sendText(session, text); },
      onCommand(command) {
        const context = sessionContext(session);
        if (!reported && context && connected(session)) {
          reported = true;
          record(context, command, "terminal");
        }
      },
      onError: showError,
      onPromptChange: () => { if (options.getSession() === session) snippets?.invalidate(); },
    });
    const parser = session.term as SuggestionTerminal & { parser: { registerOscHandler: (id: number, callback: (payload: string) => boolean) => { dispose: () => void } } };
    const listener = parser.parser.registerOscHandler(HISTORY_OSC, payload => {
      if (disposed || session.isClosing) return true;
      if (payload === "prompt-start") reported = false;
      if (payload.startsWith(COMMAND_PAYLOAD_PREFIX)) {
        try {
          const encoded = payload.slice(COMMAND_PAYLOAD_PREFIX.length);
          if (!encoded || encoded.length > MAX_COMMAND_PAYLOAD_CHARACTERS || !/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Invalid shell command report.");
          const command = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(encoded), character => character.charCodeAt(0)));
          const context = sessionContext(session);
          if (!reported && context && connected(session)) { reported = true; record(context, command, "terminal"); }
        } catch (error) { showError(error); }
      }
      controller.handleShellEvent(payload);
      return true;
    });
    const attached = {
      ...controller,
      reset() { reported = false; controller.reset(); },
      dispose() { listener.dispose(); controller.dispose(); controllers.delete(attached); },
    };
    controllers.add(attached);
    return attached;
  }

  const unsubscribe = history.subscribe(() => refresh());
  refresh();
  return {
    attachSession,
    refresh,
    open() { selectView(false); },
    close() { setOpen(false, false); },
    listSnippets(session: HistorySession | null = options.getSession()) { return snippetsForFolder(loadSnippets(options.storage), snippetFolderForSession(session)); },
    openSnippets(id?: string) { selectView(true); if (id) snippets?.openSnippet(id); },
    recordAgentCommand(target: AgentTarget, command: string) {
      record({ key: target.contextKey ?? target.sessionId, label: target.label }, command, "agent");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      panel.dispose();
      snippets?.dispose();
      bindings.forEach(unbind => unbind());
      controllers.forEach(controller => controller.dispose());
      controllers.clear();
    },
  };
}

declare global {
  interface Window {
    SleekSshHistory?: {
      initCommandHistoryIntegration: typeof initCommandHistoryIntegration;
      SSH_COMMAND_HISTORY_SCRIPT: string;
      controller?: ReturnType<typeof initCommandHistoryIntegration>;
    };
  }
}

if (typeof window !== "undefined") window.SleekSshHistory = { initCommandHistoryIntegration, SSH_COMMAND_HISTORY_SCRIPT };
