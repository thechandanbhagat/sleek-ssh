import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  loadSnippets, removeSnippet, renderSnippet, saveSnippet, snippetParameters,
  type NamedSnippet, type SnippetShell,
} from "../src/named-snippets.ts";

const STORAGE_KEY = "sleekssh_named_snippets";
const MAX_SNIPPETS = 100;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 120;
const MAX_COMMAND_LENGTH = 16_000;
const MAX_PARAMETER_NAME_LENGTH = 64;
const MAX_PARAMETERS = 20;
const MAX_VALUE_LENGTH = 4_000;
const PROCESS_TIMEOUT_MS = 10_000;
const SNIPPET: NamedSnippet = Object.freeze({ id: "status", name: "Service status", template: "systemctl status {{service}}", shell: "posix" });
const BASH_PATH = process.platform === "win32"
  ? ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files/Git/usr/bin/bash.exe"].find(existsSync)
  : "/bin/bash";
const POWERSHELL_PATH = process.platform === "win32" ? "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" : "";

function createStorage(initial: string | null = null) {
  const values = new Map<string, string>();
  if (initial !== null) values.set(STORAGE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function encoded(snippets: unknown): string { return JSON.stringify({ version: 1, snippets }); }

function assertInvalidSnippet(value: unknown): void {
  const storage = createStorage();
  assert.throws(() => saveSnippet(storage, [], value as NamedSnippet));
  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.throws(() => loadSnippets(createStorage(encoded([value]))));
}

test("empty storage loads a frozen empty library", () => {
  for (const storage of [createStorage(), createStorage(encoded([]))]) {
    const snippets = loadSnippets(storage);
    assert.deepEqual(snippets, []);
    assert.ok(Object.isFrozen(snippets));
  }
});

test("snippets round-trip, update in place, and remove without mutating earlier lists", () => {
  const storage = createStorage();
  const original: readonly NamedSnippet[] = Object.freeze([]);
  const saved = saveSnippet(storage, original, SNIPPET);
  const other: NamedSnippet = { id: "folder", name: "Folder", template: "Get-ChildItem {{path}}", shell: "powershell" };
  const appended = saveSnippet(storage, saved, other);
  const updated = saveSnippet(storage, appended, { ...SNIPPET, name: "Inspect service", template: "systemctl show {{service}}" });
  assert.deepEqual(original, []);
  assert.deepEqual(saved, [SNIPPET]);
  assert.deepEqual(appended, [SNIPPET, other]);
  assert.deepEqual(updated.map(item => item.name), ["Inspect service", "Folder"]);
  assert.deepEqual(loadSnippets(storage), updated);
  assert.ok(Object.isFrozen(updated));
  assert.ok(updated.every(Object.isFrozen));
  const removed = removeSnippet(storage, updated, "status");
  assert.deepEqual(removed, [other]);
  assert.deepEqual(removeSnippet(storage, removed, "missing"), removed);
  assert.deepEqual(removeSnippet(storage, removed, "folder"), []);
  assert.deepEqual(loadSnippets(storage), []);
});

test("canonical storage excludes entered values, credentials, and unrelated fields", () => {
  const storage = createStorage();
  const candidate = { ...SNIPPET, values: { service: "secret-value" }, password: "secret-password", target: { sessionId: "transient" } };
  const result = saveSnippet(storage, [], candidate);
  assert.deepEqual(result, [SNIPPET]);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)!), { version: 1, snippets: [SNIPPET] });
  assert.deepEqual(loadSnippets(createStorage(encoded([candidate]))), [SNIPPET]);
  assert.doesNotMatch(storage.getItem(STORAGE_KEY)!, /secret|sessionId|values|password/);
});

test("names and IDs are trimmed while intentional template whitespace is retained", () => {
  const candidate = { ...SNIPPET, id: " status ", name: " Service status ", template: "  systemctl status {{service}}  " };
  const result = saveSnippet(createStorage(), [], candidate)[0];
  assert.equal(result.id, "status");
  assert.equal(result.name, "Service status");
  assert.equal(result.template, candidate.template);
  assert.equal(renderSnippet(result.template, result.shell, { service: "nginx" }), "  systemctl status 'nginx'  ");
});

