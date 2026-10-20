import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const APPLICATION_SOURCE = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const HTML_SOURCE = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const SUDO_PASSWORD_MAX_BYTES = 255;

class ElementMock {
  value = "";
  checked = false;
  disabled = false;
  textContent = "";
  placeholder = "";
  isConnected = true;
  hiddenClasses = new Set<string>();
  classList = {
    add: (name: string) => this.hiddenClasses.add(name),
    remove: (name: string) => this.hiddenClasses.delete(name),
    contains: (name: string) => this.hiddenClasses.has(name),
    toggle: (name: string, state: boolean) => state ? this.hiddenClasses.add(name) : this.hiddenClasses.delete(name)
  };
  listeners = new Map<string, (event: Record<string, unknown>) => unknown>();
  focusCount = 0;
  focus() { this.focusCount += 1; }
  addEventListener(name: string, handler: (event: Record<string, unknown>) => unknown) { this.listeners.set(name, handler); }
  querySelectorAll() { return [] as ElementMock[]; }
  getClientRects() { return [1]; }
  reset() {}
}

function createHarness(invokeOverride?: (command: string, args: Record<string, unknown>) => Promise<unknown>) {
  const elements = new Map<string, ElementMock>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new ElementMock());
    return elements.get(id)!;
  };
  const initialProfile = {
    id: "saved-profile", name: "Development", host: "dev.example", port: 22, username: "developer",
    key_path: "id_ed25519", passphrase: null, password: null, use_password: false, namespace: null,
    sudo_shortcut_enabled: false, has_sudo_password: false
  };
  let backendProfiles: Record<string, unknown>[] = [initialProfile];
  let hasSecret = false;
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const notifications: string[] = [];
  const timers: (() => void)[] = [];
  const trigger = new ElementMock();
  const context = createContext({
    TextEncoder,
    document: {
      activeElement: trigger,
      querySelectorAll: () => [], getElementsByName: () => [], getElementById: element,
      querySelector: (selector: string) => {
        const radio = element(selector);
        if (selector.includes(":checked")) radio.value = "key";
        return radio;
      }
    },
    HTMLElement: ElementMock,
    window: {
      __TAURI__: { core: { invoke: async (command: string, args: Record<string, unknown> = {}) => {
        calls.push({ command, args: JSON.parse(JSON.stringify(args)) });
        if (invokeOverride) return await invokeOverride(command, args);
        if (command === "save_connections") backendProfiles = args.connections as Record<string, unknown>[];
        if (command === "save_sudo_password") hasSecret = true;
        if (command === "delete_sudo_password") hasSecret = false;
        if (command === "load_connections") return backendProfiles.map(profile => ({ ...profile, has_sudo_password: hasSecret }));
        return null;
      } }, event: { listen() {} } },
      addEventListener() {},
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
      clearTimeout() {}
    },
    console: { log() { throw new Error("Secret logging is forbidden."); }, error() { throw new Error("Secret logging is forbidden."); } }
  });
  runInContext(APPLICATION_SOURCE, context);
  Object.assign(context, {
    initialProfile,
    loadDefaultKeyForInput() {}, initProfileList() {},
    showNotification: (message: string) => notifications.push(message)
  });
  runInContext("savedProfiles = [initialProfile]", context);
  element("profile-modal").classList.add("hidden");
  const run = (source: string) => runInContext(source, context);
  run("showProfileModal(initialProfile)");
  return { element, elements, calls, notifications, context, initialProfile, trigger, timers, run };
}

test("profile form presents separate opt-in sudo credentials without login-password reuse", () => {
  assert.match(HTML_SOURCE, /id="prof-sudo-shortcut"/);
  assert.match(HTML_SOURCE, /id="prof-sudo-password" autocomplete="new-password"/);
  const harness = createHarness();
  harness.element("prof-password").value = "ssh-login-secret";
  assert.equal(harness.element("prof-sudo-password").value, "");
  assert.equal(harness.element("prof-sudo-shortcut").checked, false);
  assert.equal(harness.element("prof-delete-sudo-password-label").classList.contains("hidden"), true);
});

