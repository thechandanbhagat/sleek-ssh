import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { initTerminalSuggestions, type SuggestionTerminal } from "../src/terminal-suggestions.ts";

const COLUMNS = 40;
const ROWS = 12;
const CELL_WIDTH = 8;
const CELL_HEIGHT = 16;
const MAX_COMMAND_CHARACTERS = 16_000;

function createHarness(configuration: { captureOnEnter?: boolean; commands?: readonly string[]; onError?: (error: unknown) => void; sendError?: Error; onPromptChange?: () => void } = {}) {
  const { document } = parseHTML('<html><body><div id="container"><div id="terminal"><div class="xterm-screen"></div></div></div></body></html>');
  const container = document.getElementById("container")!;
  const element = document.getElementById("terminal")!;
  const screen = element.querySelector<HTMLElement>(".xterm-screen")!;
  container.getBoundingClientRect = () => ({ left: 10, top: 20, width: COLUMNS * CELL_WIDTH, height: ROWS * CELL_HEIGHT }) as DOMRect;
  screen.getBoundingClientRect = () => ({ left: 14, top: 28, width: COLUMNS * CELL_WIDTH, height: ROWS * CELL_HEIGHT }) as DOMRect;
  const listeners = new Map<string, Set<() => void>>();
  const register = (name: string) => (listener: () => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(listener);
    return { dispose: () => { listeners.get(name)!.delete(listener); } };
  };
  type Line = { text: string; isWrapped: boolean };
  let lines: Line[] = [{ text: "$ ", isWrapped: false }];
  let selection = false;
  let commands = configuration.commands ?? ["git status", "git stash", "npm test"];
  let markerDisposed = 0;
  const sent: string[] = [];
  const recorded: string[] = [];
  const buffer = {
    type: "normal", baseY: 0, cursorY: 0, cursorX: 2, viewportY: 0,
    getLine(row: number) {
      const line = lines[row];
      if (!line) return undefined;
      return {
        isWrapped: line.isWrapped, length: COLUMNS,
        getCell(column: number) { return { getChars: () => line.text[column] ?? "", getWidth: () => 1 }; },
        translateToString(trimRight = false, startColumn = 0, endColumn = COLUMNS) {
          const result = line.text.slice(startColumn, endColumn);
          return trimRight ? result.trimEnd() : result;
        },
      };
    },
  };
  const term: SuggestionTerminal = {
    cols: COLUMNS, rows: ROWS, element, buffer: { active: buffer },
    options: { fontFamily: "JetBrains Mono", fontSize: 13, fontWeight: "400", letterSpacing: 0 },
    hasSelection: () => selection,
    registerMarker: () => ({ line: buffer.baseY + buffer.cursorY, dispose: () => { markerDisposed += 1; } }),
    onWriteParsed: register("parsed"), onCursorMove: register("cursor"), onRender: register("render"),
    onScroll: register("scroll"), onResize: register("resize"), onLineFeed: register("lineFeed"),
    onSelectionChange: register("selection"),
  };
  const controller = initTerminalSuggestions({
    term, container, captureOnEnter: configuration.captureOnEnter,
    getCommands: () => commands,
    sendText: text => { if (configuration.sendError) throw configuration.sendError; sent.push(text); },
    onCommand: command => { recorded.push(command); }, onError: configuration.onError,
    onPromptChange: configuration.onPromptChange,
  });
  const emit = (name: string) => listeners.get(name)?.forEach(listener => listener());
  const setInput = (text: string, cursor = text.length) => {
    const rendered = "$ " + text;
    lines = Array.from({ length: Math.max(1, Math.ceil(rendered.length / COLUMNS)) }, (_, index) => ({
      text: rendered.slice(index * COLUMNS, (index + 1) * COLUMNS), isWrapped: index !== 0,
    }));
    const position = "$ ".length + cursor;
    buffer.cursorY = Math.floor(position / COLUMNS);
    buffer.cursorX = position % COLUMNS;
    if (buffer.cursorY === lines.length) lines.push({ text: "", isWrapped: true });
  };
  const key = (key: string, extra: Partial<KeyboardEvent> = {}) => {
    let prevented = false;
    const accepted = controller.handleKeyEvent({
      type: "keydown", key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false,
      preventDefault: () => { prevented = true; }, stopPropagation() {}, ...extra,
    } as KeyboardEvent);
    return { accepted, prevented };
  };
  const lineFeed = () => {
    buffer.cursorY += 1;
    buffer.cursorX = 0;
    lines.push({ text: "", isWrapped: false });
    emit("lineFeed");
  };
  return {
    controller, container, buffer, sent, recorded, emit, setInput, key, lineFeed,
    get ghost() { return container.querySelector<HTMLElement>(".terminal-history-suggestion"); },
    get markerDisposed() { return markerDisposed; },
    get listenerCount() { return [...listeners.values()].reduce((count, set) => count + set.size, 0); },
    setCommands(value: readonly string[]) { commands = value; controller.refresh(); },
    select(value: boolean) { selection = value; emit("selection"); },
    prompt() { controller.handleShellEvent("prompt-start"); setInput(""); controller.handleShellEvent("prompt-end"); },
    edit(text: string, cursor = text.length) { setInput(text, cursor); emit("parsed"); },
    multiline() { lines = [{ text: "$ git", isWrapped: false }, { text: "> status", isWrapped: false }]; buffer.cursorY = 1; buffer.cursorX = 8; emit("parsed"); },
  };
}

