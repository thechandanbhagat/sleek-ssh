import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const APPLICATION_SOURCE = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SSH_PORT = 22;
const REMOTE_HOME = "/home/tester";
const SAVED_DIRECTORY = "/srv/project with spaces";

type Invocation = { command: string; arguments: Record<string, unknown> };
type InvokeHandler = (invocation: Invocation) => Promise<unknown>;

function createElement() {
  const classes = new Set<string>();
  const children = new Map<string, ReturnType<typeof createElement>>();
  const attributes = new Map<string, string>();
  return {
    className: "",
    textContent: "",
    innerHTML: "",
    value: "",
    disabled: false,
    hidden: false,
    inert: false,
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      contains: (name: string) => classes.has(name),
      toggle(name: string, force = !classes.has(name)) {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      },
    },
    querySelector(selector: string) {
      if (!children.has(selector)) children.set(selector, createElement());
      return children.get(selector)!;
    },
    querySelectorAll: () => [],
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name),
    addEventListener() {},
    appendChild() {},
    remove() {},
    focus() {},
  };
}

function createTerminal() {
  const output: unknown[] = [];
  const oscHandlers = new Map<number, (data: string) => boolean>();
  return {
    cols: DEFAULT_COLUMNS,
    rows: DEFAULT_ROWS,
    output,
    oscHandlers,
    options: { disableStdin: false },
    disposed: false,
    focus() {},
    write(data: unknown) { output.push(data); },
    dispose() { this.disposed = true; },
    onData() {},
    parser: {
      registerOscHandler(code: number, handler: (data: string) => boolean) {
        oscHandlers.set(code, handler);
        return { dispose() {} };
      },
    },
  };
}

function deferred() {
  const result = Promise.withResolvers<void>();
  return result;
}

function createHarness(handleInvocation?: InvokeHandler) {
  const calls: Invocation[] = [];
  const events = new Map<string, (event: { payload: Record<string, unknown> }) => void>();
  const elements = createElement();
  const storage = new Map<string, string>();
  const sftpLoads: { session: unknown; path: string; options: unknown }[] = [];
  let transportNumber = 0;
  const context = createContext({
    window: {
      __TAURI__: {
        core: {
          async invoke(command: string, arguments_: Record<string, unknown>) {
            const invocation = { command, arguments: arguments_ };
            calls.push(invocation);
            if (handleInvocation) return handleInvocation(invocation);
            if (command === "sftp_resolve_path") return arguments_.path === "." ? REMOTE_HOME : arguments_.path;
            if (command === "sftp_list_directory") return [];
          },
        },
        event: {
          async listen(name: string, callback: (event: { payload: Record<string, unknown> }) => void) {
            events.set(name, callback);
            return () => events.delete(name);
          },
        },
      },
      addEventListener() {},
      setTimeout: () => 1,
      clearTimeout() {},
    },
    document: {
      querySelectorAll: () => [],
      getElementsByName: () => [],
      getElementById: (id: string) => elements.querySelector(id),
      querySelector: (selector: string) => elements.querySelector(selector),
      createElement,
      addEventListener() {},
    },
    crypto: { randomUUID: () => `transport-${++transportNumber}` },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    console: { error() {}, warn() {}, log() {} },
    TextEncoder,
    TextDecoder,
    URL,
    btoa,
    atob,
    setTimeout: () => 1,
    clearTimeout() {},
  });
  runInContext(APPLICATION_SOURCE, context, { filename: "src/main.js" });
  Object.assign(context, {
    fitTerminal() {},
    scheduleTerminalSearchRefresh() {},
    disposeTerminalSearch() {},
    initSftpForSession() {},
    async initializeTerminalDirectoryReporting() {},
    createTerminalForSession(session: { term?: ReturnType<typeof createTerminal> }) {
      session.term ??= createTerminal();
      return session.term;
    },
  });
  const originalLoadSftpDirectory = context.loadSftpDirectory;
  context.loadSftpDirectory = async (session: unknown, path: string, options: unknown) => {
    sftpLoads.push({ session, path, options });
  };
  const session = {
    id: "stable-tab",
    kind: "ssh",
    name: "Test server",
    host: "test.invalid",
    connectionId: "old-transport",
    connectionProfile: {
      id: "saved-profile",
      name: "Test server",
      host: "test.invalid",
      port: DEFAULT_SSH_PORT,
      username: "tester",
      key_path: "test-key",
      use_password: false,
    },
    container: createElement(),
    term: createTerminal(),
    isClosed: true,
    isConnecting: false,
    isClosing: false,
    isReady: false,
    currentPath: SAVED_DIRECTORY as string | null,
    terminalPath: SAVED_DIRECTORY as string | null,
    terminalInput: "",
    canTrackTerminalInput: true,
    sftpRequestId: 0,
    sftpStateKey: "saved-profile",
    sftpInitialized: true,
    sftpPanelOpen: true,
  };
  elements.querySelector(`.terminal-tab[data-id="${session.id}"]`).dataset.kind = "ssh";
  context.session = session;
  runInContext("activeSessions[session.id] = session", context);
  return {
    session,
    calls,
    events,
    sftpLoads,
    elements,
    run<T>(expression: string): T { return runInContext(expression, context) as T; },
    restoreSftpLoader() { context.loadSftpDirectory = originalLoadSftpDirectory; },
  };
}

