import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { createTerminalGroups, initPaneDivider, type PaneDirection } from "../src/terminal-panes.ts";

const MAX_SESSION_ID_LENGTH = 256;
const INITIAL_RATIO = 0.5;
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;
const CONTAINER_LEFT = 100;
const CONTAINER_TOP = 50;
const CONTAINER_WIDTH = 1_000;
const CONTAINER_HEIGHT = 600;
const POINTER_ID = 7;
const OTHER_POINTER_ID = 8;

test("terminal groups start empty and return immutable single-pane snapshots", () => {
  const groups = createTerminalGroups();
  assert.deepEqual(groups.all(), []);
  assert.equal(groups.get("missing"), undefined);
  assert.equal(groups.forSession("missing"), undefined);
  const first = groups.add("first");
  assert.deepEqual(first, { id: "first", sessionIds: ["first"], activeSessionId: "first", direction: "right", ratio: INITIAL_RATIO });
  assert.equal(groups.get("first"), first);
  assert.equal(groups.forSession("first"), first);
  assert.ok(Object.isFrozen(groups));
  assert.ok(Object.isFrozen(groups.all()));
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.sessionIds));
  assert.throws(() => (first.sessionIds as string[]).push("injected"));
});

test("terminal IDs validate null, empty, controls, and maximum length across all lookups", () => {
  const groups = createTerminalGroups();
  const maximum = "x".repeat(MAX_SESSION_ID_LENGTH);
  assert.equal(groups.add(maximum).id, maximum);
  for (const invalid of [null, undefined, 0, "", "  ", "line\nfeed", "escape\x1b", "delete\x7f", maximum + "x"]) {
    const id = invalid as string;
    for (const operation of [() => groups.add(id), () => groups.get(id), () => groups.forSession(id),
      () => groups.focus(id), () => groups.resize(id, INITIAL_RATIO), () => groups.remove(id),
      () => groups.split(id, maximum, "right"), () => groups.split(maximum, id, "right")]) {
      assert.throws(operation, /Terminal IDs/);
    }
  }
  assert.equal(groups.all().length, 1);
});

test("splitting merges only a standalone terminal, focuses it, and preserves group order", () => {
  const groups = createTerminalGroups();
  const before = groups.add("before");
  const primary = groups.add("primary");
  groups.add("secondary");
  const after = groups.add("after");
  const split = groups.split("primary", "secondary", "below");
  assert.deepEqual(split, { id: "primary", sessionIds: ["primary", "secondary"], activeSessionId: "secondary", direction: "below", ratio: INITIAL_RATIO });
  assert.deepEqual(groups.all(), [before, split, after]);
  assert.equal(groups.get("secondary"), undefined);
  assert.equal(groups.forSession("secondary"), split);
  assert.deepEqual(primary.sessionIds, ["primary"]);
  assert.equal(primary.activeSessionId, "primary");
  assert.throws(() => groups.add("primary"), /already belongs/);
  assert.throws(() => groups.add("secondary"), /already belongs/);
});

test("split validation rejects missing, same, full, grouped, and invalid-direction targets atomically", () => {
  const groups = createTerminalGroups();
  for (const id of ["first", "second", "third", "fourth", "fifth"]) groups.add(id);
  const original = groups.all();
  assert.throws(() => groups.split("missing", "second", "right"), /tab no longer exists/);
  assert.throws(() => groups.split("first", "missing", "right"), /pane no longer exists/);
  assert.throws(() => groups.split("first", "first", "right"), /different terminal/);
  for (const invalid of [null, undefined, "", "left", 0]) {
    assert.throws(() => groups.split("first", "second", invalid as PaneDirection), /right or below/);
  }
  assert.deepEqual(groups.all(), original);
  groups.split("first", "second", "right");
  groups.split("third", "fourth", "right");
  const full = groups.all();
  assert.throws(() => groups.split("first", "fifth", "below"), /at most 2/);
  assert.throws(() => groups.split("fifth", "fourth", "below"), /at most 2/);
  assert.deepEqual(groups.all(), full);
});

