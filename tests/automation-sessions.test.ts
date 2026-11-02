import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHTML } from "linkedom";
import { initAutomation } from "../src/automation.ts";
import { initAutomationSessions } from "../src/automation-sessions.ts";

const HTML = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const CONVERSATION = "11111111-2222-3333-4444-555555555555";
type Invocation = Readonly<{ command: string; arguments_?: Record<string, unknown> }>;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

async function harness(configuration: { listenFailure?: boolean; invoke?: (call: Invocation) => Promise<unknown> } = {}) {
  const { document, window } = parseHTML(HTML);
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get() { return [...this.options].find(option => option.selected)?.value ?? this.options[0]?.value ?? ""; },
    set(value: string) {
      for (const option of this.options) option.selected = false;
      const selected = [...this.options].find(option => option.value === value);
      if (selected) selected.selected = true;
    },
  });
  const targets = new Map(["a", "b"].map(key => [key, { sessionId: `transport-${key}`, label: `SSH ${key}`, contextKey: "same-profile" }]));
  let selected: string | null = "a";
  let focused: HTMLElement | null = null;
  window.HTMLElement.prototype.focus = function () { focused = this as HTMLElement; };
  const storage = new Map<string, string>();
  const calls: Invocation[] = [];
  const errors: string[] = [];
  const navigation: string[] = [];
  let events: ((event: { payload: unknown }) => void) | null = null;
  let unlistens = 0;
  let runNumber = 0;
  const agent = initAutomationSessions({
    document: document as unknown as Document,
    getSelectedSessionKey: () => selected,
    getTargetForSession: key => targets.get(key) ?? null,
    createRunId: () => `run-${++runNumber}`,
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); }, removeItem: key => { storage.delete(key); } },
    async invoke(command, arguments_) {
      const call = { command, arguments_ }; calls.push(call);
      if (configuration.invoke) { const result = await configuration.invoke(call); if (result !== undefined) return result; }
      if (command === "list_automation_providers") return [{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }];
      if (command === "list_local_agent_sessions") return { sessions: [], warnings: [], truncated: false };
      if (command === "get_local_agent_history") return { messages: [], truncated: false };
    },
    async listen(_name, callback) {
      if (configuration.listenFailure) throw new Error("Event stream unavailable");
      events = callback; return () => { unlistens += 1; };
    },
    onFiles() { navigation.push("files"); }, onHistory() { navigation.push("history"); },
    onSnippets() { navigation.push("snippets"); }, onLayoutChange() {}, onError: message => { errors.push(message); },
  }, initAutomation);
  const control = <T extends HTMLElement>(key: string, name: string): T => {
    const element = document.querySelector<T>(`[data-session-key="${key}"] [data-automation-control="${name}"]`);
    assert.ok(element, key + ":" + name); return element;
  };
  await settle();
  return {
    agent, document, window, calls, errors, navigation, storage, targets, control,
    get focused() { return focused; }, get unlistens() { return unlistens; },
    view(key: string) { return document.querySelector<HTMLElement>(`[data-session-key="${key}"]`)!; },
    toggle() { document.getElementById("btn-automation-toggle")!.click(); },
    async select(key: string | null) { selected = key; agent.refresh(); await settle(); },
    async task(key: string, text: string) { control<HTMLTextAreaElement>(key, "automation-prompt").value = text; control(key, "automation-prompt").dispatchEvent(new window.Event("input")); await settle(); },
    async start(key: string) { control(key, "automation-form").dispatchEvent(new window.Event("submit", { cancelable: true })); await settle(); },
    async enter(key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}) {
      const event = new window.Event("keydown", { cancelable: true });
      Object.defineProperties(event, { key: { value: "Enter" }, ctrlKey: { value: Boolean(modifiers.ctrlKey) }, metaKey: { value: Boolean(modifiers.metaKey) }, shiftKey: { value: Boolean(modifiers.shiftKey) } });
      control(key, "automation-prompt").dispatchEvent(event); await settle(); return event;
    },
    emit(run: Invocation, kind: string, message: string, extra: Record<string, unknown> = {}) {
      events?.({ payload: { run_id: run.arguments_?.runId, session_id: run.arguments_?.sessionId, kind, message, ...extra } });
    },
    run(key: string) { const call = calls.find(call => call.command === "start_ssh_automation" && call.arguments_?.sessionId === `transport-${key}`); assert.ok(call); return call; },
  };
}

