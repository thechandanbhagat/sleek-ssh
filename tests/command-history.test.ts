import assert from "node:assert/strict";
import test from "node:test";
import { createCommandHistory, type CommandSource, type HistoryContext } from "../src/command-history.ts";

const STORAGE_KEY = "sleekssh_command_history";
const CONTEXT: HistoryContext = Object.freeze({ key: "ssh:deploy@example.test:22", label: "Production · deploy@example.test:22" });
const OTHER_CONTEXT: HistoryContext = Object.freeze({ key: "local:powershell", label: "Local PowerShell" });
const MAX_COMMAND_CHARACTERS = 16_000;
const MAX_CONTEXT_ENTRIES = 200;
const MAX_TOTAL_ENTRIES = 1_000;
const MAX_CONTEXTS = 64;
const MAX_STORAGE_CHARACTERS = 2_000_000;

function createStorage(initial: string | null = null) {
  const values = new Map<string, string>();
  if (initial !== null) values.set(STORAGE_KEY, initial);
  let writes = 0;
  let failure: Error | null = null;
  return {
    values,
    get writes() { return writes; },
    failWith(error: Error | null) { failure = error; },
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      if (failure) throw failure;
      values.set(key, value);
      writes += 1;
    },
  };
}

function savedEntry(command = "uptime") {
  return { command, runCount: 1, terminalCount: 1, agentCount: 0, lastRunAt: 0 };
}

function savedHistory(entry: unknown = savedEntry()) {
  return JSON.stringify({ version: 1, contexts: [{ ...CONTEXT, entries: [entry] }] });
}

test("command history starts empty and persists combined terminal and agent execution counts", () => {
  const storage = createStorage();
  let timestamp = 0;
  const history = createCommandHistory({ storage, now: () => timestamp++ });
  assert.deepEqual(history.entries(CONTEXT.key), []);
  assert.equal(storage.writes, 0);
  history.record(CONTEXT, "uptime", "terminal");
  history.record(CONTEXT, "uptime", "agent");
  history.record(CONTEXT, "uptime", "terminal");
  const expected = [{ command: "uptime", runCount: 3, terminalCount: 2, agentCount: 1, lastRunAt: 2 }];
  assert.deepEqual(history.entries(CONTEXT.key), expected);
  assert.deepEqual(createCommandHistory({ storage }).entries(CONTEXT.key), expected);
  assert.equal(storage.writes, 3);
});

test("command histories remain isolated by server and shell and return immutable snapshots", () => {
  const storage = createStorage();
  const history = createCommandHistory({ storage, now: () => 1 });
  history.record(CONTEXT, "pwd", "terminal");
  const snapshot = history.entries(CONTEXT.key);
  assert(Object.isFrozen(snapshot));
  assert(Object.isFrozen(snapshot[0]));
  history.record(OTHER_CONTEXT, "Get-Location", "terminal");
  history.record({ ...CONTEXT, label: "Renamed production" }, "pwd", "agent");
  assert.equal(snapshot[0].runCount, 1);
  assert.equal(history.entries(CONTEXT.key)[0].runCount, 2);
  assert.deepEqual(history.entries(OTHER_CONTEXT.key).map(entry => entry.command), ["Get-Location"]);
  assert.deepEqual(history.entries("unknown-server"), []);
  const saved = JSON.parse(storage.getItem(STORAGE_KEY)!);
  assert.equal(saved.contexts.find((context: HistoryContext) => context.key === CONTEXT.key).label, "Renamed production");
});

test("history searches all words without case sensitivity and ranks last used before frequency", () => {
  const storage = createStorage();
  let timestamp = 0;
  const history = createCommandHistory({ storage, now: () => timestamp++ });
  history.record(CONTEXT, "systemctl status nginx", "terminal");
  history.record(CONTEXT, "systemctl status nginx", "agent");
  history.record(CONTEXT, "systemctl reload nginx", "terminal");
  history.record(CONTEXT, "ls -la", "terminal");
  assert.deepEqual(history.entries(CONTEXT.key, "NGINX system").map(entry => entry.command), ["systemctl reload nginx", "systemctl status nginx"]);
  assert.deepEqual(history.entries(CONTEXT.key, "   ").map(entry => entry.command), ["ls -la", "systemctl reload nginx", "systemctl status nginx"]);
  assert.deepEqual(history.entries(CONTEXT.key, "missing"), []);
  history.record(CONTEXT, "systemctl status nginx", "terminal");
  const expected = ["systemctl status nginx", "ls -la", "systemctl reload nginx"];
  assert.deepEqual(history.entries(CONTEXT.key).map(entry => entry.command), expected);
  assert.deepEqual(createCommandHistory({ storage }).entries(CONTEXT.key).map(entry => entry.command), expected);
});