test("focus and resize preserve previous snapshots and respect ratio boundaries", () => {
  const groups = createTerminalGroups();
  groups.add("first");
  groups.add("second");
  const split = groups.split("first", "second", "right");
  const focused = groups.focus("first");
  assert.equal(focused.activeSessionId, "first");
  assert.equal(split.activeSessionId, "second");
  assert.equal(groups.focus("first"), focused);
  assert.equal(groups.resize("first", INITIAL_RATIO), focused);
  for (const ratio of [MIN_RATIO, MAX_RATIO]) assert.equal(groups.resize("first", ratio).ratio, ratio);
  const resized = groups.get("first");
  for (const ratio of [null, undefined, "0.5", Number.NaN, Infinity, -Infinity, MIN_RATIO - 0.001, MAX_RATIO + 0.001]) {
    assert.throws(() => groups.resize("first", ratio as number), /pane ratio/);
  }
  assert.equal(groups.get("first"), resized);
  assert.equal(focused.ratio, INITIAL_RATIO);
  assert.throws(() => groups.focus("missing"), /pane no longer exists/);
  assert.throws(() => groups.resize("missing", INITIAL_RATIO), /tab no longer exists/);
});

test("closing the original pane retains the tab ID and surviving focus until the last pane closes", () => {
  const groups = createTerminalGroups();
  groups.add("first");
  groups.add("second");
  const split = groups.split("first", "second", "below");
  const removed = groups.remove("first");
  assert.ok(Object.isFrozen(removed));
  assert.equal(removed.tabId, "first");
  assert.deepEqual(removed.group, { ...split, sessionIds: ["second"] });
  assert.equal(groups.forSession("first"), undefined);
  assert.equal(groups.forSession("second"), groups.get("first"));
  assert.throws(() => groups.add("first"), /already belongs/);
  const last = groups.remove("second");
  assert.deepEqual(last, { tabId: "first", group: null });
  assert.deepEqual(groups.all(), []);
  assert.throws(() => groups.remove("second"), /pane no longer exists/);
  assert.equal(groups.add("first").id, "first");
});

test("closing the focused second pane focuses its sibling and permits a new split", () => {
  const groups = createTerminalGroups();
  groups.add("first");
  groups.add("second");
  groups.add("third");
  groups.split("first", "second", "right");
  groups.resize("first", MAX_RATIO);
  const result = groups.remove("second");
  assert.equal(result.group?.activeSessionId, "first");
  assert.deepEqual(result.group?.sessionIds, ["first"]);
  const replacement = groups.split("first", "third", "below");
  assert.equal(replacement.ratio, INITIAL_RATIO);
  assert.equal(replacement.activeSessionId, "third");
  assert.deepEqual(replacement.sessionIds, ["first", "third"]);
});

function dividerHarness(direction: PaneDirection = "right", capture = true) {
  const { document, window } = parseHTML('<div id="container"><div id="divider"></div></div>');
  const container = document.getElementById("container") as HTMLElement;
  const handle = document.getElementById("divider") as HTMLElement;
  const changes: number[] = [];
  const captures: number[] = [];
  const releases: number[] = [];
  const captured = new Set<number>();
  let focused = false;
  let ratio = INITIAL_RATIO;
  let width = CONTAINER_WIDTH;
  let height = CONTAINER_HEIGHT;
  handle.focus = () => { focused = true; };
  container.getBoundingClientRect = () => ({ left: CONTAINER_LEFT, top: CONTAINER_TOP, width, height }) as DOMRect;
  if (capture) {
    handle.setPointerCapture = id => { captures.push(id); captured.add(id); };
    handle.hasPointerCapture = id => captured.has(id);
    handle.releasePointerCapture = id => { releases.push(id); captured.delete(id); };
  }
  const options = { handle, container, direction, getRatio: () => ratio, onChange: (next: number) => { changes.push(next); ratio = next; } };
  const divider = initPaneDivider(options);
  const event = (type: string, properties: Record<string, unknown>, target: HTMLElement | Document = handle) => {
    const value = new window.Event(type, { bubbles: true, cancelable: true });
    for (const [key, item] of Object.entries(properties)) Object.defineProperty(value, key, { value: item });
    target.dispatchEvent(value);
    return value;
  };
  return {
    handle, container, document, divider, options, changes, captures, releases,
    get focused() { return focused; },
    get ratio() { return ratio; },
    setExtent(nextWidth: number, nextHeight: number) { width = nextWidth; height = nextHeight; },
    pointer(type: string, x = CONTAINER_LEFT, y = CONTAINER_TOP, properties: Record<string, unknown> = {}) {
      return event(type, { pointerId: POINTER_ID, button: 0, isPrimary: true, clientX: x, clientY: y, ...properties },
        type === "pointerdown" || type === "lostpointercapture" ? handle : document);
    },
    key(key: string, properties: Record<string, unknown> = {}) { return event("keydown", { key, ...properties }); },
  };
}