test("reconnecting preserves the tab, terminal, and saved directories with a fresh transport", async () => {
  const harness = createHarness();
  const previousTerminal = harness.session.term;

  await harness.run<Promise<void>>("reconnectSshSession(session)");

  const connections = harness.calls.filter((call) => call.command === "connect_ssh");
  assert.equal(connections.length, 1);
  assert.notEqual(harness.session.connectionId, "old-transport");
  assert.equal(connections[0].arguments.sessionId, harness.session.connectionId);
  assert.equal(harness.session.id, "stable-tab");
  assert.equal(harness.session.term, previousTerminal);
  assert.equal(harness.session.currentPath, SAVED_DIRECTORY);
  assert.equal(harness.session.terminalPath, SAVED_DIRECTORY);
  assert.equal(harness.session.isClosed, false);
  assert.equal(harness.session.isConnecting, false);
  assert.equal(harness.run("activeSessions[session.id]"), harness.session);
  assert.equal(harness.sftpLoads.at(-1)?.path, SAVED_DIRECTORY);
});

test("reconnect resumes the reported shell directory when it differs from the file browser", async () => {
  const harness = createHarness();
  harness.session.terminalPath = "/srv/current-shell-directory";

  await harness.run<Promise<void>>("reconnectSshSession(session)");

  const connection = harness.calls.find((call) => call.command === "connect_ssh");
  assert.ok((connection?.arguments.terminalSetup as string).includes("; cd '/srv/current-shell-directory';"));
  assert.equal(harness.calls.some((call) => call.command === "write_ssh"), false);
  assert.equal(harness.sftpLoads.at(-1)?.path, harness.session.terminalPath);
});

test("fresh connections provide a single quiet setup payload with a safely quoted restore path", () => {
  const harness = createHarness();
  const command = harness.run<string>("createTerminalSetupCommand(\"/srv/owner's files\")");

  assert.ok(command.includes("; cd '/srv/owner'\\''s files';"));
  assert.equal(/[\x00\r\n]/.test(command), false);
  assert.equal(harness.calls.length, 0);
  assert.ok(harness.run<string>("createTerminalSetupCommand(null)").endsWith("; fi"));
});

test("the session toolbar displays the actual path and enables copy only for selected text", () => {
  const harness = createHarness();
  harness.session.term.getSelection = () => "selected output";
  harness.session.terminalPath = "/srv/active directory";
  harness.run("setSshConnectionStatus(session, 'connected', 'Connected')");
  const toolbar = harness.session.container.querySelector(".session-toolbar");

  assert.equal(toolbar.querySelector(".session-directory").textContent, "/srv/active directory");
  assert.equal(toolbar.querySelector(".session-copy-selection").disabled, false);
  assert.equal(toolbar.querySelector(".session-paste").disabled, false);
  assert.equal(toolbar.querySelector(".session-state").textContent, "Connected");
});

test("directory reports emitted during quiet startup survive connection completion", async () => {
  const connection = deferred();
  const harness = createHarness(async ({ command }) => {
    if (command === "connect_ssh") await connection.promise;
  });
  harness.run("updateWorkspaceTabTitle = () => {}");
  const connecting = harness.run<Promise<void>>("connectProfile({ id: 'fresh', name: 'Fresh', host: 'test.invalid', port: 22, username: 'tester', use_password: false })");
  const fresh = harness.run<ReturnType<typeof createHarness>["session"]>("Object.values(activeSessions).find(session => session.id !== 'stable-tab')");
  fresh.term.oscHandlers.get(7)?.("file://localhost/srv/startup%20directory");
  assert.equal(harness.run<string>("Object.values(activeSessions).find(session => session.id !== 'stable-tab').pendingTerminalPath"), "/srv/startup directory");

  connection.resolve();
  await connecting;

  assert.equal(fresh.terminalPath, "/srv/startup directory");
  assert.equal(harness.sftpLoads.at(-1)?.path, "/srv/startup directory");
});