test("history uses deterministic ties and accepts the maximum timestamp in last-used ordering", () => {
  const storage = createStorage();
  let timestamp = 0;
  const history = createCommandHistory({ storage, now: () => timestamp });
  history.record(CONTEXT, "whoami", "terminal");
  history.record(CONTEXT, "pwd", "terminal");
  history.record(CONTEXT, "whoami", "agent");
  history.record(CONTEXT, "ls", "terminal");
  assert.deepEqual(history.entries(CONTEXT.key).map(entry => entry.command), ["whoami", "ls", "pwd"]);
  timestamp = Number.MAX_SAFE_INTEGER;
  history.record(CONTEXT, "date", "terminal");
  assert.deepEqual(history.entries(CONTEXT.key).map(entry => entry.command), ["date", "whoami", "ls", "pwd"]);
});

test("blank commands and obvious credential-bearing commands never reach persistent history", () => {
  const storage = createStorage();
  const history = createCommandHistory({ storage });
  for (const command of [
    "", " ", "\t\n", " uptime", "\tpwd", "export OPENAI_API_KEY=hidden", "API_TOKEN=hidden command",
    "$env:CLIENT_SECRET = 'hidden'", "set PASSWORD=hidden", "curl --token hidden https://example.test",
    "tool --api-key=hidden", "tool --password hidden", "curl -H 'Authorization: Bearer hidden' https://example.test",
    "curl -H 'X-Api-Key: hidden' https://example.test", "curl https://user:hidden@example.test",
    "mysql -u root -phidden", "sshpass -p hidden ssh example.test",
  ]) history.record(CONTEXT, command, "terminal");
  assert.equal(storage.writes, 0);
  assert.deepEqual(history.entries(CONTEXT.key), []);
  history.record(CONTEXT, "cat public_key.pub", "terminal");
  history.record(CONTEXT, "grep token app.log", "terminal");
  assert.equal(history.entries(CONTEXT.key).length, 2);
});

test("PowerShell and quoted CMD assignments, prefixed secret flags, and inline curl credentials are excluded", () => {
  const storage = createStorage();
  const history = createCommandHistory({ storage });
  for (const command of [
    "$password = 'hidden'", "$global:token=\"hidden\"", "$script:dbPassword = 'hidden'",
    "$env:OPENAI_API_KEY='hidden'", "set \"API_TOKEN=hidden\"", "SET \"DB_PASSWORD=hidden\"",
    "tool --db-password=hidden", "tool --access-token hidden", "tool --service-client-secret hidden",
    "curl -u user:hidden https://example.test", "curl -uuser:hidden https://example.test",
    "curl --user user:hidden https://example.test", "curl --user='user:hidden' https://example.test",
    "curl.exe --user \"user:hidden\" https://example.test", "curl --proxy-user user:hidden https://example.test",
    "sshpass -phidden ssh example.test", "sshpass -p hidden ssh example.test",
  ]) history.record(CONTEXT, command, "terminal");
  assert.equal(storage.writes, 0);
  assert.deepEqual(history.entries(CONTEXT.key), []);
  const ordinaryCommands = [
    "Get-Variable password", "Write-Output $global:token", "Get-ChildItem Env:*TOKEN*",
    "grep access-token app.log", "grep password settings.txt", "tool --db-password-file /secure/credentials",
    "curl --user alice https://example.test", "curl -u alice https://example.test",
  ];
  for (const command of ordinaryCommands) history.record(CONTEXT, command, "terminal");
  assert.equal(storage.writes, ordinaryCommands.length);
  assert.deepEqual(history.entries(CONTEXT.key).map(entry => entry.command).sort(), ordinaryCommands.sort());
});

test("registry login short password flags are private while container port mappings and SSH ports are retained", () => {
  const storage = createStorage();
  const history = createCommandHistory({ storage });
  for (const command of [
    "docker login -u deploy -p hidden", "docker login registry.test -phidden", "docker.exe login -p=hidden",
    "podman login -u deploy -p 'hidden' registry.test", "sudo podman login registry.test -phidden",
  ]) history.record(CONTEXT, command, "terminal");
  assert.equal(storage.writes, 0);
  const ordinaryCommands = [
    "docker run -p 8080:80 nginx", "podman run -p 443:443 nginx", "ssh -p 2222 deploy@example.test",
    "ssh -p2222 deploy@example.test", "docker login --password-stdin registry.test",
  ];
  for (const command of ordinaryCommands) history.record(CONTEXT, command, "terminal");
  assert.equal(storage.writes, ordinaryCommands.length);
  assert.deepEqual(history.entries(CONTEXT.key).map(entry => entry.command).sort(), ordinaryCommands.sort());
});

