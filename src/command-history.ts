export type CommandSource = "terminal" | "agent";
export type HistoryContext = Readonly<{ key: string; label: string }>;
export type CommandHistoryEntry = Readonly<{
  command: string;
  runCount: number;
  terminalCount: number;
  agentCount: number;
  lastRunAt: number;
}>;

type StoredContext = HistoryContext & Readonly<{ entries: readonly CommandHistoryEntry[] }>;
type StoredHistory = Readonly<{ version: number; contexts: readonly StoredContext[] }>;
type HistoryOptions = Readonly<{ storage: Pick<Storage, "getItem" | "setItem">; now?: () => number }>;

const STORAGE_KEY = "sleekssh_command_history";
const STORAGE_VERSION = 1;
const MAX_COMMAND_CHARACTERS = 16_000;
const MAX_CONTEXT_KEY_CHARACTERS = 1_024;
const MAX_CONTEXT_LABEL_CHARACTERS = 256;
const MAX_CONTEXTS = 64;
const MAX_CONTEXT_ENTRIES = 200;
const MAX_TOTAL_ENTRIES = 1_000;
const MAX_STORAGE_CHARACTERS = 2_000_000;
const TEXT_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const COMMAND_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const SECRET_NAME = "(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|credentials)";
const SECRET_ASSIGNMENT = new RegExp(`(?:^|[\\s;&|])(?:export\\s+|set\\s+["']?)?(?:\\$(?:[a-z][a-z0-9_]*:)?)?[a-z0-9_]*${SECRET_NAME}\\s*=`, "i");
const SECRET_ARGUMENT = new RegExp(`(?:^|\\s)--?(?:[a-z0-9]+[-_])*${SECRET_NAME}(?:[=\\s]|$)`, "i");
const SECRET_HEADER = /\b(?:authorization|proxy-authorization|x-api-key)\s*:/i;
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i;
const INLINE_PASSWORD = /\b(?:mysql|mariadb|sshpass)\b[\s\S]*\s-p(?:\S|\s+\S)/i;
const CURL_CREDENTIALS = /\bcurl(?:\.exe)?(?=\s)[\s\S]*?\s(?:-u\s*|--(?:proxy-)?user(?:=|\s+))["']?[^\s:"']+:[^\s"']+/i;
const REGISTRY_LOGIN_PASSWORD = /\b(?:docker|podman)(?:\.exe)?\s+login\b[^\r\n;&|]*?\s-p(?:=|\s*)\S+/i;

function contextText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || TEXT_CONTROL_CHARACTERS.test(value) || value.length > maximum) {
    throw new Error(`${label} must be nonempty text of at most ${maximum} characters without control characters.`);
  }
  return value;
}

function validateContext(value: unknown): HistoryContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Command history context is invalid.");
  const context = value as Record<string, unknown>;
  return Object.freeze({
    key: contextText(context.key, "Command history context key", MAX_CONTEXT_KEY_CHARACTERS),
    label: contextText(context.label, "Command history context label", MAX_CONTEXT_LABEL_CHARACTERS),
  });
}

function validateCommand(value: unknown): string {
  const command = typeof value === "string" ? value.replace(/\r\n/g, "\n") : null;
  if (command === null || command.length > MAX_COMMAND_CHARACTERS || COMMAND_CONTROL_CHARACTERS.test(command)) {
    throw new Error(`Command history accepts text of at most ${MAX_COMMAND_CHARACTERS} characters without terminal control characters.`);
  }
  return command.trimEnd();
}

function sensitiveCommand(command: string): boolean {
  return /^\s/.test(command) || SECRET_ASSIGNMENT.test(command) || SECRET_ARGUMENT.test(command)
    || SECRET_HEADER.test(command) || CREDENTIAL_URL.test(command) || INLINE_PASSWORD.test(command)
    || CURL_CREDENTIALS.test(command) || REGISTRY_LOGIN_PASSWORD.test(command);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateEntry(value: unknown): CommandHistoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Saved command history entry is invalid.");
  const entry = value as Record<string, unknown>;
  const command = validateCommand(entry.command);
  if (!command || sensitiveCommand(command) || !nonnegativeInteger(entry.runCount) || entry.runCount < 1
    || !nonnegativeInteger(entry.terminalCount) || !nonnegativeInteger(entry.agentCount)
    || entry.terminalCount + entry.agentCount !== entry.runCount || !nonnegativeInteger(entry.lastRunAt)) {
    throw new Error("Saved command history counts or command are invalid.");
  }
  return Object.freeze({ command, runCount: entry.runCount, terminalCount: entry.terminalCount,
    agentCount: entry.agentCount, lastRunAt: entry.lastRunAt });
}

