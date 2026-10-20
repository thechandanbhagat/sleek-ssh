import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const APPLICATION_SOURCE = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const HOST = "test.invalid";
const PORT = 22;
const FINGERPRINT = `SHA256:${"A".repeat(43)}`;
const CHALLENGE = { host: HOST, port: PORT, key_type: "ssh-ed25519", fingerprint: FINGERPRINT, key_base64: "AAAA" };
const UNTRUSTED_ERROR = `SSH_HOST_TRUST_REQUIRED:${JSON.stringify(CHALLENGE)}`;
const CHANGED_ERROR = `SSH_HOST_KEY_CHANGED:${JSON.stringify(CHALLENGE)}`;
type Invocation = { command: string; arguments: Record<string, unknown> };
type Handler = (invocation: Invocation) => Promise<unknown>;
type KeyEvent = { key: string; shiftKey?: boolean; preventDefault(): void; stopPropagation(): void };

class ElementMock {
  textContent = "";
  innerHTML = "";
  className = "";
  hidden = false;
  disabled = false;
  isConnected = true;
  focusCount = 0;
  children: ElementMock[] = [];
  selectors = new Map<string, ElementMock>();
  listeners = new Map<string, (event?: KeyEvent) => unknown>();
  parent: ElementMock | null = null;
  readonly onFocus: (element: ElementMock) => void;
  constructor(onFocus: (element: ElementMock) => void) { this.onFocus = onFocus; }
  querySelector(selector: string) {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new ElementMock(this.onFocus));
    return this.selectors.get(selector)!;
  }
  querySelectorAll() {
    return [".ssh-host-trust-close", ".ssh-host-trust-cancel", ".ssh-host-trust-accept"]
      .map(selector => this.querySelector(selector)).filter(element => !element.hidden && !element.disabled);
  }
  addEventListener(name: string, handler: (event?: KeyEvent) => unknown) { this.listeners.set(name, handler); }
  appendChild(child: ElementMock) { child.parent = this; this.children.push(child); }
  remove() {
    this.isConnected = false;
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
  }
  focus() { this.focusCount += 1; this.onFocus(this); }
  click() { return this.listeners.get("click")?.(); }
}

function createHarness(handler?: Handler) {
  const calls: Invocation[] = [];
  const dialogShown = Promise.withResolvers<void>();
  const document = {
    activeElement: null as ElementMock | null,
    body: null as ElementMock | null,
    getElementById: (_id: string) => new ElementMock(onFocus),
    querySelectorAll: () => [],
    getElementsByName: () => [],
    querySelector: (_selector: string) => new ElementMock(onFocus),
    createElement: () => new ElementMock(onFocus),
  };
  function onFocus(element: ElementMock) { document.activeElement = element; }
  document.body = new ElementMock(onFocus);
  const append = document.body.appendChild.bind(document.body);
  document.body.appendChild = element => { append(element); dialogShown.resolve(); };
  const previousFocus = new ElementMock(onFocus);
  document.activeElement = previousFocus;
  const context = createContext({
    window: {
      __TAURI__: {
        core: { async invoke(command: string, arguments_: Record<string, unknown>) {
          const invocation = { command, arguments: arguments_ };
          calls.push(invocation);
          return handler?.(invocation);
        } },
        event: { listen() {} },
      },
      addEventListener() {},
      clearTimeout() {},
    },
    document,
    console: { error() {}, warn() {} },
    TextEncoder,
    TextDecoder,
    URL,
    btoa,
    atob,
  });
  runInContext(APPLICATION_SOURCE, context);
  const session = { id: "tab", kind: "ssh", name: "Test", isClosing: false, connectionProfile: { host: HOST, port: PORT } };
  Object.assign(context, { session, challenge: CHALLENGE, arguments_: { sessionId: "transport", host: HOST, port: PORT, profileId: "profile" } });
  runInContext("activeSessions[session.id] = session", context);
  return {
    session, context, calls, document, previousFocus, dialogShown: dialogShown.promise,
    run<T>(expression: string) { return runInContext(expression, context) as T; },
    get overlay() { return document.body!.children[0]; },
  };
}