test("history preserves Unicode, shell metacharacters, multiline commands, and meaningful internal whitespace", () => {
  const history = createCommandHistory({ storage: createStorage(), now: () => 0 });
  const command = "printf 'héllo 世界'  &&\nprintf '%s' '$HOME'";
  history.record(CONTEXT, command + "  \n", "agent");
  assert.equal(history.entries(CONTEXT.key)[0].command, command);
  history.record(CONTEXT, "printf  x", "terminal");
  history.record(CONTEXT, "printf x", "terminal");
  assert.equal(history.entries(CONTEXT.key).length, 3);
  history.record(CONTEXT, "Write-Output first\r\nWrite-Output second", "terminal");
  history.record(CONTEXT, "Write-Output first\nWrite-Output second", "terminal");
  assert.equal(history.entries(CONTEXT.key).find(entry => entry.command === "Write-Output first\nWrite-Output second")?.runCount, 2);
});

test("record validates input boundaries before writing or notifying", () => {
  const storage = createStorage();
  const history = createCommandHistory({ storage });
  let notifications = 0;
  history.subscribe(() => { notifications += 1; });
  for (const context of [null, {}, { key: "", label: "x" }, { key: "x", label: "" }, { key: "x\0", label: "x" },
    { key: "x".repeat(1025), label: "x" }, { key: "x", label: "x".repeat(257) }]) {
    assert.throws(() => history.record(context as HistoryContext, "pwd", "terminal"), /context/i);
  }
  for (const command of [null, undefined, 1, "x\0", "x\r", "x\x1b[A", "x".repeat(MAX_COMMAND_CHARACTERS + 1)]) {
    assert.throws(() => history.record(CONTEXT, command as string, "terminal"), /Command history accepts/);
  }
  assert.throws(() => history.record(CONTEXT, "pwd", "unknown" as CommandSource), /source/);
  assert.equal(storage.writes, 0);
  assert.equal(notifications, 0);
});

test("maximum command/context sizes are accepted and oversized persisted input is rejected", () => {
  const storage = createStorage();
  const history = createCommandHistory({ storage, now: () => 0 });
  const context = { key: "k".repeat(1024), label: "l".repeat(256) };
  const command = "x".repeat(MAX_COMMAND_CHARACTERS);
  history.record(context, command, "terminal");
  assert.equal(createCommandHistory({ storage }).entries(context.key)[0].command, command);
  assert.throws(() => createCommandHistory({ storage: createStorage(" ".repeat(MAX_STORAGE_CHARACTERS + 1)) }), /storage limit/);
});

test("history keeps the newest commands when per-context, total, and context-count limits are reached", () => {
  let timestamp = 0;
  const storage = createStorage();
  const history = createCommandHistory({ storage, now: () => timestamp++ });
  for (let index = 0; index <= MAX_CONTEXT_ENTRIES; index += 1) history.record(CONTEXT, `command-${index}`, "terminal");
  assert.equal(history.entries(CONTEXT.key).length, MAX_CONTEXT_ENTRIES);
  assert.equal(history.entries(CONTEXT.key).some(entry => entry.command === "command-0"), false);
  assert.equal(history.entries(CONTEXT.key).some(entry => entry.command === `command-${MAX_CONTEXT_ENTRIES}`), true);
  for (let context = 0; context < 6; context += 1) {
    for (let index = 0; index < MAX_CONTEXT_ENTRIES; index += 1) {
      history.record({ key: `server-${context}`, label: `Server ${context}` }, `command-${index}`, "terminal");
    }
  }
  let saved = JSON.parse(storage.getItem(STORAGE_KEY)!);
  assert.equal(saved.contexts.reduce((count: number, context: { entries: unknown[] }) => count + context.entries.length, 0), MAX_TOTAL_ENTRIES);
  for (let context = 0; context <= MAX_CONTEXTS; context += 1) {
    history.record({ key: `later-server-${context}`, label: `Later ${context}` }, "pwd", "terminal");
  }
  saved = JSON.parse(storage.getItem(STORAGE_KEY)!);
  assert.equal(saved.contexts.length, MAX_CONTEXTS);
  assert.equal(saved.contexts.some((context: HistoryContext) => context.key === `later-server-${MAX_CONTEXTS}`), true);
  assert.equal(saved.contexts.some((context: HistoryContext) => context.key === "later-server-0"), false);
});