test("editing a saved password keeps the field blank and shows preservation status", () => {
  const harness = createHarness();
  harness.initialProfile.has_sudo_password = true;
  harness.initialProfile.sudo_shortcut_enabled = true;
  harness.run("showProfileModal(initialProfile)");
  assert.equal(harness.element("prof-sudo-password").value, "");
  assert.equal(harness.element("prof-sudo-shortcut").checked, true);
  assert.match(harness.element("prof-sudo-password-status").textContent, /Leave this field blank/);
  assert.equal(harness.element("prof-sudo-password").placeholder, "Leave blank to keep saved password");
});

test("enabled shortcut requires a matching saved credential or a new password", async () => {
  const harness = createHarness();
  harness.element("prof-sudo-shortcut").checked = true;
  assert.equal(await harness.run("saveProfileFromForm()"), false);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.element("profile-save-error").classList.contains("hidden"), false);
  assert.equal(harness.element("prof-sudo-password").focusCount, 1);
});

for (const [name, controlCharacter] of [["tab", "\t"], ["Escape", "\x1b"], ["Ctrl+C", "\x03"], ["DEL", "\x7f"]]) {
  test(`sudo password containing ${name} is rejected before profile or secret persistence`, async () => {
    const harness = createHarness();
    harness.element("prof-sudo-shortcut").checked = true;
    harness.element("prof-sudo-password").value = `secret${controlCharacter}suffix`;
    assert.equal(await harness.run("saveProfileFromForm()"), false);
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.element("prof-sudo-password").value, "");
    assert.match(harness.element("profile-save-error").textContent, /cannot contain control characters/);
    assert.equal(harness.element("profile-save-error").textContent.includes("suffix"), false);
  });
}

test("sudo validation rejects every C0 control character and DEL", async () => {
  const harness = createHarness();
  for (const codePoint of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    harness.element("prof-sudo-password").value = `secret${String.fromCharCode(codePoint)}suffix`;
    assert.equal(await harness.run("saveProfileFromForm()"), false);
  }
  assert.equal(harness.calls.length, 0);
});

test("empty sudo password stays absent for a disabled shortcut", async () => {
  const harness = createHarness();
  harness.element("prof-sudo-password").value = "";
  assert.equal(await harness.run("saveProfileFromForm()"), true);
  assert.equal(harness.calls.some(call => call.command === "save_sudo_password"), false);
});

for (const [name, password] of [
  ["ASCII", "a".repeat(SUDO_PASSWORD_MAX_BYTES)],
  ["Unicode", "é".repeat(127) + "a"],
  ["emoji", "😀".repeat(63) + "abc"]
]) {
  test(`sudo password at the 255-byte limit accepts ${name}`, async () => {
    const harness = createHarness();
    harness.element("prof-sudo-shortcut").checked = true;
    harness.element("prof-sudo-password").value = password;
    assert.equal(new TextEncoder().encode(password).length, SUDO_PASSWORD_MAX_BYTES);
    assert.equal(await harness.run("saveProfileFromForm()"), true);
    assert.equal(harness.calls.filter(call => call.command === "save_sudo_password").length, 1);
    assert.equal(harness.element("prof-sudo-password").value, "");
  });
}

for (const [name, password] of [["ASCII", "a".repeat(SUDO_PASSWORD_MAX_BYTES + 1)], ["Unicode", "é".repeat(128)], ["emoji", "😀".repeat(64)]]) {
  test(`sudo password above the byte limit rejects ${name} before persistence`, async () => {
    const harness = createHarness();
    harness.element("prof-sudo-shortcut").checked = true;
    harness.element("prof-sudo-password").value = password;
    assert.equal(await harness.run("saveProfileFromForm()"), false);
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.element("prof-sudo-password").value, "");
    assert.match(harness.element("profile-save-error").textContent, /255 UTF-8 bytes or fewer/);
  });
}

for (const [field, value] of [["prof-host", "other.example"], ["prof-port", "2222"], ["prof-username", "other-user"]]) {
  test(`changing ${field} requires re-entering the password before enabling`, async () => {
    const harness = createHarness();
    harness.initialProfile.has_sudo_password = true;
    harness.initialProfile.sudo_shortcut_enabled = true;
    harness.run("showProfileModal(initialProfile)");
    harness.element(field).value = value;
    harness.run("updateProfileSudoFields()");
    assert.match(harness.element("prof-sudo-password-status").textContent, /Enter the sudo password again/);
    assert.equal(await harness.run("saveProfileFromForm()"), false);
    assert.equal(harness.calls.length, 0);
  });
}