test("SSH sessions retain independent drafts, open state and unique accessible controls", async () => {
  const h = await harness();
  try {
    h.toggle(); await h.task("a", "Task A");
    await h.select("b");
    assert.equal(h.document.getElementById("automation-panel")!.hidden, true);
    h.toggle(); await h.task("b", "Task B");
    await h.select("a");
    assert.equal(h.control<HTMLTextAreaElement>("a", "automation-prompt").value, "Task A");
    assert.equal(h.control<HTMLTextAreaElement>("b", "automation-prompt").value, "Task B");
    assert.equal(h.view("a").hidden, false); assert.equal(h.view("b").hidden, true);
    const ids = [...h.document.querySelectorAll<HTMLElement>("[id]")].map(element => element.id);
    assert.equal(new Set(ids).size, ids.length);
    const prompt = h.control("a", "automation-prompt");
    assert.ok(h.document.querySelector(`label[for="${prompt.id}"]`));
    await h.select(null); assert.equal(h.document.getElementById("automation-panel")!.hidden, true);
    assert.equal((h.document.getElementById("btn-automation-toggle") as HTMLButtonElement).disabled, true);
  } finally { h.agent.dispose(); }
});

test("only the selected Agent session can navigate to the Snippets tab without stopping its task", async () => {
  const h = await harness();
  try {
    h.toggle(); await h.task("a", "Task A"); await h.start("a");
    h.control<HTMLButtonElement>("a", "automation-snippets-tab").click();
    assert.deepEqual(h.navigation, ["snippets"]);
    await h.select("b");
    h.control<HTMLButtonElement>("a", "automation-snippets-tab").click();
    assert.deepEqual(h.navigation, ["snippets"]);
    h.control<HTMLButtonElement>("b", "automation-snippets-tab").click();
    assert.deepEqual(h.navigation, ["snippets", "snippets"]);
    assert.equal(h.calls.some(call => call.command === "stop_ssh_automation"), false);
  } finally { h.agent.dispose(); }
});

test("the compact progress indicator follows only the selected session and preserves approval attention", async () => {
  const h = await harness();
  try {
    const toggle = h.document.getElementById("btn-automation-toggle")!;
    h.toggle(); await h.task("a", "Task A"); await h.start("a"); const first = h.run("a");
    const progress = toggle.querySelector('[role="progressbar"]');
    assert.ok(progress); assert.equal(progress.hasAttribute("aria-valuenow"), false);
    assert.equal(toggle.textContent, ""); assert.equal(toggle.getAttribute("aria-label"), "Agent running");
    assert.equal(toggle.getAttribute("title"), "Agent running");
    h.emit(first, "output", "Working on A"); assert.equal(toggle.querySelector('[role="progressbar"]'), progress);
    await h.select("b"); assert.equal(toggle.textContent, "Agent"); assert.equal(toggle.querySelector('[role="progressbar"]'), null);
    await h.select("a"); assert.equal(toggle.querySelector('[role="progressbar"]'), progress);
    h.emit(first, "approval", "Review command", { request_id: "approve-a", command: "pwd" });
    assert.equal(toggle.textContent, "Approval needed"); assert.equal(toggle.querySelector('[role="progressbar"]'), null);
    assert.equal(toggle.getAttribute("aria-label"), "Approval needed");
    h.emit(first, "completed", "Done"); assert.equal(toggle.textContent, "Agent");
    assert.equal(toggle.querySelector('[role="progressbar"]'), null);
    assert.equal(toggle.getAttribute("aria-label"), "Agent");
  } finally { h.agent.dispose(); }
});

