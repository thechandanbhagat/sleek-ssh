import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { parseHTML } from "linkedom";
import { initAutomation } from "../src/automation.ts";
import { createTerminalGroups } from "../src/terminal-panes.ts";

const MAX_PROMPT_CHARACTERS = 16_000;
const MAX_OUTPUT_CHARACTERS = 200_000;
const MAX_OUTPUT_BLOCKS = 200;
const MAX_TRANSCRIPT_STORAGE_CHARACTERS = 2_000_000;
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

function transcriptStorageKey(target: SshTarget, provider: string, conversationId: string) {
  return "sleekssh_automation_transcript:" + JSON.stringify([target.contextKey ?? target.sessionId, provider, conversationId]);
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

async function createHarness(configuration: { invoke?: InvokeHandler; target?: SshTarget | null; getSelectedTarget?: () => SshTarget | null; listenError?: string; storage?: ConversationStorage; missingControl?: string; onCommandExecuted?: Parameters<typeof initAutomation>[0]["onCommandExecuted"] } = {}) {
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
    getSelectedTarget: configuration.getSelectedTarget ?? (() => selectedTarget),
    createRunId: () => `run-${++runSequence}`,
    storage: configuration.storage ?? null,
    onLayoutChange: () => { layoutChanges += 1; },
    onCommandExecuted: configuration.onCommandExecuted,
    async invoke(command, arguments_) {
      const invocation = { command, arguments_ };
      calls.push(invocation);
      if (configuration.invoke) return configuration.invoke(invocation);
      if (command === "list_automation_providers") return PROVIDERS;
      if (command === "list_local_agent_sessions") return LOCAL_CHAT_LISTING;
      if (command === "get_local_agent_history") return { messages: [], truncated: false };
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
    assert.equal(harness.control("automation-prompt").value, prompt);
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
    assert.equal(harness.control("automation-prompt").value, "");
    assert.equal(harness.control("automation-provider").disabled, true);
    assert.equal(harness.control("automation-stop").disabled, false);
    assert.equal(harness.control("automation-panel").dataset.running, "true");
    assert.match(harness.control("automation-output").textContent, /Task: inspect nginx/);
    await harness.start();
    assert.equal(harness.calls.filter(call => call.command === "start_ssh_automation").length, 1);
  });
}

for (const provider of ["claude", "codex"]) {
  for (const rejected of [false, true]) {
    test(`${provider} clears the submitted draft immediately and ${rejected ? "restores it on startup failure" : "keeps it clear on startup success"}`, async () => {
      const startup = Promise.withResolvers<unknown>();
      const harness = await createHarness({ invoke: async ({ command }) => {
        if (command === "list_automation_providers") return PROVIDERS;
        if (command === "start_ssh_automation") return startup.promise;
      } });
      harness.control("automation-provider").value = provider;
      await harness.control("automation-provider").dispatch("change");
      const draft = "  Inspect nginx\nthen explain the result.\n  ";
      await harness.task(draft);
      const started = harness.start();
      assert.equal(harness.control("automation-prompt").value, "");
      assert.equal(harness.control("automation-prompt").disabled, false);
      assert.equal(harness.calls.find(call => call.command === "start_ssh_automation")?.arguments_?.prompt, draft.trim());
      assert.match(harness.control("automation-output").textContent, /Inspect nginx\nthen explain the result\./);
      if (rejected) startup.reject(new Error("CLI unavailable"));
      else startup.resolve(undefined);
      await started;
      assert.equal(harness.control("automation-prompt").value, rejected ? draft : "");
      assert.equal(harness.control("automation-start").disabled, !rejected);
      if (rejected) assert.match(harness.control("automation-status").textContent, /CLI unavailable/);
    });
  }
}

test("a maximum-length submitted task clears the composer and remains in the transcript", async () => {
  const harness = await createHarness();
  const draft = "x".repeat(MAX_PROMPT_CHARACTERS);
  await harness.task(draft);
  await harness.start();
  assert.equal(harness.control("automation-prompt").value, "");
  assert.equal(harness.calls.find(call => call.command === "start_ssh_automation")?.arguments_?.prompt, draft);
  assert.equal(harness.control("automation-output").textContent, `Task: ${draft}`);
});

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
    assert.equal(harness.control("automation-prompt").value, "");
    assert.equal(harness.control("automation-prompt").disabled, false);
    assert.equal(harness.control("automation-start").disabled, true);
    assert.equal(harness.control("automation-panel").dataset.running, "false");
    assert.equal(harness.control("automation-status").dataset.error, String(kind === "failed"));
    const transcript = harness.control("automation-output").textContent;
    harness.emit("output", "late output");
    assert.equal(harness.control("automation-output").textContent, transcript);
    await harness.task("Inspect the next service");
    assert.equal(harness.control("automation-start").disabled, false);
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
  assert.equal(output.children.filter(child => child.className === "automation-output-task").length, 1);
  assert.equal(output.children.filter(child => child.className === "automation-output-command").length, 1);
  assert.equal(output.children.filter(child => child.className === "automation-output-log").length, 0);
  assert.equal(output.querySelector("strong")?.textContent, "Finished");
});

test("command cards show running, success, and failure from the reported exit status", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  const output = harness.control("automation-output");
  const cards = () => output.children.filter(child => child.className === "automation-output-command");
  harness.emit("command", "Running approved remote command", { command: "systemctl status nginx" });
  assert.equal(cards()[0].dataset.state, "running");
  assert.equal(cards()[0].querySelector(".automation-command-label")?.textContent, "Running");
  assert.equal(cards()[0].attributes.get("open"), "");
  harness.emit("command_output", "active (running)\nExit status: 0\n");
  assert.equal(cards()[0].dataset.state, "ok");
  assert.equal(cards()[0].querySelector(".automation-command-label")?.textContent, "Ran");
  assert.equal(cards()[0].querySelector(".automation-command-output")?.textContent, "active (running)\nExit status: 0\n");
  harness.emit("command", "Running approved remote command", { command: "cat /etc/missing" });
  harness.emit("command_output", "cat: /etc/missing: No such file or directory\nExit status: 1\n");
  assert.equal(cards()[1].dataset.state, "failed");
  assert.equal(cards()[1].querySelector(".automation-command-label")?.textContent, "Failed · exit 1");
  harness.emit("command", "Running approved remote command", { command: "sleep 600" });
  harness.emit("cancelled", "Stopped by the user.");
  assert.equal(cards()[2].dataset.state, "idle");
  assert.equal(cards()[2].querySelector(".automation-command-label")?.textContent, "Command");
  assert.equal(cards()[2].querySelector(".automation-command-output"), null);
});

