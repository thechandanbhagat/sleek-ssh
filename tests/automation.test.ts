import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { parseHTML } from "linkedom";
import { initAutomation } from "../src/automation.ts";

const MAX_PROMPT_CHARACTERS = 16_000;
const MAX_OUTPUT_CHARACTERS = 200_000;
const TARGET = Object.freeze({ sessionId: "ssh-transport-1", label: "Production · deploy@example.test:22" });
const PROVIDERS = [
  { id: "claude", name: "Claude Code", available: true, executable: "C:\\agents\\claude.exe" },
  { id: "codex", name: "Codex", available: true, executable: "C:\\agents\\codex.exe" },
];
type Invocation = { command: string; arguments_?: Record<string, unknown> };
type InvokeHandler = (invocation: Invocation) => Promise<unknown>;
type SshTarget = { sessionId: string; label: string; contextKey?: string };
type ConversationStorage = NonNullable<Parameters<typeof initAutomation>[0]["storage"]>;
const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_CONVERSATION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const LOCAL_CHAT_LISTING = {
  sessions: [{ id: CONVERSATION_ID, title: "Investigate nginx", project_path: "/srv/customer-api", updated_at: Date.UTC(2026, 9, 19) }],
  warnings: [],
  truncated: false,
};

function createStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function contextStorageKey(target: SshTarget, provider = "claude") {
  return "sleekssh_automation_conversation:" + JSON.stringify([target.contextKey ?? target.sessionId, provider]);
}

class Control {
  hidden = false;
  disabled = false;
  value = "";
  private plainText = "";
  private renderedBody: HTMLElement | null = null;
  className = "";
  scrollTop = 0;
  scrollHeight = 0;
  focusCount = 0;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: Control[] = [];
  get textContent(): string {
    return this.renderedBody?.textContent ?? (this.children.length ? this.children.map(child => child.textContent).join("") : this.plainText);
  }
  set textContent(value: string) { this.plainText = value; this.renderedBody = null; this.children = []; }
  get innerHTML(): string { return this.renderedBody?.innerHTML ?? ""; }
  set innerHTML(value: string) { this.renderedBody = parseHTML(`<html><body>${value}</body></html>`).document.body; this.plainText = ""; this.children = []; }
  listeners = new Map<string, Set<(event: Event) => unknown>>();
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  replaceChildren(...children: Control[]) { this.children = children; this.renderedBody = null; this.plainText = ""; }
  contains(node: Node): boolean { return Boolean(this.renderedBody?.contains(node)) || this.children.some(child => child.contains(node)); }
  querySelector(selector: string): Element | null { return this.renderedBody?.querySelector(selector) ?? this.children.map(child => child.querySelector(selector)).find(Boolean) ?? null; }
  addEventListener(name: string, listener: (event: Event) => unknown) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: (event: Event) => unknown) { this.listeners.get(name)?.delete(listener); }
  focus() { this.focusCount += 1; }
  async dispatch(name: string, event = new Event(name, { cancelable: true })) {
    await Promise.all([...this.listeners.get(name) ?? []].map(listener => listener(event)));
  }
}

function nextTurn() {
  return new Promise<void>(resolve => setImmediate(resolve));
}

async function createHarness(configuration: { invoke?: InvokeHandler; target?: SshTarget | null; listenError?: string; storage?: ConversationStorage; missingControl?: string } = {}) {
  const controls = new Map<string, Control>();
  const control = (id: string) => {
    if (!controls.has(id)) controls.set(id, new Control());
    return controls.get(id)!;
  };
  control("automation-panel").hidden = true;
  control("automation-provider").value = "claude";
  const calls: Invocation[] = [];
  let selectedTarget: SshTarget | null = configuration.target === undefined ? { ...TARGET } : configuration.target;
  let eventListener: ((event: { payload: unknown }) => void) | null = null;
  let listenerDisposed = false;
  let layoutChanges = 0;
  let runSequence = 0;
  const panel = initAutomation({
    document: { getElementById: (id: string) => configuration.missingControl === id ? null : control(id), createElement: () => new Control() } as unknown as Document,
    getSelectedTarget: () => selectedTarget,
    createRunId: () => `run-${++runSequence}`,
    storage: configuration.storage ?? null,
    onLayoutChange: () => { layoutChanges += 1; },
    async invoke(command, arguments_) {
      const invocation = { command, arguments_ };
      calls.push(invocation);
      if (configuration.invoke) return configuration.invoke(invocation);
      if (command === "list_automation_providers") return PROVIDERS;
      if (command === "list_local_agent_sessions") return LOCAL_CHAT_LISTING;
    },
    async listen(name, callback) {
      assert.equal(name, "ssh-automation-event");
      if (configuration.listenError) throw new Error(configuration.listenError);
      eventListener = callback;
      return () => { listenerDisposed = true; };
    },
  });
  await nextTurn();
  return {
    panel, calls, control,
    get listenerDisposed() { return listenerDisposed; },
    get layoutChanges() { return layoutChanges; },
    selectTarget(target: SshTarget | null) { selectedTarget = target; panel.refresh(); },
    emit(kind: string, message = "", additional: Record<string, unknown> = {}) {
      eventListener?.({ payload: { run_id: `run-${runSequence}`, session_id: TARGET.sessionId, kind, message, ...additional } });
    },
    async task(prompt = "Inspect nginx status") {
      control("automation-prompt").value = prompt;
      await control("automation-prompt").dispatch("input");
    },
    async start() { await control("automation-form").dispatch("submit"); },
  };
}

test("automation opens accessibly, restores the trigger, and disposes its event handlers", async () => {
  const harness = await createHarness();
  await harness.control("btn-automation-toggle").dispatch("click");
  assert.equal(harness.control("automation-panel").hidden, false);
  assert.equal(harness.control("btn-automation-toggle").attributes.get("aria-expanded"), "true");
  assert.equal(harness.control("automation-prompt").focusCount, 1);
  await harness.control("automation-close").dispatch("click");
  assert.equal(harness.control("automation-panel").hidden, true);
  assert.equal(harness.control("btn-automation-toggle").focusCount, 1);
  assert.equal(harness.layoutChanges, 2);
  harness.panel.dispose();
  assert.equal(harness.listenerDisposed, true);
  await harness.control("btn-automation-toggle").dispatch("click");
  assert.equal(harness.layoutChanges, 2);
  harness.selectTarget(null);
  assert.equal(harness.control("automation-target").textContent, TARGET.label);
});

test("empty, whitespace, oversized, and missing-target tasks cannot start", async () => {
  const harness = await createHarness();
  for (const prompt of ["", " \n\t ", "x".repeat(MAX_PROMPT_CHARACTERS + 1)]) {
    await harness.task(prompt);
    assert.equal(harness.control("automation-start").disabled, true);
    await harness.start();
  }
  await harness.task("x".repeat(MAX_PROMPT_CHARACTERS));
  assert.equal(harness.control("automation-start").disabled, false);
  harness.selectTarget(null);
  assert.equal(harness.control("automation-start").disabled, true);
  await harness.start();
  assert.equal(harness.calls.filter(call => call.command === "start_ssh_automation").length, 0);
});

