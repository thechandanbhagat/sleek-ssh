import assert from "node:assert/strict";
import test from "node:test";
import { validateSnippetFolder, snippetFolderForSession, snippetAvailableInFolder, snippetsForFolder } from "../src/named-snippet-scope.ts";
import { loadSnippets, saveSnippet, type NamedSnippet } from "../src/named-snippets.ts";

const FOLDER = Object.freeze({ host: "api.test", port: 22, username: "deploy", path: "/srv/app" });
const SHARED: NamedSnippet = { id: "status", name: "Status", template: "pwd", shell: "posix" };
const SCOPED: NamedSnippet = { ...SHARED, id: "app", name: "App", folder: FOLDER };
const MAX_HOST_LENGTH = 253;
const MAX_USERNAME_LENGTH = 128;
const MAX_PATH_LENGTH = 4_096;
const MAX_PORT = 65_535;

test("folder scopes validate and normalize the server and absolute path without persisting extra fields", () => {
  const normalized = validateSnippetFolder({ ...FOLDER, host: " API.TEST ", path: "/srv//app/./logs/../", password: "discard" });
  assert.deepEqual(normalized, FOLDER); assert.ok(Object.isFrozen(normalized));
  assert.deepEqual(validateSnippetFolder({ ...FOLDER, path: "/" }), { ...FOLDER, path: "/" });
  assert.equal(validateSnippetFolder({ ...FOLDER, path: "/srv/app with spaces " }).path, "/srv/app with spaces ");
});

test("folder scopes reject empty, null, invalid ports, relative paths and control characters", () => {
  for (const value of [null, undefined, [], {}, "folder", { ...FOLDER, path: "" }, { ...FOLDER, path: "~/app" },
    { ...FOLDER, path: "relative" }, { ...FOLDER, host: "" }, { ...FOLDER, username: null },
    ...[0, MAX_PORT + 1, 1.5, NaN, "22", null].map(port => ({ ...FOLDER, port })),
    ...["path", "host", "username"].flatMap(field => ["\n", "\0", "\x1b", "\u0085", "\u2028"].map(control => ({ ...FOLDER, [field]: "/a" + control }))),
  ]) assert.throws(() => validateSnippetFolder(value));
});

test("folder scope limits accept exact maxima and reject overflow", () => {
  const maximum = { host: "h".repeat(MAX_HOST_LENGTH), username: "u".repeat(MAX_USERNAME_LENGTH), port: MAX_PORT, path: "/" + "p".repeat(MAX_PATH_LENGTH - 1) };
  assert.deepEqual(validateSnippetFolder(maximum), maximum);
  for (const field of ["host", "username", "path"] as const) assert.throws(() => validateSnippetFolder({ ...maximum, [field]: maximum[field] + "x" }));
  assert.equal(validateSnippetFolder({ ...FOLDER, port: 1 }).port, 1);
});

test("only a connected SSH terminal's working folder supplies a folder scope", () => {
  const session = { kind: "ssh", host: FOLDER.host, connectionProfile: FOLDER, connectionId: "transport", terminalPath: FOLDER.path };
  assert.deepEqual(snippetFolderForSession(session), FOLDER);
  for (const value of [null, { ...session, kind: "local" }, { ...session, connectionId: null },
    { ...session, terminalPath: null }, { ...session, terminalPath: "~" }, { ...session, connectionProfile: undefined },
    { ...session, isClosed: true }, { ...session, isClosing: true }, { ...session, isConnecting: true },
  ]) assert.equal(snippetFolderForSession(value), null);
});

test("folder matching includes descendants and root while isolating servers, ports, users and path boundaries", () => {
  assert.equal(snippetAvailableInFolder(SHARED, null), true);
  assert.equal(snippetAvailableInFolder(SCOPED, null), false);
  assert.equal(snippetAvailableInFolder(SCOPED, FOLDER), true);
  assert.equal(snippetAvailableInFolder(SCOPED, { ...FOLDER, path: "/srv/app/releases/next" }), true);
  assert.equal(snippetAvailableInFolder({ ...SCOPED, folder: { ...FOLDER, path: "/" } }, FOLDER), true);
  for (const folder of [{ ...FOLDER, host: "other.test" }, { ...FOLDER, port: 2222 }, { ...FOLDER, username: "root" },
    { ...FOLDER, path: "/srv/app-old" }, { ...FOLDER, path: "/srv/App" }, { ...FOLDER, path: "/srv" },
  ]) assert.equal(snippetAvailableInFolder(SCOPED, folder), false);
});

test("matching snippets rank the closest folder first, retain shared order and leave input unchanged", () => {
  const deep = { ...SCOPED, id: "deep", folder: { ...FOLDER, path: "/srv/app/logs" } };
  const other = { ...SCOPED, id: "other", folder: { ...FOLDER, host: "other.test" } };
  const source = Object.freeze([SHARED, SCOPED, deep, other]);
  assert.deepEqual(snippetsForFolder(source, { ...FOLDER, path: "/srv/app/logs/archive" }), [deep, SCOPED, SHARED]);
  assert.deepEqual(snippetsForFolder(source, null), [SHARED]);
  assert.deepEqual(snippetsForFolder([], null), []);
  assert.deepEqual(source, [SHARED, SCOPED, deep, other]);
});

test("existing snippets stay shared and folder scope survives save and load boundaries", () => {
  let saved: string | null = null;
  const storage = { getItem: () => saved, setItem(_key: string, value: string) { saved = value; } };
  saveSnippet(storage, [], SHARED);
  assert.deepEqual(loadSnippets(storage), [SHARED]);
  saveSnippet(storage, [SHARED], { ...SHARED, folder: FOLDER });
  assert.deepEqual(loadSnippets(storage), [{ ...SHARED, folder: FOLDER }]);
  const before = saved;
  for (const folder of [null, {}, { ...FOLDER, path: "~" }]) {
    assert.throws(() => saveSnippet(storage, [], { ...SHARED, folder } as NamedSnippet));
    assert.equal(saved, before);
  }
  saveSnippet(storage, loadSnippets(storage), { ...SHARED, folder: undefined });
  assert.deepEqual(loadSnippets(storage), [SHARED]);
});