test("command output stays attached when its approval RPC resolves after command start", async () => {
  const response = Promise.withResolvers<unknown>();
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "respond_automation_approval") return response.promise;
  } });
  await harness.task();
  await harness.start();
  harness.emit("approval", "Review command", { request_id: "approval-1", command: "uptime" });
  await harness.control("automation-approve").dispatch("click");
  harness.emit("command", "Running", { command: "uptime" });
  response.resolve(undefined);
  await nextTurn();
  harness.emit("output", "**Waiting for uptime.**\n\n");
  harness.emit("command_output", "server up\n");
  harness.emit("output", "Still waiting for the exit status.\n");
  harness.emit("command_output", "<img src=x onerror=alert(1)>\nExit status: 0\n");
  const output = harness.control("automation-output");
  assert.deepEqual(output.children.map(child => child.className), [
    "automation-output-task", "automation-output-command", "automation-output-event", "automation-output-markdown",
  ]);
  const card = output.children.find(child => child.className === "automation-output-command")!;
  assert.equal(card.dataset.state, "ok");
  assert.equal(card.querySelector(".automation-command-output")?.textContent, "server up\n<img src=x onerror=alert(1)>\nExit status: 0\n");
  assert.equal(output.querySelector("img"), null);
  assert.equal(output.querySelector(".automation-event-text")?.textContent, "Approved");
  assert.match(output.children.at(-1)!.textContent, /Waiting for uptime\.[\s\S]*Still waiting for the exit status\./);
});

test("interleaved agent Markdown leaves only the latest command active and receives its exit state", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  const output = harness.control("automation-output");
  const cards = () => output.children.filter(child => child.className === "automation-output-command");
  harness.emit("command", "Running", { command: "uptime" });
  harness.emit("command_output", "up\nExit status: 0\n");
  harness.emit("command", "Running", { command: "cat /etc/missing" });
  harness.emit("output", "Checking the file now.\n");
  assert.equal(cards()[0].dataset.state, "ok");
  assert.equal(cards()[1].dataset.state, "running");
  harness.emit("command_output", "No such file\nExit status: 1\n");
  assert.equal(cards()[0].querySelector(".automation-command-output")?.textContent, "up\nExit status: 0\n");
  assert.equal(cards()[1].dataset.state, "failed");
  assert.equal(cards()[1].querySelector(".automation-command-output")?.textContent, "No such file\nExit status: 1\n");
  assert.deepEqual(output.children.map(child => child.className), [
    "automation-output-task", "automation-output-command", "automation-output-command", "automation-output-markdown",
  ]);
});

test("approval markers retain a running command until the run ends", async () => {
  const response = Promise.withResolvers<unknown>();
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "respond_automation_approval") return response.promise;
  } });
  await harness.task();
  await harness.start();
  const output = harness.control("automation-output");
  const card = () => output.children.find(child => child.className === "automation-output-command")!;
  harness.emit("approval", "Review command", { request_id: "approval-1", command: "sleep 1" });
  await harness.control("automation-approve").dispatch("click");
  harness.emit("command", "Running", { command: "sleep 1" });
  assert.equal(card().dataset.state, "running");
  response.resolve(undefined);
  await nextTurn();
  assert.equal(card().dataset.state, "running");
  harness.emit("output", "Waiting for the command.\n");
  assert.equal(card().dataset.state, "running");
  harness.emit("completed", "Done");
  assert.equal(card().dataset.state, "idle");
});

test("command output without a command card remains a literal plain log", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  const message = "**literal output** <img src=x onerror=alert(1)>\nExit status: 0\n";
  harness.emit("command_output", message);
  const output = harness.control("automation-output");
  const log = output.children.find(child => child.className === "automation-output-log");
  assert.equal(log?.textContent, message);
  assert.equal(output.querySelector("img"), null);
  assert.equal(output.children.some(child => child.className === "automation-output-command"), false);
});

test("approval decisions and run endings appear as single marker lines", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  harness.emit("approval", "Review", { request_id: "approval-1", command: "uptime" });
  await harness.control("automation-approve").dispatch("click");
  await nextTurn();
  harness.emit("approval", "Review", { request_id: "approval-2", command: "rm -rf /tmp/cache" });
  await harness.control("automation-deny").dispatch("click");
  await nextTurn();
  harness.emit("failed", "Agent exited with code 1.");
  const events = harness.control("automation-output").children.filter(child => child.className === "automation-output-event");
  assert.deepEqual(events.map(event => [event.dataset.tone, event.textContent]), [
    ["ok", "Approved uptime"],
    ["danger", "Denied rm -rf /tmp/cache"],
    ["danger", "Run failed. Agent exited with code 1."],
  ]);
});

test("Enter sends the task, while Shift+Enter and composing input preserve native editing", async () => {
    const harness = await createHarness();
    const keydown = (modifiers: { shiftKey?: boolean; isComposing?: boolean; altKey?: boolean } = {}) => {
      const event = new Event("keydown", { cancelable: true });
      Object.defineProperties(event, { key: { value: "Enter" }, shiftKey: { value: Boolean(modifiers.shiftKey) }, altKey: { value: Boolean(modifiers.altKey) }, isComposing: { value: Boolean(modifiers.isComposing) } });
      return event;
    };
    await harness.task("inspect nginx\nand explain the result");
    for (const modifiers of [{ shiftKey: true }, { isComposing: true }, { altKey: true }]) {
      const edit = keydown(modifiers);
      await harness.control("automation-prompt").dispatch("keydown", edit);
      assert.equal(edit.defaultPrevented, false);
      assert.equal(harness.calls.filter(call => call.command === "start_ssh_automation").length, 0);
      assert.equal(harness.control("automation-prompt").value, "inspect nginx\nand explain the result");
    }
    const submit = keydown();
    await harness.control("automation-prompt").dispatch("keydown", submit);
    assert.equal(submit.defaultPrevented, true);
    assert.equal(harness.calls.filter(call => call.command === "start_ssh_automation").length, 1);
    assert.equal(harness.control("automation-prompt").value, "");
    harness.panel.dispose();
});

