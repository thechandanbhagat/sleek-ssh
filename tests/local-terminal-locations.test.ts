import assert from "node:assert/strict";
import test from "node:test";
import {
  loadLocalTerminalLocations,
  removeLocalTerminalLocation,
  saveLocalTerminalLocation,
  type LocalTerminalLocation
} from "../src/local-terminal-locations.ts";

const STORAGE_KEY = "sleekssh_local_terminal_locations";
const MAX_NAME_LENGTH = 120;
const MAX_PATH_LENGTH = 32_767;
const MAX_ID_LENGTH = 128;
const LOCATION: LocalTerminalLocation = Object.freeze({ id: "project", name: "Project", path: "C:\\Projects\\app" });

function createStorage(initial: string | null = null) {
  const data = new Map<string, string>();
  if (initial !== null) data.set(STORAGE_KEY, initial);
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }
  };
}

test("locations load empty storage and an empty saved list", () => {
  assert.deepEqual(loadLocalTerminalLocations(createStorage()), []);
  assert.deepEqual(loadLocalTerminalLocations(createStorage("[]")), []);
});

test("locations save, reload, update in place, and remove without mutating input", () => {
  const storage = createStorage();
  const empty: readonly LocalTerminalLocation[] = Object.freeze([]);
  const saved = saveLocalTerminalLocation(storage, empty, LOCATION);
  assert.deepEqual(empty, []);
  assert.deepEqual(saved, [LOCATION]);
  assert.deepEqual(loadLocalTerminalLocations(storage), saved);
  const second = { id: "other", name: "Other", path: "D:\\Other" };
  const appended = saveLocalTerminalLocation(storage, saved, second);
  const edited = saveLocalTerminalLocation(storage, appended, { ...LOCATION, name: "Renamed", path: "C:\\Renamed" });
  assert.deepEqual(edited.map(location => location.name), ["Renamed", "Other"]);
  assert.deepEqual(saved, [LOCATION]);
  assert.deepEqual(appended, [LOCATION, second]);
  const removed = removeLocalTerminalLocation(storage, edited, LOCATION.id);
  assert.deepEqual(removed, [second]);
  assert.deepEqual(loadLocalTerminalLocations(storage), [second]);
  assert.equal(edited.length, 2);
  assert.deepEqual(removeLocalTerminalLocation(storage, removed, "unknown"), [second]);
  assert.deepEqual(removeLocalTerminalLocation(storage, removed, second.id), []);
  assert.deepEqual(loadLocalTerminalLocations(storage), []);
});

test("valid paths preserve spaces, Unicode, shell metacharacters, drive roots and UNC shares", () => {
  const paths = [
    "C:\\Projects\\My app",
    "C:\\Projects\\O'Brien & $project; [draft] `notes`",
    "C:\\Projects\\日本語",
    "C:\\",
    "D:/Projects/app",
    "\\\\server\\share\\My app",
    "//server/share/project"
  ];
  for (const path of paths) {
    const storage = createStorage();
    const saved = saveLocalTerminalLocation(storage, [], { ...LOCATION, path });
    assert.equal(saved[0].path, path);
    assert.equal(loadLocalTerminalLocations(storage)[0].path, path);
  }
});

test("location fields trim surrounding spaces and return immutable data", () => {
  const storage = createStorage(JSON.stringify([{ id: " project ", name: " Project ", path: " C:\\Projects\\app " }]));
  const loaded = loadLocalTerminalLocations(storage);
  assert.deepEqual(loaded, [LOCATION]);
  assert.ok(Object.isFrozen(loaded));
  assert.ok(Object.isFrozen(loaded[0]));
  const saved = saveLocalTerminalLocation(storage, [], { id: " project ", name: " Project ", path: " C:\\Projects\\app " });
  assert.deepEqual(saved, [LOCATION]);
});

test("invalid JSON, null, empty text, nonlists, and invalid entries fail without changing storage", () => {
  for (const raw of ["", "{", "null", "{}", '"text"', "[null]", "[[]]", "[{}]"]) {
    const storage = createStorage(raw);
    assert.throws(() => loadLocalTerminalLocations(storage));
    assert.equal(storage.getItem(STORAGE_KEY), raw);
  }
});