test("new password is saved after a disabled profile then enabled and reloaded", async () => {
  const harness = createHarness();
  harness.element("prof-sudo-shortcut").checked = true;
  harness.element("prof-sudo-password").value = "sudo-secret";
  assert.equal(await harness.run("saveProfileFromForm()"), true);
  assert.deepEqual(harness.calls.map(call => call.command), ["save_connections", "save_sudo_password", "save_connections", "load_connections"]);
  const firstProfiles = harness.calls[0].args.connections as Record<string, unknown>[];
  const finalProfiles = harness.calls[2].args.connections as Record<string, unknown>[];
  assert.equal(firstProfiles[0].sudo_shortcut_enabled, false);
  assert.equal(finalProfiles[0].sudo_shortcut_enabled, true);
  assert.equal(JSON.stringify(firstProfiles).includes("sudo-secret"), false);
  assert.deepEqual(harness.calls[1].args, { profileId: "saved-profile", password: "sudo-secret" });
  assert.equal(harness.element("prof-sudo-password").value, "");
  assert.equal(harness.run("savedProfiles[0].has_sudo_password"), true);
  assert.match(harness.notifications[0], /Reconnect/);
});

test("unchanged existing password is preserved without calling secret APIs", async () => {
  const harness = createHarness();
  harness.initialProfile.has_sudo_password = true;
  harness.initialProfile.sudo_shortcut_enabled = true;
  harness.run("showProfileModal(initialProfile)");
  assert.equal(await harness.run("saveProfileFromForm()"), true);
  assert.deepEqual(harness.calls.map(call => call.command), ["save_connections", "load_connections"]);
});

test("explicit removal disables the shortcut and clears replacement text", async () => {
  const harness = createHarness();
  harness.initialProfile.has_sudo_password = true;
  harness.initialProfile.sudo_shortcut_enabled = true;
  harness.run("showProfileModal(initialProfile)");
  harness.element("prof-sudo-password").value = "replacement-secret";
  harness.element("prof-delete-sudo-password").checked = true;
  harness.run("updateProfileSudoFields()");
  assert.equal(harness.element("prof-sudo-password").value, "");
  assert.equal(harness.element("prof-sudo-password").disabled, true);
  assert.equal(harness.element("prof-sudo-shortcut").checked, false);
  assert.equal(await harness.run("saveProfileFromForm()"), true);
  assert.deepEqual(harness.calls.map(call => call.command), ["save_connections", "delete_sudo_password", "load_connections"]);
});

test("identity change while disabled deletes the secret bound to the old server", async () => {
  const harness = createHarness();
  harness.initialProfile.has_sudo_password = true;
  harness.run("showProfileModal(initialProfile)");
  harness.element("prof-host").value = "other.example";
  assert.equal(await harness.run("saveProfileFromForm()"), true);
  assert.deepEqual(harness.calls.map(call => call.command), ["save_connections", "delete_sudo_password", "load_connections"]);
});

test("failure leaves savedProfiles unchanged and clears secrets without displaying backend details", async () => {
  const harness = createHarness(async command => {
    if (command === "save_sudo_password") throw new Error("sensitive-password");
    return null;
  });
  harness.element("prof-name").value = "Changed name";
  harness.element("prof-sudo-shortcut").checked = true;
  harness.element("prof-sudo-password").value = "sensitive-password";
  assert.equal(await harness.run("saveProfileFromForm()"), false);
  assert.equal(harness.run("savedProfiles[0].name"), "Development");
  assert.equal(harness.element("prof-sudo-password").value, "");
  assert.equal(harness.element("profile-save-error").textContent.includes("sensitive-password"), false);
  assert.equal(harness.element("btn-save-profile").disabled, false);
  assert.equal(harness.element("profile-modal").classList.contains("hidden"), false);
});

test("pending save blocks duplicate submission and reopening the credential form", async () => {
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  const harness = createHarness(async command => {
    if (command === "save_connections") await pending;
    if (command === "load_connections") return [harness.initialProfile];
    return null;
  });
  const first = harness.run("saveProfileFromForm()");
  assert.equal(await harness.run("saveProfileFromForm()"), false);
  harness.element("prof-name").value = "Current edits";
  harness.run("showProfileModal(null)");
  assert.equal(harness.element("prof-name").value, "Current edits");
  complete();
  assert.equal(await first, true);
  assert.equal(harness.calls.filter(call => call.command === "save_connections").length, 1);
});

