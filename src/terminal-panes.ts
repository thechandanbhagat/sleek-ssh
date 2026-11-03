export type PaneDirection = "right" | "below";

export interface TerminalTabGroup {
  readonly id: string;
  readonly sessionIds: readonly string[];
  readonly activeSessionId: string;
  readonly direction: PaneDirection;
  readonly ratio: number;
}

interface PaneDividerOptions {
  readonly handle: HTMLElement;
  readonly container: HTMLElement;
  readonly direction: PaneDirection;
  readonly getRatio: () => number;
  readonly onChange: (ratio: number) => void;
}

const MAX_SESSION_ID_LENGTH = 256;
const MAX_PANES = 2;
const DEFAULT_RATIO = 0.5;
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;
const KEYBOARD_RATIO_STEP = 0.05;
const RATIO_PRECISION = 1_000;
const PERCENTAGE_SCALE = 100;

function sessionId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_SESSION_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Terminal IDs must be nonempty text of at most ${MAX_SESSION_ID_LENGTH} characters without control characters.`);
  }
  return value;
}

function paneDirection(value: unknown): PaneDirection {
  if (value !== "right" && value !== "below") throw new Error("Choose a split to the right or below.");
  return value;
}

function paneRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_RATIO || value > MAX_RATIO) {
    throw new Error(`The pane ratio must be between ${MIN_RATIO} and ${MAX_RATIO}.`);
  }
  return value;
}

function snapshot(group: TerminalTabGroup): TerminalTabGroup {
  return Object.freeze({ ...group, sessionIds: Object.freeze([...group.sessionIds]) });
}

export function createTerminalGroups() {
  let groups = new Map<string, TerminalTabGroup>();
  const requireGroup = (id: string) => {
    const group = groups.get(sessionId(id));
    if (!group) throw new Error("The terminal tab no longer exists.");
    return group;
  };
  const forSession = (id: string) => {
    const validated = sessionId(id);
    return [...groups.values()].find(group => group.sessionIds.includes(validated));
  };
  const requireSession = (id: string) => {
    const group = forSession(id);
    if (!group) throw new Error("The terminal pane no longer exists.");
    return group;
  };
  const replace = (group: TerminalTabGroup) => {
    const next = snapshot(group);
    groups = new Map(groups).set(next.id, next);
    return next;
  };

  return Object.freeze({
    add(id: string): TerminalTabGroup {
      const validated = sessionId(id);
      if (groups.has(validated) || forSession(validated)) throw new Error("This terminal already belongs to a tab.");
      return replace({ id: validated, sessionIds: [validated], activeSessionId: validated, direction: "right", ratio: DEFAULT_RATIO });
    },
    get(id: string): TerminalTabGroup | undefined { return groups.get(sessionId(id)); },
    forSession,
    split(tabId: string, secondarySessionId: string, direction: PaneDirection): TerminalTabGroup {
      const primary = requireGroup(tabId);
      const secondary = requireSession(secondarySessionId);
      const validatedDirection = paneDirection(direction);
      if (primary.id === secondary.id) throw new Error("Choose a different terminal for the second pane.");
      if (primary.sessionIds.length >= MAX_PANES || secondary.sessionIds.length !== 1) {
        throw new Error(`A terminal tab can contain at most ${MAX_PANES} panes.`);
      }
      const next = snapshot({ ...primary, sessionIds: [...primary.sessionIds, secondarySessionId],
        activeSessionId: secondarySessionId, direction: validatedDirection, ratio: DEFAULT_RATIO });
      groups = new Map([...groups].filter(([id]) => id !== secondary.id)).set(primary.id, next);
      return next;
    },
    focus(id: string): TerminalTabGroup {
      const group = requireSession(id);
      return group.activeSessionId === id ? group : replace({ ...group, activeSessionId: id });
    },
    resize(id: string, ratio: number): TerminalTabGroup {
      const group = requireGroup(id);
      const validated = paneRatio(ratio);
      return group.ratio === validated ? group : replace({ ...group, ratio: validated });
    },
    remove(id: string): Readonly<{ group: TerminalTabGroup | null; tabId: string }> {
      const group = requireSession(id);
      const remaining = group.sessionIds.filter(candidate => candidate !== id);
      if (!remaining.length) {
        groups = new Map([...groups].filter(([tabId]) => tabId !== group.id));
        return Object.freeze({ group: null, tabId: group.id });
      }
      const next = replace({ ...group, sessionIds: remaining,
        activeSessionId: group.activeSessionId === id ? remaining[0] : group.activeSessionId });
      return Object.freeze({ group: next, tabId: group.id });
    },
    all(): readonly TerminalTabGroup[] { return Object.freeze([...groups.values()]); },
  });
}

export function initPaneDivider(options: PaneDividerOptions) {
  if (!options?.handle?.ownerDocument || !options.container?.getBoundingClientRect
    || options.handle.ownerDocument !== options.container.ownerDocument
    || typeof options.getRatio !== "function" || typeof options.onChange !== "function") {
    throw new Error("The terminal pane divider is unavailable.");
  }
  const { handle, container, getRatio, onChange } = options;
  const direction = paneDirection(options.direction);
  const document = handle.ownerDocument;
  let disposed = false;
  let drag: Readonly<{ pointerId: number; initialRatio: number }> | null = null;
  const setValue = (ratio: number) => {
    const percent = Math.round(ratio * PERCENTAGE_SCALE);
    handle.setAttribute("aria-valuenow", String(percent));
    handle.setAttribute("aria-valuetext", `First pane ${percent}%`);
  };
  const change = (value: number) => {
    const ratio = Math.round(Math.min(MAX_RATIO, Math.max(MIN_RATIO, value)) * RATIO_PRECISION) / RATIO_PRECISION;
    onChange(ratio);
    if (!disposed) setValue(ratio);
  };
  const finish = () => {
    const pointerId = drag?.pointerId;
    drag = null;
    handle.classList.remove("is-dragging");
    container.classList.remove("terminal-pane-resizing");
    if (pointerId !== undefined && typeof handle.releasePointerCapture === "function"
      && (typeof handle.hasPointerCapture !== "function" || handle.hasPointerCapture(pointerId))) {
      handle.releasePointerCapture(pointerId);
    }
  };
  const cancel = (event: PointerEvent) => {
    if (disposed || !drag || event.pointerId !== drag.pointerId) return;
    const initialRatio = drag.initialRatio;
    finish();
    change(initialRatio);
  };
  const down = (event: PointerEvent) => {
    if (disposed || drag || event.button !== 0 || event.isPrimary === false) return;
    drag = { pointerId: event.pointerId, initialRatio: paneRatio(getRatio()) };
    if (typeof handle.setPointerCapture === "function") handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
    container.classList.add("terminal-pane-resizing");
    handle.focus();
    event.preventDefault();
  };
  const move = (event: PointerEvent) => {
    if (disposed || !drag || event.pointerId !== drag.pointerId) return;
    const bounds = container.getBoundingClientRect();
    const extent = direction === "right" ? bounds.width : bounds.height;
    const offset = direction === "right" ? event.clientX - bounds.left : event.clientY - bounds.top;
    if (!Number.isFinite(extent) || extent <= 0 || !Number.isFinite(offset)) return;
    event.preventDefault();
    change(offset / extent);
  };
  const up = (event: PointerEvent) => {
    if (!disposed && drag?.pointerId === event.pointerId) finish();
  };
  const key = (event: KeyboardEvent) => {
    if (disposed || event.altKey || event.ctrlKey || event.metaKey) return;
    const previous = direction === "right" ? "ArrowLeft" : "ArrowUp";
    const next = direction === "right" ? "ArrowRight" : "ArrowDown";
    if (![previous, next, "Home", "End"].includes(event.key)) return;
    const current = paneRatio(getRatio());
    event.preventDefault();
    event.stopPropagation();
    change(event.key === "Home" ? MIN_RATIO : event.key === "End" ? MAX_RATIO
      : current + (event.key === previous ? -KEYBOARD_RATIO_STEP : KEYBOARD_RATIO_STEP));
  };

  handle.classList.add("terminal-pane-divider");
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-label", direction === "right" ? "Resize terminal columns" : "Resize terminal rows");
  handle.setAttribute("aria-orientation", direction === "right" ? "vertical" : "horizontal");
  handle.setAttribute("aria-valuemin", String(MIN_RATIO * PERCENTAGE_SCALE));
  handle.setAttribute("aria-valuemax", String(MAX_RATIO * PERCENTAGE_SCALE));
  setValue(paneRatio(getRatio()));
  handle.addEventListener("pointerdown", down);
  handle.addEventListener("lostpointercapture", cancel);
  handle.addEventListener("keydown", key);
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", cancel);

  return Object.freeze({ dispose() {
    if (disposed) return;
    disposed = true;
    finish();
    handle.removeEventListener("pointerdown", down);
    handle.removeEventListener("lostpointercapture", cancel);
    handle.removeEventListener("keydown", key);
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", cancel);
  } });
}

declare global {
  interface Window {
    SleekSshPanes?: { createTerminalGroups: typeof createTerminalGroups; initPaneDivider: typeof initPaneDivider };
  }
}

if (typeof window !== "undefined") window.SleekSshPanes = { createTerminalGroups, initPaneDivider };