for (const provider of ["claude", "codex"]) {
  test(`${provider} receives a trimmed task and the selected SSH transport`, async () => {
    const harness = await createHarness();
    harness.control("automation-provider").value = provider;
    await harness.control("automation-provider").dispatch("change");
    await harness.task("  inspect nginx  ");
    await harness.start();
    assert.deepEqual(harness.calls.find(call => call.command === "start_ssh_automation")?.arguments_, {
      runId: "run-1", sessionId: TARGET.sessionId, provider, prompt: "inspect nginx", resumeSessionId: null,
    });
    assert.equal(harness.control("automation-provider").disabled, true);
    assert.equal(harness.control("automation-stop").disabled, false);
    assert.equal(harness.control("automation-panel").dataset.running, "true");
    assert.match(harness.control("automation-output").textContent, /Task: inspect nginx/);
    await harness.start();
    assert.equal(harness.calls.filter(call => call.command === "start_ssh_automation").length, 1);
  });
}

test("running target is pinned across tab changes and ignores stale or cross-server events", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  harness.selectTarget({ sessionId: "another-server", label: "Other server" });
  assert.equal(harness.control("automation-target").textContent, `${TARGET.label} · Target locked for this run`);
  const previousOutput = harness.control("automation-output").textContent;
  harness.emit("output", "wrong server", { session_id: "another-server" });
  harness.emit("output", "old run", { run_id: "run-old" });
  harness.emit("completed", "old completion", { run_id: "run-old" });
  harness.emit("unsupported", "invalid event");
  harness.emit("approval", "invalid approval", { request_id: null, command: "true" });
  assert.equal(harness.control("automation-output").textContent, previousOutput);
  assert.equal(harness.control("automation-stop").disabled, false);
  harness.emit("output", "<img src=x onerror=alert(1)>");
  assert.match(harness.control("automation-output").textContent, /<img src=x onerror=alert\(1\)>/);
});

test("approval is explicit, scoped, queued, and never sent automatically", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  harness.emit("approval", "Review", { request_id: "approval-1", command: "systemctl status nginx" });
  harness.emit("approval", "Duplicate", { request_id: "approval-1", command: "systemctl status nginx" });
  harness.emit("approval", "Review", { request_id: "approval-2", command: "cat /etc/nginx/nginx.conf" });
  assert.equal(harness.control("automation-panel").hidden, false);
  assert.equal(harness.control("automation-command").textContent, "systemctl status nginx");
  assert.equal(harness.control("automation-approval-target").textContent, TARGET.label);
  assert.equal(harness.calls.filter(call => call.command === "respond_automation_approval").length, 0);
  await harness.control("automation-approve").dispatch("click");
  await nextTurn();
  assert.deepEqual(harness.calls.find(call => call.command === "respond_automation_approval")?.arguments_, {
    runId: "run-1", requestId: "approval-1", approved: true,
  });
  assert.equal(harness.control("automation-command").textContent, "cat /etc/nginx/nginx.conf");
  await harness.control("automation-deny").dispatch("click");
  await nextTurn();
  assert.deepEqual(harness.calls.filter(call => call.command === "respond_automation_approval").at(-1)?.arguments_, {
    runId: "run-1", requestId: "approval-2", approved: false,
  });
  assert.equal(harness.control("automation-approval").hidden, true);
});

test("failed command approval stays visible and can be retried", async () => {
  let attempts = 0;
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "respond_automation_approval" && attempts++ === 0) throw new Error("Approval expired");
  } });
  await harness.task();
  await harness.start();
  harness.emit("approval", "Review", { request_id: "approval-1", command: "hostname" });
  await harness.control("automation-approve").dispatch("click");
  await nextTurn();
  assert.equal(harness.control("automation-approval").hidden, false);
  assert.equal(harness.control("automation-approve").disabled, false);
  assert.match(harness.control("automation-status").textContent, /Approval expired/);
  await harness.control("automation-deny").dispatch("click");
  await nextTurn();
  assert.equal(harness.control("automation-approval").hidden, true);
});

test("expired approvals are removed so later commands remain actionable", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  harness.emit("approval", "Review", { request_id: "expired", command: "hostname" });
  harness.emit("approval", "Review", { request_id: "current", command: "pwd" });
  harness.emit("status", "Command approval expired; the command was not executed", { request_id: "expired" });
  assert.equal(harness.control("automation-command").textContent, "pwd");
  await harness.control("automation-approve").dispatch("click");
  await nextTurn();
  assert.deepEqual(harness.calls.find(call => call.command === "respond_automation_approval")?.arguments_, {
    runId: "run-1", requestId: "current", approved: true,
  });
});

test("Stop targets the pinned run, blocks approvals, and waits for cancellation", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  harness.emit("approval", "Review", { request_id: "approval-1", command: "hostname" });
  harness.selectTarget(null);
  await harness.control("automation-stop").dispatch("click");
  assert.deepEqual(harness.calls.find(call => call.command === "stop_ssh_automation")?.arguments_, { runId: "run-1" });
  assert.equal(harness.control("automation-stop").disabled, true);
  assert.equal(harness.control("automation-approve").disabled, true);
  await harness.control("automation-approve").dispatch("click");
  assert.equal(harness.calls.filter(call => call.command === "respond_automation_approval").length, 0);
  harness.emit("cancelled", "Automation stopped.");
  assert.equal(harness.control("automation-approval").hidden, true);
  assert.equal(harness.control("automation-provider").disabled, false);
  assert.equal(harness.control("automation-start").disabled, true);
  assert.equal(harness.control("automation-status").textContent, "Automation stopped.");
});

test("failed Stop permits retry without unlocking a running agent", async () => {
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "stop_ssh_automation") throw new Error("Transport busy");
  } });
  await harness.task();
  await harness.start();
  await harness.control("automation-stop").dispatch("click");
  assert.equal(harness.control("automation-stop").disabled, false);
  assert.equal(harness.control("automation-start").disabled, true);
  assert.match(harness.control("automation-status").textContent, /Transport busy/);
});

for (const kind of ["completed", "failed", "cancelled"]) {
  test(`${kind} unlocks the form and prevents late output from changing the transcript`, async () => {
    const harness = await createHarness();
    await harness.task();
    await harness.start();
    harness.emit("command", "Executing", { command: "hostname" });
    assert.match(harness.control("automation-output").textContent, /\$ hostname/);
    harness.emit(kind, `Task ${kind}.`);
    assert.equal(harness.control("automation-start").disabled, false);
    assert.equal(harness.control("automation-panel").dataset.running, "false");
    assert.equal(harness.control("automation-status").dataset.error, String(kind === "failed"));
    const transcript = harness.control("automation-output").textContent;
    harness.emit("output", "late output");
    assert.equal(harness.control("automation-output").textContent, transcript);
  });
}

test("agent startup errors are visible and permit another task", async () => {
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "start_ssh_automation") throw new Error("Run claude auth login first");
  } });
  await harness.task();
  await harness.start();
  assert.equal(harness.control("automation-start").disabled, false);
  assert.equal(harness.control("automation-stop").disabled, true);
  assert.match(harness.control("automation-status").textContent, /Run claude auth login first/);
});

test("provider detection selects the installed CLI and guides missing-provider recovery", async () => {
  let installed = false;
  const harness = await createHarness({ invoke: async () => PROVIDERS.map(provider => ({
    ...provider, available: provider.id === "codex" && installed,
  })) });
  await harness.task();
  assert.equal(harness.control("automation-start").disabled, true);
  assert.match(harness.control("automation-provider-help").textContent, /Could not find Claude Code on this machine.*Install it locally/);
  installed = true;
  await harness.control("automation-refresh").dispatch("click");
  assert.equal(harness.control("automation-provider").value, "codex");
  assert.equal(harness.control("automation-start").disabled, false);
  assert.equal(harness.control("automation-provider-help").textContent, "Runs Codex on this machine: C:\\agents\\codex.exe");
});