for (const modifier of ["ctrlKey", "metaKey"]) {
  test(`${modifier}+Enter does not send a task when there is no run to steer`, async () => {
    const harness = await createHarness();
    await harness.task("Draft instruction");
    const event = new Event("keydown", { cancelable: true });
    Object.defineProperties(event, { key: { value: "Enter" }, [modifier]: { value: true } });
    await harness.control("automation-prompt").dispatch("keydown", event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(harness.calls.some(call => call.command === "start_ssh_automation" || call.command === "stop_ssh_automation"), false);
    assert.equal(harness.control("automation-prompt").value, "Draft instruction");
    harness.panel.dispose();
  });
}

test("routine composer status remains available to assistive technology while errors stay visible", async () => {
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "start_ssh_automation") throw new Error("CLI unavailable");
  } });
  assert.equal(harness.control("automation-status").className, "automation-status sr-only");
  await harness.task(); await harness.start();
  assert.equal(harness.control("automation-status").className, "automation-status");
  assert.match(harness.control("automation-status").textContent, /CLI unavailable/);
  harness.panel.dispose();
});

test("the status bar uses an accessible indeterminate bar while the agent runs", async () => {
  const harness = await createHarness();
  assert.equal(harness.control("btn-automation-toggle").textContent, "Agent idle");
  assert.equal(harness.control("btn-automation-toggle").dataset.state, "idle");
  await harness.task();
  await harness.start();
  const toggle = harness.control("btn-automation-toggle");
  assert.equal(toggle.textContent, "");
  assert.equal(toggle.attributes.get("aria-label"), "Agent running");
  assert.equal(toggle.attributes.get("title"), "Agent running");
  const progress = toggle.children[0];
  assert.equal(progress.attributes.get("role"), "progressbar");
  assert.equal(progress.attributes.get("aria-label"), "Agent running");
  assert.equal(progress.attributes.has("aria-valuenow"), false);
  harness.emit("output", "Still working");
  assert.equal(toggle.children[0], progress);
  assert.equal(harness.control("btn-automation-toggle").dataset.state, "running");
  harness.emit("approval", "Review", { request_id: "approval-1", command: "uptime" });
  assert.equal(harness.control("btn-automation-toggle").textContent, "Approval needed");
  assert.equal(toggle.children.length, 0);
  harness.emit("completed", "Done");
  assert.equal(harness.control("btn-automation-toggle").textContent, "Agent idle");
  assert.equal(toggle.attributes.get("aria-label"), "Agent idle");
  harness.panel.dispose();
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

test("explicit New chat clears rendered Markdown and the trim notice", async () => {
  const harness = await createHarness();
  await harness.task();
  await harness.start();
  harness.emit("output", "# Old report\n\n" + "x".repeat(MAX_OUTPUT_CHARACTERS));
  harness.emit("completed", "Done");
  await harness.control("automation-new-chat").dispatch("click");
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

function createMainTargetHarness() {
  const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  const initSource = source.slice(source.indexOf("function initAutomationPanel()"), source.indexOf("// --- PANEL LAYOUT ---"));
  const paneSelectionSource = source.slice(source.indexOf("function getActiveSession()"), source.indexOf("function activateSession("));
  const terminalGroups = createTerminalGroups();
  terminalGroups.add("tab");
  let getSelectedTarget: (() => SshTarget | null) | undefined;
  const context = createContext({
    window: { SleekSshAutomation: { initAutomationSessions(options: { getSelectedSessionKey: () => string | null; getTargetForSession: (key: string) => SshTarget | null }) {
      getSelectedTarget = () => { const key = options.getSelectedSessionKey(); return key ? options.getTargetForSession(key) : null; };
    } } },
    terminalGroups,
    invoke() {}, listen() {},
  });
  runInContext(`let automationPanel; let activeTabId = 'tab'; let activeSessions = {}; ${paneSelectionSource} ${initSource}; initAutomationPanel();`, context);
  return { context, terminalGroups, getSelectedTarget() { assert.ok(getSelectedTarget); return getSelectedTarget(); } };
}

test("main integration rejects local, disconnected, and reconnecting sessions", () => {
  const { context, getSelectedTarget } = createMainTargetHarness();
  assert.equal(getSelectedTarget(), null);
  for (const update of [
    { kind: "local" }, { connectionStatus: "disconnected" }, { connectionStatus: "reconnecting" },
    { isClosed: true }, { isClosing: true }, { isConnecting: true }, { connectionId: null },
  ]) {
    context.sessionUpdate = update;
    runInContext(`activeSessions.tab = { id: 'tab', kind: 'ssh', connectionId: 'transport', connectionStatus: 'connected', name: 'Test', host: 'server', connectionProfile: { username: 'test', port: 22 }, ...sessionUpdate };`, context);
    assert.equal(getSelectedTarget(), null);
  }
  runInContext(`activeSessions.tab = { id: 'tab', kind: 'ssh', connectionId: 'transport', connectionStatus: 'connected', name: 'Test', host: 'server', connectionProfile: { username: 'test', port: 22 } };`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(getSelectedTarget())), { sessionId: "transport", label: "Test · test@server:22", contextKey: '["","test","server",22]' });
});

test("new agent tasks bind the focused secondary SSH pane and retain that target after focus moves", async () => {
  const main = createMainTargetHarness();
  main.terminalGroups.add("secondary");
  main.terminalGroups.split("tab", "secondary", "right");
  runInContext(`activeSessions = {
    tab: { id: 'tab', kind: 'ssh', connectionId: 'first-transport', connectionStatus: 'connected', name: 'First', host: 'first.test', connectionProfile: { id: 'first', username: 'deploy', port: 22 } },
    secondary: { id: 'secondary', kind: 'ssh', connectionId: 'second-transport', connectionStatus: 'connected', name: 'Second', host: 'second.test', connectionProfile: { id: 'second', username: 'deploy', port: 22 } }
  };`, main.context);
  const harness = await createHarness({ getSelectedTarget: main.getSelectedTarget });
  await harness.task("Inspect the focused pane");
  await harness.start();
  assert.equal(harness.calls.find(call => call.command === "start_ssh_automation")?.arguments_?.sessionId, "second-transport");
  assert.equal(harness.control("automation-target").textContent, "Second · deploy@second.test:22 · Target locked for this run");

  main.terminalGroups.focus("tab");
  harness.panel.refresh();
  assert.equal(harness.control("automation-target").textContent, "Second · deploy@second.test:22 · Target locked for this run");
  harness.emit("completed", "Done", { session_id: "second-transport" });
  await harness.task("Inspect the newly focused pane");
  await harness.start();
  assert.deepEqual(harness.calls.filter(call => call.command === "start_ssh_automation").map(call => call.arguments_?.sessionId),
    ["second-transport", "first-transport"]);
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
  await harness.task("Continue the investigation after reconnecting");
  await harness.start();
  assert.equal(harness.calls.filter(call => call.command === "start_ssh_automation").at(-1)?.arguments_?.resumeSessionId, CONVERSATION_ID);
  const reopened = await createHarness({ storage, target: { ...target, sessionId: "new-app-transport" } });
  assert.equal(reopened.control("automation-conversation").value, CONVERSATION_ID);
});

test("follow-up tasks retain both turns and resume the same conversation", async () => {
  const harness = await createHarness({ storage: createStorage() });
  await harness.task("Investigate the first failure");
  await harness.start();
  harness.emit("session", CONVERSATION_ID);
  harness.emit("output", "The first failure is a missing configuration.\n");
  harness.emit("completed", "First investigation complete");
  await harness.task("Explain how to fix that configuration");
  await harness.start();
  harness.emit("session", CONVERSATION_ID);
  harness.emit("output", "Update the existing configuration.\n");
  harness.emit("completed", "Follow-up complete");
  const starts = harness.calls.filter(call => call.command === "start_ssh_automation");
  assert.equal(starts.length, 2);
  assert.equal(starts[0].arguments_?.resumeSessionId, null);
  assert.equal(starts[1].arguments_?.resumeSessionId, CONVERSATION_ID);
  const transcript = harness.control("automation-output").textContent;
  assert.match(transcript, /Investigate the first failure/);
  assert.match(transcript, /The first failure is a missing configuration/);
  assert.match(transcript, /Explain how to fix that configuration/);
  assert.match(transcript, /Update the existing configuration/);
});

test("saved transcripts restore after reopening and reconnecting to the same server", async () => {
  const storage = createStorage();
  const target = { ...TARGET, contextKey: "persistent-server-context" };
  const harness = await createHarness({ storage, target });
  await harness.task("Inspect the saved service");
  await harness.start();
  harness.emit("session", CONVERSATION_ID);
  harness.emit("command", "Inspect service", { command: "systemctl status nginx" });
  harness.emit("command_output", "active (running)\nExit status: 0\n");
  harness.emit("output", "## Saved result\n\nThe service is healthy.\n");
  harness.emit("completed", "Inspection complete");
  const transcript = harness.control("automation-output").textContent;
  harness.panel.dispose();
  const reopened = await createHarness({ storage, target: { ...target, sessionId: "new-transport" } });
  assert.equal(reopened.control("automation-conversation").value, CONVERSATION_ID);
  assert.equal(reopened.control("automation-output").textContent, transcript);
  assert.equal(reopened.control("automation-output").querySelector("h2")?.textContent, "Saved result");
  assert.equal(reopened.control("automation-output").children.find(block => block.className === "automation-output-command")?.dataset.state, "ok");
  reopened.selectTarget(null);
  assert.doesNotMatch(reopened.control("automation-output").textContent, /The service is healthy/);
  reopened.selectTarget({ ...target, sessionId: "reconnected-transport" });
  assert.equal(reopened.control("automation-output").textContent, transcript);
});

test("New chat clears the visible transcript and selecting its previous chat restores history", async () => {
  const storage = createStorage();
  const harness = await createHarness({ storage });
  await harness.task("Original chat question");
  await harness.start();
  harness.emit("session", CONVERSATION_ID);
  harness.emit("output", "Original chat answer.\n");
  harness.emit("completed", "Done");
  const transcript = harness.control("automation-output").textContent;
  await harness.control("automation-new-chat").dispatch("click");
  assert.equal(harness.control("automation-conversation").value, "");
  assert.doesNotMatch(harness.control("automation-output").textContent, /Original chat/);
  harness.control("automation-chat").value = CONVERSATION_ID;
  await harness.control("automation-chat").dispatch("change");
  assert.equal(harness.control("automation-output").textContent, transcript);
  harness.panel.dispose();
  const reopened = await createHarness({ storage });
  assert.equal(reopened.control("automation-conversation").value, CONVERSATION_ID);
  assert.equal(reopened.control("automation-output").textContent, transcript);
});

test("a newly returned chat remains in the picker after New chat and resumes with its transcript", async () => {
  const harness = await createHarness({ storage: createStorage() });
  await harness.control("btn-automation-toggle").dispatch("click");
  await nextTurn();
  assert.equal(harness.control("automation-chat").children.some(option => option.value === OTHER_CONVERSATION_ID), false);
  await harness.task("Investigate the newly created chat");
  await harness.start();
  harness.emit("session", OTHER_CONVERSATION_ID);
  harness.emit("output", "The newly created chat has its own saved answer.\n");
  harness.emit("completed", "Done");
  const transcript = harness.control("automation-output").textContent;
  await harness.control("automation-new-chat").dispatch("click");
  const previousChat = harness.control("automation-chat").children.find(option => option.value === OTHER_CONVERSATION_ID);
  assert.match(previousChat?.textContent ?? "", /Investigate the newly created chat/);
  assert.equal(harness.calls.filter(call => call.command === "list_local_agent_sessions").length, 1);
  harness.control("automation-chat").value = previousChat!.value;
  await harness.control("automation-chat").dispatch("change");
  assert.equal(harness.control("automation-output").textContent, transcript);
  await harness.task("Follow up in that newly created chat");
  await harness.start();
  assert.equal(harness.calls.filter(call => call.command === "start_ssh_automation").at(-1)?.arguments_?.resumeSessionId, OTHER_CONVERSATION_ID);
  assert.match(harness.control("automation-output").textContent, /The newly created chat has its own saved answer/);
});

test("an older pending chat scan cannot remove a newly returned chat after New chat", async () => {
  const listing = Promise.withResolvers<unknown>();
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "list_local_agent_sessions") return listing.promise;
  } });
  await harness.control("btn-automation-toggle").dispatch("click");
  await harness.task("Keep the newly returned chat in the picker");
  await harness.start();
  harness.emit("session", OTHER_CONVERSATION_ID);
  harness.emit("output", "New chat retained while its older scan is pending.\n");
  harness.emit("completed", "Done");
  await harness.control("automation-new-chat").dispatch("click");
  listing.resolve(LOCAL_CHAT_LISTING);
  await nextTurn();
  const returnedChat = harness.control("automation-chat").children.find(option => option.value === OTHER_CONVERSATION_ID);
  assert.match(returnedChat?.textContent ?? "", /Keep the newly returned chat in the picker/);
  harness.control("automation-chat").value = returnedChat!.value;
  await harness.control("automation-chat").dispatch("change");
  assert.match(harness.control("automation-output").textContent, /New chat retained while its older scan is pending/);
});