test("cancel clears all credential fields and restores the dialog trigger focus", () => {
  const harness = createHarness();
  harness.element("prof-sudo-password").value = "sudo-secret";
  harness.element("prof-password").value = "ssh-secret";
  harness.element("prof-passphrase").value = "key-secret";
  harness.run("hideProfileModal()");
  for (const field of ["prof-sudo-password", "prof-password", "prof-passphrase"]) assert.equal(harness.element(field).value, "");
  assert.equal(harness.element("profile-modal").classList.contains("hidden"), true);
  assert.equal(harness.trigger.focusCount, 1);
});

test("new profile has an empty id and does not inherit opt-in or credentials", () => {
  const harness = createHarness();
  harness.run("hideProfileModal(); showProfileModal(null)");
  assert.equal(harness.element("prof-id").value, "");
  assert.equal(harness.element("prof-sudo-shortcut").checked, false);
  assert.equal(harness.element("prof-sudo-password").value, "");
  assert.equal(harness.run("getProfileSudoIdentity({host: 'host', port: 22, username: 'user'})"), '["host",22,"user"]');
});

test("initModal routes submits and Escape through secret-clearing form helpers", async () => {
  const harness = createHarness();
  harness.run("initModal()");
  assert.equal(harness.element("prof-sudo-password").listeners.has("input"), true);
  assert.equal(harness.element("prof-delete-sudo-password").listeners.has("change"), true);
  harness.element("prof-sudo-password").value = "cancel-secret";
  let prevented = false;
  harness.element("profile-modal").listeners.get("keydown")!({ key: "Escape", preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(harness.element("prof-sudo-password").value, "");
});

test("profile identity comparison keeps empty values and full-length hostnames distinct", () => {
  const harness = createHarness();
  assert.equal(harness.run("getProfileSudoIdentity({host: '', port: null, username: ''})"), '["",null,""]');
  assert.throws(() => harness.run("getProfileSudoIdentity(null)"), /host/);
  const hostname = "a".repeat(253);
  harness.context.hostname = hostname;
  assert.equal(harness.run("getProfileSudoIdentity({host: hostname, port: 65535, username: 'user'})"), JSON.stringify([hostname, 65535, "user"]));
});

test("active sessions are disabled after config save even if a later secret operation fails", async () => {
  const harness = createHarness(async command => {
    if (command === "save_sudo_password") throw new Error("Secret save failed.");
    return null;
  });
  harness.run("let toolbarRefreshCount = 0; updateSessionToolbar = () => { toolbarRefreshCount += 1 }; activeSessions.session = {kind: 'ssh', container: {}, connectionProfile: {id: 'saved-profile', sudo_shortcut_enabled: true, has_sudo_password: true}}");
  harness.element("prof-sudo-shortcut").checked = true;
  harness.element("prof-sudo-password").value = "replacement-secret";
  assert.equal(await harness.run("saveProfileFromForm()"), false);
  assert.equal(harness.run("activeSessions.session.connectionProfile.sudo_shortcut_enabled"), false);
  assert.equal(harness.run("activeSessions.session.sudoPromptReady"), false);
  assert.equal(harness.run("toolbarRefreshCount"), 1);
});

test("focus trap skips hidden controls and wraps both directions", () => {
  const harness = createHarness();
  harness.run("initModal()");
  const first = harness.element("btn-close-modal");
  const hidden = harness.element("prof-delete-sudo-password");
  hidden.getClientRects = () => [];
  const last = harness.element("btn-save-profile");
  harness.element("profile-modal").querySelectorAll = () => [first, hidden, last];
  const keydown = harness.element("profile-modal").listeners.get("keydown")!;
  const document = harness.context.document as { activeElement: ElementMock };
  document.activeElement = last;
  let prevented = false;
  keydown({ key: "Tab", shiftKey: false, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(first.focusCount, 1);
  document.activeElement = first;
  keydown({ key: "Tab", shiftKey: true, preventDefault() {} });
  assert.equal(last.focusCount, 1);
  assert.equal(hidden.focusCount, 0);
});
