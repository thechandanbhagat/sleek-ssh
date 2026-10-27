export interface LocalTerminalLocation {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

const STORAGE_KEY = "sleekssh_local_terminal_locations";
const MAX_LOCATION_ID_LENGTH = 128;
const MAX_LOCATION_NAME_LENGTH = 120;
const MAX_LOCATION_PATH_LENGTH = 32_767;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_DRIVE_PATH = /^[a-z]:[\\/]/i;
const ABSOLUTE_NETWORK_PATH = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/;

function validateText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value) || !value.trim()) {
    throw new Error(`${label} must be nonempty text without control characters.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maximumLength) {
    throw new Error(`${label} must be at most ${maximumLength} characters.`);
  }
  return trimmed;
}

function validateLocation(value: unknown): LocalTerminalLocation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Saved location must contain a name and an absolute folder path.");
  }
  const record = value as Record<string, unknown>;
  const id = validateText(record.id, "Location ID", MAX_LOCATION_ID_LENGTH);
  const name = validateText(record.name, "Location name", MAX_LOCATION_NAME_LENGTH);
  const path = validateText(record.path, "Folder path", MAX_LOCATION_PATH_LENGTH);
  if (!ABSOLUTE_DRIVE_PATH.test(path) && !ABSOLUTE_NETWORK_PATH.test(path)) {
    throw new Error("Folder path must be an absolute Windows path, such as C:\\Projects.");
  }
  return Object.freeze({ id, name, path });
}

function pathIdentity(path: string): string {
  return path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}

function validateLocations(value: unknown): readonly LocalTerminalLocation[] {
  if (!Array.isArray(value)) throw new Error("Saved locations must be a list.");
  const locations = value.map(validateLocation);
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const location of locations) {
    if (ids.has(location.id)) throw new Error("Saved locations contain a duplicate location ID.");
    const identity = pathIdentity(location.path);
    if (paths.has(identity)) throw new Error("This folder already has a saved PowerShell location.");
    ids.add(location.id);
    paths.add(identity);
  }
  return Object.freeze(locations);
}

export function loadLocalTerminalLocations(storage: Pick<Storage, "getItem">): readonly LocalTerminalLocation[] {
  const saved = storage.getItem(STORAGE_KEY);
  if (saved === null) return Object.freeze([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(saved);
  } catch (cause) {
    throw new Error("Saved PowerShell locations could not be read. Their stored data is invalid.", { cause });
  }
  return validateLocations(parsed);
}

export function saveLocalTerminalLocation(
  storage: Pick<Storage, "setItem">,
  locations: readonly LocalTerminalLocation[],
  location: LocalTerminalLocation
): readonly LocalTerminalLocation[] {
  const existing = validateLocations(locations);
  const next = validateLocation(location);
  const updated = existing.some(item => item.id === next.id)
    ? existing.map(item => item.id === next.id ? next : item)
    : [...existing, next];
  const validated = validateLocations(updated);
  storage.setItem(STORAGE_KEY, JSON.stringify(validated));
  return validated;
}

export function removeLocalTerminalLocation(
  storage: Pick<Storage, "setItem">,
  locations: readonly LocalTerminalLocation[],
  id: string
): readonly LocalTerminalLocation[] {
  const validatedId = validateText(id, "Location ID", MAX_LOCATION_ID_LENGTH);
  const updated = Object.freeze(validateLocations(locations).filter(location => location.id !== validatedId));
  storage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return updated;
}