test("different sessions run concurrently and route output, approvals and Stop only to their own run", async () => {
  const h = await harness();
  try {
    h.toggle(); await h.task("a", "Task A"); await h.start("a"); const a = h.run("a");
    await h.select("b"); h.toggle(); await h.task("b", "Task B"); await h.start("b"); const b = h.run("b");
    assert.equal(h.agent.states().filter(state => state.running).length, 2);
    h.emit(a, "output", "Output A"); h.emit(b, "output", "Output B");
    assert.match(h.control("a", "automation-output").textContent!, /Output A/);
    assert.doesNotMatch(h.control("b", "automation-output").textContent!, /Output A/);
    h.emit(a, "approval", "Approve A", { request_id: "approval-a", command: "pwd" });
    assert.equal(h.view("a").hidden, true); assert.equal(h.view("b").hidden, false);
    assert.equal(h.agent.states().find(state => state.sessionKey === "a")!.review, true);
    h.control("a", "automation-approve").click(); await settle();
    assert.equal(h.calls.some(call => call.command === "respond_automation_approval"), false);
    h.emit(b, "approval", "Approve B", { request_id: "approval-b", command: "ls" });
    h.control("b", "automation-approve").click(); await settle();
    assert.equal(h.calls.find(call => call.command === "respond_automation_approval")!.arguments_!.runId, b.arguments_!.runId);
    h.control("b", "automation-stop").click(); await settle();
    assert.equal(h.calls.find(call => call.command === "stop_ssh_automation")!.arguments_!.runId, b.arguments_!.runId);
    h.emit(b, "cancelled", "Stopped B");
    assert.equal(h.agent.states().find(state => state.sessionKey === "a")!.running, true);
    await h.select("a"); h.control("a", "automation-approve").click(); await settle();
    assert.equal(h.calls.filter(call => call.command === "respond_automation_approval").at(-1)!.arguments_!.runId, a.arguments_!.runId);
  } finally { h.agent.dispose(); }
});

test("background sudo consent cannot open another session's panel or steal its focus", async () => {
  const h = await harness();
  try {
    h.toggle(); await h.task("a", "Task A"); await h.start("a");
    await h.select("b"); h.toggle(); const focus = h.focused;
    h.emit(h.run("a"), "sudo_approval", "Allow sudo A", { request_id: "sudo-a", command: "id -u" });
    assert.equal(h.focused, focus); assert.equal(h.view("a").hidden, true);
    h.control("a", "automation-sudo-allow").click(); await settle();
    assert.equal(h.calls.some(call => call.command === "respond_automation_sudo_consent"), false);
  } finally { h.agent.dispose(); }
});

test("conversation context and transcripts do not transfer between same-host sessions", async () => {
  const h = await harness();
  try {
    h.toggle(); await h.task("a", "Private A"); await h.start("a");
    h.emit(h.run("a"), "session", CONVERSATION); h.emit(h.run("a"), "output", "Private response A"); h.emit(h.run("a"), "completed", "Done");
    await h.select("b"); h.toggle(); await settle();
    assert.equal(h.control<HTMLInputElement>("b", "automation-conversation").value, "");
    assert.doesNotMatch(h.control("b", "automation-output").textContent!, /Private/);
    const conversation = h.control<HTMLInputElement>("b", "automation-conversation");
    conversation.value = CONVERSATION; conversation.dispatchEvent(new h.window.Event("input")); await settle();
    await h.task("b", "Try A's chat"); await h.start("b");
    assert.equal(h.calls.some(call => call.command === "start_ssh_automation" && call.arguments_?.sessionId === "transport-b"), false);
    assert.match(h.control("b", "automation-status").textContent! + h.control("b", "automation-chat-help").textContent!, /another SSH session/);
    await h.select("a"); assert.equal(h.control<HTMLInputElement>("a", "automation-conversation").value, CONVERSATION);
  } finally { h.agent.dispose(); }
});

test("closing one session stops and disposes only its agent", async () => {
  const h = await harness();
  try {
    h.toggle(); await h.task("a", "Task A"); await h.start("a");
    await h.select("b"); h.toggle(); await h.task("b", "Task B"); await h.start("b");
    await h.agent.releaseSession("a");
    assert.equal(h.calls.find(call => call.command === "stop_ssh_automation")!.arguments_!.runId, h.run("a").arguments_!.runId);
    assert.equal(h.agent.states().length, 1); assert.equal(h.agent.states()[0].running, true);
    assert.equal(h.view("a"), null); assert.equal(h.unlistens, 0);
  } finally { h.agent.dispose(); }
  assert.equal(h.unlistens, 1);
});

