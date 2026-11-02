import assert from "node:assert/strict";
import test from "node:test";
import { loadRemoteFolders, saveRemoteFolders, validateRemoteFolders, remoteFolderCommand, REMOTE_FOLDER_LIMITS } from "../src/remote-folders.ts";

const SETTINGS = { startPath: "~/app", folders: [{ name: "Logs", path: "/var/log" }] };
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test("remote folders persist across reloads and remain isolated by host", () => {
  const data = storage();
  assert.deepEqual(loadRemoteFolders(data, "api"), { startPath: "", folders: [] });
  const saved = saveRemoteFolders(data, "api", SETTINGS);
  assert.deepEqual(loadRemoteFolders(data, "api"), SETTINGS);
  assert.deepEqual(loadRemoteFolders(data, "other"), { startPath: "", folders: [] });
  assert.ok(Object.isFrozen(saved) && Object.isFrozen(saved.folders) && Object.isFrozen(saved.folders[0]));
  saveRemoteFolders(data, "api", { startPath: "", folders: [] });
  assert.deepEqual(loadRemoteFolders(data, "api"), { startPath: "", folders: [] });
});

test("remote folder validation rejects malformed values, duplicate names and unsafe paths", () => {
  for (const value of [null, [], {}, { startPath: null, folders: [] }, { startPath: "", folders: null },
    { startPath: "", folders: [null] }, { startPath: "relative", folders: [] },
    { startPath: "~another", folders: [] }, { startPath: "/srv\napp", folders: [] },
    { startPath: "", folders: [{ name: "", path: "/app" }] },
    { startPath: "", folders: [{ name: "Logs", path: "" }] },
    { startPath: "", folders: [{ name: "Logs", path: "/a" }, { name: "logs", path: "/b" }] }]) {
    assert.throws(() => validateRemoteFolders(value));
  }
});

test("remote folder limits accept the maximum and reject overflow without writing", () => {
  const maximum = {
    startPath: "/" + "x".repeat(REMOTE_FOLDER_LIMITS.path - 1),
    folders: Array.from({ length: REMOTE_FOLDER_LIMITS.folders }, (_, index) => ({
      name: `${index}`.padEnd(REMOTE_FOLDER_LIMITS.name, "x"), path: "/app",
    })),
  };
  const data = storage();
  assert.deepEqual(saveRemoteFolders(data, "x".repeat(REMOTE_FOLDER_LIMITS.profileId), maximum), maximum);
  const before = [...data.values];
  for (const value of [
    { ...maximum, startPath: maximum.startPath + "x" },
    { ...maximum, folders: [...maximum.folders, { name: "extra", path: "/extra" }] },
    { ...maximum, folders: [{ name: "x".repeat(REMOTE_FOLDER_LIMITS.name + 1), path: "/app" }] },
  ]) assert.throws(() => saveRemoteFolders(data, "api", value));
  for (const id of ["", "x".repeat(REMOTE_FOLDER_LIMITS.profileId + 1), null]) {
    assert.throws(() => loadRemoteFolders(data, id as string));
    assert.throws(() => saveRemoteFolders(data, id as string, SETTINGS));
  }
  assert.deepEqual([...data.values], before);
});

test("invalid stored data and storage failures stay visible and never erase data", () => {
  const data = storage();
  saveRemoteFolders(data, "api", SETTINGS);
  const key = [...data.values.keys()][0];
  for (const invalid of ["{", "null", '{"version":99}', '{"version":1,"settings":null}']) {
    data.values.set(key, invalid);
    assert.throws(() => loadRemoteFolders(data, "api"));
    assert.equal(data.values.get(key), invalid);
  }
  assert.throws(() => loadRemoteFolders({ getItem() { throw new Error("Read denied"); } }, "api"), /Read denied/);
  assert.throws(() => saveRemoteFolders({ setItem() { throw new Error("Disk full"); } }, "api", SETTINGS), /Disk full/);
});

test("folder commands quote shell operators literally and expand only the home prefix", () => {
  assert.equal(remoteFolderCommand("/srv/app"), "cd '/srv/app'");
  assert.equal(remoteFolderCommand("~"), 'cd "$HOME"');
  assert.equal(remoteFolderCommand("~/app files"), 'cd "$HOME"\'/app files\'');
  assert.equal(remoteFolderCommand("/srv/O'Brien; $(touch pwned)`id`"), "cd '/srv/O'\\''Brien; $(touch pwned)`id`'");
  for (const invalid of ["", null, "relative", "/a\rcommand", "/a\x1b", "/" + "x".repeat(REMOTE_FOLDER_LIMITS.path)]) {
    assert.throws(() => remoteFolderCommand(invalid as string));
  }
});
