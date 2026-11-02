import { renderSnippet, type NamedSnippet, type SnippetShell } from "./named-snippets.ts";
import { initNamedSnippetsPanel, type SnippetPreview } from "./named-snippets-panel.ts";
import type { initTerminalSuggestions } from "./terminal-suggestions.ts";
import { snippetAvailableInFolder, snippetFolderForSession } from "./named-snippet-scope.ts";

export interface SnippetSession {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly paneLabel?: string;
  readonly shell?: string;
  readonly host?: string;
  readonly terminalPath?: string | null;
  readonly connectionProfile?: Readonly<{ username: string; port: number }>;
  readonly connectionId?: string | null;
  readonly isClosed?: boolean;
  readonly isClosing?: boolean;
  readonly isConnecting?: boolean;
  readonly isReady?: boolean;
  readonly term?: { focus?: () => void };
  readonly commandHistory?: ReturnType<typeof initTerminalSuggestions>;
}

interface SnippetIntegrationOptions {
  readonly root: HTMLElement;
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly getSession: () => SnippetSession | null;
  readonly writeText: (session: SnippetSession, text: string) => Promise<void>;
}

type PreviewBinding = Readonly<{
  session: SnippetSession;
  connectionId: string | null | undefined;
  paneLabel: string | undefined;
  term: SnippetSession["term"];
  controller: NonNullable<SnippetSession["commandHistory"]>;
  promptToken: object;
  snippet: NamedSnippet;
  terminalPath: string | null | undefined;
}>;

function connected(session: SnippetSession | null): session is SnippetSession {
  return Boolean(session && !session.isClosed && !session.isClosing && !session.isConnecting
    && (session.kind === "local" ? session.isReady : session.kind === "ssh" && session.connectionId));
}

export function initNamedSnippetsIntegration(options: SnippetIntegrationOptions) {
  const bindings = new WeakMap<object, PreviewBinding>();
  let currentToken: object | null = null;
  let disposed = false;
  let lastSession = options.getSession();
  let lastConnectionId = lastSession?.connectionId;
  let lastPaneLabel = lastSession?.paneLabel;
  let lastPath = lastSession?.terminalPath;

  function folderUnchanged(binding: PreviewBinding, session: SnippetSession): boolean {
    return !binding.snippet.folder || (session.terminalPath === binding.terminalPath
      && snippetAvailableInFolder(binding.snippet, snippetFolderForSession(session)));
  }

  function valid(preview: SnippetPreview): boolean {
    const binding = bindings.get(preview.token);
    const session = options.getSession();
    const matches = !disposed && currentToken === preview.token && binding && connected(session)
      && session === binding.session && session.connectionId === binding.connectionId
      && session.paneLabel === binding.paneLabel
      && session.term === binding.term && session.commandHistory === binding.controller
      && folderUnchanged(binding, session)
      && binding.controller.getPromptToken() === binding.promptToken;
    if (!matches) currentToken = null;
    return Boolean(matches);
  }

  const panel = initNamedSnippetsPanel({
    root: options.root, storage: options.storage,
    getFolder: () => snippetFolderForSession(options.getSession()),
    preview(snippet: NamedSnippet, values: Readonly<Record<string, string>>): SnippetPreview {
      if (disposed) throw new Error("Snippets are no longer available.");
      const command = renderSnippet(snippet.template, snippet.shell, values);
      const session = options.getSession();
      const promptToken = session?.commandHistory?.getPromptToken();
      if (!connected(session) || !session.commandHistory || !promptToken) {
        throw new Error("Select a connected terminal with an empty, ready shell prompt, then review again.");
      }
      if (!snippetAvailableInFolder(snippet, snippetFolderForSession(session))) {
        throw new Error("Open this snippet's server and folder before reviewing its command.");
      }
      currentToken = Object.freeze({});
      bindings.set(currentToken, {
        session, connectionId: session.connectionId, paneLabel: session.paneLabel,
        term: session.term, controller: session.commandHistory, promptToken,
        snippet, terminalPath: session.terminalPath,
      });
      const profile = session.connectionProfile;
      const sessionLabel = session.kind === "ssh" && profile
        ? `${session.name} · ${profile.username}@${session.host}:${profile.port}` : session.name;
      const targetLabel = session.paneLabel ? `${session.paneLabel} · ${sessionLabel}` : sessionLabel;
      return Object.freeze({ command, targetLabel, shell: snippet.shell, token: currentToken });
    },
    isPreviewValid: valid,
    async execute(preview, run) {
      if (!valid(preview)) throw new Error("The terminal or prompt changed. Review the command again before continuing.");
      const binding = bindings.get(preview.token)!;
      currentToken = null;
      await binding.controller.sendSnippet(preview.command, run, binding.promptToken, async text => {
        const session = options.getSession();
        if (disposed || !connected(session) || session !== binding.session || session.connectionId !== binding.connectionId
          || session.paneLabel !== binding.paneLabel || session.term !== binding.term || session.commandHistory !== binding.controller
          || !folderUnchanged(binding, session)) {
          throw new Error("The target terminal changed before the command could be sent.");
        }
        await options.writeText(session, text);
      });
      const session = options.getSession();
      if (!disposed && connected(session) && session === binding.session
        && session.connectionId === binding.connectionId && session.term === binding.term
        && session.commandHistory === binding.controller && session.paneLabel === binding.paneLabel
        && folderUnchanged(binding, session)) binding.term?.focus?.();
    },
  });

  function invalidate() {
    if (disposed) return;
    currentToken = null;
    panel.invalidate();
  }

  return Object.freeze({
    refresh() {
      if (disposed) return;
      const session = options.getSession();
      if (session !== lastSession || session?.connectionId !== lastConnectionId || session?.paneLabel !== lastPaneLabel || session?.terminalPath !== lastPath) invalidate();
      lastSession = session;
      lastConnectionId = session?.connectionId;
      lastPaneLabel = session?.paneLabel;
      lastPath = session?.terminalPath;
      panel.refresh();
    },
    invalidate,
    saveFromHistory(command: string) {
      if (disposed) return;
      invalidate();
      const session = options.getSession();
      const shell: SnippetShell = session?.kind === "local" && session.shell === "powershell" ? "powershell"
        : session?.kind === "local" && session.shell === "cmd" ? "cmd" : "posix";
      panel.saveFromHistory(command, shell);
    },
    showLibrary() { if (!disposed) { invalidate(); panel.showLibrary(); } },
    openSnippet(id: string) { if (!disposed) { invalidate(); panel.openSnippet(id); } },
    dispose() {
      if (disposed) return;
      disposed = true;
      currentToken = null;
      panel.dispose();
    },
  });
}