for (const [name, error] of [["new", UNTRUSTED_ERROR], ["changed", CHANGED_ERROR]] as const) {
  test(`host parser accepts the ${name} key challenge without losing fingerprint data`, () => {
    const harness = createHarness();
    harness.context.error = error;
    const result = harness.run<Record<string, unknown>>("parseSshHostTrustError(error)");
    assert.equal(result.host, HOST);
    assert.equal(result.port, PORT);
    assert.equal(result.fingerprint, FINGERPRINT);
    assert.equal(result.changed, name === "changed");
  });
}

for (const error of [null, "", "SSH handshake failed", "SSH_HOST_TRUST_REQUIRED:{", "SSH_HOST_TRUST_REQUIRED:null"]) {
  test(`host parser rejects unrelated or malformed input ${JSON.stringify(error)}`, () => {
    const harness = createHarness();
    harness.context.error = error;
    assert.equal(harness.run("parseSshHostTrustError(error)"), null);
  });
}

for (const invalid of [{ host: "" }, { host: "server\n" }, { port: 0 }, { port: 65_536 }, { port: 1.5 }, { fingerprint: "untrusted" }, { key_type: "<script>" }, { key_base64: "" }, { key_base64: "secret!" }, { key_base64: "A".repeat(16_385) }]) {
  test(`host parser validates boundary fields ${Object.keys(invalid).join()}`, () => {
    const harness = createHarness();
    harness.context.error = `SSH_HOST_TRUST_REQUIRED:${JSON.stringify({ ...CHALLENGE, ...invalid })}`;
    assert.equal(harness.run("parseSshHostTrustError(error)"), null);
  });
}

test("unknown host dialog displays key data and saves only after explicit approval", async () => {
  const harness = createHarness();
  const approved = harness.run<Promise<boolean>>("requestSshHostTrust(session, { ...challenge, changed: false })");
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.overlay.querySelector(".ssh-host-trust-server").textContent, `${HOST}:${PORT}`);
  assert.equal(harness.overlay.querySelector(".ssh-host-trust-fingerprint").textContent, FINGERPRINT);
  assert.equal(harness.document.activeElement, harness.overlay.querySelector(".ssh-host-trust-cancel"));
  await harness.overlay.querySelector(".ssh-host-trust-accept").click();
  assert.equal(await approved, true);
  assert.equal(harness.calls[0].command, "trust_ssh_host");
  assert.deepEqual({ ...harness.calls[0].arguments }, { host: HOST, port: PORT, keyBase64: "AAAA" });
  assert.equal(harness.document.body!.children.length, 0);
  assert.equal(harness.document.activeElement, harness.previousFocus);
});

test("changed keys expose no acceptance action and cannot overwrite saved trust", async () => {
  const harness = createHarness();
  const approved = harness.run<Promise<boolean>>("requestSshHostTrust(session, { ...challenge, changed: true, expected_fingerprint: 'SHA256:saved' })");
  assert.equal(harness.overlay.querySelector(".ssh-host-trust-accept").hidden, true);
  assert.equal(harness.overlay.querySelector(".ssh-host-trust-saved-fingerprint").textContent, "SHA256:saved");
  await harness.overlay.querySelector(".ssh-host-trust-accept").click();
  assert.equal(harness.calls.length, 0);
  harness.overlay.querySelector(".ssh-host-trust-cancel").click();
  assert.equal(await approved, false);
});

test("key-save failure keeps connection blocked and displays a bounded error", async () => {
  const harness = createHarness(async () => { throw new Error("private backend details"); });
  const approved = harness.run<Promise<boolean>>("requestSshHostTrust(session, { ...challenge, changed: false })");
  await harness.overlay.querySelector(".ssh-host-trust-accept").click();
  assert.equal(harness.overlay.querySelector(".ssh-host-trust-accept").disabled, false);
  assert.match(harness.overlay.querySelector(".ssh-host-trust-error").textContent, /remains blocked/);
  assert.doesNotMatch(harness.overlay.querySelector(".ssh-host-trust-error").textContent, /private/);
  harness.overlay.querySelector(".ssh-host-trust-cancel").click();
  assert.equal(await approved, false);
});

