import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { parseHTML } from "linkedom";

const APPLICATION_SOURCE = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const TERMINAL_COLUMNS = 112;
const TERMINAL_ROWS = 36;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DIRECTORY = "C:\\Projects\\O'Brien & $app; [draft] `notes` 日本語";
const LOCATION_NAME = 'Project <preview> & "notes"';
type Invocation = { readonly command: string; readonly arguments_: Record<string, unknown> };
type InvokeHandler = (invocation: Invocation) => Promise<unknown>;

function createTerminal(cols: number, rows: number) {
  const output: string[] = [];
  const inputListeners: Array<(data: string) => void> = [];
  let focusCount = 0;
  return {
    cols,
    rows,
    output,
    inputListeners,
    options: { disableStdin: false },
    get focusCount() { return focusCount; },
    focus() { focusCount += 1; },
    getSelection: () => "",
    write(data: string) { output.push(data); },
    onData(handler: (data: string) => void) { inputListeners.push(handler); },
    onSelectionChange: () => ({ dispose() {} })
  };
}

type TerminalMock = ReturnType<typeof createTerminal>;
type LocalSession = {
  id: string;
  kind: "local";
  name: string;
  shell: string;
  workingDirectory: string | null;
  locationName: string | null;
  container: HTMLElement;
  term: TerminalMock;
  fitAddon: { fit(): void };
  isClosed: boolean;
  isReady: boolean;
};

