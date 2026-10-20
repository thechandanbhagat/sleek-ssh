import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const APPLICATION_SOURCE = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const VIEWPORT_WIDTH = 1024;
const VIEWPORT_HEIGHT = 768;
const MENU_WIDTH = 252;
const MENU_HEIGHT = 172;
const LARGE_SELECTION_LENGTH = 100_000;
const DEFAULT_TERMINAL_COLUMNS = 80;
type EventMock = ReturnType<typeof createEvent>;
type EventHandler = (event: EventMock) => void;
type CellData = { chars: string; width: number };

function createBufferLine(content: (string | CellData)[], columns = DEFAULT_TERMINAL_COLUMNS, isWrapped = false) {
  const cells = Array.from({ length: Math.max(columns, content.length) }, (_, index) => {
    const value = content[index] ?? "";
    return typeof value === "string" ? { chars: value, width: 1 } : value;
  });
  return {
    length: cells.length,
    isWrapped,
    getCell(column: number) {
      const cell = cells[column];
      return cell ? { getChars: () => cell.chars, getWidth: () => cell.width } : undefined;
    },
  };
}

function createEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "keydown",
    code: "KeyC",
    key: overrides.code === "KeyV" ? "v" : "c",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    clientX: 0,
    clientY: 0,
    target: null as ElementMock | null,
    clipboardData: null as { getData(type: string): string } | null,
    defaultPrevented: false,
    propagationStopped: false,
    immediatePropagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    ...overrides,
  };
}

class ElementMock {
  className = "";
  textContent = "";
  type = "";
  tabIndex = 0;
  disabled = false;
  title = "";
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: ElementMock[] = [];
  parent: ElementMock | null = null;
  listeners = new Map<string, Set<EventHandler>>();
  queryChildren = new Map<string, ElementMock>();
  classList = { contains: () => false, add() {}, remove() {} };
  focusCount = 0;
  readonly onFocus: (element: ElementMock) => void;

  constructor(onFocus: (element: ElementMock) => void = () => {}) { this.onFocus = onFocus; }

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name); }
  addEventListener(name: string, handler: EventHandler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(handler);
  }
  removeEventListener(name: string, handler: EventHandler) { this.listeners.get(name)?.delete(handler); }
  dispatch(event: EventMock) {
    event.target ??= this;
    for (const handler of this.listeners.get(event.type) ?? []) {
      handler(event);
      if (event.immediatePropagationStopped) break;
    }
  }
  append(...children: ElementMock[]) { children.forEach(child => this.appendChild(child)); }
  appendChild(child: ElementMock) {
    child.remove();
    this.children.push(child);
    child.parent = this;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  contains(target: ElementMock | null): boolean { return target === this || this.children.some(child => child.contains(target)); }
  focus() { this.focusCount += 1; this.onFocus(this); }
  getBoundingClientRect() {
    return this.className === "terminal-context-menu"
      ? { left: 0, top: 0, width: MENU_WIDTH, height: MENU_HEIGHT }
      : { left: 32, top: 48, width: 600, height: 500 };
  }
  querySelector(selector: string) {
    if (!this.queryChildren.has(selector)) this.queryChildren.set(selector, new ElementMock(this.onFocus));
    return this.queryChildren.get(selector)!;
  }
  querySelectorAll() { return []; }
}

