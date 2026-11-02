export type RemoteFolder = Readonly<{ name: string; path: string }>;
export type RemoteFolders = Readonly<{ startPath: string; folders: readonly RemoteFolder[] }>;

export const REMOTE_FOLDER_LIMITS = Object.freeze({ folders: 20, name: 80, path: 4_096, profileId: 128 });
const STORAGE_PREFIX = "sleekssh_remote_folders:";
const STORAGE_VERSION = 1;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Remote folder settings must be an object.");
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number, optional = false): string {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value) || value.length > maximum || (!optional && !value.trim())) {
    throw new Error(`${label} must be ${optional ? "single-line" : "nonempty single-line"} text of at most ${maximum} characters.`);
  }
  return value.trim();
}

function folderPath(value: unknown, optional = false): string {
  const path = text(value, "Remote path", REMOTE_FOLDER_LIMITS.path, optional);
  if (path && !path.startsWith("/") && path !== "~" && !path.startsWith("~/")) {
    throw new Error("Remote paths must start with / or ~/ (or use ~ for your home folder).");
  }
  return path;
}

export function validateRemoteFolders(value: unknown): RemoteFolders {
  const input = record(value);
  if (!Array.isArray(input.folders) || input.folders.length > REMOTE_FOLDER_LIMITS.folders) {
    throw new Error(`Save up to ${REMOTE_FOLDER_LIMITS.folders} remote folder shortcuts per host.`);
  }
  const names = new Set<string>();
  const folders = Array.from(input.folders, entry => {
    const folder = record(entry);
    const name = text(folder.name, "Folder name", REMOTE_FOLDER_LIMITS.name);
    if (names.has(name.toLowerCase())) throw new Error("Use a different name for each remote folder shortcut.");
    names.add(name.toLowerCase());
    return Object.freeze({ name, path: folderPath(folder.path) });
  });
  return Object.freeze({ startPath: folderPath(input.startPath, true), folders: Object.freeze(folders) });
}

function storageKey(profileId: string): string {
  return STORAGE_PREFIX + encodeURIComponent(text(profileId, "Host ID", REMOTE_FOLDER_LIMITS.profileId));
}

export function loadRemoteFolders(storage: Pick<Storage, "getItem">, profileId: string): RemoteFolders {
  const saved = storage.getItem(storageKey(profileId));
  if (saved === null) return validateRemoteFolders({ startPath: "", folders: [] });
  let parsed: unknown;
  try { parsed = JSON.parse(saved); }
  catch (cause) { throw new Error("Saved remote folders could not be read. Their stored data is invalid.", { cause }); }
  const envelope = record(parsed);
  if (envelope.version !== STORAGE_VERSION) throw new Error("This saved remote folder format is not supported.");
  return validateRemoteFolders(envelope.settings);
}

export function saveRemoteFolders(storage: Pick<Storage, "setItem">, profileId: string, value: unknown): RemoteFolders {
  const key = storageKey(profileId);
  const validated = validateRemoteFolders(value);
  storage.setItem(key, JSON.stringify({ version: STORAGE_VERSION, settings: validated }));
  return validated;
}

export function remoteFolderCommand(value: string): string {
  const path = folderPath(value);
  const quote = (argument: string) => `'${argument.replaceAll("'", "'\\''")}'`;
  return path === "~" ? 'cd "$HOME"' : path.startsWith("~/") ? `cd "$HOME"${quote(path.slice(1))}` : `cd ${quote(path)}`;
}
