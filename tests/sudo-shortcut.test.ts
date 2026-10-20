import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const APPLICATION_SOURCE = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const SHORTCUT_WINDOW_MS = 2000;
const PROMPT_EXPIRY_MS = 30_000;

function createKey(overrides: Record<string, unknown> = {}) {
  return {
    type: "keydown", key: "F2", code: "F2", repeat: false,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
    ...overrides
  };
}

function createHarness(invokeOverride?: (command: string, args: Record<string, unknown>) => Promise<void>) {
  let now = 1000;
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const elementListeners = new Map<string, () => void>();
  const windowListeners = new Map<string, () => void>();
  const notifications: string[] = [];
  let toolbarRefreshes = 0;
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const term = {
    element: {
      addEventListener: (event: string, handler: () => void) => elementListeners.set(event, handler),
      removeEventListener: (event: string) => elementListeners.delete(event)
    },
    paste() { throw new Error("Password must not use xterm paste."); }
  };
  const session = {
    id: "tab-a", kind: "ssh", connectionId: "transport-a", connectionStatus: "connected",
    isClosed: false, isClosing: false, isConnecting: false, term, container: null as Record<string, unknown> | null,
    connectionProfile: { sudo_shortcut_enabled: true, has_sudo_password: true },
    sudoPromptReady: false, sudoPromptId: null as string | null,
    sudoShortcutDispose: null as (() => void) | null
  };
  const context = createContext({
    Date: { now: () => now },
    document: { querySelectorAll: () => [], getElementsByName: () => [], getElementById: () => null },
    window: {
      __TAURI__: { core: { invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args });
        await invokeOverride?.(command, args);
      } }, event: { listen() {} } },
      addEventListener: (event: string, handler: () => void) => windowListeners.set(event, handler),
      removeEventListener: (event: string) => windowListeners.delete(event),
      setTimeout: (handler: () => void) => { timerId += 1; timers.set(timerId, handler); return timerId; },
      clearTimeout: (id: number) => timers.delete(id)
    },
    console: { log() { throw new Error("Secret logging is forbidden."); }, error() { throw new Error("Secret logging is forbidden."); } }
  });
  runInContext(APPLICATION_SOURCE, context);
  Object.assign(context, {
    session,
    showNotification: (message: string) => notifications.push(message),
    updateSessionToolbar: () => { toolbarRefreshes += 1; }
  });
  runInContext("activeSessions[session.id] = session; activeTabId = session.id", context);
  return {
    session, calls, notifications, timers, elementListeners, windowListeners,
    toolbarRefreshCount: () => toolbarRefreshes,
    run: (source: string) => runInContext(source, context),
    key(overrides: Record<string, unknown> = {}) {
      const event = createKey(overrides);
      context.event = event;
      return { event, result: runInContext("handleSudoShortcutKeyEvent(session, event)", context) };
    },
    ready(promptId = "native-prompt-token") { context.promptId = promptId; runInContext("setSudoPromptState(session, true, promptId)", context); },
    advance: (ms: number) => { now += ms; },
    async settle() { await Promise.resolve(); await Promise.resolve(); }
  };
}

test("three deliberate F2 presses submit only a native prompt token through the backend", async () => {
  const harness = createHarness();
  harness.ready();
  for (let index = 0; index < 3; index += 1) {
    const { event, result } = harness.key();
    assert.equal(result, false);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
  }
  await harness.settle();
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].command, "send_sudo_password");
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls[0].args)), { sessionId: "transport-a", promptId: "native-prompt-token" });
  assert.equal(harness.session.sudoPromptReady, false);
  assert.deepEqual(harness.notifications, ["Saved sudo password submitted."]);
  harness.key();
  assert.equal(harness.calls.length, 1);
});

for (const [name, mutation] of [
  ["disabled", "session.connectionProfile.sudo_shortcut_enabled = false"],
  ["no saved password", "session.connectionProfile.has_sudo_password = false"],
  ["local", "session.kind = 'local'"],
  ["inactive tab", "activeTabId = 'other-tab'"],
  ["closed", "session.isClosed = true"],
  ["closing", "session.isClosing = true"],
  ["connecting", "session.isConnecting = true"],
  ["disconnected", "session.connectionStatus = 'disconnected'"],
  ["missing transport", "session.connectionId = null"],
  ["removed", "delete activeSessions[session.id]"],
  ["replaced session", "activeSessions[session.id] = {}"]
]) {
  test(`F2 passes through and cannot submit for ${name}`, () => {
    const harness = createHarness();
    harness.ready();
    harness.run(mutation);
    for (let index = 0; index < 3; index += 1) assert.equal(harness.key().result, true);
    assert.equal(harness.run("canSendSudoPassword(session)"), false);
    assert.equal(harness.calls.length, 0);
  });
}