function createHarness(clipboardOverrides: { writeText?: (text: string) => Promise<void>; readText?: () => Promise<string> } = {}) {
  const documentEvents = new ElementMock();
  const windowEvents = new ElementMock();
  const document = {
    activeElement: null as ElementMock | null,
    body: new ElementMock(),
    createElement: () => new ElementMock(element => { document.activeElement = element; }),
    querySelectorAll: () => [],
    getElementsByName: () => [],
    getElementById: (id: string) => documentEvents.querySelector(id),
    querySelector: (selector: string) => documentEvents.querySelector(selector),
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
  };
  const notifications: string[] = [];
  const copied: string[] = [];
  let clipboardReads = 0;
  const clipboard = {
    async writeText(text: string) { copied.push(text); },
    async readText() { clipboardReads += 1; return "clipboard text"; },
    ...clipboardOverrides,
  };
  const selections = new Set<() => void>();
  const term = {
    element: document.createElement(),
    options: {} as Record<string, unknown>,
    cols: DEFAULT_TERMINAL_COLUMNS,
    buffer: {
      active: {
        lines: [createBufferLine([..."all terminal output"]), createBufferLine([])],
        get length() { return this.lines.length; },
        getLine(row: number) { return this.lines[row]; },
      },
    },
    selectedRange: null as null | { column: number; row: number; length: number },
    selection: "",
    pasted: [] as string[],
    focusCount: 0,
    clearCount: 0,
    keyHandler: null as ((event: EventMock) => boolean) | null,
    getSelection() { return this.selection; },
    hasSelection() { return Boolean(this.selection); },
    setSelection(value: string) { this.selection = value; selections.forEach(listener => listener()); },
    clearSelection() { this.clearCount += 1; this.setSelection(""); },
    select(column: number, row: number, length: number) {
      this.selectedRange = { column, row, length };
      this.setSelection("all terminal output");
    },
    focus() { this.focusCount += 1; document.activeElement = this.element; },
    paste(text: string) { this.pasted.push(text); },
    onSelectionChange(callback: () => void) {
      selections.add(callback);
      return { dispose() { selections.delete(callback); } };
    },
    attachCustomKeyEventHandler(handler: (event: EventMock) => boolean) { this.keyHandler = handler; },
    loadAddon() {},
    open() {},
  };
  const session = {
    id: "terminal-tab",
    connectionId: "ssh-transport",
    kind: "ssh",
    isClosed: false,
    isClosing: false,
    isConnecting: false,
    isReady: true,
    term,
    container: document.createElement(),
    terminalInteractions: null as null | { open(event: EventMock): void; close(returnFocus?: boolean): void; refresh(): void; dispose(): void },
  };
  const context = createContext({
    document,
    window: {
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
      __TAURI__: { core: { invoke() {} }, event: { listen() {} } },
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    },
    navigator: { clipboard },
    localStorage: { getItem: () => null },
    console,
    Terminal: function(options: Record<string, unknown>) { term.options = options; return term; },
    FitAddon: { FitAddon: function() { return { fit() {} }; } },
  });
  runInContext(APPLICATION_SOURCE, context, { filename: "src/main.js" });
  Object.assign(context, { session, showNotification: (message: string) => notifications.push(message), initTerminalSearch() {} });
  runInContext("activeSessions[session.id] = session; activeTabId = session.id; createTerminalForSession(session)", context);
  return {
    session, term, clipboard, copied, notifications, document, documentEvents, windowEvents, selections,
    get clipboardReads() { return clipboardReads; },
    get menu() { return document.body.children.find(element => element.className === "terminal-context-menu"); },
    key(event: EventMock) { return term.keyHandler!(event); },
    run<T>(expression: string): T { return runInContext(expression, context) as T; },
  };
}

async function flushClipboard() { await Promise.resolve(); await Promise.resolve(); }

test("Ctrl+C copies Unicode selection then clears it so the next Ctrl+C interrupts", async () => {
  const write = Promise.withResolvers<void>();
  const copied: string[] = [];
  const harness = createHarness({ writeText: text => { copied.push(text); return write.promise; } });
  harness.term.setSelection("résumé 日本語\nsecond line");
  const copy = createEvent();
  assert.equal(harness.key(copy), false);
  assert.equal(copy.defaultPrevented, true);
  assert.deepEqual(copied, [harness.term.selection]);
  assert.equal(harness.term.clearCount, 0);
  write.resolve();
  await flushClipboard();
  assert.equal(harness.term.selection, "");
  assert.equal(harness.term.clearCount, 1);
  const interrupt = createEvent();
  assert.equal(harness.key(interrupt), true);
  assert.equal(interrupt.defaultPrevented, false);
});

test("failed clipboard copy keeps selection and reports the failure", async () => {
  const harness = createHarness({ async writeText() { throw new Error("Access denied"); } });
  harness.term.setSelection("selected output");
  harness.key(createEvent());
  await flushClipboard();
  assert.equal(harness.term.selection, "selected output");
  assert.equal(harness.term.clearCount, 0);
  assert.match(harness.notifications.at(-1)!, /Could not copy selected text: Access denied/);
});