test("visible transcripts stay isolated by provider, server, and selected chat", async () => {
  const harness = await createHarness({ storage: createStorage() });
  await harness.task("Claude server-one question");
  await harness.start();
  harness.emit("session", CONVERSATION_ID);
  harness.emit("output", "Claude server-one answer.\n");
  harness.emit("completed", "Done");
  const claudeTranscript = harness.control("automation-output").textContent;
  harness.control("automation-provider").value = "codex";
  await harness.control("automation-provider").dispatch("change");
  assert.doesNotMatch(harness.control("automation-output").textContent, /Claude server-one/);
  await harness.task("Codex server-one question");
  await harness.start();
  harness.emit("session", OTHER_CONVERSATION_ID);
  harness.emit("output", "Codex server-one answer.\n");
  harness.emit("completed", "Done");
  const codexTranscript = harness.control("automation-output").textContent;
  harness.selectTarget({ sessionId: "other-server", label: "Other server" });
  assert.doesNotMatch(harness.control("automation-output").textContent, /server-one/);
  harness.selectTarget(TARGET);
  assert.equal(harness.control("automation-output").textContent, codexTranscript);
  harness.control("automation-provider").value = "claude";
  await harness.control("automation-provider").dispatch("change");
  assert.equal(harness.control("automation-output").textContent, claudeTranscript);
  harness.control("automation-chat").value = OTHER_CONVERSATION_ID;
  await harness.control("automation-chat").dispatch("change");
  assert.doesNotMatch(harness.control("automation-output").textContent, /server-one/);
  harness.control("automation-chat").value = CONVERSATION_ID;
  await harness.control("automation-chat").dispatch("change");
  assert.equal(harness.control("automation-output").textContent, claudeTranscript);
});

