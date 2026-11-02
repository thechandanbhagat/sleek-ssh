import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { createAutomationPromptQueue, renderAutomationPromptQueue, AUTOMATION_QUEUE_LIMITS } from "../src/automation-prompt-queue.ts";

const CONTEXT = Object.freeze({ sessionId: "transport-a", contextKey: "ssh-a", provider: "claude" });

test("prompt queues preserve FIFO order, prioritize steering and expose immutable snapshots", () => {
  const queue = createAutomationPromptQueue();
  assert.equal(queue.next(CONTEXT), null);
  queue.prioritize(1); assert.deepEqual(queue.state().prompts, []);
  const first = queue.enqueue("  First question  ", CONTEXT);
  const second = queue.enqueue("Second question", CONTEXT);
  assert.equal(queue.next(CONTEXT), first);
  const steer = queue.enqueue("Focus on logs", CONTEXT, true);
  assert.deepEqual(queue.state().prompts, [steer, first, second]);
  assert.equal(first.text, "First question");
  assert.ok(Object.isFrozen(first) && Object.isFrozen(queue.state()) && Object.isFrozen(queue.state().prompts));
  queue.remove(steer.id); queue.moveEarlier(second.id);
  assert.deepEqual(queue.state().prompts, [second, first]);
  queue.prioritize(first.id); assert.deepEqual(queue.state().prompts, [first, second]);
  queue.prioritize(Number.MAX_SAFE_INTEGER); assert.deepEqual(queue.state().prompts, [first, second]);
  queue.remove(second.id); queue.remove(first.id);
  assert.equal(queue.state().context, null); assert.deepEqual(queue.state().prompts, []);
});

test("queue validation covers empty, null, oversized prompts, invalid contexts and the queue capacity", () => {
  const queue = createAutomationPromptQueue();
  for (const value of [null, "", "  ", "a\0b", "x".repeat(AUTOMATION_QUEUE_LIMITS.characters + 1)]) {
    assert.throws(() => queue.enqueue(value as string, CONTEXT));
  }
  for (const context of [null, {}, { ...CONTEXT, sessionId: "" }, { ...CONTEXT, provider: "other" }]) {
    assert.throws(() => queue.enqueue("Question", context as typeof CONTEXT));
  }
  queue.enqueue("x".repeat(AUTOMATION_QUEUE_LIMITS.characters), CONTEXT);
  for (let index = 1; index < AUTOMATION_QUEUE_LIMITS.prompts; index += 1) queue.enqueue(String(index), CONTEXT);
  assert.equal(queue.state().prompts.length, AUTOMATION_QUEUE_LIMITS.prompts);
  const last = queue.state().prompts.at(-1)!;
  queue.prioritize(last.id); assert.equal(queue.next(CONTEXT), last);
  assert.equal(queue.state().prompts.length, AUTOMATION_QUEUE_LIMITS.prompts);
  assert.throws(() => queue.enqueue("Overflow", CONTEXT), /Queue up to/);
  for (const invalid of [0, -1, NaN, null, 1.5]) {
    assert.throws(() => queue.remove(invalid as number)); assert.throws(() => queue.moveEarlier(invalid as number));
    assert.throws(() => queue.prioritize(invalid as number));
  }
});

test("queues cannot cross sessions or providers and reconnects need explicit resumption", () => {
  const queue = createAutomationPromptQueue(); const first = queue.enqueue("Question", CONTEXT);
  for (const context of [{ ...CONTEXT, contextKey: "ssh-b" }, { ...CONTEXT, provider: "codex" }]) {
    assert.throws(() => queue.enqueue("Other", context));
    assert.throws(() => queue.resume(context));
  }
  const reconnected = { ...CONTEXT, sessionId: "new-transport" };
  assert.throws(() => queue.next(reconnected), /SSH connection or agent changed/);
  assert.equal(queue.state().paused, true); assert.equal(queue.next(CONTEXT), null);
  queue.resume(reconnected); assert.equal(queue.next(reconnected), first);
  queue.pause(); assert.equal(queue.next(reconnected), null);
  queue.remove(first.id); assert.equal(queue.state().paused, false);
});

test("queue controls render literal text with accessible reordering and removal actions", () => {
  const { document } = parseHTML("<ol></ol>"); const root = document.querySelector("ol")!;
  const queue = createAutomationPromptQueue();
  const first = queue.enqueue("<img src=x> First", CONTEXT); const second = queue.enqueue("Second", CONTEXT);
  const actions: string[] = [];
  const callbacks = { remove: (id: number) => { actions.push(`remove:${id}`); }, moveEarlier: (id: number) => { actions.push(`up:${id}`); },
    steer: (id: number) => { actions.push(`steer:${id}`); }, togglePause: () => { actions.push("pause"); } };
  renderAutomationPromptQueue({ root, prompts: queue.state().prompts, pendingId: first.id, paused: false, canSteer: false, toggleDisabled: true, ...callbacks });
  assert.equal(root.querySelector("img"), null);
  const button = (label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  assert.equal(button("Steer with queued prompt 1").disabled, true);
  assert.equal(button("Remove queued prompt 1").disabled, true);
  assert.equal(button("Move queued prompt 2 earlier").disabled, true);
  assert.equal(button("Pause queue").disabled, true);
  button("Remove queued prompt 2").click();
  assert.deepEqual(actions, [`remove:${second.id}`]);
  renderAutomationPromptQueue({ root, prompts: queue.state().prompts, pendingId: null, paused: true, canSteer: true, toggleDisabled: false, ...callbacks });
  assert.match(root.textContent!, /Paused/);
  assert.equal(button("Steer with queued prompt 2").disabled, false); button("Steer with queued prompt 2").click();
  button("Move queued prompt 2 earlier").click(); button("Resume queue").click();
  assert.deepEqual(actions, [`remove:${second.id}`, `steer:${second.id}`, `up:${second.id}`, "pause"]);
  assert.equal(root.querySelector("details")!.open, false);
  renderAutomationPromptQueue({ root, prompts: [], pendingId: null, paused: false, canSteer: false, toggleDisabled: false, ...callbacks });
  assert.equal(root.children.length, 0);
});