test("listener errors are visible and keep session runs disabled", async () => {
  const h = await harness({ listenFailure: true });
  try {
    assert.match(h.errors[0], /Event stream unavailable/);
    h.toggle(); await h.task("a", "Task A"); await h.start("a");
    assert.equal(h.calls.some(call => call.command === "start_ssh_automation"), false);
  } finally { h.agent.dispose(); }
});

test("reconnects keep their own chat while old transport events cannot affect a new run", async () => {
  const h = await harness();
  try {
    h.toggle(); await h.task("a", "First task"); await h.start("a"); const first = h.run("a");
    h.emit(first, "session", CONVERSATION); h.emit(first, "completed", "Done");
    h.targets.set("a", { sessionId: "replacement-transport", label: "SSH a", contextKey: "same-profile" });
    h.agent.refresh(); await settle();
    await h.task("a", "Second task"); await h.start("a");
    const second = h.calls.filter(call => call.command === "start_ssh_automation").at(-1)!;
    assert.equal(second.arguments_?.sessionId, "replacement-transport");
    assert.equal(second.arguments_?.resumeSessionId, CONVERSATION);
    h.emit(first, "output", "Stale output");
    h.emit(second, "output", "Wrong transport", { session_id: "transport-b" });
    assert.doesNotMatch(h.control("a", "automation-output").textContent!, /Stale output|Wrong transport/);
    assert.equal(h.agent.states()[0].running, true);
  } finally { h.agent.dispose(); }
});

test("releasing the selected session cannot recreate its agent on a late refresh", async () => {
  const h = await harness();
  try {
    h.toggle(); await h.task("a", "First task"); await h.start("a");
    await h.agent.releaseSession("a"); h.agent.refresh();
    assert.deepEqual(h.agent.states(), []);
    assert.equal(h.document.getElementById("automation-panel")!.hidden, true);
    await h.select("b"); h.toggle();
    assert.equal(h.view("b").hidden, false);
  } finally { h.agent.dispose(); }
});

test("follow-ups queue in order and continue the same chat exactly once", async () => {
  const h = await harness();
  try {
    h.toggle(); await h.task("a", "First task"); await h.start("a"); const first = h.run("a");
    h.emit(first, "session", CONVERSATION);
    assert.equal(h.control<HTMLTextAreaElement>("a", "automation-prompt").disabled, false);
    await h.task("a", "Explain the result"); h.control("a", "automation-start").focus(); await h.start("a");
    assert.equal(h.focused, h.control("a", "automation-prompt"));
    await h.task("a", "Then inspect logs"); await h.start("a");
    assert.equal(h.calls.filter(call => call.command === "start_ssh_automation").length, 1);
    assert.equal(h.control("a", "automation-queue-list").children.length, 2);
    h.emit(first, "completed", "Done"); await settle();
    const second = h.calls.filter(call => call.command === "start_ssh_automation").at(-1)!;
    assert.equal(second.arguments_?.prompt, "Explain the result"); assert.equal(second.arguments_?.resumeSessionId, CONVERSATION);
    h.emit(first, "completed", "Duplicate completion"); await settle();
    assert.equal(h.calls.filter(call => call.command === "start_ssh_automation").length, 2);
    h.emit(second, "completed", "Done"); await settle();
    const third = h.calls.filter(call => call.command === "start_ssh_automation").at(-1)!;
    assert.equal(third.arguments_?.prompt, "Then inspect logs");
    assert.equal(h.control("a", "automation-queue").hidden, true);
    h.emit(third, "completed", "Done");
    assert.equal(h.control("a", "automation-start").textContent, "Send follow-up");
  } finally { h.agent.dispose(); }
});