test("duplicate reconnect requests share one pending connection attempt", async () => {
  const connection = deferred();
  const harness = createHarness(async ({ command }) => {
    if (command === "connect_ssh") await connection.promise;
  });

  const reconnect = harness.run<Promise<void>>("reconnectSshSession(session)");
  await harness.run<Promise<void>>("reconnectSshSession(session)");
  assert.equal(harness.session.isClosed, true);
  assert.equal(harness.session.isConnecting, true);
  connection.resolve();
  await reconnect;

  assert.equal(harness.calls.filter((call) => call.command === "connect_ssh").length, 1);
});

test("events from an old connection cannot close or write into the reconnected tab", async () => {
  const harness = createHarness();
  harness.run("initConnectionListeners()");
  await harness.run<Promise<void>>("reconnectSshSession(session)");
  const outputCount = harness.session.term.output.length;

  harness.events.get("ssh-closed")!({ payload: { session_id: "old-transport" } });
  harness.events.get("ssh-error")!({ payload: { session_id: "old-transport", data: "stale error" } });
  harness.events.get("ssh-output")!({ payload: { session_id: "old-transport", data: btoa("stale output") } });

  assert.equal(harness.session.isClosed, false);
  assert.equal(harness.session.term.output.length, outputCount);
  assert.equal(harness.run("findSshSession('old-transport')"), undefined);
  assert.equal(harness.run("findSshSession(session.connectionId)"), harness.session);
  harness.session.isClosing = true;
  assert.equal(harness.run("findSshSession(session.connectionId)"), undefined);
});

test("native sudo prompt events target only the connected transport and expose the explicit action", () => {
  const harness = createHarness();
  Object.assign(harness.session.connectionProfile, { sudo_shortcut_enabled: true, has_sudo_password: true });
  harness.session.isClosed = false;
  harness.run("activeTabId = session.id; setSshConnectionStatus(session, 'connected', 'Connected'); initConnectionListeners()");
  const promptEvent = harness.events.get("ssh-sudo-prompt")!;
  promptEvent({ payload: { session_id: "old-transport", ready: true, prompt_id: "native-request" } });
  assert.equal(harness.run("session.sudoPromptReady"), true);
  assert.equal(harness.run("session.sudoPromptId"), "native-request");
  const toolbar = harness.session.container.querySelector(".session-toolbar");
  assert.equal(toolbar.querySelector(".session-sudo-password").hidden, false);

  promptEvent({ payload: { session_id: "unrelated-transport", ready: false, prompt_id: null } });
  assert.equal(harness.run("session.sudoPromptReady"), true);
  promptEvent({ payload: { session_id: "old-transport", ready: false, prompt_id: null } });
  assert.equal(harness.run("session.sudoPromptReady"), false);
  assert.equal(toolbar.querySelector(".session-sudo-password").hidden, true);
});

test("disconnecting and reconnecting invalidate the previous native sudo request", async () => {
  const harness = createHarness();
  Object.assign(harness.session.connectionProfile, { sudo_shortcut_enabled: true, has_sudo_password: true });
  harness.session.isClosed = false;
  harness.run("activeTabId = session.id; setSshConnectionStatus(session, 'connected', 'Connected'); setSudoPromptState(session, true, 'previous-request')");
  assert.equal(harness.run("canSendSudoPassword(session)"), true);
  harness.run("handleSshDisconnect(session, 'Connection lost')");
  assert.equal(harness.run("session.sudoPromptReady"), false);
  await harness.run<Promise<void>>("reconnectSshSession(session)");
  assert.equal(harness.run("canSendSudoPassword(session)"), false);
  assert.equal(harness.calls.filter(call => call.command === "connect_ssh").at(-1)?.arguments.profileId, "saved-profile");
});

test("native sudo prompts are ignored during startup and after closure", () => {
  const harness = createHarness();
  Object.assign(harness.session.connectionProfile, { sudo_shortcut_enabled: true, has_sudo_password: true });
  harness.run("activeTabId = session.id; initConnectionListeners()");
  const promptEvent = harness.events.get("ssh-sudo-prompt")!;
  promptEvent({ payload: { session_id: "old-transport", ready: true, prompt_id: "startup-request" } });
  assert.notEqual(harness.run("session.sudoPromptReady"), true);
  harness.session.isClosed = false;
  harness.session.isConnecting = true;
  promptEvent({ payload: { session_id: "old-transport", ready: true, prompt_id: "connecting-request" } });
  assert.notEqual(harness.run("session.sudoPromptReady"), true);
});