test("empty, null, and non-native prompts never enable submission", () => {
  const harness = createHarness();
  assert.equal(harness.key().result, true);
  for (const value of ["''", "null", "42", "undefined", "'x'.repeat(129)"]) {
    harness.run(`setSudoPromptState(session, true, ${value})`);
    assert.equal(harness.run("canSendSudoPassword(session)"), false);
  }
  harness.run("setSudoPromptState(session, 'true', 'valid-token')");
  assert.equal(harness.run("canSendSudoPassword(session)"), false);
  harness.ready("x".repeat(128));
  assert.equal(harness.run("canSendSudoPassword(session)"), true);
  assert.equal(harness.run("isSudoSessionConnected(null)"), false);
  harness.run("resetSudoShortcut(null)");
});

test("two-second boundary permits the third press but expiry restarts counting", () => {
  const boundary = createHarness();
  boundary.ready();
  boundary.key();
  boundary.advance(SHORTCUT_WINDOW_MS);
  boundary.key();
  boundary.key();
  assert.equal(boundary.calls.length, 1);
  const expired = createHarness();
  expired.ready();
  expired.key();
  expired.key();
  expired.advance(SHORTCUT_WINDOW_MS + 1);
  expired.key();
  assert.equal(expired.calls.length, 0);
  expired.key();
  expired.key();
  assert.equal(expired.calls.length, 1);
});

test("key repeat is consumed without incrementing and keyup preserves the sequence", () => {
  const harness = createHarness();
  harness.ready();
  harness.key();
  harness.key({ repeat: true });
  assert.equal(harness.key({ type: "keyup" }).result, true);
  harness.key();
  assert.equal(harness.calls.length, 0);
  harness.key();
  assert.equal(harness.calls.length, 1);
});

for (const overrides of [
  { key: "a", code: "KeyA" }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }
]) {
  test(`other keys or modifiers clear readiness: ${JSON.stringify(overrides)}`, () => {
    const harness = createHarness();
    harness.ready();
    harness.key();
    assert.equal(harness.key(overrides).result, true);
    assert.equal(harness.session.sudoPromptReady, false);
    assert.equal(harness.calls.length, 0);
  });
}

test("blur and tab resets clear counting while retaining the valid native prompt", () => {
  const harness = createHarness();
  harness.run("initSudoShortcut(session)");
  harness.ready();
  harness.key();
  harness.key();
  harness.windowListeners.get("blur")!();
  assert.equal(harness.session.sudoPromptReady, true);
  harness.key();
  assert.equal(harness.calls.length, 0);
  harness.run("resetSudoShortcut(session, false)");
  harness.key();
  harness.key();
  assert.equal(harness.calls.length, 0);
  harness.key();
  assert.equal(harness.calls.length, 1);
  harness.session.sudoShortcutDispose!();
  assert.equal(harness.elementListeners.size, 0);
  assert.equal(harness.windowListeners.has("blur"), false);
  assert.equal(harness.timers.size, 0);
});

test("prompt expires at thirty seconds and expiry timer clears readiness", () => {
  const harness = createHarness();
  harness.ready();
  harness.advance(PROMPT_EXPIRY_MS - 1);
  assert.equal(harness.run("canSendSudoPassword(session)"), true);
  harness.advance(1);
  assert.equal(harness.run("canSendSudoPassword(session)"), false);
  [...harness.timers.values()][0]();
  assert.equal(harness.session.sudoPromptReady, false);
  assert.equal(harness.session.sudoPromptId, null);
});

test("a new native prompt resets counting and a false event clears its timer", () => {
  const harness = createHarness();
  harness.ready();
  harness.key();
  harness.key();
  harness.ready("new-native-token");
  harness.key();
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.timers.size, 1);
  harness.run("setSudoPromptState(session, false, null)");
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.run("canSendSudoPassword(session)"), false);
});

test("overlapping sends and a prompt arriving during pending submission cannot duplicate it", async () => {
  let resolve!: () => void;
  const pending = new Promise<void>(complete => { resolve = complete; });
  const harness = createHarness(() => pending);
  harness.ready();
  const first = harness.run("sendSudoPassword(session)");
  harness.ready("next-native-token");
  assert.equal(await harness.run("sendSudoPassword(session)"), false);
  assert.equal(harness.calls.length, 1);
  resolve();
  assert.equal(await first, true);
  assert.deepEqual(harness.notifications, []);
  assert.equal(harness.run("canSendSudoPassword(session)"), true);
});