test("queued prompts keep their SSH owner when another session is selected", async () => {
  const h = await harness();
  try {
    h.toggle(); await h.task("a", "First A"); await h.start("a"); const first = h.run("a");
    h.emit(first, "session", CONVERSATION); await h.task("a", "Follow-up A"); await h.start("a");
    await h.select("b"); h.toggle(); await h.task("b", "Draft B"); const focus = h.focused;
    h.emit(first, "completed", "Done A"); await settle();
    const followup = h.calls.filter(call => call.command === "start_ssh_automation").at(-1)!;
    assert.equal(followup.arguments_?.sessionId, "transport-a"); assert.equal(followup.arguments_?.prompt, "Follow-up A");
    assert.equal(h.control<HTMLTextAreaElement>("b", "automation-prompt").value, "Draft B");
    assert.equal(h.view("a").hidden, true); assert.equal(h.focused, focus);
  } finally { h.agent.dispose(); }
});

for (const modifier of ["ctrlKey", "metaKey"] as const) {
  test(`Enter queues follow-ups and ${modifier}+Enter steers without submitting another queued prompt`, async () => {
    const h = await harness();
    try {
      h.toggle(); await h.task("a", "First task"); await h.enter("a"); const first = h.run("a");
      h.emit(first, "session", CONVERSATION);
      await h.task("a", "Queued follow-up");
      assert.equal((await h.enter("a", { shiftKey: true })).defaultPrevented, false);
      assert.equal(h.control("a", "automation-queue-list").children.length, 0);
      assert.equal((await h.enter("a")).defaultPrevented, true);
      assert.equal(h.control("a", "automation-queue-list").children.length, 1);
      await h.task("a", "Steering instruction");
      assert.equal((await h.enter("a", { [modifier]: true })).defaultPrevented, true);
      assert.equal(h.calls.find(call => call.command === "stop_ssh_automation")?.arguments_?.runId, first.arguments_?.runId);
      assert.equal(h.calls.filter(call => call.command === "start_ssh_automation").length, 1);
      h.emit(first, "cancelled", "Stopped for steering"); await settle();
      const steered = h.calls.filter(call => call.command === "start_ssh_automation").at(-1)!;
      assert.equal(steered.arguments_?.prompt, "Steering instruction");
      assert.equal(steered.arguments_?.resumeSessionId, CONVERSATION);
      assert.match(h.control("a", "automation-queue-list").textContent!, /Queued follow-up/);
    } finally { h.agent.dispose(); }
  });
}

test("the composer keeps shortcuts discoverable without explanatory paragraphs", async () => {
  const h = await harness();
  try {
    assert.equal(h.view("a").querySelector(".composer-hint"), null);
    assert.equal(h.view("a").querySelector('[data-automation-control="automation-stop-help"]'), null);
    assert.equal(h.view("a").querySelector('[data-automation-control="automation-followup-help"]'), null);
    assert.equal(h.control("a", "automation-start").getAttribute("aria-keyshortcuts"), "Enter");
    assert.equal(h.control("a", "automation-steer").getAttribute("aria-keyshortcuts"), "Control+Enter Meta+Enter");
    assert.equal(h.control<HTMLTextAreaElement>("a", "automation-prompt").placeholder, "Message the agent…");
    assert.match(h.control("a", "automation-prompt").getAttribute("aria-description")!, /Shift\+Enter/);
  } finally { h.agent.dispose(); }
});