test("closing a tab while reconnecting closes the abandoned transport", async () => {
  const connection = deferred();
  const connectionStarted = deferred();
  const harness = createHarness(async ({ command }) => {
    if (command === "connect_ssh") {
      connectionStarted.resolve();
      await connection.promise;
    }
  });
  const reconnect = harness.run<Promise<void>>("reconnectSshSession(session)");
  await connectionStarted.promise;
  await harness.run<Promise<void>>("closeTab(session.id)");
  const disconnectsBeforeConnect = harness.calls.filter((call) => call.command === "disconnect_ssh").length;

  connection.resolve();
  await reconnect;

  const disconnects = harness.calls.filter((call) => call.command === "disconnect_ssh");
  assert.ok(disconnects.length > disconnectsBeforeConnect);
  assert.equal(disconnects.at(-1)?.arguments.sessionId, harness.session.connectionId);
  assert.equal(harness.run("activeSessions[session.id]"), undefined);
  assert.equal(harness.session.term.disposed, true);
  assert.equal(harness.sftpLoads.length, 0);
});

test("an SSH error during connection setup keeps the tab disconnected and cleans up the transport", async () => {
  const connection = deferred();
  const connectionStarted = deferred();
  const harness = createHarness(async ({ command }) => {
    if (command === "connect_ssh") {
      connectionStarted.resolve();
      await connection.promise;
    }
  });
  harness.run("initConnectionListeners()");
  const reconnect = harness.run<Promise<void>>("reconnectSshSession(session)");
  await connectionStarted.promise;
  harness.events.get("ssh-error")!({
    payload: { session_id: harness.session.connectionId, data: "Connection lost during setup" },
  });
  connection.resolve();
  await reconnect;

  assert.equal(harness.session.isClosed, true);
  assert.equal(harness.session.isConnecting, false);
  assert.equal(harness.run("session.connectionStatus"), "disconnected");
  assert.equal(harness.calls.filter((call) => call.command === "disconnect_ssh").at(-1)?.arguments.sessionId, harness.session.connectionId);
  assert.equal(harness.calls.some((call) => call.command === "write_ssh"), false);
  assert.equal(harness.sftpLoads.length, 0);
  assert.equal(harness.session.terminalPath, SAVED_DIRECTORY);
});

test("a failed reconnect preserves directories and permits another attempt", async () => {
  let attempts = 0;
  const harness = createHarness(async ({ command }) => {
    if (command === "connect_ssh" && ++attempts === 1) throw new Error("Network unavailable");
  });

  await harness.run<Promise<void>>("reconnectSshSession(session)");
  const failedConnectionId = harness.session.connectionId;
  assert.equal(harness.session.isClosed, true);
  assert.equal(harness.session.isConnecting, false);
  assert.equal(harness.session.currentPath, SAVED_DIRECTORY);
  await harness.run<Promise<void>>("reconnectSshSession(session)");

  assert.equal(attempts, 2);
  assert.notEqual(harness.session.connectionId, failedConnectionId);
  assert.equal(harness.session.isClosed, false);
});

for (const status of ["connecting", "reconnecting", "connected", "disconnected"]) {
  test(`${status} status updates reconnect availability and terminal input`, () => {
    const harness = createHarness();
    harness.run(`setSshConnectionStatus(session, ${JSON.stringify(status)}, 'Connection status')`);
    const statusElement = harness.session.container.querySelector(".terminal-connection-status");
    const reconnectButton = harness.session.container.querySelector(".session-toolbar").querySelector(".btn-reconnect");

    assert.equal(statusElement.classList.contains("hidden"), status === "connected");
    assert.equal(reconnectButton.disabled, status !== "disconnected");
    assert.equal(reconnectButton.hidden, status !== "disconnected" && status !== "reconnecting");
    assert.equal(harness.session.term.options.disableStdin, status !== "connected");
    assert.equal(harness.session.container.querySelector(".sftp-panel").inert, status !== "connected");
    assert.equal(statusElement.querySelector(".terminal-connection-message").textContent, "Connection status");
  });
}

test("disconnect invalidates pending directory requests once and keeps the path for reconnect", () => {
  const harness = createHarness();
  harness.session.isClosed = false;
  harness.session.terminalInput = "unfinished command";
  const previousRequestId = harness.session.sftpRequestId;
  harness.run("handleSshDisconnect(session, 'Network unavailable')");
  harness.run("handleSshDisconnect(session, 'Connection closed')");

  assert.equal(harness.session.isClosed, true);
  assert.equal(harness.session.sftpRequestId, previousRequestId + 1);
  assert.equal(harness.session.terminalInput, "");
  assert.equal(harness.session.currentPath, SAVED_DIRECTORY);
  assert.equal(harness.session.terminalPath, SAVED_DIRECTORY);
  assert.equal(harness.session.term.output.length, 1);
});

