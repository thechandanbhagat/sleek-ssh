type Disposable = Readonly<{ dispose(): void }>;
type TerminalCell = Readonly<{ getChars(): string; getWidth(): number }>;
type TerminalLine = Readonly<{
  isWrapped: boolean;
  length: number;
  getCell(column: number): TerminalCell | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}>;
type TerminalBuffer = Readonly<{
  type: string;
  baseY: number;
  cursorY: number;
  cursorX: number;
  viewportY: number;
  getLine(row: number): TerminalLine | undefined;
}>;
type TerminalMarker = Disposable & Readonly<{ line: number }>;
type TerminalEvent = (listener: () => void) => Disposable;

export type SuggestionTerminal = Readonly<{
  cols: number;
  rows: number;
  element: HTMLElement | undefined;
  buffer: Readonly<{ active: TerminalBuffer }>;
  options?: Readonly<{ fontFamily?: string; fontSize?: number; fontWeight?: string | number; letterSpacing?: number }>;
  hasSelection(): boolean;
  registerMarker?(offset?: number): TerminalMarker | undefined;
  onWriteParsed?: TerminalEvent;
  onCursorMove?: TerminalEvent;
  onRender?: TerminalEvent;
  onScroll?: TerminalEvent;
  onResize?: TerminalEvent;
  onLineFeed?: TerminalEvent;
  onSelectionChange?: TerminalEvent;
}>;

type TerminalSuggestionOptions = Readonly<{
  term: SuggestionTerminal;
  container: HTMLElement;
  getCommands: () => readonly string[];
  sendText: (text: string) => void;
  onCommand?: (command: string) => void;
  onError?: (error: unknown) => void;
  onPromptChange?: () => void;
  captureOnEnter?: boolean;
}>;

type PromptOrigin = Readonly<{ row: number; column: number; marker?: TerminalMarker }>;
type RenderedInput = Readonly<{ text: string; row: number; column: number }>;

const MAX_COMMAND_CHARACTERS = 16_000;
const MAX_COMMAND_ROWS = 256;
const UNSAFE_COMMAND_CHARACTERS = /[\x00-\x1f\x7f]/;
const INPUT_CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const SNIPPET_ENTER = "\r";