test("steering stops the current task before resuming its chat and takes priority over queued work", async () => {
  const h = await harness();
  try {
    h.toggle(); await h.task("a", "Inspect server"); await h.start("a"); const first = h.run("a");
    h.emit(first, "session", CONVERSATION);
    assert.equal(h.control("a", "automation-steer").hidden, true);
    await h.task("a", "Report afterwards"); await h.start("a");
    await h.task("a", "Focus on nginx only"); assert.equal(h.control("a", "automation-steer").hidden, false);
    h.control("a", "automation-steer").focus(); h.control("a", "automation-steer").click(); await settle();
    assert.equal(h.focused, h.control("a", "automation-prompt"));
    assert.equal(h.calls.find(call => call.command === "stop_ssh_automation")?.arguments_?.runId, first.arguments_?.runId);
    assert.equal(h.calls.filter(call => call.command === "start_ssh_automation").length, 1);
    h.emit(first, "cancelled", "Stopped for steering"); await settle();
    const steered = h.calls.filter(call => call.command === "start_ssh_automation").at(-1)!;
    assert.equal(steered.arguments_?.prompt, "Focus on nginx only"); assert.equal(steered.arguments_?.resumeSessionId, CONVERSATION);
    h.emit(steered, "completed", "Done"); await settle();
    assert.equal(h.calls.filter(call => call.command === "start_ssh_automation").at(-1)!.arguments_?.prompt, "Report afterwards");
    assert.equal(h.calls.some(call => call.command === "respond_automation_approval"), false);
  } finally { h.agent.dispose(); }
});

test("failed steering retains the instruction in a paused queue", async () => {
  const h = await harness({ async invoke(call) { if (call.command === "stop_ssh_automation") throw new Error("Transport busy"); } });
  try {
    h.toggle(); await h.task("a", "First task"); await h.start("a"); const first = h.run("a");
    h.emit(first, "session", CONVERSATION);
    await h.task("a", "New direction"); h.control("a", "automation-steer").click(); await settle();
    assert.match(h.control("a", "automation-status").textContent!, /Transport busy/);
    assert.match(h.control("a", "automation-queue-list").textContent!, /New direction/);
    assert.equal(h.control("a", "automation-queue-resume").textContent, "Resume queue");
    h.emit(first, "completed", "Done"); await settle();
    assert.equal(h.calls.filter(call => call.command === "start_ssh_automation").length, 1);
  } finally { h.agent.dispose(); }
});

test("the compact queue can steer with an existing prompt while preserving the unsent draft and SSH owner", async () => {
  const h = await harness();
  try {
    h.toggle(); await h.task("a", "First task"); await h.start("a"); const first = h.run("a");
    h.emit(first, "session", CONVERSATION);
    await h.task("a", "Keep this queued"); await h.start("a");
    await h.task("a", "Use this direction now"); await h.start("a");
    await h.task("a", "Unsent draft");
    const queuedSteer = () => h.control("a", "automation-queue-list").querySelector<HTMLButtonElement>('button[aria-label="Steer with queued prompt 2"]')!;
    await h.select("b"); h.toggle(); queuedSteer().click(); await settle();
    assert.equal(h.calls.some(call => call.command === "stop_ssh_automation"), false);
    await h.select("a"); queuedSteer().click(); await settle();
    assert.equal(h.calls.find(call => call.command === "stop_ssh_automation")?.arguments_?.runId, first.arguments_?.runId);
    h.emit(first, "cancelled", "Stopped for steering"); await settle();
    const steered = h.calls.filter(call => call.command === "start_ssh_automation").at(-1)!;
    assert.equal(steered.arguments_?.prompt, "Use this direction now");
    assert.equal(steered.arguments_?.sessionId, "transport-a"); assert.equal(steered.arguments_?.resumeSessionId, CONVERSATION);
    assert.equal(h.control<HTMLTextAreaElement>("a", "automation-prompt").value, "Unsent draft");
    assert.equal(h.control("a", "automation-queue-list").children.length, 1);
    assert.match(h.control("a", "automation-queue-list").textContent!, /Keep this queued/);
  } finally { h.agent.dispose(); }
});

for (const ending of ["failed", "cancelled"] as const) {
  test(`${ending} tasks pause queued prompts until explicit resumption`, async () => {
    const h = await harness();
    try {
      h.toggle(); await h.task("a", "First task"); await h.start("a"); const first = h.run("a");
      h.emit(first, "session", CONVERSATION); await h.task("a", "Next task"); await h.start("a");
      h.emit(first, ending, "Ended"); await settle();
      assert.equal(h.calls.filter(call => call.command === "start_ssh_automation").length, 1);
      assert.match(h.control("a", "automation-queue-count").textContent!, /paused/);
      h.control("a", "automation-queue-resume").click(); await settle();
      assert.equal(h.calls.filter(call => call.command === "start_ssh_automation").at(-1)!.arguments_?.prompt, "Next task");
    } finally { h.agent.dispose(); }
  });
}

