import type { NamedSnippet } from "./named-snippets.ts";

export type SnippetFolder = Readonly<{ host: string; port: number; username: string; path: string }>;
type FolderSession = Readonly<{
  kind: string;
  host?: string;
  terminalPath?: string | null;
  connectionId?: string | null;
  connectionProfile?: Readonly<{ username: string; port: number }>;
  isClosed?: boolean;
  isClosing?: boolean;
  isConnecting?: boolean;
}>;

const MAX_HOST_LENGTH = 253;
const MAX_USERNAME_LENGTH = 128;
const MAX_PATH_LENGTH = 4_096;
const MAX_PORT = 65_535;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function validateSnippetFolder(value: unknown): SnippetFolder {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Snippet folder must name a server and an absolute remote path.");
  const folder = value as Record<string, unknown>;
  const text = (input: unknown, label: string, maximum: number): string => {
    if (typeof input !== "string" || !input.trim() || input.length > maximum || CONTROL_CHARACTERS.test(input)) {
      throw new Error(`${label} must be nonempty single-line text of at most ${maximum} characters.`);
    }
    return input;
  };
  const host = text(folder.host, "Snippet host", MAX_HOST_LENGTH).trim().toLowerCase();
  const username = text(folder.username, "Snippet username", MAX_USERNAME_LENGTH).trim();
  const path = text(folder.path, "Snippet folder path", MAX_PATH_LENGTH);
  if (!path.startsWith("/")) throw new Error("Snippet folders require an absolute remote path.");
  if (typeof folder.port !== "number" || !Number.isInteger(folder.port) || folder.port < 1 || folder.port > MAX_PORT) {
    throw new Error(`Snippet server port must be between 1 and ${MAX_PORT}.`);
  }
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(segment);
  }
  return Object.freeze({ host, port: folder.port, username, path: "/" + segments.join("/") });
}

export function snippetFolderForSession(session: FolderSession | null): SnippetFolder | null {
  if (!session || session.kind !== "ssh" || !session.connectionId || session.isClosed || session.isClosing || session.isConnecting
    || !session.host || !session.connectionProfile || !session.terminalPath?.startsWith("/")) return null;
  return validateSnippetFolder({ ...session.connectionProfile, host: session.host, path: session.terminalPath });
}

export function snippetAvailableInFolder(snippet: NamedSnippet, current: SnippetFolder | null): boolean {
  if (!snippet.folder) return true;
  if (!current) return false;
  const folder = validateSnippetFolder(snippet.folder);
  const context = validateSnippetFolder(current);
  return folder.host === context.host && folder.port === context.port && folder.username === context.username
    && (folder.path === "/" || context.path === folder.path || context.path.startsWith(folder.path + "/"));
}

export function snippetsForFolder(snippets: readonly NamedSnippet[], folder: SnippetFolder | null): readonly NamedSnippet[] {
  return snippets.filter(snippet => snippetAvailableInFolder(snippet, folder))
    .sort((left, right) => (right.folder?.path.length ?? 0) - (left.folder?.path.length ?? 0));
}