test("a run finishing after a server switch saves the transcript to its pinned server", async () => {
  const harness = await createHarness({ storage: createStorage() });
  await harness.task("Pinned server investigation");
  await harness.start();
  harness.emit("session", CONVERSATION_ID);
  harness.selectTarget({ sessionId: "other-server", label: "Other server" });
  harness.emit("output", "Pinned server result.\n");
  harness.emit("completed", "Pinned run finished");
  assert.doesNotMatch(harness.control("automation-output").textContent, /Pinned server/);
  harness.selectTarget(TARGET);
  assert.match(harness.control("automation-output").textContent, /Pinned server investigation/);
  assert.match(harness.control("automation-output").textContent, /Pinned server result/);
  assert.match(harness.control("automation-output").textContent, /Pinned run finished/);
});

for (const selection of ["dropdown", "manual"]) {
  test(`${selection} chat selection persists before any task starts`, async () => {
    const storage = createStorage();
    const harness = await createHarness({ storage });
    const control = harness.control(selection === "dropdown" ? "automation-chat" : "automation-conversation");
    control.value = CONVERSATION_ID;
    await control.dispatch(selection === "dropdown" ? "change" : "input");
    harness.panel.dispose();
    const reopened = await createHarness({ storage });
    assert.equal(reopened.control("automation-conversation").value, CONVERSATION_ID);
    assert.equal(reopened.control("automation-chat").value, CONVERSATION_ID);
    assert.equal(harness.calls.some(call => call.command === "start_ssh_automation"), false);
  });
}

test("selecting an external chat loads its native history before accepting a follow-up", async () => {
  const response = Promise.withResolvers<unknown>();
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "get_local_agent_history") return response.promise;
  } });
  await harness.task("Continue the existing diagnosis");
  harness.control("automation-chat").value = CONVERSATION_ID;
  await harness.control("automation-chat").dispatch("change");
  assert.deepEqual(harness.calls.find(call => call.command === "get_local_agent_history")?.arguments_, {
    provider: "claude", sessionId: CONVERSATION_ID,
  });
  assert.equal(harness.control("automation-start").disabled, true);
  assert.match(harness.control("automation-chat-help").textContent, /Loading conversation history/);
  await harness.start();
  assert.equal(harness.calls.some(call => call.command === "start_ssh_automation"), false);
  response.resolve({ messages: [
    { role: "user", text: "What caused the original failure?" },
    { role: "assistant", text: "## Diagnosis\n\nA configuration is missing." },
  ], truncated: false });
  await nextTurn();
  assert.equal(harness.control("automation-start").disabled, false);
  assert.match(harness.control("automation-output").textContent, /What caused the original failure/);
  assert.equal(harness.control("automation-output").querySelector("h2")?.textContent, "Diagnosis");
  await harness.start();
  assert.equal(harness.calls.find(call => call.command === "start_ssh_automation")?.arguments_?.resumeSessionId, CONVERSATION_ID);
  assert.match(harness.control("automation-output").textContent, /A configuration is missing/);
  assert.match(harness.control("automation-output").textContent, /Continue the existing diagnosis/);
});

for (const change of ["chat", "provider", "server"]) {
  test(`a stale native history response cannot replace a newly selected ${change}`, async () => {
    const storage = createStorage();
    const otherTarget = { sessionId: "other-server", label: "Other server" };
    storage.setItem(contextStorageKey(TARGET, "codex"), JSON.stringify(OTHER_CONVERSATION_ID));
    storage.setItem(contextStorageKey(otherTarget), JSON.stringify(OTHER_CONVERSATION_ID));
    const requests: Array<ReturnType<typeof Promise.withResolvers<unknown>>> = [];
    const harness = await createHarness({ storage, invoke: async ({ command }) => {
      if (command === "list_automation_providers") return PROVIDERS;
      if (command === "get_local_agent_history") {
        const request = Promise.withResolvers<unknown>();
        requests.push(request);
        return request.promise;
      }
    } });
    await harness.task("Continue selected chat");
    harness.control("automation-chat").value = CONVERSATION_ID;
    await harness.control("automation-chat").dispatch("change");
    if (change === "chat") {
      harness.control("automation-chat").value = OTHER_CONVERSATION_ID;
      await harness.control("automation-chat").dispatch("change");
    } else if (change === "provider") {
      harness.control("automation-provider").value = "codex";
      await harness.control("automation-provider").dispatch("change");
    } else {
      harness.selectTarget(otherTarget);
    }
    assert.equal(requests.length, 2);
    requests[0].resolve({ messages: [{ role: "assistant", text: "Stale chat history" }], truncated: false });
    await nextTurn();
    assert.doesNotMatch(harness.control("automation-output").textContent, /Stale chat history/);
    assert.equal(harness.control("automation-start").disabled, true);
    requests[1].resolve({ messages: [{ role: "assistant", text: "Selected chat history" }], truncated: false });
    await nextTurn();
    assert.match(harness.control("automation-output").textContent, /Selected chat history/);
    assert.doesNotMatch(harness.control("automation-output").textContent, /Stale chat history/);
    assert.equal(harness.control("automation-start").disabled, false);
  });
}