test("copy completion preserves a selection made while clipboard access was pending", async () => {
  const write = Promise.withResolvers<void>();
  const harness = createHarness({ writeText: () => write.promise });
  harness.term.setSelection("same selected text");
  harness.key(createEvent());
  harness.term.setSelection("");
  harness.term.setSelection("same selected text");
  write.resolve();
  await flushClipboard();
  assert.equal(harness.term.selection, "same selected text");
  assert.equal(harness.term.clearCount, 0);
});

test("clipboard copy completion does not touch a disposed terminal", async () => {
  const write = Promise.withResolvers<void>();
  const harness = createHarness({ writeText: () => write.promise });
  harness.term.setSelection("copied before close");
  harness.key(createEvent());
  harness.session.terminalInteractions!.dispose();
  write.resolve();
  await flushClipboard();
  assert.equal(harness.term.clearCount, 0);
});

test("Ctrl+Shift+C retains selected text and consumes empty selection without interrupting", async () => {
  const harness = createHarness();
  const emptyCopy = createEvent({ shiftKey: true });
  assert.equal(harness.key(emptyCopy), false);
  assert.match(harness.notifications.at(-1)!, /Select terminal text/);
  harness.term.setSelection("x".repeat(LARGE_SELECTION_LENGTH));
  harness.key(createEvent({ shiftKey: true }));
  await flushClipboard();
  assert.equal(harness.copied[0].length, LARGE_SELECTION_LENGTH);
  assert.equal(harness.term.selection.length, LARGE_SELECTION_LENGTH);
});

test("empty copy, keyup, and unrelated modifier combinations reach the normal terminal handler", () => {
  const harness = createHarness();
  assert.equal(harness.run("copyTerminalSelection(session.term)"), false);
  assert.equal(harness.key(createEvent({ type: "keyup" })), true);
  assert.equal(harness.key(createEvent({ altKey: true })), true);
  assert.equal(harness.key(createEvent({ ctrlKey: false, code: "KeyV" })), true);
});

test("clipboard shortcuts accept key-only keyboard events with control modifiers", async () => {
  const harness = createHarness();
  harness.term.setSelection("key-only copy");
  const copy = createEvent({ code: "", key: "C" });
  assert.equal(harness.key(copy), false);
  assert.equal(copy.defaultPrevented, true);
  await flushClipboard();
  assert.deepEqual(harness.copied, ["key-only copy"]);
  assert.equal(harness.term.selection, "");
  const paste = createEvent({ code: "", key: "V", shiftKey: true });
  assert.equal(harness.key(paste), false);
  assert.equal(paste.defaultPrevented, true);
  await flushClipboard();
  assert.deepEqual(harness.term.pasted, ["clipboard text"]);
  assert.equal(harness.key(createEvent({ code: "", key: "c", ctrlKey: false })), true);
});

for (const shiftKey of [false, true]) {
  test(`${shiftKey ? "Ctrl+Shift+V" : "Ctrl+V"} pastes exactly once through xterm and suppresses native default`, async () => {
    const harness = createHarness({ async readText() { return "one\r\ntwo\n日本語"; } });
    const paste = createEvent({ code: "KeyV", key: "v", shiftKey });
    assert.equal(harness.key(paste), false);
    assert.equal(paste.defaultPrevented, true);
    assert.equal(paste.propagationStopped, true);
    await flushClipboard();
    assert.deepEqual(harness.term.pasted, ["one\r\ntwo\n日本語"]);
  });
}

test("pending clipboard reads and repeated shortcuts cannot duplicate a paste", async () => {
  const read = Promise.withResolvers<string>();
  let readCount = 0;
  const harness = createHarness({ readText: () => { readCount += 1; return read.promise; } });
  harness.key(createEvent({ code: "KeyV" }));
  harness.key(createEvent({ code: "KeyV" }));
  harness.key(createEvent({ code: "KeyV", repeat: true }));
  const nativePaste = createEvent({ type: "paste", clipboardData: { getData: () => "duplicate native paste" } });
  harness.term.element.dispatch(nativePaste);
  assert.equal(nativePaste.immediatePropagationStopped, true);
  assert.equal(readCount, 1);
  read.resolve("one paste");
  await flushClipboard();
  assert.deepEqual(harness.term.pasted, ["one paste"]);
});