test("suggestions appear automatically at a confirmed prompt and Tab inserts only the suffix", () => {
  const harness = createHarness();
  harness.prompt();
  assert.equal(harness.ghost?.hidden, true);
  harness.controller.handleInput("git s");
  harness.edit("git s");
  assert.equal(harness.ghost?.hidden, false);
  assert.equal(harness.ghost?.textContent, "tatus");
  assert.equal(harness.ghost?.getAttribute("aria-hidden"), "true");
  assert.equal(harness.ghost?.style.left, `${4 + 7 * CELL_WIDTH}px`);
  assert.equal(harness.ghost?.style.top, "8px");
  assert.deepEqual(harness.key("Tab"), { accepted: false, prevented: true });
  assert.deepEqual(harness.sent, ["tatus"]);
  assert.equal(harness.ghost?.hidden, true);
  assert.deepEqual(harness.recorded, []);
  harness.edit("git status");
  assert.deepEqual(harness.key("Tab"), { accepted: true, prevented: false });
});

test("Escape dismisses the current prefix and typing a changed prefix restores suggestions", () => {
  const harness = createHarness();
  harness.prompt();
  harness.edit("git");
  assert.deepEqual(harness.key("Escape"), { accepted: false, prevented: true });
  harness.emit("render");
  assert.equal(harness.ghost?.hidden, true);
  assert.deepEqual(harness.key("Tab"), { accepted: true, prevented: false });
  harness.controller.handleInput(" ");
  harness.edit("git ");
  assert.equal(harness.ghost?.hidden, false);
});

test("native Tab and modified keys pass through when no historical completion is visible", () => {
  const harness = createHarness();
  assert.deepEqual(harness.key("Tab"), { accepted: true, prevented: false });
  harness.prompt();
  harness.edit("unknown");
  assert.deepEqual(harness.key("Tab"), { accepted: true, prevented: false });
  harness.edit("git");
  for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { type: "keyup" }]) {
    assert.deepEqual(harness.key("Tab", extra), { accepted: true, prevented: false });
  }
  assert.deepEqual(harness.sent, []);
});

test("pending and partial echoes cannot accept a stale completion", () => {
  const harness = createHarness();
  harness.prompt();
  harness.edit("git");
  harness.controller.handleInput(" s");
  harness.emit("render");
  assert.equal(harness.ghost?.hidden, true);
  assert.equal(harness.key("Tab").accepted, true);
  harness.edit("git ");
  assert.equal(harness.ghost?.hidden, true);
  harness.edit("git s");
  assert.equal(harness.ghost?.textContent, "tatus");
  harness.controller.handleInput("\x7f");
  harness.edit("git ");
  assert.equal(harness.ghost?.textContent, "status");
});

test("native cursor edits show suggestions only at the end of the rendered command", () => {
  const harness = createHarness();
  harness.prompt();
  harness.edit("git stat", 3);
  assert.equal(harness.ghost?.hidden, true);
  assert.equal(harness.key("Tab").accepted, true);
  harness.edit("git stat");
  assert.equal(harness.ghost?.textContent, "us");
  harness.controller.handleInput("\x1b[D");
  harness.edit("git stat", 7);
  assert.equal(harness.ghost?.hidden, true);
  harness.controller.handleInput("\x1b[C");
  harness.edit("git stat");
  assert.equal(harness.ghost?.textContent, "us");
});