test("dividers expose named keyboard-accessible separator values for both orientations", () => {
  for (const direction of ["right", "below"] as const) {
    const harness = dividerHarness(direction);
    assert.equal(harness.handle.getAttribute("tabindex"), "0");
    assert.equal(harness.handle.getAttribute("role"), "separator");
    assert.equal(harness.handle.getAttribute("aria-label"), direction === "right" ? "Resize terminal columns" : "Resize terminal rows");
    assert.equal(harness.handle.getAttribute("aria-orientation"), direction === "right" ? "vertical" : "horizontal");
    assert.equal(harness.handle.getAttribute("aria-valuemin"), "20");
    assert.equal(harness.handle.getAttribute("aria-valuemax"), "80");
    assert.equal(harness.handle.getAttribute("aria-valuenow"), "50");
    assert.equal(harness.handle.getAttribute("aria-valuetext"), "First pane 50%");
    assert.deepEqual(harness.changes, []);
  }
});

test("divider construction rejects unavailable elements, invalid directions, ratios, and callbacks", () => {
  const harness = dividerHarness();
  const foreign = parseHTML('<div id="foreign"></div>').document.getElementById("foreign") as HTMLElement;
  for (const invalid of [null, undefined, {}, { ...harness.options, handle: null }, { ...harness.options, container: null },
    { ...harness.options, container: foreign }, { ...harness.options, direction: "left" },
    { ...harness.options, getRatio: null }, { ...harness.options, onChange: null },
    ...[null, Number.NaN, MIN_RATIO - 0.001, MAX_RATIO + 0.001].map(ratio => ({ ...harness.options, getRatio: () => ratio }))]) {
    assert.throws(() => initPaneDivider(invalid as Parameters<typeof initPaneDivider>[0]));
  }
});

test("horizontal and vertical pointer resizing use measured geometry and clamp both ends", () => {
  for (const direction of ["right", "below"] as const) {
    const harness = dividerHarness(direction);
    assert.equal(harness.pointer("pointerdown").defaultPrevented, true);
    assert.equal(harness.focused, true);
    assert.deepEqual(harness.captures, [POINTER_ID]);
    assert.ok(harness.handle.classList.contains("is-dragging"));
    assert.ok(harness.container.classList.contains("terminal-pane-resizing"));
    harness.pointer("pointermove", CONTAINER_LEFT + CONTAINER_WIDTH * 0.65, CONTAINER_TOP + CONTAINER_HEIGHT * 0.65);
    assert.equal(harness.ratio, 0.65);
    assert.equal(harness.handle.getAttribute("aria-valuenow"), "65");
    harness.pointer("pointermove", CONTAINER_LEFT - CONTAINER_WIDTH, CONTAINER_TOP - CONTAINER_HEIGHT);
    assert.equal(harness.ratio, MIN_RATIO);
    harness.pointer("pointermove", CONTAINER_LEFT + CONTAINER_WIDTH * 2, CONTAINER_TOP + CONTAINER_HEIGHT * 2);
    assert.equal(harness.ratio, MAX_RATIO);
    harness.pointer("pointerup");
    assert.deepEqual(harness.releases, [POINTER_ID]);
    assert.equal(harness.handle.classList.contains("is-dragging"), false);
    assert.equal(harness.container.classList.contains("terminal-pane-resizing"), false);
    const count = harness.changes.length;
    harness.pointer("pointermove");
    assert.equal(harness.changes.length, count);
  }
});

test("pointer cancellation and lost capture restore the starting ratio", () => {
  for (const type of ["pointercancel", "lostpointercapture"]) {
    const harness = dividerHarness();
    harness.key("End");
    harness.pointer("pointerdown");
    harness.pointer("pointermove", CONTAINER_LEFT + CONTAINER_WIDTH * MIN_RATIO);
    assert.equal(harness.ratio, MIN_RATIO);
    harness.pointer(type);
    assert.equal(harness.ratio, MAX_RATIO);
    assert.equal(harness.handle.getAttribute("aria-valuenow"), "80");
    assert.equal(harness.handle.classList.contains("is-dragging"), false);
  }
});