test("native paste routes clipboard event text through xterm once without a second clipboard read", async () => {
  const harness = createHarness();
  let nativeXtermPastes = 0;
  harness.term.element.addEventListener("paste", () => { nativeXtermPastes += 1; });
  const event = createEvent({ type: "paste", clipboardData: { getData: type => type === "text/plain" ? "native text" : "" } });
  harness.term.element.dispatch(event);
  await flushClipboard();
  assert.equal(event.defaultPrevented, true);
  assert.equal(nativeXtermPastes, 0);
  assert.equal(harness.clipboardReads, 0);
  assert.deepEqual(harness.term.pasted, ["native text"]);
});

test("paste errors are visible and release the pending clipboard guard", async () => {
  const harness = createHarness({ async readText() { throw new Error("Read permission denied"); } });
  assert.equal(await harness.run<Promise<boolean>>("pasteTerminalClipboard(session)"), false);
  assert.match(harness.notifications.at(-1)!, /Could not paste clipboard text: Read permission denied/);
  harness.clipboard.readText = async () => "retry";
  assert.equal(await harness.run<Promise<boolean>>("pasteTerminalClipboard(session)"), true);
  assert.deepEqual(harness.term.pasted, ["retry"]);
});

test("unavailable clipboard access reports copy and paste failures without losing selection", async () => {
  const harness = createHarness();
  harness.term.setSelection("selected output");
  harness.run("navigator.clipboard = null");
  harness.key(createEvent());
  await flushClipboard();
  assert.equal(harness.term.selection, "selected output");
  assert.match(harness.notifications.at(-1)!, /Could not copy.*Clipboard access is unavailable/);
  assert.equal(await harness.run<Promise<boolean>>("pasteTerminalClipboard(session)"), false);
  assert.match(harness.notifications.at(-1)!, /Could not paste.*Clipboard access is unavailable/);
});

test("empty clipboard text does not write to the terminal", async () => {
  const harness = createHarness({ async readText() { return ""; } });
  assert.equal(await harness.run<Promise<boolean>>("pasteTerminalClipboard(session)"), false);
  assert.deepEqual(harness.term.pasted, []);
});

for (const state of ["disconnected", "connecting", "closing", "local not ready", "removed session", "missing terminal"]) {
  test(`paste cannot read clipboard for ${state}`, async () => {
    const harness = createHarness();
    if (state === "disconnected") harness.session.isClosed = true;
    if (state === "connecting") harness.session.isConnecting = true;
    if (state === "closing") harness.session.isClosing = true;
    if (state === "local not ready") { harness.session.kind = "local"; harness.session.isReady = false; }
    if (state === "removed session") harness.run("delete activeSessions[session.id]");
    if (state === "missing terminal") harness.run("session.term = null");
    assert.equal(await harness.run<Promise<boolean>>("pasteTerminalClipboard(session)"), false);
    assert.equal(harness.clipboardReads, 0);
    assert.deepEqual(harness.term.pasted, []);
  });
}

test("a ready local terminal can paste without an SSH transport", async () => {
  const harness = createHarness();
  harness.session.kind = "local";
  harness.session.connectionId = "";
  assert.equal(await harness.run<Promise<boolean>>("pasteTerminalClipboard(session)"), true);
  assert.deepEqual(harness.term.pasted, ["clipboard text"]);
});

for (const change of ["reconnect", "close", "replace session", "replace terminal"]) {
  test(`clipboard read completion cannot paste after ${change}`, async () => {
    const read = Promise.withResolvers<string>();
    const harness = createHarness({ readText: () => read.promise });
    const pendingPaste = harness.run<Promise<boolean>>("pasteTerminalClipboard(session)");
    if (change === "reconnect") harness.session.connectionId = "new-transport";
    if (change === "close") harness.session.isClosed = true;
    if (change === "replace session") harness.run("activeSessions[session.id] = { ...session }");
    if (change === "replace terminal") harness.run("session.term = { ...session.term }");
    read.resolve("stale clipboard text");
    assert.equal(await pendingPaste, false);
    assert.deepEqual(harness.term.pasted, []);
    assert.match(harness.notifications.at(-1)!, /connection changed/);
  });
}