test("invalid and unsupported storage is rejected without replacing its contents", () => {
  const invalid = ["", "{", "null", "[]", "42", "{}", JSON.stringify({ version: 2, snippets: [] }), JSON.stringify({ version: 1 }), encoded(null), encoded({}), encoded([null])];
  for (const value of invalid) {
    const storage = createStorage(value);
    assert.throws(() => loadSnippets(storage));
    assert.equal(storage.getItem(STORAGE_KEY), value);
  }
});

test("invalid snippet fields and malformed libraries fail at load and save boundaries", () => {
  for (const value of [null, [], "snippet", undefined]) assertInvalidSnippet(value);
  for (const field of ["id", "name", "template", "shell"] as const) {
    for (const value of [null, undefined, "", " ", 42, [], {}]) assertInvalidSnippet({ ...SNIPPET, [field]: value });
  }
  for (const field of ["id", "name", "template"] as const) {
    for (const control of ["\n", "\r", "\t", "\0", "\x1b", "\x7f", "\u0085", "\u009b", "\u2028", "\u2029"]) assertInvalidSnippet({ ...SNIPPET, [field]: `a${control}b` });
  }
  assertInvalidSnippet({ ...SNIPPET, shell: "fish" });
  for (const value of [null, {}, [SNIPPET, { ...SNIPPET, name: "Other" }], [SNIPPET, { ...SNIPPET, id: "other", name: "SERVICE STATUS" }]]) {
    assert.throws(() => saveSnippet(createStorage(), value as readonly NamedSnippet[], SNIPPET));
    assert.throws(() => loadSnippets(createStorage(encoded(value))));
  }
});

test("duplicate names are rejected case-insensitively but unchanged-name updates are accepted", () => {
  const storage = createStorage(encoded([SNIPPET]));
  assert.throws(() => saveSnippet(storage, [SNIPPET], { ...SNIPPET, id: "other", name: " service STATUS " }), /already exists/);
  assert.equal(storage.getItem(STORAGE_KEY), encoded([SNIPPET]));
  assert.equal(saveSnippet(storage, [SNIPPET], { ...SNIPPET, name: "SERVICE STATUS" })[0].name, "SERVICE STATUS");
});

test("maximum snippet count and text lengths are supported while overflow is rejected", () => {
  const maximum = { ...SNIPPET, id: "i".repeat(MAX_ID_LENGTH), name: "n".repeat(MAX_NAME_LENGTH), template: "x".repeat(MAX_COMMAND_LENGTH) };
  assert.deepEqual(saveSnippet(createStorage(), [], maximum), [maximum]);
  for (const [field, length] of [["id", MAX_ID_LENGTH], ["name", MAX_NAME_LENGTH], ["template", MAX_COMMAND_LENGTH]] as const) {
    assertInvalidSnippet({ ...SNIPPET, [field]: "x".repeat(length + 1) });
  }
  const full = Array.from({ length: MAX_SNIPPETS }, (_, index) => ({ ...SNIPPET, id: `id-${index}`, name: `Name ${index}` }));
  assert.equal(loadSnippets(createStorage(encoded(full))).length, MAX_SNIPPETS);
  assert.equal(saveSnippet(createStorage(), full.slice(0, -1), full.at(-1)!).length, MAX_SNIPPETS);
  assert.equal(saveSnippet(createStorage(), full, { ...full[0], template: "pwd" }).length, MAX_SNIPPETS);
  assert.throws(() => saveSnippet(createStorage(), full, SNIPPET), /at most 100/);
  assert.throws(() => loadSnippets(createStorage(encoded([...full, SNIPPET]))), /at most 100/);
});

test("remove validates IDs and existing libraries before touching storage", () => {
  const storage = createStorage(encoded([SNIPPET]));
  for (const id of [null, undefined, "", " ", "id\n", "i".repeat(MAX_ID_LENGTH + 1)]) {
    assert.throws(() => removeSnippet(storage, [SNIPPET], id as string));
  }
  for (const list of [null, {}, [null]]) assert.throws(() => removeSnippet(storage, list as readonly NamedSnippet[], "status"));
  assert.equal(storage.getItem(STORAGE_KEY), encoded([SNIPPET]));
  assert.deepEqual(removeSnippet(storage, [SNIPPET], " status "), []);
});