test("native history failure is visible while still permitting the selected chat to resume", async () => {
  const harness = await createHarness({ invoke: async ({ command }) => {
    if (command === "list_automation_providers") return PROVIDERS;
    if (command === "get_local_agent_history") throw new Error("History file is unavailable");
  } });
  await harness.task("Continue without the visible transcript");
  harness.control("automation-chat").value = CONVERSATION_ID;
  await harness.control("automation-chat").dispatch("change");
  await nextTurn();
  assert.match(harness.control("automation-chat-help").textContent, /Could not load conversation history.*History file is unavailable/);
  assert.equal(harness.control("automation-chat-help").dataset.error, "true");
  assert.equal(harness.control("automation-start").disabled, false);
  await harness.start();
  assert.equal(harness.calls.find(call => call.command === "start_ssh_automation")?.arguments_?.resumeSessionId, CONVERSATION_ID);
});

for (const retry of ["reopen", "refresh"]) {
  test(`${retry} retries a failed native history load for the selected conversation`, async () => {
    let historyAttempts = 0;
    const harness = await createHarness({ invoke: async ({ command }) => {
      if (command === "list_automation_providers") return PROVIDERS;
      if (command === "list_local_agent_sessions") return LOCAL_CHAT_LISTING;
      if (command === "get_local_agent_history") {
        historyAttempts += 1;
        if (historyAttempts === 1) throw new Error("Temporary history read failure");
        return { messages: [{ role: "assistant", text: "Recovered selected conversation history" }], truncated: false };
      }
    } });
    await harness.control("btn-automation-toggle").dispatch("click");
    await nextTurn();
    harness.control("automation-chat").value = CONVERSATION_ID;
    await harness.control("automation-chat").dispatch("change");
    await nextTurn();
    assert.equal(historyAttempts, 1);
    assert.match(harness.control("automation-chat-help").textContent, /Temporary history read failure/);
    if (retry === "reopen") {
      await harness.control("automation-close").dispatch("click");
      await harness.control("btn-automation-toggle").dispatch("click");
    } else {
      await harness.control("automation-refresh-chats").dispatch("click");
    }
    await nextTurn();
    assert.equal(historyAttempts, 2);
    assert.equal(harness.control("automation-conversation").value, CONVERSATION_ID);
    assert.match(harness.control("automation-output").textContent, /Recovered selected conversation history/);
    assert.doesNotMatch(harness.control("automation-chat-help").textContent, /Temporary history read failure/);
    assert.equal(harness.control("automation-chat-help").dataset.error, "false");
  });
}

const INVALID_NATIVE_HISTORIES: unknown[] = [
  null, {}, { messages: null, truncated: false }, { messages: [], truncated: "false" },
  { messages: [null], truncated: false }, { messages: [{ role: "system", text: "Untrusted system text" }], truncated: false },
  { messages: [{ role: "assistant", text: null }], truncated: false },
  { messages: Array.from({ length: MAX_OUTPUT_BLOCKS + 1 }, () => ({ role: "user", text: "overflow" })), truncated: false },
];

for (const [index, history] of INVALID_NATIVE_HISTORIES.entries()) {
  test(`malformed native history ${index} fails visibly without rendering unvalidated content`, async () => {
    const harness = await createHarness({ invoke: async ({ command }) => {
      if (command === "list_automation_providers") return PROVIDERS;
      if (command === "get_local_agent_history") return history;
    } });
    await harness.task();
    harness.control("automation-chat").value = CONVERSATION_ID;
    await harness.control("automation-chat").dispatch("change");
    await nextTurn();
    assert.equal(harness.control("automation-chat-help").dataset.error, "true");
    assert.match(harness.control("automation-chat-help").textContent, /Could not load conversation history/);
    assert.doesNotMatch(harness.control("automation-output").textContent, /Untrusted system text|overflow/);
    assert.equal(harness.control("automation-start").disabled, false);
  });
}

const INVALID_SAVED_TRANSCRIPTS = [
  "{", "null", JSON.stringify({ version: 2, blocks: [], trimmed: false }),
  JSON.stringify({ version: 1, blocks: null, trimmed: false }),
  JSON.stringify({ version: 1, blocks: [{ id: 0, format: "task", text: "invalid" }], trimmed: false }),
  JSON.stringify({ version: 1, blocks: [{ id: 1, format: "unknown", text: "invalid" }], trimmed: false }),
  JSON.stringify({ version: 1, blocks: [{ id: 1, format: "event", text: "invalid", tone: "unsafe" }], trimmed: false }),
  JSON.stringify({ version: 1, blocks: [{ id: 1, format: "markdown", text: "invalid", agent: 42 }], trimmed: false }),
  JSON.stringify({ version: 1, blocks: [{ id: 1, format: ["markdown"], text: "invalid" }], trimmed: false }),
  JSON.stringify({ version: 1, blocks: [{ id: 1, format: "event", text: "invalid", tone: ["danger"] }], trimmed: false }),
  JSON.stringify({ version: 1, blocks: [{ id: Number.MAX_SAFE_INTEGER, format: "task", text: "invalid" }], trimmed: false }),
  JSON.stringify({ version: 1, blocks: [
    { id: 1, format: "task", text: "invalid" }, { id: 1, format: "markdown", text: "duplicate" },
  ], trimmed: false }),
  " ".repeat(MAX_TRANSCRIPT_STORAGE_CHARACTERS + 1),
];

for (const [index, saved] of INVALID_SAVED_TRANSCRIPTS.entries()) {
  test(`malformed saved transcript ${index} falls back to native history`, async () => {
    const storage = createStorage();
    storage.setItem(contextStorageKey(TARGET), JSON.stringify(CONVERSATION_ID));
    storage.setItem(transcriptStorageKey(TARGET, "claude", CONVERSATION_ID), saved);
    const harness = await createHarness({ storage, invoke: async ({ command }) => {
      if (command === "list_automation_providers") return PROVIDERS;
      if (command === "get_local_agent_history") return { messages: [{ role: "assistant", text: "Recovered native history" }], truncated: false };
    } });
    assert.equal(harness.calls.filter(call => call.command === "get_local_agent_history").length, 1);
    assert.match(harness.control("automation-output").textContent, /Recovered native history/);
    assert.doesNotMatch(harness.control("automation-output").textContent, /invalid|duplicate/);
  });
}