test("dialogs serialize and canceling a session resolves visible and queued requests", async () => {
  const harness = createHarness();
  const first = harness.run<Promise<boolean>>("requestSshHostTrust(session, { ...challenge, changed: false })");
  const second = harness.run<Promise<boolean>>("requestSshHostTrust(session, { ...challenge, changed: false })");
  assert.equal(harness.document.body!.children.length, 1);
  harness.run("cancelSshHostTrust(session)");
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(harness.document.body!.children.length, 0);
});

test("closed and removed sessions never create fingerprint dialogs", async () => {
  const harness = createHarness();
  harness.session.isClosing = true;
  assert.equal(await harness.run("requestSshHostTrust(session, challenge)"), false);
  harness.session.isClosing = false;
  harness.run("delete activeSessions[session.id]");
  assert.equal(await harness.run("requestSshHostTrust(session, challenge)"), false);
  assert.equal(harness.document.body!.children.length, 0);
});

test("fingerprint dialog traps Tab and Escape declines approval", async () => {
  const harness = createHarness();
  const approved = harness.run<Promise<boolean>>("requestSshHostTrust(session, { ...challenge, changed: false })");
  const overlay = harness.overlay;
  const close = overlay.querySelector(".ssh-host-trust-close");
  const accept = overlay.querySelector(".ssh-host-trust-accept");
  const event = { key: "Tab", shiftKey: false, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
  accept.focus();
  overlay.listeners.get("keydown")!(event);
  assert.equal(harness.document.activeElement, close);
  assert.equal(event.prevented, true);
  event.shiftKey = true;
  overlay.listeners.get("keydown")!(event);
  assert.equal(harness.document.activeElement, accept);
  event.key = "Escape";
  overlay.listeners.get("keydown")!(event);
  assert.equal(await approved, false);
});

test("verified connection retries once after approval and preserves its arguments", async () => {
  let attempts = 0;
  const harness = createHarness(async ({ command }) => {
    if (command === "connect_ssh" && attempts++ === 0) throw UNTRUSTED_ERROR;
  });
  const connecting = harness.run<Promise<void>>("connectVerifiedSshSession(session, arguments_)");
  await harness.dialogShown;
  await harness.overlay.querySelector(".ssh-host-trust-accept").click();
  await connecting;
  const connections = harness.calls.filter(call => call.command === "connect_ssh");
  assert.equal(connections.length, 2);
  assert.deepEqual(connections[0].arguments, connections[1].arguments);
});

test("connection cancellation never retries or sends credentials to another host", async () => {
  const harness = createHarness(async () => { throw UNTRUSTED_ERROR; });
  const connecting = harness.run<Promise<void>>("connectVerifiedSshSession(session, arguments_)");
  await harness.dialogShown;
  harness.overlay.querySelector(".ssh-host-trust-cancel").click();
  await assert.rejects(connecting, /not approved/);
  assert.equal(harness.calls.length, 1);
});

test("mismatched host challenges and a second key change fail closed", async () => {
  const mismatch = createHarness(async () => { throw `SSH_HOST_TRUST_REQUIRED:${JSON.stringify({ ...CHALLENGE, host: "other.invalid" })}`; });
  await assert.rejects(mismatch.run<Promise<void>>("connectVerifiedSshSession(session, arguments_)"), /did not match/);
  assert.equal(mismatch.document.body!.children.length, 0);
  const changed = createHarness(async ({ command }) => { if (command === "connect_ssh") throw UNTRUSTED_ERROR; });
  const connecting = changed.run<Promise<void>>("connectVerifiedSshSession(session, arguments_)");
  await changed.dialogShown;
  await changed.overlay.querySelector(".ssh-host-trust-accept").click();
  await assert.rejects(connecting, /changed during verification/);
  assert.equal(changed.calls.filter(call => call.command === "trust_ssh_host").length, 1);
});

test("directory reporting avoids retaining typed terminal input", () => {
  const harness = createHarness();
  Object.assign(harness.session, { hasDirectoryReporting: true, terminalInput: "previous", canTrackTerminalInput: false });
  harness.run("trackTerminalDirectoryChange(session, 'typed input')");
  assert.equal(harness.run("session.terminalInput"), "");
  assert.equal(harness.run("session.canTrackTerminalInput"), true);
});