test("storage read and write failures propagate without changing the supplied library", () => {
  const failure = new Error("Storage unavailable");
  assert.throws(() => loadSnippets({ getItem() { throw failure; } }), error => error === failure);
  const writer = { setItem() { throw failure; } };
  assert.throws(() => saveSnippet(writer, [SNIPPET], { ...SNIPPET, name: "Changed" }), error => error === failure);
  assert.throws(() => removeSnippet(writer, [SNIPPET], SNIPPET.id), error => error === failure);
  assert.equal(SNIPPET.name, "Service status");
});

test("parameters are unique in appearance order and returned immutably", () => {
  const parameters = snippetParameters("diff {{first}} {{second}} {{first}}", "posix");
  assert.deepEqual(parameters, ["first", "second"]);
  assert.ok(Object.isFrozen(parameters));
  for (const shell of ["posix", "powershell", "cmd"] as const) {
    assert.deepEqual(snippetParameters("echo plain", shell), []);
    assert.equal(renderSnippet("echo plain", shell, {}), "echo plain");
    assert.deepEqual(snippetParameters("{{only}}", shell), ["only"]);
  }
});

test("template and shell inputs are validated by both parameter discovery and rendering", () => {
  for (const template of [null, undefined, 42, {}, "", " ", "echo\nhello", "echo\t{{arg}}", "x".repeat(MAX_COMMAND_LENGTH + 1)]) {
    assert.throws(() => snippetParameters(template as string, "posix"));
    assert.throws(() => renderSnippet(template as string, "posix", {}));
  }
  for (const shell of [null, undefined, "", "fish", {}, 42]) {
    assert.throws(() => snippetParameters("echo {{arg}}", shell as SnippetShell));
    assert.throws(() => renderSnippet("echo {{arg}}", shell as SnippetShell, { arg: "hello" }));
  }
});

test("maximum parameter counts and name lengths are accepted without allowing malformed placeholders", () => {
  const name = "p".repeat(MAX_PARAMETER_NAME_LENGTH);
  assert.deepEqual(snippetParameters(`echo {{${name}}}`, "posix"), [name]);
  const names = Array.from({ length: MAX_PARAMETERS }, (_, index) => `parameter_${index}`);
  const template = "echo " + names.map(name => `{{${name}}}`).join(" ");
  assert.deepEqual(snippetParameters(template, "posix"), names);
  assert.throws(() => snippetParameters(template + " {{extra}}", "posix"), /at most 20/);
  for (const malformed of ["{{", "}}", "{{name}", "{{}}", "{{ name }}", "{{1name}}", "{{hyphen-name}}", "{{nested{{name}}}}", `{{${name}x}}`, "{{name}}}", "{{name}}suffix", "prefix{{name}}", "--flag={{name}}", "{{name}};", "{{name}}|cat"]) {
    assert.throws(() => snippetParameters(`echo ${malformed}`, "posix"), malformed);
  }
});

test("placeholders cannot be quoted, escaped, or joined to an existing argument", () => {
  for (const template of ["echo '{{arg}}'", 'echo "{{arg}}"', "echo \\{{arg}}", "echo \\ {{arg}}", "echo ''{{arg}}", "echo {{arg}}'suffix'", "echo $'{{arg}}'"]) {
    assert.throws(() => snippetParameters(template, "posix"), /whole argument/);
  }
  for (const template of ["Write-Output '{{arg}}'", 'Write-Output "{{arg}}"', "Write-Output `{{arg}}", "Write-Output ` {{arg}}", "Write-Output ''{{arg}}", "Write-Output 'can''t {{arg}}'"]) {
    assert.throws(() => snippetParameters(template, "powershell"), /whole argument/);
  }
  for (const template of ['echo "{{arg}}"', "echo ^{{arg}}", "echo ^ {{arg}}", "echo '{{arg}}'"]) {
    assert.throws(() => snippetParameters(template, "cmd"), /whole argument/);
  }
});