for (const response of [null, [], [PROVIDERS[0]], [PROVIDERS[1]], [PROVIDERS[0], PROVIDERS[0]], [...PROVIDERS, PROVIDERS[0]], [{ id: "other", name: "Other", available: true }]]) {
  test(`invalid provider detection ${JSON.stringify(response)} fails closed`, async () => {
    const harness = await createHarness({ invoke: async () => response });
    await harness.task();
    assert.equal(harness.control("automation-start").disabled, true);
    assert.match(harness.control("automation-status").textContent, /Could not detect local agents/);
    assert.match(harness.control("automation-provider-help").textContent, /Could not check local agents on this machine.*Refresh/);
    assert.doesNotMatch(harness.control("automation-provider-help").textContent, /Install/);
    assert.equal(harness.control("automation-provider-help").dataset.error, "true");
  });
}

test("provider detection distinguishes loading from an unavailable CLI", async () => {
  const detection = Promise.withResolvers<unknown>();
  const harness = await createHarness({ invoke: async () => detection.promise });
  await harness.task();
  assert.equal(harness.control("automation-provider-help").textContent, "Checking local agents on this machine…");
  assert.equal(harness.control("automation-start").disabled, true);
  assert.equal(harness.control("automation-refresh").disabled, true);
  detection.resolve(PROVIDERS.map(provider => ({ ...provider, available: false, executable: null })));
  await nextTurn();
  assert.match(harness.control("automation-provider-help").textContent, /Could not find Claude Code on this machine/);
  assert.equal(harness.control("automation-provider-help").dataset.error, "false");
});

test("detected local executable paths render as literal text", async () => {
  const executable = 'C:\\agents\\<script>alert("local")<\\script>\\codex.exe';
  const harness = await createHarness({ invoke: async () => PROVIDERS.map(provider => ({ ...provider, executable })) });
  harness.control("automation-provider").value = "codex";
  await harness.control("automation-provider").dispatch("change");
  assert.equal(harness.control("automation-provider-help").textContent, `Runs Codex on this machine: ${executable}`);
});

for (const executable of [undefined, null]) {
  test(`available provider remains usable with ${executable} executable metadata`, async () => {
    const harness = await createHarness({ invoke: async () => PROVIDERS.map(provider => ({ ...provider, executable })) });
    await harness.task();
    assert.equal(harness.control("automation-start").disabled, false);
    assert.equal(harness.control("automation-provider-help").textContent, "Runs your configured Claude Code CLI on this machine.");
  });
}

for (const executable of ["", " \t ", 42, {}]) {
  test(`invalid executable metadata ${JSON.stringify(executable)} fails explicitly`, async () => {
    const harness = await createHarness({ invoke: async () => PROVIDERS.map(provider => ({ ...provider, executable })) });
    await harness.task();
    assert.equal(harness.control("automation-start").disabled, true);
    assert.match(harness.control("automation-status").textContent, /invalid executable path/);
    assert.doesNotMatch(harness.control("automation-provider-help").textContent, /Install/);
  });
}

test("listener startup failures prevent runs and explain recovery", async () => {
  const harness = await createHarness({ listenError: "Event channel unavailable" });
  await harness.task();
  assert.equal(harness.control("automation-start").disabled, true);
  assert.match(harness.control("automation-status").textContent, /Event channel unavailable.*Restart SleekSSH/);
});

test("provider detection recovers its error state after a successful refresh", async () => {
  let failed = true;
  const harness = await createHarness({ invoke: async () => {
    if (failed) throw new Error("PATH unavailable");
    return PROVIDERS;
  } });
  assert.match(harness.control("automation-status").textContent, /PATH unavailable/);
  assert.match(harness.control("automation-provider-help").textContent, /Could not check local agents on this machine.*Refresh/);
  assert.doesNotMatch(harness.control("automation-provider-help").textContent, /Install/);
  failed = false;
  await harness.control("automation-refresh").dispatch("click");
  await harness.task();
  assert.equal(harness.control("automation-status").dataset.error, "false");
  assert.equal(harness.control("automation-start").disabled, false);
  assert.equal(harness.control("automation-provider-help").dataset.error, "false");
  assert.equal(harness.control("automation-provider-help").textContent, "Runs Claude Code on this machine: C:\\agents\\claude.exe");
});

test("refresh clears stale provider availability and recovers from an incomplete listing", async () => {
  let response: unknown = PROVIDERS;
  const harness = await createHarness({ invoke: async () => response });
  await harness.task();
  assert.equal(harness.control("automation-start").disabled, false);
  response = [PROVIDERS[0]];
  await harness.control("automation-refresh").dispatch("click");
  assert.equal(harness.control("automation-start").disabled, true);
  assert.match(harness.control("automation-provider-help").textContent, /Could not check local agents on this machine/);
  assert.doesNotMatch(harness.control("automation-provider-help").textContent, /C:\\agents|Install/);
  response = PROVIDERS;
  await harness.control("automation-refresh").dispatch("click");
  assert.equal(harness.control("automation-start").disabled, false);
  assert.equal(harness.control("automation-provider-help").dataset.error, "false");
  assert.equal(harness.control("automation-status").dataset.error, "false");
});

test("output is bounded while retaining its newest text", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  harness.emit("output", "x".repeat(MAX_OUTPUT_CHARACTERS));
  harness.emit("output", "newest output");
  const transcript = harness.control("automation-output").textContent;
  assert.equal(transcript.length, MAX_OUTPUT_CHARACTERS);
  assert.match(transcript, /^\[Earlier output trimmed\]/);
  assert.match(transcript, /newest output$/);
});

test("agent output renders Markdown across streamed messages", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  harness.emit("output", "## Server report\n\n- **Healthy**\n\n```sh\nsystemctl ");
  harness.emit("output", "status nginx\n```\n\n| Service | State |\n| --- | --- |\n| nginx | active |\n");
  const output = harness.control("automation-output");
  assert.equal(output.querySelector("h2")?.textContent, "Server report");
  assert.equal(output.querySelector("li strong")?.textContent, "Healthy");
  assert.equal(output.querySelector("pre code")?.textContent, "systemctl status nginx\n");
  assert.equal(output.querySelector("td")?.textContent, "nginx");
  assert.equal(output.children.filter(child => child.className === "automation-output-markdown").length, 1);
});

test("SSH output, task text, commands, and approvals stay literal beside agent Markdown", async () => {
  const harness = await createHarness();
  await harness.task("Inspect **literal task**");
  await harness.start();
  harness.emit("output", "## Agent report\n");
  harness.emit("command", "Running", { command: "printf '**literal command**'" });
  harness.emit("command_output", "# literal server output\n**literal value**\n<img src=x onerror=alert(1)>\nExit status: 0\n");
  harness.emit("output", "**Finished**\n");
  const output = harness.control("automation-output");
  assert.match(output.textContent, /Inspect \*\*literal task\*\*/);
  assert.match(output.textContent, /\$ printf '\*\*literal command\*\*'/);
  assert.match(output.textContent, /# literal server output\n\*\*literal value\*\*/);
  assert.equal(output.querySelector("img"), null);
  assert.equal(output.children.filter(child => child.className === "automation-output-markdown").length, 2);
  assert.equal(output.children.filter(child => child.className === "automation-output-log").length, 2);
  assert.equal(output.querySelector("strong")?.textContent, "Finished");
});

test("safe Markdown links open through the native opener without navigating the app", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  harness.emit("output", "[**Documentation**](https://example.test/status?x=1&y=2)");
  const output = harness.control("automation-output");
  const click = new Event("click", { cancelable: true });
  Object.defineProperty(click, "target", { value: output.querySelector("a strong") });
  await output.dispatch("click", click);
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(harness.calls.find(call => call.command === "plugin:opener|open_url")?.arguments_, { url: "https://example.test/status?x=1&y=2" });
});