for (const [name, mutation] of [
  ["reconnect", "resetSudoShortcut(session); session.connectionId = 'transport-b'"],
  ["tab switch", "resetSudoShortcut(session, false); activeTabId = 'other-tab'"],
  ["close", "resetSudoShortcut(session); delete activeSessions[session.id]"]
]) {
  test(`completion after ${name} cannot update another session`, async () => {
    let resolve!: () => void;
    const pending = new Promise<void>(complete => { resolve = complete; });
    const harness = createHarness(() => pending);
    harness.ready();
    const result = harness.run("sendSudoPassword(session)");
    harness.run(mutation);
    resolve();
    await result;
    assert.deepEqual(harness.notifications, []);
  });
}

test("backend failures show a fixed secret-free message and consume the prompt once", async () => {
  const harness = createHarness(async () => { throw new Error("backend error containing sensitive-password"); });
  harness.ready();
  assert.equal(await harness.run("sendSudoPassword(session)"), false);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].includes("sensitive-password"), false);
  assert.equal(await harness.run("sendSudoPassword(session)"), false);
  assert.equal(harness.calls.length, 1);
});

test("native prompt consumption before RPC completion preserves one success notification", async () => {
  let resolve!: () => void;
  const pending = new Promise<void>(complete => { resolve = complete; });
  const harness = createHarness(() => pending);
  harness.ready();
  const result = harness.run("sendSudoPassword(session)");
  harness.run("setSudoPromptState(session, false, null)");
  harness.run("setSudoPromptState(session, false, null)");
  assert.equal(harness.session.sudoPromptReady, false);
  assert.equal(await harness.run("sendSudoPassword(session)"), false);
  resolve();
  assert.equal(await result, true);
  assert.deepEqual(harness.notifications, ["Saved sudo password submitted."]);
  assert.equal(harness.calls.length, 1);
});

test("failure after native prompt consumption still shows only the generic error", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_, fail) => { reject = fail; });
  const harness = createHarness(() => pending);
  harness.ready();
  const result = harness.run("sendSudoPassword(session)");
  harness.run("setSudoPromptState(session, false, null)");
  reject(new Error("backend error containing sensitive-password"));
  assert.equal(await result, false);
  assert.deepEqual(harness.notifications, ["Could not submit the saved sudo password. Wait for a new sudo prompt or reconnect."]);
  assert.equal(harness.calls.length, 1);
});

test("native consumption cannot restore notifications cancelled by tab changes or new prompts", async () => {
  for (const boundary of ["resetSudoShortcut(session, false); activeTabId = 'other-tab'", "setSudoPromptState(session, true, 'new-native-token')"]) {
    let resolve!: () => void;
    const pending = new Promise<void>(complete => { resolve = complete; });
    const harness = createHarness(() => pending);
    harness.ready();
    const result = harness.run("sendSudoPassword(session)");
    harness.run(boundary);
    harness.run("setSudoPromptState(session, false, null)");
    resolve();
    await result;
    assert.deepEqual(harness.notifications, []);
  }
});

test("ordinary keys refresh toolbar only when clearing readiness; count-only blur does not refresh", () => {
  const harness = createHarness();
  harness.session.container = {};
  harness.run("initSudoShortcut(session)");
  harness.ready();
  assert.equal(harness.toolbarRefreshCount(), 1);
  harness.key();
  harness.windowListeners.get("blur")!();
  harness.run("resetSudoShortcut(session, false)");
  assert.equal(harness.toolbarRefreshCount(), 1);
  harness.key({ key: "a", code: "KeyA" });
  assert.equal(harness.toolbarRefreshCount(), 2);
  assert.equal(harness.session.sudoPromptReady, false);
  for (let index = 0; index < 5; index += 1) harness.key({ key: "a", code: "KeyA" });
  harness.windowListeners.get("blur")!();
  assert.equal(harness.toolbarRefreshCount(), 2);
  harness.ready("new-native-token");
  assert.equal(harness.toolbarRefreshCount(), 3);
  harness.run("setSudoPromptState(session, false, null)");
  assert.equal(harness.toolbarRefreshCount(), 4);
  harness.run("setSudoPromptState(session, false, null)");
  assert.equal(harness.toolbarRefreshCount(), 4);
});