test("busy captures the canonical rendered command once after native edits and ignores passwords", () => {
  const harness = createHarness();
  harness.prompt();
  harness.edit("git status");
  harness.key("Enter");
  harness.lineFeed();
  harness.controller.handleShellEvent("command;Z2l0IHN0YXR1cw==");
  harness.controller.handleShellEvent("busy");
  harness.controller.handleShellEvent("busy");
  assert.deepEqual(harness.recorded, ["git status"]);
  harness.controller.handleInput("hidden-password\r");
  harness.edit("hidden-password");
  harness.lineFeed();
  assert.equal(harness.ghost?.hidden, true);
  assert.equal(harness.key("Tab").accepted, true);
  assert.deepEqual(harness.recorded, ["git status"]);
});

test("Cmd Enter recording waits for the complete native echo and line feed", () => {
  const harness = createHarness({ captureOnEnter: true });
  harness.prompt();
  harness.edit("git s");
  harness.controller.handleInput("tatus");
  harness.key("Enter");
  assert.deepEqual(harness.recorded, []);
  harness.setInput("git status");
  harness.lineFeed();
  assert.deepEqual(harness.recorded, ["git status"]);
  harness.controller.handleShellEvent("busy");
  harness.lineFeed();
  assert.deepEqual(harness.recorded, ["git status"]);
});

test("pasted Enter records echoed input without persisting raw pasted or password text", () => {
  const harness = createHarness({ captureOnEnter: true });
  harness.prompt();
  harness.controller.handleInput("git status\r");
  assert.deepEqual(harness.recorded, []);
  harness.setInput("git status");
  harness.lineFeed();
  assert.deepEqual(harness.recorded, ["git status"]);
  harness.controller.handleInput("do-not-record\r");
  harness.setInput("do-not-record");
  harness.lineFeed();
  assert.deepEqual(harness.recorded, ["git status"]);
});

test("Cmd continuation prompts cannot record an incomplete command as an executed entry", () => {
  const harness = createHarness({ captureOnEnter: true });
  for (const command of ["echo first ^", "if exist example (", "for %i in (*) do ("]) {
    harness.prompt();
    harness.edit(command);
    harness.key("Enter");
    harness.lineFeed();
  }
  assert.deepEqual(harness.recorded, []);
  harness.prompt();
  harness.edit("echo ^^");
  harness.key("Enter");
  harness.lineFeed();
  assert.deepEqual(harness.recorded, ["echo ^^"]);
});

test("alternate screens, selections, scrolled views, multiline prompts, and IME suppress suggestions", () => {
  const harness = createHarness();
  harness.prompt();
  harness.edit("git");
  harness.buffer.type = "alternate";
  harness.controller.refresh();
  assert.equal(harness.ghost?.hidden, true);
  harness.buffer.type = "normal";
  harness.select(true);
  assert.equal(harness.ghost?.hidden, true);
  harness.select(false);
  assert.equal(harness.ghost?.hidden, false);
  harness.buffer.viewportY = 1;
  harness.emit("scroll");
  assert.equal(harness.ghost?.hidden, true);
  harness.buffer.viewportY = 0;
  harness.container.dispatchEvent(new harness.container.ownerDocument.defaultView!.Event("compositionstart"));
  assert.equal(harness.ghost?.hidden, true);
  assert.equal(harness.key("Tab").accepted, true);
  harness.container.dispatchEvent(new harness.container.ownerDocument.defaultView!.Event("compositionend"));
  assert.equal(harness.ghost?.hidden, false);
  harness.multiline();
  assert.equal(harness.ghost?.hidden, true);
});

test("wrapped commands complete and record without adding layout line breaks", () => {
  const command = "git " + "x".repeat(COLUMNS) + " status";
  const harness = createHarness({ commands: [command] });
  harness.prompt();
  harness.edit(command.slice(0, -3));
  assert.equal(harness.ghost?.textContent, "tus");
  harness.key("Tab");
  assert.deepEqual(harness.sent, ["tus"]);
  harness.edit(command);
  harness.key("Enter");
  harness.lineFeed();
  harness.controller.handleShellEvent("busy");
  assert.deepEqual(harness.recorded, [command]);
});