test("invalid fields and relative paths are rejected on load and save", () => {
  const invalidLocations = [
    null,
    undefined,
    { ...LOCATION, id: "" },
    { ...LOCATION, id: null },
    { ...LOCATION, name: "   " },
    { ...LOCATION, name: null },
    { ...LOCATION, path: "" },
    { ...LOCATION, path: null },
    { ...LOCATION, name: "Project\n" },
    { ...LOCATION, path: "C:\\Projects\\app\t" },
    { ...LOCATION, path: "C:\\Projects\u0000app" },
    { ...LOCATION, path: "C:\\Projects\u007fapp" },
    { ...LOCATION, path: "C:Projects" },
    { ...LOCATION, path: "\\Projects" },
    { ...LOCATION, path: "Projects\\app" },
    { ...LOCATION, path: "/Projects/app" },
    { ...LOCATION, path: "\\\\server" },
    { ...LOCATION, path: "\\\\server\\" }
  ];
  for (const location of invalidLocations) {
    const storage = createStorage();
    assert.throws(() => saveLocalTerminalLocation(storage, [], location as unknown as LocalTerminalLocation));
    assert.equal(storage.getItem(STORAGE_KEY), null);
    const raw = JSON.stringify([location]);
    assert.throws(() => loadLocalTerminalLocations(createStorage(raw)));
  }
});

test("field maximum lengths are accepted and oversized fields are rejected", () => {
  const maximum = {
    id: "i".repeat(MAX_ID_LENGTH),
    name: "n".repeat(MAX_NAME_LENGTH),
    path: `C:\\${"p".repeat(MAX_PATH_LENGTH - "C:\\".length)}`
  };
  const storage = createStorage();
  assert.deepEqual(saveLocalTerminalLocation(storage, [], maximum), [maximum]);
  assert.deepEqual(loadLocalTerminalLocations(storage), [maximum]);
  for (const field of ["id", "name", "path"] as const) {
    const oversized = { ...maximum, [field]: `${maximum[field]}x` };
    assert.throws(() => saveLocalTerminalLocation(storage, [], oversized), /at most/);
    assert.throws(() => loadLocalTerminalLocations(createStorage(JSON.stringify([oversized]))), /at most/);
  }
});

test("duplicate paths ignore case, slash direction and trailing separators", () => {
  for (const path of ["c:\\projects\\APP", "C:/Projects/app/", "C:\\Projects\\app\\\\"]) {
    const duplicate = { id: "duplicate", name: "Duplicate", path };
    const storage = createStorage(JSON.stringify([LOCATION]));
    assert.throws(() => saveLocalTerminalLocation(storage, [LOCATION], duplicate), /already has a saved/);
    assert.deepEqual(loadLocalTerminalLocations(storage), [LOCATION]);
    assert.throws(() => loadLocalTerminalLocations(createStorage(JSON.stringify([LOCATION, duplicate]))), /already has a saved/);
  }
  const storage = createStorage();
  const locations = [LOCATION, { id: "other", name: "Other", path: "D:\\Other" }];
  assert.throws(() => saveLocalTerminalLocation(storage, locations, { ...locations[1], path: LOCATION.path }), /already has a saved/);
  assert.deepEqual(saveLocalTerminalLocation(storage, [LOCATION], { ...LOCATION, path: "c:\\projects\\app\\" }), [{ ...LOCATION, path: "c:\\projects\\app\\" }]);
});

test("duplicate IDs and invalid existing state are rejected", () => {
  const duplicate = { ...LOCATION, path: "D:\\Other" };
  assert.throws(() => loadLocalTerminalLocations(createStorage(JSON.stringify([LOCATION, duplicate]))), /duplicate location ID/);
  assert.throws(() => saveLocalTerminalLocation(createStorage(), [LOCATION, duplicate], LOCATION), /duplicate location ID/);
  assert.throws(() => saveLocalTerminalLocation(createStorage(), null as unknown as LocalTerminalLocation[], LOCATION), /must be a list/);
  assert.throws(() => removeLocalTerminalLocation(createStorage(), null as unknown as LocalTerminalLocation[], LOCATION.id), /must be a list/);
});

test("remove validates IDs and leaves saved locations unchanged on validation failure", () => {
  const raw = JSON.stringify([LOCATION]);
  for (const id of ["", " ", "bad\n", "i".repeat(MAX_ID_LENGTH + 1), null, undefined]) {
    const storage = createStorage(raw);
    assert.throws(() => removeLocalTerminalLocation(storage, [LOCATION], id as string));
    assert.equal(storage.getItem(STORAGE_KEY), raw);
  }
});

test("storage read and write failures propagate and input state remains unchanged", () => {
  const failure = new Error("Storage is unavailable");
  assert.throws(() => loadLocalTerminalLocations({ getItem() { throw failure; } }), error => error === failure);
  const brokenStorage = { setItem() { throw failure; } };
  const locations = Object.freeze([LOCATION]);
  assert.throws(() => saveLocalTerminalLocation(brokenStorage, locations, { ...LOCATION, name: "Renamed" }), error => error === failure);
  assert.throws(() => removeLocalTerminalLocation(brokenStorage, locations, LOCATION.id), error => error === failure);
  assert.deepEqual(locations, [LOCATION]);
});