test("parameterized templates reject substitutions, arithmetic, and unfinished quoting", () => {
  for (const template of ["echo $(pwd) {{arg}}", "echo `pwd` {{arg}}", "echo $(( 1 + {{arg}} ))", "(( {{arg}} ))", 'echo "$(pwd)" {{arg}}', 'echo "unterminated {{arg}}', "echo {{arg}} '", "echo {{arg}} \\", "cat <( echo {{arg}} )", "cat >( echo {{arg}} )", "echo ${name:- {{arg}} }", "[[ -v {{arg}} ]]", 'echo "${HOME}" {{arg}}']) {
    assert.throws(() => snippetParameters(template, "posix"));
  }
  for (const template of ["Write-Output $(Get-Location) {{arg}}", "Write-Output {{arg}} '", "Write-Output {{arg}} `"]) {
    assert.throws(() => snippetParameters(template, "powershell"));
  }
  assert.deepEqual(snippetParameters("echo '$(literal)' {{arg}}", "posix"), ["arg"]);
  assert.deepEqual(snippetParameters("Write-Output 'can''t' {{arg}}", "powershell"), ["arg"]);
  assert.deepEqual(snippetParameters('echo "quoted" {{arg}}', "cmd"), ["arg"]);
  assert.deepEqual(snippetParameters("echo $(pwd)", "posix"), []);
});

test("PowerShell stop-parsing is rejected when parameters would lose their literal quoting", () => {
  for (const template of ["cmd /c --% echo {{value}}", "--% {{value}}", "echo {{value}} --%", 'cmd /c --% "quoted" {{value}}']) {
    assert.throws(() => snippetParameters(template, "powershell"), /stop-parsing/);
    assert.throws(() => renderSnippet(template, "powershell", { value: "a & echo injected" }), /stop-parsing/);
  }
  assert.deepEqual(snippetParameters("Write-Output '--%' {{value}}", "powershell"), ["value"]);
  assert.equal(renderSnippet("cmd /c --% echo static", "powershell", {}), "cmd /c --% echo static");
});

test("POSIX values are escaped as one literal argument and are never expanded recursively", () => {
  const value = "O'Brien $(printf injected); `uname` & {{other}} /a b";
  const result = renderSnippet("printf %s {{value}}", "posix", { value });
  assert.equal(result, "printf %s 'O'\\''Brien $(printf injected); `uname` & {{other}} /a b'");
  assert.equal(renderSnippet("echo {{value}} {{value}}", "posix", { value: "{{later}}" }), "echo '{{later}}' '{{later}}'");
  assert.equal(renderSnippet("echo {{value}}", "posix", { value: "" }), "echo ''");
  assert.equal(renderSnippet("echo {{value}}", "posix", { value: "  " }), "echo '  '");
});

test("PowerShell values remain single-quoted literals including expansion and quote characters", () => {
  const value = "O'Brien $env:USERPROFILE $(Write-Output injected); `";
  assert.equal(renderSnippet("Write-Output {{value}}", "powershell", { value }), "Write-Output 'O''Brien $env:USERPROFILE $(Write-Output injected); `'");
  assert.equal(renderSnippet("Write-Output {{value}}", "powershell", { value: "" }), "Write-Output ''");
  assert.equal(renderSnippet("Write-Output {{value}}", "powershell", { value: '"double quotes"' }), `Write-Output '"double quotes"'`);
  for (const quote of ["\u2018", "\u2019", "\u201a", "\u201b"]) {
    assert.equal(renderSnippet("Write-Output {{value}}", "powershell", { value: `a${quote}b` }), `Write-Output 'a${quote}${quote}b'`);
  }
});

test("PowerShell smart quote delimiters cannot conceal quoted placeholders", () => {
  for (const quote of ["\u2018", "\u2019", "\u201a", "\u201b", "\u201c", "\u201d", "\u201e"]) {
    assert.throws(() => snippetParameters(`Write-Output ${quote} {{value}} ${quote}`, "powershell"), /whole argument/);
    assert.deepEqual(snippetParameters(`Write-Output ${quote}literal${quote} {{value}}`, "powershell"), ["value"]);
    assert.throws(() => snippetParameters(`Write-Output {{value}} ${quote}`, "powershell"), /Balance quotes/);
  }
  assert.deepEqual(snippetParameters("Write-Output 'can’’t' {{value}}", "powershell"), ["value"]);
  assert.throws(() => snippetParameters("Write-Output ‘can'’t {{value}} ' ", "powershell"), /whole argument/);
});