test("transcript quota failures stay visible while in-memory chat history remains usable", async () => {
  const storage = createStorage();
  const harness = await createHarness({ storage: {
    ...storage,
    setItem(key, value) {
      if (key.startsWith("sleekssh_automation_transcript:")) throw new Error("Transcript quota exceeded");
      storage.setItem(key, value);
    },
  } });
  await harness.task("Retain this question in memory");
  await harness.start();
  harness.emit("session", CONVERSATION_ID);
  harness.emit("output", "Retain this answer in memory.\n");
  harness.emit("completed", "Done");
  assert.match(harness.control("automation-chat-help").textContent, /Could not save chat history.*Transcript quota exceeded.*Keep this window open/);
  assert.equal(harness.control("automation-chat-help").dataset.error, "true");
  await harness.control("automation-new-chat").dispatch("click");
  harness.control("automation-chat").value = CONVERSATION_ID;
  await harness.control("automation-chat").dispatch("change");
  assert.match(harness.control("automation-output").textContent, /Retain this question in memory/);
  assert.match(harness.control("automation-output").textContent, /Retain this answer in memory/);
});

test("bounded transcripts retain their newest output and one trim notice after reload", async () => {
  const storage = createStorage();
  const harness = await createHarness({ storage });
  await harness.task();
  await harness.start();
  harness.emit("session", CONVERSATION_ID);
  harness.emit("output", "x".repeat(MAX_OUTPUT_CHARACTERS));
  harness.emit("output", "Newest saved output.");
  harness.emit("completed", "Done");
  const transcript = harness.control("automation-output").textContent;
  harness.panel.dispose();
  const reopened = await createHarness({ storage });
  const restored = reopened.control("automation-output").textContent;
  assert.equal(restored, transcript);
  assert(restored.length <= MAX_OUTPUT_CHARACTERS);
  assert.equal(restored.match(/\[Earlier output trimmed\]/g)?.length, 1);
  assert.match(restored, /Newest saved output/);
});

test("restored transcript text remains escaped and Markdown links remain sanitized", async () => {
  const storage = createStorage();
  storage.setItem(contextStorageKey(TARGET), JSON.stringify(CONVERSATION_ID));
  storage.setItem(transcriptStorageKey(TARGET, "claude", CONVERSATION_ID), JSON.stringify({ version: 1, trimmed: false, blocks: [
    { id: 1, format: "task", text: '<img src=x onerror="alert(1)"> **literal task**' },
    { id: 2, format: "markdown", text: '<script>alert(1)</script> [unsafe](javascript:alert(1)) **Safe answer**' },
    { id: 3, format: "command", command: '<img src=x onerror="alert(1)">', text: "Exit status: 0\n" },
    { id: 4, format: "event", text: '<script>alert(1)</script>', command: '<img src=x>', tone: "ok" },
  ] }));
  const harness = await createHarness({ storage });
  const output = harness.control("automation-output");
  assert.equal(output.querySelector("img"), null);
  assert.equal(output.querySelector("script"), null);
  assert.equal(output.querySelector('a[href^="javascript:"]'), null);
  assert.match(output.textContent, /\*\*literal task\*\*/);
  assert.equal(output.querySelector("strong")?.textContent, "Safe answer");
  assert.equal(harness.calls.some(call => call.command === "get_local_agent_history"), false);
});

test("the selected provider restores its conversation and transcript after reload", async () => {
  const storage = createStorage();
  const harness = await createHarness({ storage });
  harness.control("automation-provider").value = "codex";
  await harness.control("automation-provider").dispatch("change");
  await harness.task("Codex saved question");
  await harness.start();
  harness.emit("session", OTHER_CONVERSATION_ID);
  harness.emit("output", "Codex saved answer.\n");
  harness.emit("completed", "Done");
  harness.panel.dispose();
  const reopened = await createHarness({ storage });
  assert.equal(reopened.control("automation-provider").value, "codex");
  assert.equal(reopened.control("automation-conversation").value, OTHER_CONVERSATION_ID);
  assert.match(reopened.control("automation-output").textContent, /Codex saved question/);
  assert.match(reopened.control("automation-output").textContent, /Codex saved answer/);
  await reopened.task("Codex follow-up");
  await reopened.start();
  assert.equal(reopened.calls.find(call => call.command === "start_ssh_automation")?.arguments_?.provider, "codex");
  assert.equal(reopened.calls.find(call => call.command === "start_ssh_automation")?.arguments_?.resumeSessionId, OTHER_CONVERSATION_ID);
});

test("a later turn cannot reactivate historical commands or attach orphan output to them", async () => {
  const harness = await createHarness();
  await harness.task("First turn command");
  await harness.start();
  harness.emit("session", CONVERSATION_ID);
  harness.emit("command", "Running", { command: "first-command" });
  harness.emit("completed", "First turn finished");
  const output = harness.control("automation-output");
  assert.equal(output.children.find(block => block.className === "automation-output-command")?.dataset.state, "idle");
  await harness.task("Second turn command");
  await harness.start();
  assert.equal(output.children.find(block => block.className === "automation-output-command")?.dataset.state, "idle");
  harness.emit("command_output", "Unassociated second-turn output\n");
  const oldCommand = output.children.find(block => block.className === "automation-output-command")!;
  assert.equal(oldCommand.dataset.state, "idle");
  assert.doesNotMatch(oldCommand.textContent, /Unassociated second-turn output/);
  assert.match(output.children.find(block => block.className === "automation-output-log")?.textContent ?? "", /Unassociated second-turn output/);
  harness.emit("command", "Running", { command: "second-command" });
  const commands = output.children.filter(block => block.className === "automation-output-command");
  assert.equal(commands[0].dataset.state, "idle");
  assert.equal(commands[1].dataset.state, "running");
});

test("New chat clears a failed run draft across reload even without a returned conversation ID", async () => {
  const storage = createStorage();
  const harness = await createHarness({ storage });
  await harness.task("Failed new-chat question");
  await harness.start();
  harness.emit("output", "Partial failed new-chat answer.\n");
  harness.emit("failed", "Agent exited before returning an ID");
  await harness.control("automation-new-chat").dispatch("click");
  assert.doesNotMatch(harness.control("automation-output").textContent, /Failed new-chat question|Partial failed new-chat answer/);
  harness.panel.dispose();
  const reopened = await createHarness({ storage });
  assert.equal(reopened.control("automation-conversation").value, "");
  assert.doesNotMatch(reopened.control("automation-output").textContent, /Failed new-chat question|Partial failed new-chat answer/);
});