test("link opener errors remain visible while the agent continues", async () => {
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "plugin:opener|open_url") throw new Error("Browser unavailable");
  } });
  await harness.task();
  await harness.start();
  harness.emit("output", "[Documentation](https://example.test/)");
  const output = harness.control("automation-output");
  const click = new Event("click", { cancelable: true });
  Object.defineProperty(click, "target", { value: output.querySelector("a") });
  await output.dispatch("click", click);
  assert.match(harness.control("automation-status").textContent, /Could not open link:.*Browser unavailable/);
  assert.equal(harness.control("automation-stop").disabled, false);
  assert.equal(output.querySelector("a")?.textContent, "Documentation");
});

test("empty and stale remote output cannot change the rendered transcript", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  harness.emit("output", "**Current**");
  const output = harness.control("automation-output");
  const before = output.textContent;
  const beforeNodes = [...output.children];
  harness.emit("output", "");
  harness.emit("command_output", "", {});
  harness.emit("command_output", "old output", { session_id: "other-server" });
  assert.equal(output.textContent, before);
  assert.deepEqual(output.children, beforeNodes);
});

test("many short output blocks stay bounded and keep a single trim notice", async () => {
  const MAX_OUTPUT_BLOCKS = 200;
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  for (let index = 0; index < MAX_OUTPUT_BLOCKS + 4; index += 1) {
    harness.emit(index % 2 === 0 ? "output" : "command_output", `record-${index}\n`);
  }
  const output = harness.control("automation-output");
  assert.equal(output.children.length, MAX_OUTPUT_BLOCKS + 1);
  assert.equal(output.textContent.match(/\[Earlier output trimmed\]/g)?.length, 1);
  assert.doesNotMatch(output.textContent, /record-0\n/);
  assert.match(output.textContent, new RegExp(`record-${MAX_OUTPUT_BLOCKS + 3}\\n$`));
});

test("a new task clears rendered Markdown and the trim notice", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  harness.emit("output", "# Old report\n\n" + "x".repeat(MAX_OUTPUT_CHARACTERS));
  harness.emit("completed", "Done");
  await harness.task("A fresh task");
  await harness.start();
  const output = harness.control("automation-output");
  assert.equal(output.querySelector("h1"), null);
  assert.doesNotMatch(output.textContent, /Earlier output trimmed/);
  assert.match(output.textContent, /A fresh task/);
  assert.equal(output.children.length, 1);
});

test("missing automation controls fail explicitly", () => {
  assert.throws(() => initAutomation({
    document: { getElementById: () => null } as unknown as Document,
    invoke: async () => undefined, listen: async () => () => undefined,
    getSelectedTarget: () => null, onLayoutChange() {},
  }), /SSH automation control is missing/);
});

test("main integration rejects local, disconnected, and reconnecting sessions", () => {
  const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  const initSource = source.slice(source.indexOf("function initAutomationPanel()"), source.indexOf("// --- PANEL LAYOUT ---"));
  let getSelectedTarget: (() => unknown) | undefined;
  const context = createContext({
    window: { SleekSshAutomation: { initAutomation(options: { getSelectedTarget: () => unknown }) { getSelectedTarget = options.getSelectedTarget; } } },
    invoke() {}, listen() {},
  });
  runInContext(`let automationPanel; let activeTabId = 'tab'; let activeSessions = {}; ${initSource}; initAutomationPanel();`, context);
  assert.equal(getSelectedTarget!(), null);
  for (const update of [
    { kind: "local" }, { connectionStatus: "disconnected" }, { connectionStatus: "reconnecting" },
    { isClosed: true }, { isClosing: true }, { isConnecting: true }, { connectionId: null },
  ]) {
    context.sessionUpdate = update;
    runInContext(`activeSessions.tab = { kind: 'ssh', connectionId: 'transport', connectionStatus: 'connected', name: 'Test', host: 'server', connectionProfile: { username: 'test', port: 22 }, ...sessionUpdate };`, context);
    assert.equal(getSelectedTarget!(), null);
  }
  runInContext(`activeSessions.tab = { kind: 'ssh', connectionId: 'transport', connectionStatus: 'connected', name: 'Test', host: 'server', connectionProfile: { username: 'test', port: 22 } };`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(getSelectedTarget!())), { sessionId: "transport", label: "Test · test@server:22", contextKey: '["","test","server",22]' });
});

test("an existing local conversation ID is passed explicitly and pinned during a run", async () => {
  const harness = await createHarness();
  await harness.task();
  harness.control("automation-conversation").value = CONVERSATION_ID;
  await harness.control("automation-conversation").dispatch("input");
  harness.panel.refresh();
  assert.equal(harness.control("automation-conversation").value, CONVERSATION_ID);
  await harness.start();
  assert.equal(harness.calls.find(call => call.command === "start_ssh_automation")?.arguments_?.resumeSessionId, CONVERSATION_ID);
  assert.equal(harness.control("automation-conversation").disabled, true);
  assert.equal(harness.control("automation-new-chat").disabled, true);
  await harness.control("automation-new-chat").dispatch("click");
  assert.equal(harness.control("automation-conversation").value, CONVERSATION_ID);
});

test("session events remember the CLI conversation for follow-up tasks and reconnects", async () => {
  const storage = createStorage();
  const target = { ...TARGET, contextKey: '["profile-1","deploy","example.test",22]' };
  const harness = await createHarness({ storage, target });
  await harness.task();
  await harness.start();
  harness.emit("session", CONVERSATION_ID);
  assert.equal(storage.values.get(contextStorageKey(target)), JSON.stringify(CONVERSATION_ID));
  assert.match(harness.control("automation-output").textContent, new RegExp(`Conversation ID: ${CONVERSATION_ID}`));
  harness.emit("completed", "Done");
  harness.selectTarget({ ...target, sessionId: "reconnected-transport" });
  assert.equal(harness.control("automation-conversation").value, CONVERSATION_ID);
  await harness.start();
  assert.equal(harness.calls.filter(call => call.command === "start_ssh_automation").at(-1)?.arguments_?.resumeSessionId, CONVERSATION_ID);
  const reopened = await createHarness({ storage, target: { ...target, sessionId: "new-app-transport" } });
  assert.equal(reopened.control("automation-conversation").value, CONVERSATION_ID);
});

test("conversation context and draft edits are isolated by provider and remote identity", async () => {
  const storage = createStorage();
  const otherTarget = { sessionId: "other-transport", label: "Other server", contextKey: "other-server-key" };
  storage.setItem(contextStorageKey(TARGET), JSON.stringify(CONVERSATION_ID));
  storage.setItem(contextStorageKey(TARGET, "codex"), JSON.stringify(OTHER_CONVERSATION_ID));
  const harness = await createHarness({ storage });
  assert.equal(harness.control("automation-conversation").value, CONVERSATION_ID);
  harness.control("automation-provider").value = "codex";
  await harness.control("automation-provider").dispatch("change");
  assert.equal(harness.control("automation-conversation").value, OTHER_CONVERSATION_ID);
  harness.selectTarget(otherTarget);
  assert.equal(harness.control("automation-conversation").value, "");
  harness.control("automation-conversation").value = "draft-in-progress";
  await harness.control("automation-conversation").dispatch("input");
  harness.panel.refresh();
  assert.equal(harness.control("automation-conversation").value, "draft-in-progress");
  harness.selectTarget(TARGET);
  assert.equal(harness.control("automation-conversation").value, OTHER_CONVERSATION_ID);
  harness.selectTarget(otherTarget);
  assert.equal(harness.control("automation-conversation").value, "draft-in-progress");
});