test("Command Prompt parameters allow simple literal tokens and reject expansion or operator syntax", () => {
  const allowed = ["service-1", "C:\\Projects\\app", "日本語", "a_b/c.d:@+=,-"];
  for (const value of allowed) assert.equal(renderSnippet("echo {{value}}", "cmd", { value }), `echo ${value}`);
  for (const value of ["", "a b", "%PATH%", "!secret!", "a&b", "a|b", "a>b", "a<b", "a^b", '"value"', "'value'", "(value)", "$value", "`value`", "a;b"]) {
    assert.throws(() => renderSnippet("echo {{value}}", "cmd", { value }), /Use PowerShell/);
  }
  assert.equal(renderSnippet('echo "%PATH%" & echo literal', "cmd", {}), 'echo "%PATH%" & echo literal');
});

test("rendering rejects missing, inherited, extra, non-string, and control-containing parameter values", () => {
  const template = "echo {{value}}";
  for (const values of [null, undefined, [], {}, Object.create({ value: "inherited" }), { value: "ok", extra: "unused" }, { value: null }, { value: 42 }]) {
    assert.throws(() => renderSnippet(template, "posix", values as Readonly<Record<string, string>>));
  }
  for (const control of ["\n", "\r", "\t", "\0", "\x1b", "\x7f", "\u0085", "\u009b", "\u2028", "\u2029"]) {
    for (const shell of ["posix", "powershell", "cmd"] as const) {
      assert.throws(() => renderSnippet(template, shell, { value: `a${control}b` }), /single-line text/);
    }
  }
  assert.throws(() => renderSnippet("pwd", "posix", { extra: "unused" }), /not in this snippet/);
  assert.throws(() => renderSnippet(template, "posix", { value: "ok", [Symbol("extra")]: "unused" }), /not in this snippet/);
});

test("parameter names that match object prototype keys require explicit own values", () => {
  const values = Object.create(null) as Record<string, string>;
  values.__proto__ = "literal";
  values.constructor = "constructor literal";
  assert.equal(renderSnippet("echo {{__proto__}} {{constructor}}", "posix", values), "echo 'literal' 'constructor literal'");
  assert.throws(() => renderSnippet("echo {{constructor}}", "posix", {}), /Enter a value/);
});

test("value and rendered command limits count escaped output and support exact boundaries", () => {
  const value = "x".repeat(MAX_VALUE_LENGTH);
  assert.equal(renderSnippet("echo {{value}}", "posix", { value }), `echo '${value}'`);
  assert.throws(() => renderSnippet("echo {{value}}", "posix", { value: value + "x" }), /at most 4000/);
  const template = "x".repeat(MAX_COMMAND_LENGTH - value.length - 3) + " {{value}}";
  assert.equal(renderSnippet(template, "posix", { value }).length, MAX_COMMAND_LENGTH);
  assert.throws(() => renderSnippet("x" + template, "posix", { value }), /rendered command.*16000/);
  assert.throws(() => renderSnippet("echo {{value}}", "posix", { value: "'".repeat(MAX_VALUE_LENGTH) }), /rendered command.*16000/);
  assert.equal(renderSnippet("x".repeat(MAX_COMMAND_LENGTH), "posix", {}).length, MAX_COMMAND_LENGTH);
});

test("Bash receives hostile parameter text as exactly one literal argument", { skip: !BASH_PATH }, () => {
  const value = "O'Brien $(printf injected); `printf injected` & {{later}} /path with spaces";
  const command = renderSnippet("printf %s {{value}}", "posix", { value });
  const result = spawnSync(BASH_PATH!, ["--noprofile", "--norc", "-c", command], { encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, value);
});

test("PowerShell receives hostile parameter text without evaluating it", { skip: !POWERSHELL_PATH || !existsSync(POWERSHELL_PATH) }, () => {
  const value = "O'Brien $(Write-Output injected); $env:PATH ` {{later}}";
  const command = renderSnippet("Write-Output {{value}}", "powershell", { value });
  const result = spawnSync(POWERSHELL_PATH, ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trimEnd(), value);
});

test("PowerShell smart single quotes cannot end a rendered parameter literal", { skip: !POWERSHELL_PATH || !existsSync(POWERSHELL_PATH) }, () => {
  for (const quote of ["\u2018", "\u2019", "\u201a", "\u201b"]) {
    const value = `a${quote} ; Write-Output marker ; #`;
    const command = renderSnippet("Write-Output {{value}}", "powershell", { value });
    const result = spawnSync(POWERSHELL_PATH, ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ${command}`], { encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trimEnd(), value);
  }
});