test("dropdown selection storage errors remain visible beside the selected conversation", async () => {
  const storage = createStorage();
  const harness = await createHarness({ storage: {
    ...storage,
    setItem(key, value) {
      if (key.startsWith("sleekssh_automation_conversation:")) throw new Error("Selection quota exceeded");
      storage.setItem(key, value);
    },
  } });
  harness.control("automation-chat").value = CONVERSATION_ID;
  await harness.control("automation-chat").dispatch("change");
  await nextTurn();
  assert.equal(harness.control("automation-conversation").value, CONVERSATION_ID);
  assert.match(harness.control("automation-conversation-help").textContent, /Could not save this chat context.*Selection quota exceeded.*Copy the conversation ID/);
  assert.equal(harness.control("automation-conversation-help").dataset.error, "true");
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
  assert.equal(storage.values.has(contextStorageKey(TARGET)), false);
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
  assert.equal(storage.values.has(contextStorageKey(TARGET)), false);
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
    if (command === "get_local_agent_history") return { messages: [], truncated: false };
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
  assert.match(harness.control("automation-chat-help").textContent, /1 saved local chat\./);
  assert.equal(harness.control("automation-chat-help").dataset.quiet, "true");
  harness.control("automation-chat").value = CONVERSATION_ID;
  await harness.control("automation-chat").dispatch("change");
  refresh = true;
  await harness.control("automation-refresh-chats").dispatch("click");
  await nextTurn();
  assert.equal(harness.control("automation-chat-help").dataset.quiet, "false");
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
  assert.equal(harness.control("btn-automation-toggle").textContent, "Approval needed");
  assert.equal(harness.control("btn-automation-toggle").dataset.state, "review");
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
  assert([...storage.values.keys()].every(key => key.startsWith("sleekssh_automation_transcript:")));
  harness.emit("completed", "Done");
  await harness.task("Inspect sudo consent for the next task");
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
  await harness.task("Retry with updated sudo credentials");
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
    await harness.task("Inspect sudo consent for the next task");
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

test("command history counts executed commands once with their pinned target and execution identity", async () => {
  const executed: Array<{ target: SshTarget; command: string }> = [];
  const harness = await createHarness({ onCommandExecuted: (target, command) => { executed.push({ target, command }); } });
  await harness.task();
  await harness.start();
  harness.emit("command", "Running", { command: "first-command", request_id: "execution-1" });
  harness.emit("command", "Running", { command: "second-command", request_id: "execution-2" });
  assert.equal(executed.length, 0);
  harness.selectTarget({ sessionId: "other-server", label: "Other server" });
  harness.emit("command_output", "Exit status: 1\n", { command: "first-command", request_id: "execution-1" });
  harness.emit("command_output", "Exit status: 1\n", { command: "first-command", request_id: "execution-1" });
  harness.emit("command_output", "Exit status: 0\n", { command: "second-command", request_id: "execution-2" });
  assert.deepEqual(executed, [{ target: TARGET, command: "first-command" }, { target: TARGET, command: "second-command" }]);
});

test("denied or cancelled command proposals never enter command history", async () => {
  const commands: string[] = [];
  const harness = await createHarness({ onCommandExecuted: (_target, command) => { commands.push(command); } });
  await harness.task();
  await harness.start();
  harness.emit("approval", "Approve", { request_id: "denied-command", command: "dangerous-command" });
  harness.emit("command", "Running", { command: "sudo command-needing-consent" });
  harness.emit("sudo_error", "Saved sudo password denied for this run.");
  harness.emit("failed", "Command was not executed");
  harness.emit("command_output", "Exit status: 0\n", { command: "late-command", request_id: "old-execution" });
  assert.deepEqual(commands, []);
});

test("started agent commands enter history even when stopped before returning a result", async () => {
  const commands: string[] = [];
  const harness = await createHarness({ onCommandExecuted: (_target, command) => { commands.push(command); } });
  await harness.task();
  await harness.start();
  harness.emit("command", "Running", { command: "long-running-command", request_id: "execution-started" });
  assert.deepEqual(commands, []);
  harness.emit("command_executed", "Started", { command: "long-running-command", request_id: "execution-started" });
  harness.emit("command_executed", "Started", { command: "long-running-command", request_id: "execution-started" });
  assert.deepEqual(commands, ["long-running-command"]);
  harness.emit("cancelled", "Stopped");
  assert.deepEqual(commands, ["long-running-command"]);
});

test("a completed result does not count an already recorded start again", async () => {
  const commands: string[] = [];
  const harness = await createHarness({ onCommandExecuted: (_target, command) => { commands.push(command); } });
  await harness.task();
  await harness.start();
  for (const payload of [{ command: "uptime" }, { request_id: "x" }, { command: null, request_id: "x" }]) {
    harness.emit("command_executed", "Malformed", payload);
  }
  assert.deepEqual(commands, []);
  const execution = { command: "uptime", request_id: "execution-completed" };
  harness.emit("command", "Running", execution);
  harness.emit("command_executed", "Started", execution);
  harness.emit("command_output", "Exit status: 0\n", execution);
  assert.deepEqual(commands, ["uptime"]);
});

test("legacy command results record once and history callback errors remain visible", async () => {
  const commands: string[] = [];
  const harness = await createHarness({ onCommandExecuted: (_target, command) => {
    commands.push(command);
    throw new Error("History storage full");
  } });
  await harness.task();
  await harness.start();
  harness.emit("command", "Running", { command: "uptime" });
  harness.emit("command_output", "output without completed execution");
  assert.equal(commands.length, 0);
  harness.emit("command_output", "Exit status: 0\n");
  harness.emit("command_output", "Exit status: 0\n");
  assert.deepEqual(commands, ["uptime"]);
  assert.match(harness.control("automation-status").textContent, /Could not save command history.*History storage full/);
  assert.equal(harness.control("automation-stop").disabled, false);
});

for (const missingControl of ["automation-sudo-approval", "automation-sudo-allow", "automation-sudo-deny", "automation-sudo-status", "automation-sudo-command", "automation-sudo-target", "automation-sudo-message"]) {
  test(`missing ${missingControl} fails explicitly`, async () => {
    await assert.rejects(createHarness({ missingControl }), new RegExp(`SSH automation control is missing: ${missingControl}`));
  });
}