test("New chat removes only the selected mapping and preserves CLI history", async () => {
  const storage = createStorage();
  storage.setItem(contextStorageKey(TARGET), JSON.stringify(CONVERSATION_ID));
  storage.setItem(contextStorageKey(TARGET, "codex"), JSON.stringify(OTHER_CONVERSATION_ID));
  const harness = await createHarness({ storage });
  await harness.task();
  const previousCalls = harness.calls.length;
  await harness.control("automation-new-chat").dispatch("click");
  assert.equal(harness.control("automation-conversation").value, "");
  assert.equal(storage.values.has(contextStorageKey(TARGET)), false);
  assert.equal(storage.values.get(contextStorageKey(TARGET, "codex")), JSON.stringify(OTHER_CONVERSATION_ID));
  assert.equal(harness.calls.length, previousCalls);
  await harness.start();
  assert.equal(harness.calls.find(call => call.command === "start_ssh_automation")?.arguments_?.resumeSessionId, null);
});

test("stale and cross-server conversation events cannot replace the pinned chat", async () => {
  const storage = createStorage();
  const harness = await createHarness({ storage });
  await harness.task();
  await harness.start();
  harness.emit("session", CONVERSATION_ID, { run_id: "old-run" });
  harness.emit("session", CONVERSATION_ID, { session_id: "other-server" });
  assert.equal(storage.values.size, 0);
  assert.equal(harness.control("automation-conversation").value, "");
  harness.selectTarget({ sessionId: "other-server", label: "Other server" });
  harness.emit("session", CONVERSATION_ID);
  harness.emit("completed", "Done");
  assert.equal(storage.values.get(contextStorageKey(TARGET)), JSON.stringify(CONVERSATION_ID));
  assert.equal(harness.control("automation-conversation").value, "");
});

test("invalid conversation IDs block submission and invalid native IDs are not saved", async () => {
  const storage = createStorage();
  const harness = await createHarness({ storage });
  await harness.task();
  for (const value of ["last", "../../history", "123", "x".repeat(36), CONVERSATION_ID + "x"]) {
    harness.control("automation-conversation").value = value;
    await harness.control("automation-conversation").dispatch("input");
    assert.equal(harness.control("automation-start").disabled, true);
    assert.equal(harness.control("automation-conversation").attributes.get("aria-invalid"), "true");
    await harness.start();
  }
  assert.equal(harness.calls.filter(call => call.command === "start_ssh_automation").length, 0);
  await harness.control("automation-new-chat").dispatch("click");
  await harness.start();
  harness.emit("session", "invalid");
  assert.equal(storage.values.size, 0);
  assert.match(harness.control("automation-status").textContent, /invalid conversation ID/);
});

for (const saved of ["{", "null", JSON.stringify("invalid")]) {
  test(`corrupt chat storage ${saved} is isolated and recoverable with New chat`, async () => {
    const storage = createStorage();
    storage.setItem(contextStorageKey(TARGET), saved);
    storage.setItem(contextStorageKey(TARGET, "codex"), JSON.stringify(OTHER_CONVERSATION_ID));
    const harness = await createHarness({ storage });
    await harness.task();
    assert.match(harness.control("automation-conversation-help").textContent, /Could not load this chat context/);
    assert.equal(harness.control("automation-start").disabled, true);
    await harness.control("automation-new-chat").dispatch("click");
    assert.equal(harness.control("automation-start").disabled, false);
    assert.equal(storage.values.get(contextStorageKey(TARGET, "codex")), JSON.stringify(OTHER_CONVERSATION_ID));
  });
}

test("chat storage write failures leave the returned ID visible with recovery guidance", async () => {
  const harness = await createHarness({ storage: {
    getItem: () => null, removeItem() {}, setItem() { throw new Error("Storage full"); },
  } });
  await harness.task();
  await harness.start();
  harness.emit("session", CONVERSATION_ID);
  assert.equal(harness.control("automation-conversation").value, CONVERSATION_ID);
  assert.match(harness.control("automation-conversation-help").textContent, /Storage full.*Copy the conversation ID/);
});

test("local chat metadata loads lazily on open and dropdown selection resumes without pasting", async () => {
  const harness = await createHarness();
  assert.equal(harness.calls.some(call => call.command === "list_local_agent_sessions"), false);
  await harness.control("btn-automation-toggle").dispatch("click");
  await nextTurn();
  assert.deepEqual(harness.calls.find(call => call.command === "list_local_agent_sessions")?.arguments_, { provider: "claude" });
  const choices = harness.control("automation-chat").children;
  assert.equal(choices[0].textContent, "New chat");
  assert.match(choices[1].textContent, /Investigate nginx.*\/srv\/customer-api.*2026/);
  harness.control("automation-chat").value = CONVERSATION_ID;
  await harness.control("automation-chat").dispatch("change");
  assert.equal(harness.control("automation-conversation").value, CONVERSATION_ID);
  await harness.task();
  await harness.start();
  assert.equal(harness.calls.find(call => call.command === "start_ssh_automation")?.arguments_?.resumeSessionId, CONVERSATION_ID);
  assert.equal(harness.control("automation-chat").disabled, true);
  assert.equal(harness.control("automation-refresh-chats").disabled, true);
});

test("provider changes reject stale local chat responses and use the provider cache", async () => {
  const requests = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  const harness = await createHarness({ invoke: async ({ command, arguments_ }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "list_local_agent_sessions") {
      const request = Promise.withResolvers<unknown>();
      requests.set(String(arguments_?.provider), request);
      return request.promise;
    }
  } });
  await harness.control("btn-automation-toggle").dispatch("click");
  harness.control("automation-provider").value = "codex";
  await harness.control("automation-provider").dispatch("change");
  requests.get("codex")!.resolve({ ...LOCAL_CHAT_LISTING, sessions: [{ ...LOCAL_CHAT_LISTING.sessions[0], id: OTHER_CONVERSATION_ID, title: "Codex investigation" }] });
  await nextTurn();
  requests.get("claude")!.resolve(LOCAL_CHAT_LISTING);
  await nextTurn();
  assert.equal(harness.control("automation-chat").children.some(option => option.value === CONVERSATION_ID), false);
  assert.equal(harness.control("automation-chat").children.some(option => option.value === OTHER_CONVERSATION_ID), true);
  await harness.control("automation-close").dispatch("click");
  await harness.control("btn-automation-toggle").dispatch("click");
  assert.equal(harness.calls.filter(call => call.command === "list_local_agent_sessions").length, 2);
});

test("saved, manual, and returned chat IDs remain selected when missing from local metadata", async () => {
  const storage = createStorage();
  storage.setItem(contextStorageKey(TARGET), JSON.stringify(OTHER_CONVERSATION_ID));
  const harness = await createHarness({ storage });
  await harness.control("btn-automation-toggle").dispatch("click");
  await nextTurn();
  assert.equal(harness.control("automation-chat").value, OTHER_CONVERSATION_ID);
  assert.match(harness.control("automation-chat").children.find(option => option.value === OTHER_CONVERSATION_ID)!.textContent, /Selected chat \(not in list\)/);
  await harness.task();
  await harness.start();
  harness.selectTarget({ sessionId: "other", label: "Other server" });
  harness.emit("session", "99999999-8888-7777-6666-555555555555");
  assert.equal(harness.control("automation-chat").value, "99999999-8888-7777-6666-555555555555");
  assert.equal(harness.control("automation-chat").disabled, true);
  harness.emit("completed", "Done");
  assert.equal(harness.control("automation-chat").value, "");
});

