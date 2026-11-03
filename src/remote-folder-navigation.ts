import { remoteFolderCommand } from "./remote-folders.ts";
import type { SnippetSession } from "./named-snippets-integration.ts";

type NavigationOptions = Readonly<{
  session: SnippetSession;
  getSession: () => SnippetSession | null;
  path: string;
  resolvePath: (connectionId: string, path: string) => Promise<string>;
  writeText: (connectionId: string, text: string) => Promise<void>;
}>;

export async function navigateRemoteFolder(options: NavigationOptions): Promise<string> {
  const { session } = options;
  remoteFolderCommand(options.path);
  const connectionId = session.connectionId;
  const controller = session.commandHistory;
  const term = session.term;
  const paneLabel = session.paneLabel;
  const token = controller?.getPromptToken();
  const current = () => options.getSession() === session && session.kind === "ssh"
    && !session.isClosed && !session.isClosing && !session.isConnecting && session.connectionId === connectionId
    && session.commandHistory === controller && session.term === term && session.paneLabel === paneLabel;
  if (!connectionId || !controller || !token || !current()) {
    throw new Error("Use an empty, ready shell prompt in this SSH session before opening a saved folder.");
  }
  const requested = options.path.trim();
  const path = requested === "~" ? "." : requested.startsWith("~/") ? `.${requested.slice(1)}` : requested;
  const resolved = await options.resolvePath(connectionId, path);
  if (!resolved.startsWith("/") || !current() || controller.getPromptToken() !== token) {
    throw new Error("The terminal or prompt changed. Open the session palette and choose the folder again.");
  }
  await controller.sendSnippet(remoteFolderCommand(resolved), true, token, async text => {
    if (!current()) throw new Error("The target SSH session changed before navigation could start.");
    await options.writeText(connectionId, text);
  });
  if (current()) term?.focus?.();
  return resolved;
}
