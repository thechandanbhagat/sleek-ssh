import { validateSnippetFolder, type SnippetFolder } from "./named-snippet-scope.ts";

export type SnippetShell = "posix" | "powershell" | "cmd";

export interface NamedSnippet {
  readonly id: string;
  readonly name: string;
  readonly template: string;
  readonly shell: SnippetShell;
  readonly folder?: SnippetFolder;
}

type ParameterOccurrence = Readonly<{ name: string; start: number; end: number }>;
type ParsedTemplate = Readonly<{
  template: string;
  shell: SnippetShell;
  parameters: readonly string[];
  occurrences: readonly ParameterOccurrence[];
}>;

const STORAGE_KEY = "sleekssh_named_snippets";
const STORAGE_VERSION = 1;
const MAX_SNIPPETS = 100;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 120;
const MAX_COMMAND_LENGTH = 16_000;
const MAX_PARAMETER_NAME_LENGTH = 64;
const MAX_PARAMETERS = 20;
const MAX_VALUE_LENGTH = 4_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CMD_LITERAL_VALUE = /^[\p{L}\p{N}_./:\\@+=,-]+$/u;
const POWERSHELL_SINGLE_QUOTE = /['\u2018-\u201b]/;
const POWERSHELL_DOUBLE_QUOTE = /["\u201c-\u201e]/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number, trim = true): string {
  if (typeof value !== "string" || !value.trim() || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${label} must be nonempty single-line text without control characters.`);
  }
  const result = trim ? value.trim() : value;
  if (result.length > maximum) throw new Error(`${label} must be at most ${maximum} characters.`);
  return result;
}

function shellMode(value: unknown): SnippetShell {
  if (value !== "posix" && value !== "powershell" && value !== "cmd") throw new Error("Choose Bash / Zsh, PowerShell, or Command Prompt for the snippet.");
  return value;
}

function parseTemplate(value: unknown, mode: unknown): ParsedTemplate {
  const template = text(value, "Command template", MAX_COMMAND_LENGTH, false);
  const shell = shellMode(mode);
  const names = new Set<string>();
  const occurrences: ParameterOccurrence[] = [];
  if (!template.includes("{{") && !template.includes("}}")) {
    return Object.freeze({ template, shell, parameters: Object.freeze([]), occurrences: Object.freeze([]) });
  }

  let quote: "'" | '"' | null = null;
  let escaped = false;
  let argumentOpen = false;
  for (let index = 0; index < template.length; index += 1) {
    const character = template[index];
    const singleQuote = shell === "powershell" ? POWERSHELL_SINGLE_QUOTE.test(character) : shell === "posix" && character === "'";
    const doubleQuote = shell === "powershell" ? POWERSHELL_DOUBLE_QUOTE.test(character) : character === '"';
    if (template.startsWith("{{", index)) {
      const end = template.indexOf("}}", index + 2);
      if (end < 0) throw new Error("Close each parameter with '}}', for example {{service}}.");
      const name = template.slice(index + 2, end);
      if (!PARAMETER_NAME.test(name) || name.length > MAX_PARAMETER_NAME_LENGTH) {
        throw new Error(`Parameter names must start with a letter or underscore and contain at most ${MAX_PARAMETER_NAME_LENGTH} letters, digits, or underscores.`);
      }
      if (quote || escaped || argumentOpen || (end + 2 < template.length && template[end + 2] !== " ")) {
        throw new Error(`Put {{${name}}} outside quotes as a whole argument, separated by spaces.`);
      }
      names.add(name);
      if (names.size > MAX_PARAMETERS) throw new Error(`A snippet can have at most ${MAX_PARAMETERS} parameters.`);
      occurrences.push(Object.freeze({ name, start: index, end: end + 2 }));
      argumentOpen = true;
      index = end + 1;
      continue;
    }
    if (template.startsWith("}}", index)) throw new Error("Parameters must use {{name}} with matching braces.");
    if (escaped) { escaped = false; argumentOpen = true; continue; }
    if (quote === "'") {
      if (singleQuote) {
        if (shell === "powershell" && POWERSHELL_SINGLE_QUOTE.test(template[index + 1] ?? "")) index += 1;
        else quote = null;
      }
      continue;
    }
    if (shell === "powershell" && !quote && !argumentOpen && template.startsWith("--%", index)
      && (index + 3 === template.length || template[index + 3] === " ")) {
      throw new Error("PowerShell stop-parsing (--%) cannot be combined with snippet parameters.");
    }
    if ((shell !== "cmd" && template.startsWith("$(", index))
      || (shell === "posix" && (character === "`" || template.startsWith("${", index)
        || (!quote && ["((", "<(", ">(", "[["].some(expression => template.startsWith(expression, index)))))) {
      throw new Error("Parameterized snippets cannot contain substitutions, arithmetic, or conditional expressions. Use a simpler command template.");
    }
    const escape = shell === "posix" ? "\\" : shell === "powershell" ? "`" : "^";
    if (character === escape && (shell !== "cmd" || !quote)) { escaped = true; argumentOpen = true; continue; }
    if (quote === '"') {
      if (doubleQuote) quote = null;
      continue;
    }
    if (doubleQuote || singleQuote) {
      quote = doubleQuote ? '"' : "'";
      argumentOpen = true;
    } else argumentOpen = character !== " ";
  }
  if (quote || escaped) throw new Error("Balance quotes and finish escape sequences before adding snippet parameters.");
  return Object.freeze({ template, shell, parameters: Object.freeze([...names]), occurrences: Object.freeze(occurrences) });
}