test("dropdown New chat clears only the selected server/provider mapping", async () => {
  const storage = createStorage();
  storage.setItem(contextStorageKey(TARGET), JSON.stringify(CONVERSATION_ID));
  storage.setItem(contextStorageKey(TARGET, "codex"), JSON.stringify(OTHER_CONVERSATION_ID));
  const harness = await createHarness({ storage });
  harness.control("automation-chat").value = "";
  await harness.control("automation-chat").dispatch("change");
  assert.equal(harness.control("automation-conversation").value, "");
  assert.equal(storage.values.has(contextStorageKey(TARGET)), false);
  assert.equal(storage.values.has(contextStorageKey(TARGET, "codex")), true);
  assert.equal(harness.calls.some(call => call.command === "list_local_agent_sessions"), false);
});

test("chat-list errors remain actionable without blocking New chat or manual IDs", async () => {
  let fail = true;
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "list_local_agent_sessions") {
      if (fail) throw new Error("Local history unavailable");
      return { sessions: [], warnings: [], truncated: false };
    }
  } });
  await harness.task();
  await harness.control("btn-automation-toggle").dispatch("click");
  await nextTurn();
  assert.match(harness.control("automation-chat-help").textContent, /Local history unavailable.*Refresh chats.*Advanced/);
  assert.equal(harness.control("automation-start").disabled, false);
  harness.control("automation-conversation").value = CONVERSATION_ID;
  await harness.control("automation-conversation").dispatch("input");
  assert.equal(harness.control("automation-start").disabled, false);
  fail = false;
  await harness.control("automation-refresh-chats").dispatch("click");
  await nextTurn();
  assert.match(harness.control("automation-chat-help").textContent, /No saved local chats found/);
  assert.equal(harness.control("automation-chat-help").dataset.error, "false");
  assert.equal(harness.control("automation-chat").value, CONVERSATION_ID);
});

test("refresh preserves the selected chat and renders bounded metadata as literal text", async () => {
  let refresh = false;
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "list_local_agent_sessions") return refresh ? {
      sessions: [{ id: CONVERSATION_ID, title: '<img src=x onerror=alert(1)> ' + "long ".repeat(30), project_path: "project/".repeat(30), updated_at: null }],
      warnings: ["<script>alert(1)</script>"], truncated: true,
    } : LOCAL_CHAT_LISTING;
  } });
  await harness.control("btn-automation-toggle").dispatch("click");
  await nextTurn();
  harness.control("automation-chat").value = CONVERSATION_ID;
  await harness.control("automation-chat").dispatch("change");
  refresh = true;
  await harness.control("automation-refresh-chats").dispatch("click");
  await nextTurn();
  assert.equal(harness.control("automation-chat").value, CONVERSATION_ID);
  const label = harness.control("automation-chat").children.find(option => option.value === CONVERSATION_ID)!.textContent;
  assert.match(label, /^<img src=x onerror=alert\(1\)>/);
  assert(label.length < 120);
  assert.match(harness.control("automation-chat-help").textContent, /Recent chats shown.*<script>alert\(1\)<\/script>/);
  assert.equal(harness.calls.filter(call => call.command === "list_local_agent_sessions").length, 2);
});

test("malformed local chat metadata fails visibly while preserving task availability", async () => {
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "list_local_agent_sessions") return { ...LOCAL_CHAT_LISTING, sessions: [{ id: "bad-id" }] };
  } });
  await harness.task();
  await harness.control("btn-automation-toggle").dispatch("click");
  await nextTurn();
  assert.equal(harness.control("automation-chat-help").dataset.error, "true");
  assert.equal(harness.control("automation-start").disabled, false);
});

const SUDO_REQUEST = Object.freeze({ request_id: "sudo-request-1", command: "sudo systemctl restart nginx" });
const SUDO_REQUEST_MESSAGE = "Sudo requested this server's saved password.";
const SUDO_ALLOWED_MESSAGE = "Saved sudo password allowed for this run.";

test("sudo consent opens and focuses a prompt for the pinned server without auto approval", async () => {
  const harness = await createHarness();
  harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
  assert.equal(harness.control("automation-sudo-allow").focusCount, 0);
  await harness.task();
  await harness.start();
  harness.selectTarget({ sessionId: "another-server", label: "Other server" });
  harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
  assert.equal(harness.control("automation-panel").hidden, false);
  assert.equal(harness.control("automation-sudo-approval").hidden, false);
  assert.equal(harness.control("automation-sudo-target").textContent, TARGET.label);
  assert.equal(harness.control("automation-sudo-command").textContent, SUDO_REQUEST.command);
  assert.equal(harness.control("automation-sudo-message").textContent, SUDO_REQUEST_MESSAGE);
  assert.equal(harness.control("automation-sudo-allow").focusCount, 1);
  assert.equal(harness.control("btn-automation-toggle").textContent, "Automation · review");
  assert.equal(harness.calls.some(call => call.command === "respond_automation_sudo_consent"), false);
});

test("sudo requests receive keyboard focus when the panel was already open and when reopened", async () => {
  const harness = await createHarness();
  await harness.control("btn-automation-toggle").dispatch("click");
  await harness.task();
  await harness.start();
  harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
  assert.equal(harness.control("automation-sudo-allow").focusCount, 1);
  await harness.control("automation-close").dispatch("click");
  await harness.control("btn-automation-toggle").dispatch("click");
  assert.equal(harness.control("automation-sudo-allow").focusCount, 2);
});

test("generic and unsolicited sudo statuses cannot grant consent or remove its prompt", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
  harness.emit("status", SUDO_ALLOWED_MESSAGE, { request_id: SUDO_REQUEST.request_id });
  harness.emit("sudo_status", SUDO_ALLOWED_MESSAGE, { request_id: SUDO_REQUEST.request_id });
  assert.equal(harness.control("automation-sudo-approval").hidden, false);
  assert.equal(harness.control("automation-sudo-status").hidden, true);
  assert.equal(harness.calls.some(call => call.command === "respond_automation_sudo_consent"), false);
});

test("duplicate and parallel sudo requests keep the first pending command and do not steal focus", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
  harness.emit("sudo_approval", "Duplicate", { ...SUDO_REQUEST, command: "replacement" });
  harness.emit("sudo_approval", "Other", { request_id: "other-sudo", command: "sudo pwd" });
  assert.equal(harness.control("automation-sudo-command").textContent, SUDO_REQUEST.command);
  assert.equal(harness.control("automation-sudo-allow").focusCount, 1);
  await harness.control("automation-sudo-allow").dispatch("click");
  await nextTurn();
  assert.deepEqual(harness.calls.find(call => call.command === "respond_automation_sudo_consent")?.arguments_, {
    runId: "run-1", requestId: SUDO_REQUEST.request_id, approved: true,
  });
  harness.emit("sudo_approval", "Replayed", SUDO_REQUEST);
  harness.emit("sudo_approval", "Unexpected second consent", { request_id: "new-sudo", command: "sudo pwd" });
  assert.equal(harness.control("automation-sudo-approval").hidden, true);
  assert.equal(harness.control("automation-sudo-status").textContent, SUDO_ALLOWED_MESSAGE);
});