test("right click opens explicit actions and preserves selected output", async () => {
  const harness = createHarness();
  harness.term.setSelection("selected output");
  const event = createEvent({ type: "contextmenu", clientX: 100, clientY: 120 });
  harness.term.element.dispatch(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.immediatePropagationStopped, true);
  assert.equal(harness.menu?.getAttribute("role"), "menu");
  assert.deepEqual(harness.menu?.children.map(button => button.children[0].textContent), ["Copy", "Paste", "Select all", "Clear selection"]);
  assert.equal(harness.term.selection, "selected output");
  assert.deepEqual(harness.copied, []);
  harness.menu!.children[0].dispatch(createEvent({ type: "click" }));
  await flushClipboard();
  assert.deepEqual(harness.copied, ["selected output"]);
  assert.equal(harness.term.selection, "selected output");
  assert.equal(harness.menu, undefined);
});

test("menu keyboard navigation skips disabled actions and Escape returns terminal focus", () => {
  const harness = createHarness();
  const event = createEvent({ shiftKey: true, ctrlKey: false, key: "F10", code: "F10" });
  assert.equal(harness.key(event), false);
  const menu = harness.menu!;
  assert.equal(menu.children[0].disabled, true);
  assert.equal(menu.children[3].disabled, true);
  assert.equal(harness.document.activeElement, menu.children[1]);
  menu.dispatch(createEvent({ key: "ArrowDown" }));
  assert.equal(harness.document.activeElement, menu.children[2]);
  menu.dispatch(createEvent({ key: "ArrowDown" }));
  assert.equal(harness.document.activeElement, menu.children[1]);
  menu.dispatch(createEvent({ key: "End" }));
  assert.equal(harness.document.activeElement, menu.children[2]);
  menu.dispatch(createEvent({ key: "Home" }));
  assert.equal(harness.document.activeElement, menu.children[1]);
  menu.dispatch(createEvent({ key: "ArrowUp" }));
  assert.equal(harness.document.activeElement, menu.children[2]);
  menu.dispatch(createEvent({ key: "Escape" }));
  assert.equal(harness.menu, undefined);
  assert.equal(harness.document.activeElement, harness.term.element);
});

test("menu selection actions update availability without copying or clearing on focus", () => {
  const harness = createHarness();
  harness.term.element.dispatch(createEvent({ type: "contextmenu" }));
  harness.menu!.children[2].dispatch(createEvent({ type: "click" }));
  assert.equal(harness.term.selection, "all terminal output");
  harness.term.element.dispatch(createEvent({ type: "contextmenu" }));
  assert.equal(harness.menu!.children[0].disabled, false);
  assert.equal(harness.menu!.children[3].disabled, false);
  harness.menu!.children[3].dispatch(createEvent({ type: "click" }));
  assert.equal(harness.term.selection, "");
  assert.deepEqual(harness.copied, []);
});

test("Select all stops at the final nonblank cell and excludes trailing empty viewport rows", () => {
  const harness = createHarness();
  const lastLine = "prompt$";
  harness.term.buffer.active.lines = [
    createBufferLine([..."first output"]),
    createBufferLine([]),
    createBufferLine([...lastLine, " ", " "]),
    createBufferLine([]),
    createBufferLine([" ", "\t"]),
  ];
  harness.term.element.dispatch(createEvent({ type: "contextmenu" }));
  harness.menu!.children[2].dispatch(createEvent({ type: "click" }));
  assert.deepEqual(harness.term.selectedRange, { column: 0, row: 0, length: DEFAULT_TERMINAL_COLUMNS * 2 + lastLine.length });
});

test("Select all clears an existing selection when the buffer has only blank cells", () => {
  const harness = createHarness();
  harness.term.setSelection("old selection");
  harness.term.buffer.active.lines = [createBufferLine([]), createBufferLine([" ", "\t"])];
  assert.equal(harness.run("selectTerminalOutput(session.term)"), false);
  assert.equal(harness.term.selection, "");
  assert.equal(harness.term.selectedRange, null);
});

test("Select all handles an empty buffer without selecting unused cells", () => {
  const harness = createHarness();
  harness.term.buffer.active.lines = [];
  assert.equal(harness.run("selectTerminalOutput(session.term)"), false);
  assert.equal(harness.term.selectedRange, null);
});

