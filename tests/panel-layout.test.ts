import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const APPLICATION_SOURCE = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const LAYOUT_SOURCE = APPLICATION_SOURCE.split("// --- PANEL LAYOUT ---")[1].split("// --- WINDOW CONTROLS ---")[0];
const STORAGE_KEY = "sleekssh_panel_layout";
const SIDEBAR_DEFAULT = 248;
const SFTP_DEFAULT = 280;
const TERMINAL_MINIMUM = 320;
const WIDE_WINDOW = 1200;
const COMPACT_WINDOW = 700;
const NARROW_WINDOW = 480;
const KEYBOARD_STEP = 16;
const PANEL_MINIMUMS_WIDTH = 740;

type EventListener = (event: Record<string, unknown>) => void;

function createElement(width = 0) {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const listeners = new Map<string, EventListener>();
  const capturedPointers = new Set<number>();
  return {
    hidden: false,
    inert: false,
    title: "",
    measuredWidth: width,
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
      toggle(name: string, enabled: boolean) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      }
    },
    style: { setProperty() {} },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name),
    getBoundingClientRect() { return { width: this.measuredWidth }; },
    addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
    setPointerCapture: (id: number) => capturedPointers.add(id),
    hasPointerCapture: (id: number) => capturedPointers.has(id),
    releasePointerCapture: (id: number) => capturedPointers.delete(id),
    focus() {},
    emit(name: string, event: Record<string, unknown>) {
      listeners.get(name)?.({ preventDefault() {}, ...event });
    },
    listeners
  };
}

function createHarness(savedLayout?: string) {
  const storage = new Map<string, string>();
  if (savedLayout !== undefined) storage.set(STORAGE_KEY, savedLayout);
  const app = createElement(WIDE_WINDOW);
  const sidebar = createElement(SIDEBAR_DEFAULT);
  const body = createElement();
  const sidebarToggle = createElement();
  const sidebarHandle = createElement();
  const notifications: string[] = [];
  const warnings: unknown[] = [];
  const context = createContext({
    activeSessions: {},
    activeTabId: null,
    document: {
      body,
      querySelector: (selector: string) => ({ ".app-container": app, ".sidebar": sidebar }[selector]),
      getElementById: (id: string) => ({ "btn-sidebar-toggle": sidebarToggle, "sidebar-resize-handle": sidebarHandle }[id])
    },
    window: { addEventListener() {} },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    },
    console: { warn: (...arguments_: unknown[]) => warnings.push(arguments_), error() {} },
    showNotification: (message: string) => notifications.push(message),
    fitTerminal() {}
  });
  runInContext(LAYOUT_SOURCE, context);
  const widths = (total: unknown, sidebarWidth: unknown = SIDEBAR_DEFAULT, sftpWidth: unknown = SFTP_DEFAULT, sidebarOpen = true, sftpOpen = true) => {
    Object.assign(context, { total, sidebarWidth, sftpWidth, sidebarOpen, sftpOpen });
    return JSON.parse(JSON.stringify(runInContext("getPanelLayoutWidths(total, sidebarWidth, sftpWidth, sidebarOpen, sftpOpen)", context)));
  };
  const preferences = () => JSON.parse(JSON.stringify(runInContext("panelLayoutPreferences", context)));
  return { context, app, sidebar, body, sidebarToggle, sidebarHandle, storage, warnings, notifications, widths, preferences };
}

test("wide layouts use smaller default panels and preserve terminal space", () => {
  const harness = createHarness();
  assert.deepEqual(harness.widths(WIDE_WINDOW), {
    sidebarWidth: SIDEBAR_DEFAULT,
    sftpWidth: SFTP_DEFAULT,
    terminalWidth: WIDE_WINDOW - SIDEBAR_DEFAULT - SFTP_DEFAULT,
    sidebarAutoCollapsed: false,
    sftpAutoCollapsed: false
  });
});

test("panels clamp to their minimums before collapsing", () => {
  const harness = createHarness();
  const widths = harness.widths(PANEL_MINIMUMS_WIDTH, 360, 420);
  assert.equal(widths.sidebarWidth, 200);
  assert.equal(widths.sftpWidth, 220);
  assert.equal(widths.terminalWidth, TERMINAL_MINIMUM);
  assert.equal(widths.sftpAutoCollapsed, false);
});

test("compact windows collapse files first and narrow windows collapse both panels", () => {
  const harness = createHarness();
  assert.equal(harness.widths(COMPACT_WINDOW).sftpWidth, 0);
  assert.equal(harness.widths(COMPACT_WINDOW).sftpAutoCollapsed, true);
  assert.equal(harness.widths(NARROW_WINDOW).sidebarWidth, 0);
  assert.equal(harness.widths(NARROW_WINDOW).sftpWidth, 0);
  assert.equal(harness.widths(NARROW_WINDOW).terminalWidth, NARROW_WINDOW);
});

test("closing the sidebar lets a file panel fit in a compact window", () => {
  const harness = createHarness();
  const widths = harness.widths(COMPACT_WINDOW, SIDEBAR_DEFAULT, SFTP_DEFAULT, false);
  assert.equal(widths.sidebarWidth, 0);
  assert.equal(widths.sftpWidth, SFTP_DEFAULT);
  assert.ok(widths.terminalWidth >= TERMINAL_MINIMUM);
});