test("nonprimary buttons and unrelated pointers cannot start, change, or finish a drag", () => {
  const harness = dividerHarness();
  harness.pointer("pointerdown", 0, 0, { button: 1 });
  harness.pointer("pointerdown", 0, 0, { isPrimary: false });
  harness.pointer("pointermove");
  assert.deepEqual(harness.captures, []);
  assert.deepEqual(harness.changes, []);
  harness.pointer("pointerdown");
  harness.pointer("pointerdown", 0, 0, { pointerId: OTHER_POINTER_ID });
  harness.pointer("pointermove", 0, 0, { pointerId: OTHER_POINTER_ID });
  harness.pointer("pointerup", 0, 0, { pointerId: OTHER_POINTER_ID });
  harness.pointer("pointercancel", 0, 0, { pointerId: OTHER_POINTER_ID });
  assert.deepEqual(harness.captures, [POINTER_ID]);
  assert.deepEqual(harness.releases, []);
  assert.deepEqual(harness.changes, []);
  harness.pointer("pointermove", CONTAINER_LEFT + CONTAINER_WIDTH * 0.6);
  assert.equal(harness.ratio, 0.6);
});

test("hidden or invalid layout measurements do not produce invalid ratios", () => {
  for (const direction of ["right", "below"] as const) {
    const harness = dividerHarness(direction);
    harness.pointer("pointerdown");
    for (const extent of [0, -1, Number.NaN, Infinity]) {
      harness.setExtent(extent, extent);
      harness.pointer("pointermove", CONTAINER_WIDTH, CONTAINER_HEIGHT);
    }
    harness.setExtent(CONTAINER_WIDTH, CONTAINER_HEIGHT);
    harness.pointer("pointermove", Number.NaN, Number.NaN);
    assert.deepEqual(harness.changes, []);
    assert.equal(harness.ratio, INITIAL_RATIO);
  }
});

test("keyboard resizing follows orientation, supports limits, and avoids shortcut modifiers", () => {
  for (const direction of ["right", "below"] as const) {
    const harness = dividerHarness(direction);
    const previous = direction === "right" ? "ArrowLeft" : "ArrowUp";
    const next = direction === "right" ? "ArrowRight" : "ArrowDown";
    assert.equal(harness.key(previous).defaultPrevented, true);
    assert.equal(harness.ratio, 0.45);
    harness.key(next);
    assert.equal(harness.ratio, INITIAL_RATIO);
    harness.key("Home");
    harness.key(previous);
    assert.equal(harness.ratio, MIN_RATIO);
    harness.key("End");
    harness.key(next);
    assert.equal(harness.ratio, MAX_RATIO);
    const count = harness.changes.length;
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      assert.equal(harness.key(previous, modifiers).defaultPrevented, false);
    }
    assert.equal(harness.key(direction === "right" ? "ArrowUp" : "ArrowLeft").defaultPrevented, false);
    assert.equal(harness.key("Enter").defaultPrevented, false);
    assert.equal(harness.changes.length, count);
  }
});

test("divider dragging works without pointer-capture APIs and disposal stops all later interaction", () => {
  const harness = dividerHarness("right", false);
  harness.pointer("pointerdown");
  harness.pointer("pointermove", CONTAINER_LEFT + CONTAINER_WIDTH * 0.6);
  assert.equal(harness.ratio, 0.6);
  harness.divider.dispose();
  harness.divider.dispose();
  assert.equal(harness.handle.classList.contains("is-dragging"), false);
  assert.equal(harness.container.classList.contains("terminal-pane-resizing"), false);
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) harness.pointer(type);
  assert.equal(harness.key("Home").defaultPrevented, false);
  assert.deepEqual(harness.changes, [0.6]);
});

test("disposal releases an active captured pointer without changing pane state", () => {
  const harness = dividerHarness();
  harness.pointer("pointerdown");
  harness.divider.dispose();
  assert.deepEqual(harness.releases, [POINTER_ID]);
  assert.deepEqual(harness.changes, []);
});