test("panel insertion requires a confirmed compatible prompt and never adds Enter", () => {
  const harness = createHarness();
  assert.equal(harness.controller.insert("git status"), false);
  harness.prompt();
  assert.equal(harness.controller.insert("git status"), true);
  assert.deepEqual(harness.sent, ["git status"]);
  harness.edit("git status");
  assert.equal(harness.controller.insert("npm test"), false);
  assert.equal(harness.controller.insert("git status"), true);
  harness.prompt();
  harness.edit("git ");
  assert.equal(harness.controller.insert("git stash"), true);
  assert.deepEqual(harness.sent, ["git status", "stash"]);
  for (const invalid of ["", " ", "a\r", "a\n", "a\x00", "x".repeat(MAX_COMMAND_CHARACTERS + 1), null]) {
    assert.equal(harness.controller.insert(invalid as string), false);
  }
});

test("unsafe and oversized historical commands are not offered as executable completions", () => {
  const harness = createHarness({ commands: ["git\rmalicious", "git\nmalicious", "git\x1bmalicious", "git" + "x".repeat(MAX_COMMAND_CHARACTERS)] });
  harness.prompt();
  harness.edit("git");
  assert.equal(harness.ghost?.hidden, true);
  harness.setCommands(["git status"]);
  assert.equal(harness.ghost?.hidden, false);
  harness.setCommands([]);
  assert.equal(harness.ghost?.hidden, true);
});

test("the maximum command length is accepted without adding execution or control characters", () => {
  const command = "x".repeat(MAX_COMMAND_CHARACTERS);
  const harness = createHarness({ commands: [command] });
  harness.prompt();
  harness.edit("x");
  assert.equal(harness.ghost?.textContent?.length, MAX_COMMAND_CHARACTERS - 1);
  assert.equal(harness.controller.insert(command), true);
  assert.equal(harness.sent[0].length, MAX_COMMAND_CHARACTERS - 1);
  assert.deepEqual(harness.recorded, []);
});

test("send failures are surfaced and keep stale completions hidden", () => {
  const errors: unknown[] = [];
  const failure = new Error("Connection closed");
  const harness = createHarness({ sendError: failure, onError: error => errors.push(error) });
  harness.prompt();
  harness.edit("git");
  harness.key("Tab");
  assert.deepEqual(errors, [failure]);
  assert.equal(harness.ghost?.hidden, true);
  const unhandled = createHarness({ sendError: failure });
  unhandled.prompt();
  unhandled.edit("git");
  assert.throws(() => unhandled.key("Tab"), failure);
});

test("reset and disposal remove markers, listeners, and the overlay and prevent later writes", () => {
  const harness = createHarness();
  harness.prompt();
  harness.edit("git");
  harness.controller.reset();
  assert.equal(harness.ghost?.hidden, true);
  assert.equal(harness.markerDisposed, 1);
  harness.prompt();
  assert(harness.listenerCount > 0);
  harness.controller.dispose();
  harness.controller.dispose();
  assert.equal(harness.markerDisposed, 2);
  assert.equal(harness.listenerCount, 0);
  assert.equal(harness.ghost, null);
  harness.controller.handleShellEvent("prompt-end");
  harness.controller.handleInput("git");
  harness.controller.refresh();
  assert.equal(harness.controller.insert("git status"), false);
  assert.equal(harness.key("Tab").accepted, true);
  assert.deepEqual(harness.sent, []);
});

test("snippet prompt tokens are opaque and stable only at a confirmed empty prompt", async () => {
  const harness = createHarness();
  assert.equal(harness.controller.getPromptToken(), null);
  harness.prompt();
  const token = harness.controller.getPromptToken();
  assert.ok(token);
  assert.equal(Object.isFrozen(token), true);
  for (const event of ["render", "cursor", "resize", "parsed"]) {
    harness.emit(event);
    assert.equal(harness.controller.getPromptToken(), token);
  }
  const writes: string[] = [];
  for (const forged of [null, undefined, {}, Object.freeze({})]) {
    await assert.rejects(harness.controller.sendSnippet("pwd", true, forged as object, async text => { writes.push(text); }), /prompt changed/);
  }
  assert.deepEqual(writes, []);
  assert.equal(harness.controller.getPromptToken(), token);
});