test("serialized history stays bounded while retaining a newly executed maximum-length command", () => {
  const storage = createStorage();
  let timestamp = 0;
  const history = createCommandHistory({ storage, now: () => timestamp++ });
  for (let index = 0; index < MAX_CONTEXT_ENTRIES; index += 1) {
    history.record(CONTEXT, `${index}:` + "x".repeat(MAX_COMMAND_CHARACTERS - 4), "terminal");
  }
  const raw = storage.getItem(STORAGE_KEY)!;
  assert(raw.length <= MAX_STORAGE_CHARACTERS);
  const entries = createCommandHistory({ storage }).entries(CONTEXT.key);
  assert(entries.length < MAX_CONTEXT_ENTRIES);
  assert(entries.some(entry => entry.command.startsWith(`${MAX_CONTEXT_ENTRIES - 1}:`)));
});

const malformedSaved = [
  "", "{", "null", "[]", "{}", JSON.stringify({ version: 2, contexts: [] }),
  JSON.stringify({ version: 1, contexts: null }),
  JSON.stringify({ version: 1, contexts: [{ ...CONTEXT, entries: [] }, { ...CONTEXT, entries: [] }] }),
  JSON.stringify({ version: 1, contexts: [{ ...CONTEXT, entries: [savedEntry(), savedEntry()] }] }),
  ...[null, {}, { ...savedEntry(), command: null }, { ...savedEntry(), command: "" },
    { ...savedEntry(), command: "--password hidden" }, { ...savedEntry(), runCount: 0 },
    { ...savedEntry(), runCount: 2 }, { ...savedEntry(), terminalCount: -1 },
    { ...savedEntry(), agentCount: 0.5 }, { ...savedEntry(), lastRunAt: null },
    { ...savedEntry(), lastRunAt: Number.MAX_SAFE_INTEGER + 1 }].map(savedHistory),
];

for (const [index, raw] of malformedSaved.entries()) {
  test(`malformed command history ${index} fails without overwriting stored data`, () => {
    const storage = createStorage(raw);
    assert.throws(() => createCommandHistory({ storage }));
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.equal(storage.writes, 0);
  });
}

test("storage read and write errors propagate and failed writes preserve the previous in-memory state", () => {
  assert.throws(() => createCommandHistory({ storage: { getItem() { throw new Error("Read blocked"); }, setItem() {} } }), /Read blocked/);
  assert.throws(() => createCommandHistory(null as unknown as Parameters<typeof createCommandHistory>[0]), /storage/);
  const storage = createStorage();
  const history = createCommandHistory({ storage });
  history.record(CONTEXT, "pwd", "terminal");
  const previous = storage.getItem(STORAGE_KEY);
  storage.failWith(new Error("Quota reached"));
  assert.throws(() => history.record(CONTEXT, "pwd", "agent"), /Quota reached/);
  assert.equal(history.entries(CONTEXT.key)[0].runCount, 1);
  assert.equal(storage.getItem(STORAGE_KEY), previous);
});

test("invalid timestamps and exhausted counters fail before storage changes", () => {
  for (const timestamp of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const storage = createStorage();
    const history = createCommandHistory({ storage, now: () => timestamp });
    assert.throws(() => history.record(CONTEXT, "pwd", "terminal"), /timestamp/);
    assert.equal(storage.writes, 0);
  }
  const storage = createStorage(savedHistory({ ...savedEntry(), runCount: Number.MAX_SAFE_INTEGER, terminalCount: Number.MAX_SAFE_INTEGER }));
  const history = createCommandHistory({ storage });
  assert.throws(() => history.record(CONTEXT, "uptime", "terminal"), /run count/);
  assert.equal(storage.writes, 0);
});

test("search validates empty/null/oversized values and subscriber disposal stops future notifications", () => {
  const history = createCommandHistory({ storage: createStorage() });
  for (const key of [null, "", "x\n", "x".repeat(1025)]) assert.throws(() => history.entries(key as string), /context key/);
  for (const query of [null, "x\0", "x".repeat(MAX_COMMAND_CHARACTERS + 1)]) assert.throws(() => history.entries(CONTEXT.key, query as string), /search/);
  assert.throws(() => history.subscribe(null as unknown as () => void), /subscriber/);
  let notifications = 0;
  const unsubscribe = history.subscribe(() => { notifications += 1; });
  history.record(CONTEXT, "pwd", "terminal");
  assert.equal(notifications, 1);
  unsubscribe();
  unsubscribe();
  history.record(CONTEXT, "pwd", "agent");
  assert.equal(notifications, 1);
});