export function initTerminalSuggestions(options: TerminalSuggestionOptions) {
  const { term, container } = options;
  const ghost = container.ownerDocument.createElement("span");
  ghost.className = "terminal-history-suggestion";
  ghost.setAttribute("aria-hidden", "true");
  ghost.hidden = true;
  container.appendChild(ghost);
  const subscriptions: Disposable[] = [];
  let origin: PromptOrigin | null = null;
  let ready = false;
  let disposed = false;
  let composing = false;
  let pendingEcho = false;
  let expectedInput: string | null = null;
  let submitted = false;
  let dismissedPrefix: string | null = null;
  let shownPrefix = "";
  let shownSuffix = "";
  let promptToken: object | null = null;

  function invalidatePromptToken() {
    if (promptToken === null) return;
    promptToken = null;
    options.onPromptChange?.();
  }

  function hide() {
    ghost.hidden = true;
    ghost.textContent = "";
    shownPrefix = "";
    shownSuffix = "";
  }

  function reportError(error: unknown) {
    if (options.onError) options.onError(error);
    else throw error;
  }

  function releaseOrigin() {
    origin?.marker?.dispose();
    origin = null;
  }

  function renderedInput(submission = false): RenderedInput | null {
    if (!origin || disposed || (!submission && !ready) || term.buffer.active.type !== "normal" || term.hasSelection()) return null;
    const buffer = term.buffer.active;
    const firstRow = origin.marker?.line ?? origin.row;
    let lastRow = buffer.baseY + buffer.cursorY;
    let lastColumn = buffer.cursorX;
    if (firstRow < 0 || lastRow < firstRow || lastRow - firstRow > MAX_COMMAND_ROWS) return null;
    if (submission && lastRow > firstRow && lastColumn === 0 && !buffer.getLine(lastRow)?.isWrapped) {
      lastRow -= 1;
      lastColumn = term.cols;
    }
    const parts: string[] = [];
    for (let row = firstRow; row <= lastRow; row += 1) {
      const line = buffer.getLine(row);
      if (!line || (row !== firstRow && !line.isWrapped)) return null;
      const startColumn = row === firstRow ? origin.column : 0;
      const endColumn = row === lastRow ? lastColumn : term.cols;
      if (endColumn < startColumn) return null;
      parts.push(line.translateToString(false, startColumn, endColumn));
    }
    const line = buffer.getLine(lastRow);
    if (!submission && (line?.translateToString(true, lastColumn).trim()
      || (buffer.getLine(lastRow + 1)?.isWrapped && buffer.getLine(lastRow + 1)?.translateToString(true).trim()))) return null;
    const text = parts.join("");
    if (text.length > MAX_COMMAND_CHARACTERS || UNSAFE_COMMAND_CHARACTERS.test(text)) return null;
    return { text: submission ? text.trimEnd() : text, row: lastRow, column: lastColumn };
  }

  function positionGhost(input: RenderedInput): boolean {
    const buffer = term.buffer.active;
    const visibleRow = input.row - buffer.viewportY;
    if (buffer.viewportY !== buffer.baseY || visibleRow < 0 || visibleRow >= term.rows || input.column >= term.cols) return false;
    const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return false;
    const screenRect = screen.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const cellWidth = screenRect.width / term.cols;
    const cellHeight = screenRect.height / term.rows;
    if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) return false;
    ghost.style.left = `${screenRect.left - containerRect.left + input.column * cellWidth}px`;
    ghost.style.top = `${screenRect.top - containerRect.top + visibleRow * cellHeight}px`;
    ghost.style.maxWidth = `${(term.cols - input.column) * cellWidth}px`;
    ghost.style.height = `${cellHeight}px`;
    ghost.style.lineHeight = `${cellHeight}px`;
    ghost.style.fontFamily = term.options?.fontFamily ?? "var(--font-mono, monospace)";
    if (term.options?.fontSize !== undefined) ghost.style.fontSize = `${term.options.fontSize}px`;
    if (term.options?.fontWeight !== undefined) ghost.style.fontWeight = String(term.options.fontWeight);
    if (term.options?.letterSpacing !== undefined) ghost.style.letterSpacing = `${term.options.letterSpacing}px`;
    return true;
  }

  function refresh() {
    hide();
    if (!emptyPromptReady()) invalidatePromptToken();
    if (disposed || composing || pendingEcho) return;
    const input = renderedInput();
    if (!input || !input.text.trim() || input.text === dismissedPrefix) return;
    if (dismissedPrefix !== null && dismissedPrefix !== input.text) dismissedPrefix = null;
    try {
      const command = options.getCommands().find(command => typeof command === "string"
        && command.length <= MAX_COMMAND_CHARACTERS && !UNSAFE_COMMAND_CHARACTERS.test(command)
        && command.startsWith(input.text) && command.length > input.text.length);
      if (!command || !positionGhost(input)) return;
      shownPrefix = input.text;
      shownSuffix = command.slice(input.text.length);
      ghost.textContent = shownSuffix;
      ghost.hidden = false;
    } catch (error) {
      reportError(error);
    }
  }

  function captureSubmission() {
    const input = renderedInput(true);
    if (input?.text.trim()) {
      const trailingCarets = input.text.match(/\^+\s*$/)?.[0].trimEnd().length ?? 0;
      // Cmd has not executed a line that is still requesting continuation input.
      if (options.captureOnEnter && (trailingCarets % 2 !== 0 || /\(\s*$/.test(input.text))) return;
      try { options.onCommand?.(input.text); }
      catch (error) { reportError(error); }
    }
  }

  function suspend(submit: boolean) {
    submitted = submit;
    ready = false;
    pendingEcho = false;
    expectedInput = null;
    hide();
    invalidatePromptToken();
  }

  function handleInput(data: string) {
    if (disposed || !ready) return;
    if (data.includes("\r") || data.includes("\n")) {
      suspend(true);
      return;
    }
    if (data.includes("\x03") || data.includes("\x04")) {
      suspend(false);
      return;
    }
    const current = pendingEcho ? expectedInput : renderedInput()?.text ?? null;
    expectedInput = !INPUT_CONTROL_CHARACTERS.test(data) && current !== null ? current + data
      : data === "\x15" ? "" : null;
    pendingEcho = true;
    hide();
    invalidatePromptToken();
  }

  function sendCompletion(text: string) {
    if (!text) return;
    handleInput(text);
    try { options.sendText(text); }
    catch (error) { reportError(error); }
  }

  function handleKeyEvent(event: KeyboardEvent): boolean {
    if (event.type === "keydown") invalidatePromptToken();
    if (disposed || event.type !== "keydown" || event.isComposing || composing) return true;
    if (event.key === "Enter") {
      if (ready) suspend(true);
      return true;
    }
    if (event.key === "Escape" && !ghost.hidden) {
      dismissedPrefix = shownPrefix;
      hide();
      event.preventDefault();
      event.stopPropagation();
      return false;
    }
    if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || ghost.hidden || pendingEcho) return true;
    const input = renderedInput();
    if (!input || input.text !== shownPrefix) { refresh(); return true; }
    const suffix = shownSuffix;
    hide();
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) sendCompletion(suffix);
    return false;
  }

  function handleShellEvent(payload: string) {
    if (disposed) return;
    if (payload === "prompt-start") {
      reset();
    } else if (payload === "prompt-end") {
      releaseOrigin();
      const buffer = term.buffer.active;
      origin = { row: buffer.baseY + buffer.cursorY, column: buffer.cursorX, marker: term.registerMarker?.(0) };
      ready = true;
      submitted = false;
      pendingEcho = false;
      expectedInput = null;
      dismissedPrefix = null;
      invalidatePromptToken();
      refresh();
    } else if (payload === "busy") {
      if (origin && (ready || submitted)) captureSubmission();
      suspend(false);
    }
  }

  function insert(command: string): boolean {
    if (disposed || composing || pendingEcho || typeof command !== "string" || !command.trim()
      || command.length > MAX_COMMAND_CHARACTERS || UNSAFE_COMMAND_CHARACTERS.test(command)) return false;
    const input = renderedInput();
    if (!input || !command.startsWith(input.text)) return false;
    hide();
    sendCompletion(command.slice(input.text.length));
    return true;
  }

  function emptyPromptReady(): boolean {
    if (disposed || composing || pendingEcho || !ready
      || term.buffer.active.viewportY !== term.buffer.active.baseY) return false;
    const input = renderedInput();
    if (!input || input.text !== "") return false;
    const line = term.buffer.active.getLine(input.row);
    if (!line) return false;
    // Typed spaces beyond the cursor are input; empty terminal cells are not.
    for (let column = input.column; column < line.length; column += 1) {
      if (line.getCell(column)?.getChars()) return false;
    }
    return true;
  }

  function getPromptToken(): object | null {
    if (!emptyPromptReady()) {
      invalidatePromptToken();
      return null;
    }
    if (promptToken === null) promptToken = Object.freeze({});
    return promptToken;
  }

  async function sendSnippet(command: string, run: boolean, token: object, write: (text: string) => Promise<void>): Promise<void> {
    if (typeof command !== "string" || !command.trim() || command.length > MAX_COMMAND_CHARACTERS
      || UNSAFE_COMMAND_CHARACTERS.test(command)) {
      throw new Error(`Snippets require a single-line command of at most ${MAX_COMMAND_CHARACTERS} characters without terminal controls.`);
    }
    if (typeof run !== "boolean" || typeof write !== "function") throw new Error("The snippet action is invalid.");
    const current = getPromptToken();
    if (current === null || token !== current) throw new Error("The terminal prompt changed. Review the snippet again at an empty shell prompt.");
    const text = command + (run ? SNIPPET_ENTER : "");
    // Consume the preview before invoking a writer that may synchronously emit terminal events.
    handleInput(text);
    try { await write(text); }
    catch (error) { reset(); throw error; }
  }

  function reset() {
    releaseOrigin();
    ready = false;
    submitted = false;
    pendingEcho = false;
    expectedInput = null;
    dismissedPrefix = null;
    hide();
    invalidatePromptToken();
  }

  const parsed = () => {
    if (pendingEcho) {
      if (expectedInput !== null && renderedInput()?.text !== expectedInput) { hide(); return; }
      pendingEcho = false;
      expectedInput = null;
    }
    refresh();
  };
  const lineFeed = () => {
    if (options.captureOnEnter && submitted) {
      captureSubmission();
      submitted = false;
    }
    hide();
    if (!emptyPromptReady()) invalidatePromptToken();
  };
  for (const event of [term.onCursorMove, term.onRender, term.onScroll, term.onResize, term.onSelectionChange]) {
    if (event) subscriptions.push(event.call(term, refresh));
  }
  if (term.onWriteParsed) subscriptions.push(term.onWriteParsed(parsed));
  if (term.onLineFeed) subscriptions.push(term.onLineFeed(lineFeed));
  const compositionStart = () => { composing = true; hide(); invalidatePromptToken(); };
  const compositionEnd = () => { composing = false; refresh(); };
  container.addEventListener("compositionstart", compositionStart);
  container.addEventListener("compositionend", compositionEnd);

  return {
    handleKeyEvent, handleInput, handleShellEvent, refresh, reset, insert, getPromptToken, sendSnippet,
    dispose() {
      if (disposed) return;
      reset();
      disposed = true;
      subscriptions.forEach(subscription => subscription.dispose());
      container.removeEventListener("compositionstart", compositionStart);
      container.removeEventListener("compositionend", compositionEnd);
      ghost.remove();
    },
  };
}

declare global {
  interface Window {
    SleekSshTerminalSuggestions?: { initTerminalSuggestions: typeof initTerminalSuggestions };
  }
}

if (typeof window !== "undefined") window.SleekSshTerminalSuggestions = { initTerminalSuggestions };