test("queue pause, removal and reconnect resumption preserve pending work without retargeting", async () => {
  const h = await harness();
  try {
    h.toggle(); await h.task("a", "First task"); await h.start("a"); const first = h.run("a");
    h.emit(first, "session", CONVERSATION);
    await h.task("a", "Remove this"); await h.start("a"); await h.task("a", "Keep this"); await h.start("a");
    h.control("a", "automation-queue-list").querySelector<HTMLButtonElement>('button[aria-label="Remove queued prompt 1"]')!.click();
    assert.doesNotMatch(h.control("a", "automation-queue-list").textContent!, /Remove this/);
    h.targets.set("a", { sessionId: "new-transport-a", label: "SSH a", contextKey: "same-profile" });
    h.agent.refresh(); h.emit(first, "completed", "Done"); await settle();
    assert.equal(h.calls.filter(call => call.command === "start_ssh_automation").length, 1);
    assert.match(h.control("a", "automation-status").textContent!, /Queue paused/);
    h.control("a", "automation-queue-resume").click(); await settle();
    const followup = h.calls.filter(call => call.command === "start_ssh_automation").at(-1)!;
    assert.equal(followup.arguments_?.sessionId, "new-transport-a"); assert.equal(followup.arguments_?.prompt, "Keep this");
  } finally { h.agent.dispose(); }
});

test("completion before a startup reply cannot start the next prompt twice", async () => {
  const startup = Promise.withResolvers<void>(); let starts = 0;
  const h = await harness({ async invoke(call) { if (call.command === "start_ssh_automation" && ++starts === 1) return startup.promise; } });
  try {
    h.toggle(); await h.task("a", "First task"); await h.start("a"); const first = h.run("a");
    h.emit(first, "session", CONVERSATION); await h.task("a", "Next task"); await h.start("a");
    h.emit(first, "completed", "Done"); await settle();
    assert.equal(h.calls.filter(call => call.command === "start_ssh_automation").length, 1);
    startup.resolve(); await settle(); await settle();
    assert.equal(h.calls.filter(call => call.command === "start_ssh_automation").length, 2);
    assert.equal(h.calls.filter(call => call.command === "start_ssh_automation")[1].arguments_?.prompt, "Next task");
  } finally { startup.resolve(); h.agent.dispose(); }
});

test("Stop pauses the queue and failed queued startup retains both pending work and a newly typed draft", async () => {
  const startup = Promise.withResolvers<void>(); let starts = 0;
  const h = await harness({ async invoke(call) { if (call.command === "start_ssh_automation" && ++starts === 2) return startup.promise; } });
  try {
    h.toggle(); await h.task("a", "First task"); await h.start("a"); const first = h.run("a");
    h.emit(first, "session", CONVERSATION); await h.task("a", "Queued task"); await h.start("a");
    h.control("a", "automation-stop").click(); await settle(); h.emit(first, "cancelled", "Stopped"); await settle();
    assert.equal(h.calls.filter(call => call.command === "start_ssh_automation").length, 1);
    h.control("a", "automation-queue-resume").click(); await settle();
    await h.task("a", "Unsent draft"); startup.reject(new Error("CLI unavailable")); await settle();
    assert.equal(h.control<HTMLTextAreaElement>("a", "automation-prompt").value, "Unsent draft");
    assert.match(h.control("a", "automation-queue-list").textContent!, /Queued task/);
    assert.equal(h.control("a", "automation-queue-resume").textContent, "Resume queue");
    assert.equal(h.calls.filter(call => call.command === "start_ssh_automation").length, 2);
    h.control("a", "automation-queue-resume").click(); await settle();
    assert.equal(h.calls.filter(call => call.command === "start_ssh_automation").at(-1)!.arguments_?.prompt, "Queued task");
    assert.equal(h.control<HTMLTextAreaElement>("a", "automation-prompt").value, "Unsent draft");
  } finally { startup.resolve(); h.agent.dispose(); }
});