function createHarness(configuration: { readonly invoke?: InvokeHandler; readonly cols?: number; readonly rows?: number } = {}) {
  const { document } = parseHTML(HTML);
  document.getElementsByName = name => document.querySelectorAll(`[name="${name}"]`) as unknown as NodeListOf<HTMLElement>;
  const calls: Invocation[] = [];
  const notifications: string[] = [];
  const context = createContext({
    document,
    window: {
      __TAURI__: {
        core: {
          async invoke(command: string, arguments_: Record<string, unknown>) {
            const invocation = { command, arguments_: JSON.parse(JSON.stringify(arguments_)) as Record<string, unknown> };
            calls.push(invocation);
            return configuration.invoke?.(invocation);
          }
        },
        event: { async listen() { return () => {}; } }
      },
      addEventListener() {},
      setTimeout: () => 1,
      clearTimeout() {}
    },
    crypto: { randomUUID },
    localStorage: { getItem: () => null },
    console: { error() {}, warn() {}, log() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    TextEncoder,
    TextDecoder,
    btoa,
    atob
  });
  runInContext(APPLICATION_SOURCE, context, { filename: "src/main.js" });
  Object.assign(context, {
    refreshPanelLayout() {},
    scheduleTerminalSearchRefresh() {},
    showNotification(message: string) { notifications.push(message); },
    createTerminalForSession(session: LocalSession) {
      session.term = createTerminal(configuration.cols ?? TERMINAL_COLUMNS, configuration.rows ?? TERMINAL_ROWS);
      session.fitAddon = { fit() {} };
      return session.term;
    }
  });
  return {
    document, calls, notifications,
    get sessions(): LocalSession[] { return runInContext("Object.values(activeSessions)", context) as LocalSession[]; },
    get starts() { return calls.filter(call => call.command === "start_local_terminal"); },
    open(...args: [string, (string | null)?, (string | null)?]): Promise<void> {
      context.launchArguments = args;
      return runInContext("openLocalTerminal(...launchArguments)", context) as Promise<void>;
    },
    duplicate() { runInContext("duplicateActiveSession()", context); },
    tab(sessionId: string): HTMLElement {
      const tab = document.querySelector<HTMLElement>(`.terminal-tab[data-id="${sessionId}"]`);
      assert.ok(tab);
      return tab;
    }
  };
}

test("saved location launch forwards the exact folder and shows its name and path in the workspace", async () => {
  const harness = createHarness();
  await harness.open("powershell", DIRECTORY, LOCATION_NAME);
  assert.equal(harness.starts.length, 1);
  const [session] = harness.sessions;
  assert.deepEqual(harness.starts[0], {
    command: "start_local_terminal",
    arguments_: { sessionId: session.id, shell: "powershell", workingDirectory: DIRECTORY, cols: TERMINAL_COLUMNS, rows: TERMINAL_ROWS }
  });
  assert.equal(session.workingDirectory, DIRECTORY);
  assert.equal(session.locationName, LOCATION_NAME);
  assert.equal(session.name, `PowerShell · ${LOCATION_NAME}`);
  assert.equal(session.isReady, true);
  assert.equal(session.isClosed, false);
  assert.equal(Boolean(session.term.options.disableStdin), false);
  assert.equal(harness.tab(session.id).querySelector(".tab-title")?.textContent, session.name);
  assert.equal(harness.tab(session.id).querySelector("preview"), null);
  assert.equal(session.container.querySelector(".session-identity")?.textContent, session.name);
  assert.equal(session.container.querySelector(".session-directory")?.textContent, DIRECTORY);
  assert.equal(session.container.querySelector(".session-directory")?.getAttribute("title"), DIRECTORY);
  assert.equal(session.container.querySelector(".session-state")?.textContent, "Ready");
  assert.ok(session.term.focusCount > 0);
  assert.deepEqual(harness.calls.map(call => call.command), ["start_local_terminal", "resize_local_terminal"]);
});

for (const [shell, label] of [["powershell", "PowerShell"], ["cmd", "Command Prompt"]] as const) {
  for (const explicitNull of [false, true]) {
    test(`${label} keeps its default directory and label when the directory is ${explicitNull ? "null" : "omitted"}`, async () => {
      const harness = createHarness();
      await (explicitNull ? harness.open(shell, null, null) : harness.open(shell));
      const [session] = harness.sessions;
      assert.deepEqual(harness.starts[0].arguments_, {
        sessionId: session.id,
        shell,
        workingDirectory: null,
        cols: TERMINAL_COLUMNS,
        rows: TERMINAL_ROWS
      });
      assert.equal(session.name, label);
      assert.equal(session.locationName, null);
      assert.equal(session.workingDirectory, null);
      assert.equal(harness.tab(session.id).querySelector(".tab-title")?.textContent, label);
      assert.equal(session.container.querySelector(".session-directory")?.textContent, "Local machine");
    });
  }
}

test("local launch uses default dimensions when the terminal has not measured its viewport", async () => {
  const harness = createHarness({ cols: 0, rows: 0 });
  await harness.open("powershell", DIRECTORY, LOCATION_NAME);
  assert.equal(harness.starts[0].arguments_.cols, DEFAULT_COLUMNS);
  assert.equal(harness.starts[0].arguments_.rows, DEFAULT_ROWS);
});

test("duplicating a saved local session retains its folder and location name in a new tab", async () => {
  const harness = createHarness();
  await harness.open("powershell", DIRECTORY, LOCATION_NAME);
  harness.duplicate();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(harness.starts.length, 2);
  assert.equal(harness.sessions.length, 2);
  const [original, duplicate] = harness.sessions;
  assert.notEqual(original.id, duplicate.id);
  assert.equal(duplicate.shell, "powershell");
  assert.equal(duplicate.name, original.name);
  assert.equal(duplicate.workingDirectory, DIRECTORY);
  assert.equal(duplicate.locationName, LOCATION_NAME);
  assert.deepEqual(harness.starts[1].arguments_, { ...harness.starts[0].arguments_, sessionId: duplicate.id });
  assert.equal(duplicate.container.querySelector(".session-directory")?.textContent, DIRECTORY);
  assert.equal(harness.tab(duplicate.id).querySelector(".tab-title")?.textContent, original.name);
});

test("native startup failure remains visible in the terminal and marks its tab as failed", async () => {
  const message = "Folder does not exist: C:\\Projects\\Missing";
  const harness = createHarness({ invoke: async invocation => {
    if (invocation.command === "start_local_terminal") throw message;
  } });
  await harness.open("powershell", "C:\\Projects\\Missing", "Missing");
  const [session] = harness.sessions;
  assert.equal(session.isReady, false);
  assert.equal(session.isClosed, true);
  assert.equal(session.term.options.disableStdin, true);
  assert.match(session.term.output.join(""), /\[Local terminal error: Folder does not exist: C:\\Projects\\Missing\]/);
  assert.equal(harness.tab(session.id).querySelector(".tab-title")?.textContent, "Terminal failed");
  assert.equal(harness.tab(session.id).classList.contains("connection-terminated"), true);
  assert.equal(session.container.querySelector(".session-state")?.textContent, "Exited");
  assert.equal(session.container.querySelector(".session-directory")?.textContent, "C:\\Projects\\Missing");
  assert.equal(session.container.querySelector<HTMLButtonElement>(".session-paste")?.disabled, true);
  assert.equal(harness.calls.length, 1);
});

test("two rapid launches allocate unique session IDs while native startup is pending", async () => {
  const startup = Promise.withResolvers<void>();
  const harness = createHarness({ invoke: async invocation => {
    if (invocation.command === "start_local_terminal") await startup.promise;
  } });
  const first = harness.open("powershell", DIRECTORY, LOCATION_NAME);
  const second = harness.open("powershell", DIRECTORY, LOCATION_NAME);
  assert.equal(harness.starts.length, 2);
  assert.equal(harness.sessions.length, 2);
  const ids = harness.sessions.map(session => session.id);
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.match(id, /^local_powershell_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(harness.document.querySelectorAll(".terminal-tab").length, 2);
  assert.equal(harness.document.querySelectorAll(".local-terminal-session").length, 2);
  assert.ok(harness.sessions.every(session => !session.isReady));
  startup.resolve();
  await Promise.all([first, second]);
  assert.ok(harness.sessions.every(session => session.isReady));
  assert.equal(harness.starts[0].arguments_.workingDirectory, DIRECTORY);
  assert.equal(harness.starts[1].arguments_.workingDirectory, DIRECTORY);
});

test("unsupported shells show an error without creating a local tab or invoking native startup", async () => {
  const harness = createHarness();
  await harness.open("unsupported", DIRECTORY, LOCATION_NAME);
  assert.deepEqual(harness.notifications, ["That local shell is not supported."]);
  assert.equal(harness.sessions.length, 0);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.document.querySelectorAll(".terminal-tab").length, 0);
});