for (const fields of [
  { request_id: undefined }, { request_id: null }, { request_id: "" }, { request_id: " \t " }, { request_id: 1 },
  { command: undefined }, { command: null }, { command: "" }, { command: " \n " }, { command: {} },
  { message: "" }, { message: " \t " }, { message: null },
]) {
  test(`malformed sudo consent ${JSON.stringify(fields)} is ignored`, async () => {
    const harness = await createHarness();
    await harness.task();
    await harness.start();
    harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, { ...SUDO_REQUEST, ...fields });
    assert.equal(harness.control("automation-sudo-approval").hidden, true);
    assert.equal(harness.control("automation-sudo-allow").focusCount, 0);
    await harness.control("automation-sudo-allow").dispatch("click");
    assert.equal(harness.calls.some(call => call.command === "respond_automation_sudo_consent"), false);
  });
}

test("stale, cross-server, and unmatched sudo events cannot replace or resolve active consent", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  for (const fields of [{ run_id: "old-run" }, { session_id: "other-server" }]) {
    harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, { ...SUDO_REQUEST, ...fields });
  }
  assert.equal(harness.control("automation-sudo-approval").hidden, true);
  harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
  for (const kind of ["sudo_status", "sudo_error"]) {
    harness.emit(kind, "Wrong request", { request_id: "unknown" });
    harness.emit(kind, "Old run", { request_id: SUDO_REQUEST.request_id, run_id: "old-run" });
    harness.emit(kind, "Wrong server", { request_id: SUDO_REQUEST.request_id, session_id: "other-server" });
    harness.emit(kind, "Malformed request", { request_id: null });
  }
  assert.equal(harness.control("automation-sudo-approval").hidden, false);
  assert.equal(harness.control("automation-sudo-status").hidden, true);
});

test("sudo consent and ordinary command decisions remain independent while either RPC is pending", async () => {
  const sudoResponse = Promise.withResolvers<unknown>();
  const commandResponse = Promise.withResolvers<unknown>();
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "respond_automation_sudo_consent") return sudoResponse.promise;
    if (command === "respond_automation_approval") return commandResponse.promise;
  } });
  await harness.task();
  await harness.start();
  harness.emit("approval", "Review command", { request_id: "command-request", command: "hostname" });
  harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
  await harness.control("automation-sudo-allow").dispatch("click");
  assert.equal(harness.control("automation-sudo-allow").disabled, true);
  assert.equal(harness.control("automation-sudo-deny").disabled, true);
  assert.equal(harness.control("automation-approve").disabled, false);
  await harness.control("automation-sudo-allow").dispatch("click");
  await harness.control("automation-sudo-deny").dispatch("click");
  await harness.control("automation-approve").dispatch("click");
  assert.equal(harness.calls.filter(call => call.command === "respond_automation_sudo_consent").length, 1);
  assert.deepEqual(harness.calls.find(call => call.command === "respond_automation_approval")?.arguments_, {
    runId: "run-1", requestId: "command-request", approved: true,
  });
  sudoResponse.resolve(undefined);
  await nextTurn();
  assert.equal(harness.control("automation-sudo-approval").hidden, true);
  assert.equal(harness.control("automation-approval").hidden, false);
  assert.equal(harness.control("automation-approve").disabled, true);
  commandResponse.resolve(undefined);
  await nextTurn();
  harness.emit("status", "Agent is continuing");
  harness.emit("output", "# Results\n\nReport");
  assert.equal(harness.control("automation-sudo-status").textContent, SUDO_ALLOWED_MESSAGE);
  assert.equal(harness.control("automation-sudo-status").hidden, false);
  assert.equal(harness.control("automation-approval").hidden, true);
});

test("an explicit sudo success can arrive before its Allow RPC resolves", async () => {
  const response = Promise.withResolvers<unknown>();
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "respond_automation_sudo_consent") return response.promise;
  } });
  await harness.task();
  await harness.start();
  harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
  await harness.control("automation-sudo-allow").dispatch("click");
  harness.emit("sudo_status", "Consent accepted", { request_id: "other" });
  assert.equal(harness.control("automation-sudo-approval").hidden, false);
  harness.emit("sudo_status", "Consent accepted", { request_id: SUDO_REQUEST.request_id });
  assert.equal(harness.control("automation-sudo-approval").hidden, true);
  assert.equal(harness.control("automation-sudo-status").textContent, SUDO_ALLOWED_MESSAGE);
  response.resolve(undefined);
  await nextTurn();
  assert.equal(harness.control("automation-sudo-status").textContent, SUDO_ALLOWED_MESSAGE);
});

test("a native accepted decision remains resolved if its later RPC transport response fails", async () => {
  const response = Promise.withResolvers<unknown>();
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "respond_automation_sudo_consent") return response.promise;
  } });
  await harness.task();
  await harness.start();
  harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
  await harness.control("automation-sudo-allow").dispatch("click");
  harness.emit("sudo_status", "Consent accepted", { request_id: SUDO_REQUEST.request_id });
  response.reject(new Error("Transport response lost"));
  await nextTurn();
  assert.equal(harness.control("automation-sudo-approval").hidden, true);
  assert.equal(harness.control("automation-sudo-status").textContent, SUDO_ALLOWED_MESSAGE);
  assert.equal(harness.control("automation-sudo-status").dataset.error, "false");
});

test("denying sudo consent neither approves commands nor stores a grant for later tasks", async () => {
  const storage = createStorage();
  const harness = await createHarness({ storage });
  await harness.task();
  await harness.start();
  harness.emit("approval", "Review", { request_id: "command-request", command: "sudo whoami" });
  harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
  await harness.control("automation-sudo-deny").dispatch("click");
  await nextTurn();
  assert.deepEqual(harness.calls.find(call => call.command === "respond_automation_sudo_consent")?.arguments_, {
    runId: "run-1", requestId: SUDO_REQUEST.request_id, approved: false,
  });
  assert.equal(harness.calls.some(call => call.command === "respond_automation_approval"), false);
  assert.equal(harness.control("automation-approval").hidden, false);
  harness.emit("sudo_status", SUDO_ALLOWED_MESSAGE, { request_id: SUDO_REQUEST.request_id });
  assert.doesNotMatch(harness.control("automation-sudo-status").textContent, /allowed/);
  harness.emit("sudo_approval", "Repeated", SUDO_REQUEST);
  assert.equal(harness.control("automation-sudo-approval").hidden, true);
  assert.equal(storage.values.size, 0);
  harness.emit("completed", "Done");
  await harness.start();
  harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
  assert.equal(harness.control("automation-sudo-approval").hidden, false);
  assert.equal(harness.control("automation-sudo-status").hidden, true);
});

test("sudo permission RPC failures preserve the prompt for an explicit retry", async () => {
  let attempts = 0;
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "respond_automation_sudo_consent" && attempts++ === 0) throw new Error("Connection interrupted");
  } });
  await harness.task();
  await harness.start();
  harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
  await harness.control("automation-sudo-allow").dispatch("click");
  await nextTurn();
  assert.equal(harness.control("automation-sudo-approval").hidden, false);
  assert.equal(harness.control("automation-sudo-allow").disabled, false);
  assert.match(harness.control("automation-sudo-status").textContent, /Connection interrupted.*Try Allow for this run or Deny again/);
  assert.equal(harness.control("automation-sudo-status").dataset.error, "true");
  await harness.control("automation-sudo-deny").dispatch("click");
  await nextTurn();
  assert.equal(harness.control("automation-sudo-approval").hidden, true);
  assert.equal(harness.control("automation-sudo-status").dataset.error, "false");
  assert.equal(attempts, 2);
});