test("reconnect ignores connected, closing, and removed tabs", async () => {
  const harness = createHarness();
  harness.session.isClosed = false;
  await harness.run<Promise<void>>("reconnectSshSession(session)");
  harness.session.isClosed = true;
  harness.session.isClosing = true;
  await harness.run<Promise<void>>("reconnectSshSession(session)");
  harness.session.isClosing = false;
  harness.run("delete activeSessions[session.id]");
  await harness.run<Promise<void>>("reconnectSshSession(session)");

  assert.equal(harness.calls.length, 0);
});

for (const path of [null, ""]) {
  test(`an initial ${JSON.stringify(path)} directory opens the remote home`, async () => {
    const harness = createHarness();
    harness.session.currentPath = path;
    harness.session.terminalPath = path;

    await harness.run<Promise<void>>("establishSshConnection(session)");

    assert.equal(harness.sftpLoads.at(-1)?.path, ".");
    assert.equal(harness.session.isClosed, false);
  });
}

test("shell directory arguments preserve apostrophes and metacharacters literally", () => {
  const harness = createHarness();
  assert.equal(harness.run("quoteRemoteShellArgument(\"/srv/client's $(touch nope)\")"), "'/srv/client'\\''s $(touch nope)'");
  assert.equal(harness.run("quoteRemoteShellArgument('')"), "''");
  assert.equal(harness.run("quoteRemoteShellArgument('/')"), "'/'");
  assert.throws(() => harness.run("quoteRemoteShellArgument(null)"));
  assert.throws(() => harness.run("quoteRemoteShellArgument(undefined)"));
});

for (const control of ["\0", "\n", "\r", "\t", "\x1b", "\x7f"]) {
  test(`shell directory arguments reject control character ${JSON.stringify(control)}`, () => {
    const harness = createHarness();
    assert.throws(() => harness.run(`quoteRemoteShellArgument(${JSON.stringify(`/srv/a${control}b`)})`));
  });
}

test("directory synchronization uses the current transport and waits for an OSC report before tracking the path", async () => {
  const harness = createHarness();
  harness.session.isClosed = false;
  await harness.run<Promise<void>>("synchronizeTerminalDirectory(session, '/srv/next directory')");

  const write = harness.calls.find((call) => call.command === "write_ssh");
  assert.equal(write?.arguments.sessionId, harness.session.connectionId);
  assert.match(atob(write?.arguments.dataBase64 as string), /cd .*'\/srv\/next directory'/);
  assert.equal(harness.session.terminalPath, SAVED_DIRECTORY);
});

test("file browser listing uses the current transport and resolves an empty path to home", async () => {
  const harness = createHarness();
  harness.restoreSftpLoader();
  harness.session.isClosed = false;
  await harness.run<Promise<void>>("loadSftpDirectory(session, '')");

  const resolve = harness.calls.find((call) => call.command === "sftp_resolve_path");
  const listing = harness.calls.find((call) => call.command === "sftp_list_directory");
  assert.equal(resolve?.arguments.sessionId, harness.session.connectionId);
  assert.equal(resolve?.arguments.path, ".");
  assert.equal(listing?.arguments.sessionId, harness.session.connectionId);
  assert.equal(listing?.arguments.path, REMOTE_HOME);
  assert.equal(harness.session.currentPath, REMOTE_HOME);
});

test("an old SFTP response cannot replace the restored directory after reconnect", async () => {
  const listingStarted = deferred();
  const staleListing = Promise.withResolvers<unknown[]>();
  const harness = createHarness(async ({ command, arguments: arguments_ }) => {
    if (command === "sftp_resolve_path") return arguments_.path;
    if (command === "sftp_list_directory") {
      if (arguments_.sessionId === "old-transport") {
        listingStarted.resolve();
        return staleListing.promise;
      }
      return [];
    }
  });
  harness.restoreSftpLoader();
  harness.session.isClosed = false;
  const oldRequest = harness.run<Promise<void>>("loadSftpDirectory(session, '/srv/stale-directory')");
  await listingStarted.promise;
  harness.run("handleSshDisconnect(session, 'Network unavailable')");
  await harness.run<Promise<void>>("reconnectSshSession(session)");
  staleListing.resolve([]);
  await oldRequest;

  assert.equal(harness.session.currentPath, SAVED_DIRECTORY);
  assert.equal(harness.session.container.querySelector(".sftp-path-input").value, SAVED_DIRECTORY);
  assert.equal(harness.session.isClosed, false);
});
