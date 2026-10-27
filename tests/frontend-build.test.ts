import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE_PREFIX = "sleekssh-frontend-build-";
const BUILD_TIMEOUT_MS = 60_000;
const MODULE_LOAD_TIMEOUT_MS = 10_000;
const MODULE_REGISTRATION_SCRIPT = `
import { pathToFileURL } from "node:url";
globalThis.window = {};
for (const path of process.argv.slice(1)) await import(pathToFileURL(path).href);
const registrations = Object.fromEntries(Object.entries(window).map(([name, methods]) => [
  name, Object.fromEntries(Object.entries(methods).map(([method, value]) => [method, typeof value]))
]));
process.stdout.write(JSON.stringify(registrations));
`;

function readProjectJson(path: string) {
  return JSON.parse(readFileSync(join(PROJECT_ROOT, path), "utf8"));
}

function createFixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  const modules = join(directory, "node_modules");
  context.after(() => {
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith(FIXTURE_PREFIX));
    if (existsSync(modules)) unlinkSync(modules);
    rmSync(absolute, { recursive: true });
  });
  mkdirSync(join(directory, "src"));
  mkdirSync(join(directory, "scripts"));
  for (const name of readdirSync(join(PROJECT_ROOT, "src"))) {
    if (name.endsWith(".ts") || name === "index.html") {
      copyFileSync(join(PROJECT_ROOT, "src", name), join(directory, "src", name));
    }
  }
  for (const name of ["package.json", "tsconfig.automation.json", "scripts/build-frontend.ts"]) {
    copyFileSync(join(PROJECT_ROOT, name), join(directory, name));
  }
  symlinkSync(join(PROJECT_ROOT, "node_modules"), modules, process.platform === "win32" ? "junction" : "dir");
  return directory;
}

function runBuildHook(directory: string) {
  const hook: unknown = readProjectJson("src-tauri/tauri.conf.json").build.beforeBuildCommand;
  assert.equal(typeof hook, "string", "Production builds must compile frontend modules before packaging.");
  return spawnSync(hook as string, {
    cwd: directory,
    shell: true,
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
    windowsHide: true,
  });
}

test("the production build hook recreates missing frontend assets and registers every browser integration", context => {
  const directory = createFixture(context);
  assert.equal(existsSync(join(directory, "src/generated")), false);

  const result = runBuildHook(directory);

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { document } = parseHTML(readFileSync(join(directory, "src/index.html"), "utf8"));
  const bundles = [...document.querySelectorAll('script[type="module"][src^="/generated/"]')]
    .map(script => join(directory, "src", script.getAttribute("src")!.slice(1)));
  assert.ok(bundles.length > 0);
  bundles.forEach(bundle => assert.ok(existsSync(bundle), `Missing packaged asset: ${bundle}`));
  const modules = spawnSync(process.execPath, ["--input-type=module", "--eval", MODULE_REGISTRATION_SCRIPT, ...bundles], {
    cwd: directory,
    encoding: "utf8",
    timeout: MODULE_LOAD_TIMEOUT_MS,
    windowsHide: true,
  });
  assert.ifError(modules.error);
  assert.equal(modules.status, 0, modules.stdout + modules.stderr);
  const registrations = JSON.parse(modules.stdout);
  assert.equal(registrations.SleekSshAutomation?.initAutomation, "function");
  assert.equal(registrations.SleekSshLocalTerminals?.initLocalTerminalPanel, "function");
  assert.equal(registrations.SleekSshCommandPalette?.initCommandPalette, "function");
  assert.equal(registrations.SleekSshCommandPalette?.parseConnectTarget, "function");
});

test("the build hook fails on invalid TypeScript before producing packageable frontend assets", context => {
  const directory = createFixture(context);
  appendFileSync(join(directory, "src/command-palette.ts"), "\nexport const invalidBuildRegressionValue: string = 42;\n");

  const result = runBuildHook(directory);

  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Type 'number' is not assignable to type 'string'/);
  assert.equal(existsSync(join(directory, "src/generated")), false);
});

test("development waits for the same frontend build and the npm wrapper delegates to Tauri once", () => {
  const { build } = readProjectJson("src-tauri/tauri.conf.json");
  const { scripts } = readProjectJson("package.json");

  assert.equal(build.beforeDevCommand.script, build.beforeBuildCommand);
  assert.equal(build.beforeDevCommand.wait, true);
  assert.equal(scripts.tauri, "tauri");
});