export function snippetParameters(template: string, shell: SnippetShell): readonly string[] {
  return parseTemplate(template, shell).parameters;
}

function quotedValue(value: unknown, name: string, shell: SnippetShell): string {
  if (typeof value !== "string" || value.length > MAX_VALUE_LENGTH || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`Parameter ${name} must be single-line text of at most ${MAX_VALUE_LENGTH} characters without control characters.`);
  }
  if (shell === "cmd") {
    if (!CMD_LITERAL_VALUE.test(value)) throw new Error(`Command Prompt parameter ${name} must be a simple nonempty value without spaces or shell operators. Use PowerShell for complex values.`);
    return value;
  }
  return shell === "posix" ? `'${value.replaceAll("'", "'\\''")}'` : `'${value.replace(/['\u2018-\u201b]/g, quote => quote + quote)}'`;
}

export function renderSnippet(template: string, shell: SnippetShell, values: Readonly<Record<string, string>>): string {
  const parsed = parseTemplate(template, shell);
  const parameters = record(values, "Parameter values");
  if (Reflect.ownKeys(parameters).some(key => typeof key !== "string" || !parsed.parameters.includes(key))) {
    throw new Error("Parameter values contain a name that is not in this snippet.");
  }
  const renderedValues = new Map(parsed.parameters.map(name => {
    if (!Object.hasOwn(parameters, name)) throw new Error(`Enter a value for parameter ${name}.`);
    return [name, quotedValue(parameters[name], name, parsed.shell)] as const;
  }));
  const parts: string[] = [];
  let offset = 0;
  for (const occurrence of parsed.occurrences) {
    parts.push(parsed.template.slice(offset, occurrence.start), renderedValues.get(occurrence.name)!);
    offset = occurrence.end;
  }
  parts.push(parsed.template.slice(offset));
  const command = parts.join("");
  if (command.length > MAX_COMMAND_LENGTH) throw new Error(`The rendered command must be at most ${MAX_COMMAND_LENGTH} characters.`);
  return command;
}

function validateSnippet(value: unknown): NamedSnippet {
  const snippet = record(value, "Snippet");
  const parsed = parseTemplate(snippet.template, snippet.shell);
  return Object.freeze({
    id: text(snippet.id, "Snippet ID", MAX_ID_LENGTH),
    name: text(snippet.name, "Snippet name", MAX_NAME_LENGTH),
    template: parsed.template,
    shell: parsed.shell,
    ...(snippet.folder === undefined ? {} : { folder: validateSnippetFolder(snippet.folder) }),
  });
}

function validateSnippets(value: unknown): readonly NamedSnippet[] {
  if (!Array.isArray(value) || value.length > MAX_SNIPPETS) throw new Error(`Saved snippets must be a list of at most ${MAX_SNIPPETS} snippets.`);
  const snippets = Array.from(value, validateSnippet);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const snippet of snippets) {
    if (ids.has(snippet.id)) throw new Error("Saved snippets contain a duplicate snippet ID.");
    if (names.has(snippet.name.toLowerCase())) throw new Error("A snippet with that name already exists.");
    ids.add(snippet.id);
    names.add(snippet.name.toLowerCase());
  }
  return Object.freeze(snippets);
}

export function loadSnippets(storage: Pick<Storage, "getItem">): readonly NamedSnippet[] {
  const saved = storage.getItem(STORAGE_KEY);
  if (saved === null) return Object.freeze([]);
  let parsed: unknown;
  try { parsed = JSON.parse(saved); }
  catch (cause) { throw new Error("Saved snippets could not be read. Their stored data is invalid.", { cause }); }
  const envelope = record(parsed, "Saved snippet data");
  if (envelope.version !== STORAGE_VERSION) throw new Error("This saved snippet format is not supported.");
  return validateSnippets(envelope.snippets);
}

export function saveSnippet(storage: Pick<Storage, "setItem">, snippets: readonly NamedSnippet[], snippet: NamedSnippet): readonly NamedSnippet[] {
  const existing = validateSnippets(snippets);
  const next = validateSnippet(snippet);
  const updated = validateSnippets(existing.some(item => item.id === next.id)
    ? existing.map(item => item.id === next.id ? next : item) : [...existing, next]);
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, snippets: updated }));
  return updated;
}

export function removeSnippet(storage: Pick<Storage, "setItem">, snippets: readonly NamedSnippet[], id: string): readonly NamedSnippet[] {
  const validatedId = text(id, "Snippet ID", MAX_ID_LENGTH);
  const updated = Object.freeze(validateSnippets(snippets).filter(snippet => snippet.id !== validatedId));
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, snippets: updated }));
  return updated;
}