test("invalid, empty, null and extreme widths remain bounded", () => {
  const harness = createHarness();
  for (const invalidWidth of [null, undefined, "", NaN, Infinity, -Infinity]) {
    const widths = harness.widths(WIDE_WINDOW, invalidWidth, invalidWidth);
    assert.equal(widths.sidebarWidth, SIDEBAR_DEFAULT);
    assert.equal(widths.sftpWidth, SFTP_DEFAULT);
  }
  assert.equal(harness.widths(WIDE_WINDOW, Number.MAX_VALUE, Number.MAX_VALUE).sidebarWidth, 360);
  assert.equal(harness.widths(WIDE_WINDOW, -1, -1).sidebarWidth, 200);
  for (const invalidTotal of [null, undefined, "", NaN, Infinity, -1, 0]) {
    assert.equal(harness.widths(invalidTotal).terminalWidth, 0);
  }
});

test("saved layout validates each preference and recovers corrupt JSON", () => {
  const invalidHarness = createHarness('{"sidebarWidth":"wide","sftpWidth":99999,"sidebarOpen":"false"}');
  invalidHarness.context.initPanelLayout();
  assert.deepEqual(invalidHarness.preferences(), { sidebarWidth: SIDEBAR_DEFAULT, sftpWidth: 420, sidebarOpen: true });
  for (const savedLayout of ["{", "null", "[]", "", "false"]) {
    const harness = createHarness(savedLayout);
    harness.context.initPanelLayout();
    assert.deepEqual(harness.preferences(), { sidebarWidth: SIDEBAR_DEFAULT, sftpWidth: SFTP_DEFAULT, sidebarOpen: true });
  }
});

test("sidebar visibility updates focus access and persists only the requested state", () => {
  const harness = createHarness();
  harness.context.initPanelLayout();
  harness.context.toggleSidebarPanel();
  assert.equal(harness.sidebar.inert, true);
  assert.equal(harness.sidebarToggle.getAttribute("aria-expanded"), "false");
  assert.equal(JSON.parse(harness.storage.get(STORAGE_KEY)!).sidebarOpen, false);
  harness.context.toggleSidebarPanel();
  assert.equal(harness.sidebar.inert, false);
  harness.app.measuredWidth = NARROW_WINDOW;
  harness.context.refreshPanelLayout();
  assert.equal(harness.sidebar.inert, true);
  assert.equal(harness.preferences().sidebarOpen, true);
});

test("sidebar separator arrow keys resize from its measured width", () => {
  const harness = createHarness();
  harness.context.initPanelLayout();
  harness.sidebar.measuredWidth = 220;
  harness.sidebarHandle.emit("keydown", { key: "ArrowRight", shiftKey: false });
  assert.equal(harness.preferences().sidebarWidth, 220 + KEYBOARD_STEP);
  harness.sidebarHandle.emit("keydown", { key: "Home" });
  assert.equal(harness.preferences().sidebarWidth, 200);
  harness.sidebarHandle.emit("keydown", { key: "End" });
  assert.equal(harness.preferences().sidebarWidth, 360);
});

test("file separator arrows grow toward the left and dispose active captures", () => {
  const harness = createHarness();
  const handle = createElement();
  Object.assign(harness.context, { handle });
  const dispose = runInContext("bindPanelResizeHandle(handle, 'sftp', () => 240)", harness.context);
  handle.emit("keydown", { key: "ArrowLeft", shiftKey: false });
  assert.equal(harness.preferences().sftpWidth, 240 + KEYBOARD_STEP);
  handle.emit("pointerdown", { button: 0, pointerId: 1, clientX: 100 });
  handle.emit("pointermove", { pointerId: 1, clientX: 60 });
  assert.equal(harness.preferences().sftpWidth, 280);
  assert.equal(handle.hasPointerCapture(1), true);
  dispose();
  assert.equal(handle.hasPointerCapture(1), false);
  assert.equal(handle.listeners.size, 0);
  assert.equal(harness.body.classList.contains("panel-resizing"), false);
  assert.equal(harness.preferences().sftpWidth, 240 + KEYBOARD_STEP);
});

test("pointer cancellation restores the stored size while pointer up saves the resized value", () => {
  const harness = createHarness();
  harness.context.initPanelLayout();
  harness.sidebarHandle.emit("pointerdown", { button: 0, pointerId: 2, clientX: 100 });
  harness.sidebarHandle.emit("pointermove", { pointerId: 2, clientX: 150 });
  harness.sidebarHandle.emit("pointercancel", { pointerId: 2 });
  assert.equal(harness.preferences().sidebarWidth, SIDEBAR_DEFAULT);
  assert.equal(harness.storage.has(STORAGE_KEY), false);
  harness.sidebarHandle.emit("pointerdown", { button: 0, pointerId: 3, clientX: 100 });
  harness.sidebarHandle.emit("pointermove", { pointerId: 3, clientX: 150 });
  harness.sidebarHandle.emit("pointerup", { pointerId: 3 });
  assert.equal(JSON.parse(harness.storage.get(STORAGE_KEY)!).sidebarWidth, SIDEBAR_DEFAULT + 50);
});