test("typing and erasing cannot revive a previously previewed snippet", async () => {
  const harness = createHarness();
  harness.prompt();
  const token = harness.controller.getPromptToken()!;
  harness.controller.handleInput("x");
  assert.equal(harness.controller.getPromptToken(), null);
  harness.edit("x");
  harness.controller.handleInput("\x7f");
  harness.edit("");
  const replacement = harness.controller.getPromptToken();
  assert.ok(replacement);
  assert.notEqual(replacement, token);
  await assert.rejects(harness.controller.sendSnippet("pwd", true, token, async () => { assert.fail("Stale preview must not write."); }), /prompt changed/);
});

test("snippet previews expire after selection, alternate screens, scrolling, IME, and terminal keys", async () => {
  const transitions = [
    (harness: ReturnType<typeof createHarness>) => { harness.select(true); harness.select(false); },
    (harness: ReturnType<typeof createHarness>) => {
      harness.buffer.type = "alternate"; harness.emit("render");
      harness.buffer.type = "normal"; harness.emit("render");
    },
    (harness: ReturnType<typeof createHarness>) => {
      harness.buffer.viewportY = 1; harness.emit("scroll");
      harness.buffer.viewportY = 0; harness.emit("scroll");
    },
    (harness: ReturnType<typeof createHarness>) => {
      const Event = harness.container.ownerDocument.defaultView!.Event;
      harness.container.dispatchEvent(new Event("compositionstart"));
      harness.container.dispatchEvent(new Event("compositionend"));
    },
    (harness: ReturnType<typeof createHarness>) => { harness.key("ArrowLeft"); },
  ];
  for (const transition of transitions) {
    const harness = createHarness();
    harness.prompt();
    const token = harness.controller.getPromptToken()!;
    transition(harness);
    assert.notEqual(harness.controller.getPromptToken(), token);
    await assert.rejects(harness.controller.sendSnippet("pwd", false, token, async () => { assert.fail("Expired preview must not write."); }), /prompt changed/);
  }
});

test("snippet tokens reject occupied prompts even when ordinary history insertion accepts a matching prefix", async () => {
  const harness = createHarness();
  harness.prompt();
  const token = harness.controller.getPromptToken()!;
  harness.edit("git ");
  assert.equal(harness.controller.getPromptToken(), null);
  await assert.rejects(harness.controller.sendSnippet("git status", true, token, async () => { assert.fail("Occupied prompt must not run."); }), /prompt changed/);
  assert.equal(harness.controller.insert("git status"), true);
  assert.deepEqual(harness.sent, ["status"]);
});

test("typed spaces after the cursor are not an empty snippet prompt", () => {
  const harness = createHarness();
  harness.prompt();
  const token = harness.controller.getPromptToken();
  harness.edit("   ", 0);
  assert.equal(harness.controller.getPromptToken(), null);
  harness.edit("");
  assert.notEqual(harness.controller.getPromptToken(), token);
});

test("snippet Run atomically sends one command and Enter and blocks a duplicate while awaiting the writer", async () => {
  const harness = createHarness();
  const completion = Promise.withResolvers<void>();
  const writes: string[] = [];
  harness.prompt();
  const token = harness.controller.getPromptToken()!;
  const pending = harness.controller.sendSnippet("printf 'café 世界'", true, token, text => {
    writes.push(text);
    assert.equal(harness.controller.getPromptToken(), null);
    return completion.promise;
  });
  assert.deepEqual(writes, ["printf 'café 世界'\r"]);
  assert.deepEqual(harness.recorded, []);
  await assert.rejects(harness.controller.sendSnippet("printf 'café 世界'", true, token, async () => { assert.fail("A duplicate must not write."); }), /prompt changed/);
  completion.resolve();
  await pending;
  assert.deepEqual(harness.recorded, []);
});

test("snippet Insert sends no Enter and waits for echo without recording history", async () => {
  const harness = createHarness({ captureOnEnter: true });
  const writes: string[] = [];
  harness.prompt();
  const token = harness.controller.getPromptToken()!;
  await harness.controller.sendSnippet("git status", false, token, async text => { writes.push(text); });
  assert.deepEqual(writes, ["git status"]);
  assert.equal(harness.controller.getPromptToken(), null);
  harness.edit("git sta");
  assert.equal(harness.controller.getPromptToken(), null);
  harness.edit("git status");
  assert.equal(harness.controller.getPromptToken(), null);
  assert.deepEqual(harness.recorded, []);
});