test("Select all keeps wrapped rows and counts wide glyph cells rather than string length", () => {
  const harness = createHarness();
  const columns = 4;
  harness.term.cols = columns;
  harness.term.buffer.active.lines = [
    createBufferLine([..."abcd"], columns),
    createBufferLine([{ chars: "e\u0301", width: 1 }, { chars: "日", width: 2 }, { chars: "", width: 0 }], columns, true),
    createBufferLine([], columns),
  ];
  assert.equal(harness.run("selectTerminalOutput(session.term)"), true);
  assert.deepEqual(harness.term.selectedRange, { column: 0, row: 0, length: columns + 3 });
});

test("Select all includes output through the maximum column and ignores stale cells after resize", () => {
  const harness = createHarness();
  const columns = 4;
  harness.term.cols = columns;
  harness.term.buffer.active.lines = [createBufferLine([..."abcdstale"], columns), createBufferLine([], columns)];
  assert.equal(harness.run("selectTerminalOutput(session.term)"), true);
  assert.deepEqual(harness.term.selectedRange, { column: 0, row: 0, length: columns });
});

test("menu disables paste for disconnected and pending clipboard sessions", async () => {
  const read = Promise.withResolvers<string>();
  const harness = createHarness({ readText: () => read.promise });
  harness.session.isClosed = true;
  harness.term.element.dispatch(createEvent({ type: "contextmenu" }));
  assert.equal(harness.menu!.children[1].disabled, true);
  harness.session.isClosed = false;
  harness.session.terminalInteractions!.refresh();
  assert.equal(harness.menu!.children[1].disabled, false);
  const paste = harness.run<Promise<boolean>>("pasteTerminalClipboard(session)");
  assert.equal(harness.menu!.children[1].disabled, true);
  read.resolve("paste");
  await paste;
  assert.equal(harness.menu!.children[1].disabled, false);
});

test("outside dismissal preserves selection without stealing focus and dispose removes listeners", () => {
  const harness = createHarness();
  harness.term.setSelection("selected text");
  harness.term.element.dispatch(createEvent({ type: "contextmenu" }));
  const outside = harness.document.createElement();
  outside.focus();
  harness.documentEvents.dispatch(createEvent({ type: "pointerdown", target: outside }));
  assert.equal(harness.menu, undefined);
  assert.equal(harness.document.activeElement, outside);
  assert.equal(harness.term.selection, "selected text");
  harness.term.element.dispatch(createEvent({ type: "contextmenu" }));
  harness.session.terminalInteractions!.dispose();
  assert.equal(harness.menu, undefined);
  assert.equal(harness.term.element.listeners.get("contextmenu")!.size, 0);
  assert.equal(harness.term.element.listeners.get("paste")!.size, 0);
  assert.equal(harness.documentEvents.listeners.get("pointerdown")!.size, 0);
  assert.equal(harness.windowEvents.listeners.get("blur")!.size, 0);
  assert.equal(harness.selections.size, 0);
});

test("context menu remains inside the viewport near the lower right corner", () => {
  const harness = createHarness();
  harness.term.element.dispatch(createEvent({ type: "contextmenu", clientX: VIEWPORT_WIDTH, clientY: VIEWPORT_HEIGHT }));
  assert.ok(Number.parseFloat(harness.menu!.style.left) + MENU_WIDTH < VIEWPORT_WIDTH);
  assert.ok(Number.parseFloat(harness.menu!.style.top) + MENU_HEIGHT < VIEWPORT_HEIGHT);
});

test("terminal selection keeps paths intact and uses distinct active, inactive, and cursor colors", () => {
  const harness = createHarness();
  const options = harness.term.options;
  const separators = options.wordSeparator as string;
  for (const character of "/\\.-_~:@") assert.equal(separators.includes(character), false);
  assert.equal(separators.includes(" "), true);
  assert.equal(options.rightClickSelectsWord, false);
  assert.equal(options.macOptionClickForcesSelection, true);
  const theme = options.theme as Record<string, string>;
  assert.notEqual(theme.selectionBackground, theme.selectionInactiveBackground);
  assert.notEqual(theme.selectionBackground, theme.selectionForeground);
  assert.notEqual(theme.cursor, theme.foreground);
});