for (const withRequestId of [true, false]) {
  test(`native sudo failure ${withRequestId ? "with" : "without"} request ID cancels pending consent and late RPC success`, async () => {
    const response = Promise.withResolvers<unknown>();
    const harness = await createHarness({ invoke: async ({ command }) => {
      if (command === "list_automation_providers") return PROVIDERS;
      if (command === "respond_automation_sudo_consent") return response.promise;
    } });
    await harness.task();
    await harness.start();
    harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
    await harness.control("automation-sudo-allow").dispatch("click");
    const message = "Saved sudo password was rejected. Update the saved password and start a new run.";
    harness.emit("sudo_error", message, withRequestId ? { request_id: SUDO_REQUEST.request_id } : {});
    assert.equal(harness.control("automation-sudo-approval").hidden, true);
    response.resolve(undefined);
    await nextTurn();
    assert.equal(harness.control("automation-sudo-status").textContent, message);
    assert.equal(harness.control("automation-sudo-status").dataset.error, "true");
    harness.emit("sudo_approval", "Try again", { request_id: "new-sudo", command: "sudo pwd" });
    assert.equal(harness.control("automation-sudo-approval").hidden, true);
  });
}

test("credential errors revoke the allowed banner and missing credentials are actionable before any consent", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
  await harness.control("automation-sudo-allow").dispatch("click");
  await nextTurn();
  harness.emit("sudo_error", "Password rejected. Update the saved password and start a new run.");
  assert.match(harness.control("automation-sudo-status").textContent, /Password rejected/);
  assert.doesNotMatch(harness.control("automation-sudo-status").textContent, /allowed/);
  harness.emit("failed", "Sudo failed");
  await harness.start();
  harness.emit("sudo_error", "No saved sudo password. Edit this server's saved credentials, then start a new run.");
  assert.equal(harness.control("automation-sudo-approval").hidden, true);
  assert.match(harness.control("automation-sudo-status").textContent, /No saved sudo password.*saved credentials/);
});

test("Stop disables sudo controls and pending RPC success cannot display an allowed banner while stopping", async () => {
  const response = Promise.withResolvers<unknown>();
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "respond_automation_sudo_consent") return response.promise;
  } });
  await harness.task();
  await harness.start();
  harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
  await harness.control("automation-sudo-allow").dispatch("click");
  await harness.control("automation-stop").dispatch("click");
  harness.emit("sudo_status", SUDO_ALLOWED_MESSAGE, { request_id: SUDO_REQUEST.request_id });
  response.resolve(undefined);
  await nextTurn();
  assert.equal(harness.control("automation-sudo-allow").disabled, true);
  assert.equal(harness.control("automation-sudo-deny").disabled, true);
  assert.equal(harness.control("automation-sudo-status").hidden, true);
  await harness.control("automation-sudo-deny").dispatch("click");
  assert.equal(harness.calls.filter(call => call.command === "respond_automation_sudo_consent").length, 1);
  harness.emit("cancelled", "Stopped");
  assert.equal(harness.control("automation-sudo-approval").hidden, true);
});

for (const nativeFailure of [false, true]) {
  test(`a failed Stop reconciles ${nativeFailure ? "revoked" : "accepted"} consent without showing a grant while stopping`, async () => {
    const consentResponse = Promise.withResolvers<unknown>();
    const stopResponse = Promise.withResolvers<unknown>();
    const harness = await createHarness({ invoke: async ({ command }) => {
      if (command === "list_automation_providers") return PROVIDERS;
      if (command === "respond_automation_sudo_consent") return consentResponse.promise;
      if (command === "stop_ssh_automation") return stopResponse.promise;
    } });
    await harness.task();
    await harness.start();
    harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
    await harness.control("automation-sudo-allow").dispatch("click");
    const stopping = harness.control("automation-stop").dispatch("click");
    await nextTurn();
    harness.emit("sudo_status", "Consent accepted", { request_id: SUDO_REQUEST.request_id });
    if (nativeFailure) harness.emit("sudo_error", "Sudo permission revoked. Stop the run and try again.");
    consentResponse.resolve(undefined);
    await nextTurn();
    assert.equal(harness.control("automation-sudo-status").hidden, true);
    assert.match(harness.control("automation-status").textContent, /Stopping the local agent/);
    stopResponse.reject(new Error("Stop connection interrupted"));
    await stopping;
    assert.equal(harness.control("automation-sudo-status").hidden, false);
    assert.equal(harness.control("automation-sudo-approval").hidden, true);
    assert.equal(harness.control("automation-sudo-status").dataset.error, String(nativeFailure));
    assert.equal(harness.control("automation-sudo-status").textContent,
      nativeFailure ? "Sudo permission revoked. Stop the run and try again." : SUDO_ALLOWED_MESSAGE);
    assert.match(harness.control("automation-status").textContent, /Stop connection interrupted.*Try Stop again/);
    assert.equal(harness.calls.filter(call => call.command === "respond_automation_sudo_consent").length, 1);
  });
}

for (const kind of ["completed", "failed", "cancelled"]) {
  test(`${kind} clears sudo permission and an earlier run's late RPC cannot change new consent`, async () => {
    const response = Promise.withResolvers<unknown>();
    const harness = await createHarness({ invoke: async ({ command }) => {
      if (command === "list_automation_providers") return PROVIDERS;
      if (command === "respond_automation_sudo_consent") return response.promise;
    } });
    await harness.task();
    await harness.start();
    harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
    await harness.control("automation-sudo-allow").dispatch("click");
    harness.emit("sudo_status", "Allowed", { request_id: SUDO_REQUEST.request_id });
    harness.emit(kind, "Finished");
    assert.equal(harness.control("automation-sudo-status").hidden, true);
    assert.equal(harness.control("automation-sudo-status").textContent, "");
    await harness.start();
    harness.emit("sudo_approval", SUDO_REQUEST_MESSAGE, SUDO_REQUEST);
    harness.emit("sudo_status", "Stale success", { run_id: "run-1", request_id: SUDO_REQUEST.request_id });
    response.resolve(undefined);
    await nextTurn();
    assert.equal(harness.control("automation-sudo-approval").hidden, false);
    assert.equal(harness.control("automation-sudo-status").hidden, true);
  });
}

test("sudo details remain literal text and consent controls are present in the real page", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  const command = "sudo echo '<img src=x onerror=alert(1)>'\n" + "x".repeat(MAX_PROMPT_CHARACTERS);
  harness.emit("sudo_approval", "<script>alert(1)</script>", { ...SUDO_REQUEST, command });
  assert.equal(harness.control("automation-sudo-command").textContent, command);
  assert.equal(harness.control("automation-sudo-command").querySelector("img"), null);
  assert.equal(harness.control("automation-sudo-message").textContent, "<script>alert(1)</script>");
  const page = parseHTML(readFileSync(new URL("../src/index.html", import.meta.url), "utf8")).document;
  assert.equal(page.getElementById("automation-sudo-title")?.textContent, "Use saved sudo password for this run?");
  assert.equal(page.getElementById("automation-sudo-approval")?.getAttribute("aria-labelledby"), "automation-sudo-title");
  assert.equal(page.getElementById("automation-sudo-allow")?.getAttribute("type"), "button");
  assert.equal(page.getElementById("automation-sudo-deny")?.textContent, "Deny");
  assert.equal(page.getElementById("automation-sudo-approval")?.querySelector('input[type="password"]'), null);
});

for (const missingControl of ["automation-sudo-approval", "automation-sudo-allow", "automation-sudo-deny", "automation-sudo-status", "automation-sudo-command", "automation-sudo-target", "automation-sudo-message"]) {
  test(`missing ${missingControl} fails explicitly`, async () => {
    await assert.rejects(createHarness({ missingControl }), new RegExp(`SSH automation control is missing: ${missingControl}`));
  });
}