test("snippet submission rejects missing, empty, oversized, multiline and control-character commands", async () => {
  const harness = createHarness();
  harness.prompt();
  const token = harness.controller.getPromptToken()!;
  for (const command of [null, undefined, "", " ", "pwd\r", "pwd\n", "pwd\t", "pwd\x1b", "pwd\x00", "pwd\x7f", "x".repeat(MAX_COMMAND_CHARACTERS + 1)]) {
    await assert.rejects(harness.controller.sendSnippet(command as string, true, token, async () => { assert.fail("Invalid command must not write."); }), /single-line command/);
  }
  const command = "x".repeat(MAX_COMMAND_CHARACTERS);
  const writes: string[] = [];
  await harness.controller.sendSnippet(command, true, token, async text => { writes.push(text); });
  assert.deepEqual(writes, [command + "\r"]);
});

test("invalid snippet actions do not consume a ready prompt or reach a writer", async () => {
  const harness = createHarness();
  harness.prompt();
  const token = harness.controller.getPromptToken()!;
  await assert.rejects(harness.controller.sendSnippet("pwd", "run" as unknown as boolean, token, async () => { assert.fail("Invalid action must not write."); }), /action is invalid/);
  await assert.rejects(harness.controller.sendSnippet("pwd", false, token, null as unknown as (text: string) => Promise<void>), /action is invalid/);
  assert.equal(harness.controller.getPromptToken(), token);
});

test("synchronous and asynchronous snippet write failures propagate and require a fresh prompt", async () => {
  const failure = new Error("Connection closed");
  for (const write of [() => { throw failure; }, async () => { throw failure; }]) {
    const harness = createHarness();
    harness.prompt();
    const token = harness.controller.getPromptToken()!;
    await assert.rejects(harness.controller.sendSnippet("pwd", true, token, write), failure);
    assert.equal(harness.controller.getPromptToken(), null);
    assert.deepEqual(harness.recorded, []);
    harness.prompt();
    assert.notEqual(harness.controller.getPromptToken(), token);
  }
});

test("prompt transitions, reset, and disposal permanently invalidate snippet previews", async () => {
  const transitions = [
    (harness: ReturnType<typeof createHarness>) => { harness.prompt(); },
    (harness: ReturnType<typeof createHarness>) => { harness.controller.handleShellEvent("prompt-end"); },
    (harness: ReturnType<typeof createHarness>) => { harness.controller.handleShellEvent("busy"); },
    (harness: ReturnType<typeof createHarness>) => { harness.controller.reset(); },
    (harness: ReturnType<typeof createHarness>) => { harness.controller.dispose(); },
  ];
  for (const transition of transitions) {
    const harness = createHarness();
    harness.prompt();
    const token = harness.controller.getPromptToken()!;
    transition(harness);
    await assert.rejects(harness.controller.sendSnippet("pwd", true, token, async () => { assert.fail("Expired prompt must not run."); }), /prompt changed/);
  }
});

test("snippet Run records only canonical echoed commands when the shell reports submission", async () => {
  for (const captureOnEnter of [false, true]) {
    const harness = createHarness({ captureOnEnter });
    harness.prompt();
    await harness.controller.sendSnippet("git status", true, harness.controller.getPromptToken()!, async () => {});
    assert.deepEqual(harness.recorded, []);
    harness.setInput("git status");
    harness.lineFeed();
    if (!captureOnEnter) assert.deepEqual(harness.recorded, []);
    harness.controller.handleShellEvent("busy");
    harness.controller.handleShellEvent("busy");
    harness.lineFeed();
    assert.deepEqual(harness.recorded, ["git status"]);
  }
});

test("prompt change notifications invalidate existing previews without firing when tokens are read", () => {
  let notifications = 0;
  const harness = createHarness({ onPromptChange: () => { notifications += 1; } });
  harness.prompt();
  const token = harness.controller.getPromptToken();
  assert.equal(harness.controller.getPromptToken(), token);
  harness.emit("render");
  assert.equal(notifications, 0);
  harness.select(true);
  assert.equal(notifications, 1);
  assert.equal(harness.controller.getPromptToken(), null);
  assert.equal(notifications, 1);
  harness.select(false);
  assert.ok(harness.controller.getPromptToken());
  harness.controller.handleInput("x");
  assert.equal(notifications, 2);
});