function loadHistory(storage: HistoryOptions["storage"]): readonly StoredContext[] {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return Object.freeze([]);
  if (typeof raw !== "string" || raw.length > MAX_STORAGE_CHARACTERS) throw new Error("Saved command history exceeds its storage limit.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (cause) { throw new Error("Saved command history contains invalid JSON.", { cause }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Saved command history is invalid.");
  const history = parsed as Record<string, unknown>;
  if (history.version !== STORAGE_VERSION || !Array.isArray(history.contexts) || history.contexts.length > MAX_CONTEXTS) {
    throw new Error("Saved command history version or contexts are invalid.");
  }
  const keys = new Set<string>();
  let count = 0;
  return Object.freeze(history.contexts.map((value: unknown): StoredContext => {
    const context = validateContext(value);
    const saved = value as Record<string, unknown>;
    if (keys.has(context.key) || !Array.isArray(saved.entries) || saved.entries.length > MAX_CONTEXT_ENTRIES) {
      throw new Error("Saved command history contains duplicate contexts or invalid entries.");
    }
    keys.add(context.key);
    const commands = new Set<string>();
    const entries = saved.entries.map((value: unknown) => {
      const entry = validateEntry(value);
      if (commands.has(entry.command)) throw new Error("Saved command history contains a duplicate command.");
      commands.add(entry.command);
      count += 1;
      if (count > MAX_TOTAL_ENTRIES) throw new Error("Saved command history contains too many commands.");
      return entry;
    });
    return Object.freeze({ ...context, entries: Object.freeze(entries) });
  }));
}

function recentFirst(left: CommandHistoryEntry, right: CommandHistoryEntry): number {
  return right.lastRunAt - left.lastRunAt || right.runCount - left.runCount || left.command.localeCompare(right.command);
}

function boundedHistory(contexts: readonly StoredContext[]): readonly StoredContext[] {
  const recent = contexts.flatMap(context => context.entries.slice().sort(recentFirst).slice(0, MAX_CONTEXT_ENTRIES)
    .map(entry => ({ context, entry }))).sort((left, right) => recentFirst(left.entry, right.entry)).slice(0, MAX_TOTAL_ENTRIES);
  const retained = new Map<string, StoredContext>();
  for (const { context, entry } of recent) {
    const previous = retained.get(context.key);
    if (!previous && retained.size >= MAX_CONTEXTS) continue;
    retained.set(context.key, Object.freeze({ key: context.key, label: context.label,
      entries: Object.freeze([...(previous?.entries ?? []), entry]) }));
  }
  let result = [...retained.values()];
  while (JSON.stringify({ version: STORAGE_VERSION, contexts: result }).length > MAX_STORAGE_CHARACTERS) {
    const oldest = result.flatMap(context => context.entries.map(entry => ({ context, entry })))
      .sort((left, right) => recentFirst(left.entry, right.entry)).at(-1);
    if (!oldest) throw new Error("Command history cannot fit within its storage limit.");
    result = result.map(context => context.key === oldest.context.key
      ? Object.freeze({ ...context, entries: Object.freeze(context.entries.filter(entry => entry !== oldest.entry)) }) : context)
      .filter(context => context.entries.length);
  }
  return Object.freeze(result);
}

export function createCommandHistory(options: HistoryOptions) {
  if (!options?.storage || typeof options.storage.getItem !== "function" || typeof options.storage.setItem !== "function") {
    throw new Error("Command history storage is unavailable.");
  }
  const now = options.now ?? Date.now;
  let contexts = loadHistory(options.storage);
  const listeners = new Set<() => void>();
  return Object.freeze({
    record(context: HistoryContext, input: string, source: CommandSource): void {
      const validated = validateContext(context);
      const command = validateCommand(input);
      if (source !== "terminal" && source !== "agent") throw new Error("Command history source must be terminal or agent.");
      if (!command || sensitiveCommand(command)) return;
      const lastRunAt = now();
      if (!nonnegativeInteger(lastRunAt)) throw new Error("Command history timestamp is invalid.");
      const previousContext = contexts.find(context => context.key === validated.key);
      const previous = previousContext?.entries.find(entry => entry.command === command);
      if (previous?.runCount === Number.MAX_SAFE_INTEGER) throw new Error("Command history run count reached its limit.");
      const entry = Object.freeze({ command, runCount: (previous?.runCount ?? 0) + 1,
        terminalCount: (previous?.terminalCount ?? 0) + (source === "terminal" ? 1 : 0),
        agentCount: (previous?.agentCount ?? 0) + (source === "agent" ? 1 : 0), lastRunAt });
      const updated = Object.freeze({ ...validated,
        entries: Object.freeze([entry, ...(previousContext?.entries ?? []).filter(entry => entry.command !== command)]) });
      const next = boundedHistory([updated, ...contexts.filter(context => context.key !== validated.key)]);
      const saved: StoredHistory = { version: STORAGE_VERSION, contexts: next };
      options.storage.setItem(STORAGE_KEY, JSON.stringify(saved));
      contexts = next;
      listeners.forEach(listener => listener());
    },
    entries(contextKey: string, query = ""): readonly CommandHistoryEntry[] {
      const key = contextText(contextKey, "Command history context key", MAX_CONTEXT_KEY_CHARACTERS);
      if (typeof query !== "string" || query.length > MAX_COMMAND_CHARACTERS || TEXT_CONTROL_CHARACTERS.test(query)) {
        throw new Error("Command history search is invalid.");
      }
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const entries = contexts.find(context => context.key === key)?.entries ?? [];
      return Object.freeze(entries.filter(entry => words.every(word => entry.command.toLowerCase().includes(word)))
        .sort(recentFirst));
    },
    subscribe(listener: () => void): () => void {
      if (typeof listener !== "function") throw new Error("Command history subscriber must be a function.");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
}
