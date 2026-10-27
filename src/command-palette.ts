export type PaletteIcon = "server" | "terminal" | "folder" | "plus" | "ports" | "key" | "shield" | "gear" | "bolt" | "lock" | "form" | "agent" | "search" | "panel" | "close" | "refresh";
export type PaletteStatus = "connected" | "connecting" | "disconnected" | null;
export type PaletteModifiers = Readonly<{ ctrlKey: boolean; shiftKey: boolean }>;
export type PaletteItem = Readonly<{
  id: string;
  group: string;
  title: string;
  /** Monospace text shown after the title, such as the address in "Connect to deploy@host". */
  code?: string;
  subtitle?: string;
  detail?: string;
  keywords?: string;
  icon: PaletteIcon;
  status?: PaletteStatus;
  shortcut?: readonly string[];
  hint?: string;
  run: (modifiers: PaletteModifiers) => void;
}>;
export type ConnectTarget = Readonly<{ username: string | null; host: string; port: number | null }>;
export type PaletteMode = "all" | "connect";
export type RankedItem = Readonly<{ item: PaletteItem; score: number; titleIndices: readonly number[] }>;

type PaletteOptions = {
  root: HTMLElement;
  getItems: () => readonly PaletteItem[];
  getConnectItems: (target: ConnectTarget | null) => readonly PaletteItem[];
  /** Shown under the quick connect actions once the input names a host. */
  connectNote?: string;
  maxItemsPerGroup?: number;
};

const MAX_PORT = 65_535;
const DEFAULT_MAX_ITEMS_PER_GROUP = 8;
const QUICK_CONNECT_GROUP = "Quick connect";
const WORD_BOUNDARY = /[\s\-_./@:\\]/;
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:.]+$/i;
const USER_NAME = /^[a-z0-9_.][a-z0-9_.-]{0,63}$/i;
const PLACEHOLDERS: Record<PaletteMode, string> = {
  all: "Search hosts, shells and commands, or type user@host",
  connect: "Type user@host or user@host:port",
};

const ICONS: Record<PaletteIcon, string> = {
  server: '<rect x="3" y="4" width="18" height="7" rx="2"></rect><rect x="3" y="13" width="18" height="7" rx="2"></rect><path d="M7 7.5h.01M7 16.5h.01"></path>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"></rect><path d="M7 9.5l3 2.5-3 2.5M12.5 15H17"></path>',
  folder: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2h7.4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"></path>',
  plus: '<path d="M12 5v14M5 12h14"></path>',
  ports: '<circle cx="12" cy="12" r="1.8"></circle><path d="M8.1 8.1a5.5 5.5 0 0 0 0 7.8M15.9 8.1a5.5 5.5 0 0 1 0 7.8M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4"></path>',
  key: '<circle cx="8" cy="15" r="4"></circle><path d="M10.9 12.1L19 4M15.5 7.5l2.5 2.5M13.5 9.5l1.5 1.5"></path>',
  shield: '<path d="M12 3l7 3v5.5c0 4.2-2.9 7.7-7 9.5-4.1-1.8-7-5.3-7-9.5V6z"></path>',
  gear: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
  bolt: '<path d="M13 3L5.5 13.5H11L10 21l7.5-10.5H12z"></path>',
  lock: '<rect x="5" y="11" width="14" height="9.5" rx="2"></rect><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"></path>',
  form: '<rect x="4" y="4" width="16" height="16" rx="2.5"></rect><path d="M8 9h8M8 13h8M8 17h5"></path>',
  agent: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1L5 10.5l5.1-1.9z"></path>',
  search: '<circle cx="11" cy="11" r="6.5"></circle><path d="M20 20l-4.2-4.2"></path>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2.5"></rect><path d="M9 4v16"></path>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"></path>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"></path><path d="M20 4.5V9h-4.5"></path>',
};

function validPort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= MAX_PORT ? port : null;
}

/**
 * Reads quick connect input such as `deploy@10.0.4.12:2222`, `ssh deploy@web.test -p 2222`,
 * `web.test:22` or `[::1]:22`. Bare words without a dot, `@` or port return null so that
 * ordinary search text never turns into a connection.
 */
export function parseConnectTarget(input: string): ConnectTarget | null {
  let text = input.trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return null;
  text = text.replace(/^ssh\s+/i, "");
  let explicitPort: number | null = null;
  const trailingFlag = text.match(/^(\S+)\s+-p\s*(\d{1,5})$/i);
  const leadingFlag = text.match(/^-p\s*(\d{1,5})\s+(\S+)$/i);
  if (trailingFlag || leadingFlag) {
    explicitPort = validPort(trailingFlag ? trailingFlag[2] : leadingFlag![1]);
    if (explicitPort === null) return null;
    text = trailingFlag ? trailingFlag[1] : leadingFlag![2];
  }
  if (!text || /\s/.test(text)) return null;
  const at = text.lastIndexOf("@");
  const username = at === -1 ? null : text.slice(0, at);
  if (username !== null && !USER_NAME.test(username)) return null;
  let hostPart = at === -1 ? text : text.slice(at + 1);
  let port: number | null = explicitPort;
  let host: string;
  const bracketed = hostPart.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  if (bracketed) {
    host = bracketed[1];
    if (!IPV6.test(host) || !host.includes(":")) return null;
    if (bracketed[2] !== undefined) {
      if (explicitPort !== null) return null;
      port = validPort(bracketed[2]);
      if (port === null) return null;
    }
  } else {
    const colon = hostPart.lastIndexOf(":");
    if (colon !== -1) {
      if (hostPart.indexOf(":") !== colon || explicitPort !== null) return null;
      port = validPort(hostPart.slice(colon + 1));
      if (port === null) return null;
      hostPart = hostPart.slice(0, colon);
    }
    host = hostPart;
    if (!HOST_NAME.test(host) && !IPV4.test(host)) return null;
    const looksLikeAddress = username !== null || port !== null || host.includes(".") || host.toLowerCase() === "localhost";
    if (!looksLikeAddress) return null;
  }
  return { username, host, port };
}

/** Scores `query` against `text`. Substrings beat scattered characters; word starts score higher. */
export function fuzzyScore(text: string, query: string): { score: number; indices: number[] } | null {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return { score: 0, indices: [] };
  const start = haystack.indexOf(needle);
  if (start !== -1) {
    const atBoundary = start === 0 || WORD_BOUNDARY.test(haystack[start - 1]);
    return {
      score: 100 + (atBoundary ? 30 : 0) + (needle.length === haystack.length ? 20 : 0) - Math.min(start, 40) * 0.5,
      indices: Array.from({ length: needle.length }, (_, index) => start + index),
    };
  }
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const character of needle) {
    const found = haystack.indexOf(character, from);
    if (found === -1) return null;
    indices.push(found);
    score += found === previous + 1 ? 6 : 1;
    if (found === 0 || WORD_BOUNDARY.test(haystack[found - 1])) score += 4;
    previous = found;
    from = found + 1;
  }
  return { score, indices };
}

/** Every query word must match the title, subtitle, detail or keywords. Highlights come from the title. */
export function rankPaletteItems(items: readonly PaletteItem[], query: string): RankedItem[] {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return items.map(item => ({ item, score: 0, titleIndices: [] }));
  const ranked: RankedItem[] = [];
  for (const item of items) {
    let total = 0;
    const titleIndices = new Set<number>();
    let matchedAll = true;
    for (const term of terms) {
      const title = fuzzyScore(item.title, term);
      const others = [
        [item.subtitle, 0.7],
        [item.detail, 0.6],
        [item.keywords, 0.5],
      ].map(([text, weight]) => {
        const result = text ? fuzzyScore(String(text), term) : null;
        return result ? result.score * Number(weight) : 0;
      });
      const best = Math.max(title?.score ?? 0, ...others);
      if (!title && best === 0) { matchedAll = false; break; }
      total += best;
      if (title && title.score >= best) title.indices.forEach(index => titleIndices.add(index));
    }
    if (matchedAll) ranked.push({ item, score: total, titleIndices: [...titleIndices].sort((left, right) => left - right) });
  }
  return ranked;
}

function groupItems(ranked: readonly RankedItem[], sortByScore: boolean, maxPerGroup: number | null): Array<{ group: string; entries: RankedItem[] }> {
  const groups = new Map<string, RankedItem[]>();
  for (const entry of ranked) {
    if (!groups.has(entry.item.group)) groups.set(entry.item.group, []);
    groups.get(entry.item.group)!.push(entry);
  }
  return [...groups.entries()].map(([group, entries]) => {
    const ordered = sortByScore ? entries.slice().sort((left, right) => right.score - left.score) : entries;
    return { group, entries: maxPerGroup === null ? ordered : ordered.slice(0, maxPerGroup) };
  });
}

export function initCommandPalette(options: PaletteOptions) {
  const { root } = options;
  const document_ = root.ownerDocument;
  const control = <T extends HTMLElement>(selector: string): T => {
    const found = root.querySelector<T>(selector);
    if (!found) throw new Error(`Command palette control is missing: ${selector}`);
    return found;
  };
  const input = control<HTMLInputElement>("#palette-input");
  const results = control<HTMLElement>("#palette-results");
  const footerNote = root.querySelector<HTMLElement>("#palette-footer-note");
  const note = root.querySelector<HTMLElement>("#palette-note");
  const modifierHint = root.querySelector<HTMLElement>("#palette-hint-modifier");
  const maxPerGroup = options.maxItemsPerGroup ?? DEFAULT_MAX_ITEMS_PER_GROUP;
  let mode: PaletteMode = "all";
  let visible: RankedItem[] = [];
  let selectedIndex = 0;
  let previousFocus: Element | null = null;
  let open = false;
  let staticItems: readonly PaletteItem[] = [];

  function svg(icon: PaletteIcon, className: string) {
    const span = document_.createElement("span");
    span.className = className;
    span.setAttribute("aria-hidden", "true");
    span.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[icon] ?? ICONS.search}</svg>`;
    return span;
  }

  function highlighted(text: string, indices: readonly number[]) {
    const fragment = document_.createElement("span");
    fragment.className = "palette-item-title";
    if (!indices.length) {
      fragment.textContent = text;
      return fragment;
    }
    const marks = new Set(indices);
    let buffer = "";
    let inMark = false;
    const flush = () => {
      if (!buffer) return;
      if (inMark) {
        const mark = document_.createElement("mark");
        mark.textContent = buffer;
        fragment.appendChild(mark);
      } else {
        fragment.appendChild(document_.createTextNode(buffer));
      }
      buffer = "";
    };
    [...text].forEach((character, index) => {
      const marked = marks.has(index);
      if (marked !== inMark) { flush(); inMark = marked; }
      buffer += character;
    });
    flush();
    return fragment;
  }

  function computeVisible() {
    const query = input.value;
    const target = parseConnectTarget(query);
    if (mode === "connect") {
      const connect = options.getConnectItems(target);
      return { target, groups: groupItems(connect.map(item => ({ item, score: 0, titleIndices: [] })), false, null) };
    }
    const connectGroup = target ? options.getConnectItems(target).map(item => ({ item, score: 0, titleIndices: [] as number[] })) : [];
    const ranked = rankPaletteItems(staticItems, query);
    const hasQuery = Boolean(query.trim());
    return {
      target,
      groups: [
        ...groupItems(connectGroup, false, null),
        ...groupItems(ranked, hasQuery, hasQuery ? null : maxPerGroup),
      ],
    };
  }

  function render() {
    const { target, groups } = computeVisible();
    root.dataset.queryKind = target ? "address" : "text";
    visible = groups.flatMap(group => group.entries);
    selectedIndex = Math.min(Math.max(selectedIndex, 0), Math.max(visible.length - 1, 0));
    const nodes: HTMLElement[] = [];
    let optionIndex = 0;
    groups.forEach((group, groupIndex) => {
      if (!group.entries.length) return;
      const section = document_.createElement("div");
      section.className = "palette-group";
      section.setAttribute("role", "group");
      const labelId = `palette-group-${groupIndex}`;
      section.setAttribute("aria-labelledby", labelId);
      const label = document_.createElement("div");
      label.className = "palette-group-label";
      label.id = labelId;
      label.textContent = group.group;
      section.appendChild(label);
      group.entries.forEach(entry => {
        const index = optionIndex++;
        const { item } = entry;
        const option = document_.createElement("div");
        option.className = "palette-item";
        option.id = `palette-option-${index}`;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(index === selectedIndex));
        option.dataset.index = String(index);
        if (item.group === QUICK_CONNECT_GROUP) option.classList.add("is-connect");
        const icon = svg(item.icon, "palette-item-icon");
        if (item.status) {
          const dot = document_.createElement("span");
          dot.className = `palette-status-dot is-${item.status}`;
          icon.appendChild(dot);
        }
        option.appendChild(icon);
        const text = document_.createElement("span");
        text.className = "palette-item-text";
        const title = highlighted(item.title, entry.titleIndices);
        if (item.code) {
          const code = document_.createElement("code");
          code.className = "palette-item-code";
          code.textContent = item.code;
          title.appendChild(document_.createTextNode(" "));
          title.appendChild(code);
        }
        text.appendChild(title);
        if (item.subtitle) {
          const subtitle = document_.createElement("span");
          subtitle.className = "palette-item-subtitle";
          subtitle.textContent = item.subtitle;
          text.appendChild(subtitle);
        }
        option.appendChild(text);
        const meta = document_.createElement("span");
        meta.className = "palette-item-meta";
        if (item.detail) {
          const detail = document_.createElement("span");
          detail.className = "palette-item-detail";
          detail.textContent = item.detail;
          meta.appendChild(detail);
        }
        if (item.hint) {
          const hint = document_.createElement("span");
          hint.className = "palette-item-hint";
          hint.textContent = item.hint;
          meta.appendChild(hint);
        }
        if (item.shortcut?.length) {
          const keys = document_.createElement("span");
          keys.className = "kbd-group palette-item-keys";
          keys.setAttribute("aria-hidden", "true");
          item.shortcut.forEach(key => {
            const kbd = document_.createElement("kbd");
            kbd.textContent = key;
            keys.appendChild(kbd);
          });
          meta.appendChild(keys);
        }
        option.appendChild(meta);
        section.appendChild(option);
      });
      nodes.push(section);
    });
    if (note) {
      note.hidden = !(options.connectNote && target && visible.some(entry => entry.item.group === QUICK_CONNECT_GROUP));
      const noteText = note.querySelector<HTMLElement>(".palette-note-text");
      if (noteText) noteText.textContent = options.connectNote ?? "";
    }
    if (!nodes.length) {
      const empty = document_.createElement("div");
      empty.className = "palette-empty";
      empty.setAttribute("role", "presentation");
      empty.textContent = mode === "connect"
        ? "Type a user and host, like deploy@10.0.4.12 or deploy@web.test:2222."
        : `Nothing matches “${input.value.trim()}”. Type user@host to connect without saving.`;
      nodes.push(empty);
    }
    results.replaceChildren(...nodes);
    updateSelection(false);
    const connectFirst = visible[0]?.item.group === QUICK_CONNECT_GROUP;
    if (footerNote) {
      footerNote.textContent = mode === "connect" || connectFirst
        ? "Leave out the user or port to use your defaults from Settings"
        : "Type user@host to quick connect";
    }
    if (modifierHint) modifierHint.hidden = connectFirst || mode === "connect";
  }

  function updateSelection(scroll = true) {
    const options = results.querySelectorAll<HTMLElement>('[role="option"]');
    options.forEach(option => option.setAttribute("aria-selected", String(Number(option.dataset.index) === selectedIndex)));
    const selected = results.querySelector<HTMLElement>(`#palette-option-${selectedIndex}`);
    if (selected) {
      input.setAttribute("aria-activedescendant", selected.id);
      if (scroll && typeof selected.scrollIntoView === "function") selected.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function move(delta: number) {
    if (!visible.length) return;
    selectedIndex = (selectedIndex + delta + visible.length) % visible.length;
    updateSelection();
  }

  function runSelected(modifiers: PaletteModifiers) {
    const entry = visible[selectedIndex];
    if (!entry) return;
    close(false);
    entry.item.run(modifiers);
  }

  function openPalette(nextMode: PaletteMode = "all", query = "") {
    if (!open) previousFocus = document_.activeElement;
    mode = nextMode;
    open = true;
    staticItems = mode === "all" ? options.getItems() : [];
    root.hidden = false;
    root.dataset.mode = mode;
    input.placeholder = PLACEHOLDERS[mode];
    input.value = query;
    selectedIndex = 0;
    render();
    input.focus();
    if (query) input.select();
  }

  function close(restoreFocus = true) {
    if (!open) return;
    open = false;
    root.hidden = true;
    input.removeAttribute("aria-activedescendant");
    const target = previousFocus as HTMLElement | null;
    previousFocus = null;
    if (restoreFocus && target && typeof target.focus === "function" && target.isConnected !== false) target.focus();
  }

  const onInput = () => {
    selectedIndex = 0;
    render();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
      event.preventDefault();
      move(-1);
    } else if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      move(event.key === "PageDown" ? 5 : -5);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runSelected({ ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey });
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  const optionFromEvent = (event: Event): HTMLElement | null => {
    const target = event.target as Element | null;
    return typeof target?.closest === "function" ? target.closest('[role="option"]') as HTMLElement | null : null;
  };
  const onPointerMove = (event: Event) => {
    const option = optionFromEvent(event);
    if (!option) return;
    const index = Number(option.dataset.index);
    if (index !== selectedIndex) {
      selectedIndex = index;
      updateSelection(false);
    }
  };
  const onClick = (event: MouseEvent) => {
    const option = optionFromEvent(event);
    if (!option) return;
    selectedIndex = Number(option.dataset.index);
    runSelected({ ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey });
  };
  const onOverlayPointerDown = (event: Event) => {
    if (event.target === root) close();
  };
  const onResultsMouseDown = (event: Event) => event.preventDefault();

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown);
  results.addEventListener("mousemove", onPointerMove);
  results.addEventListener("mousedown", onResultsMouseDown);
  results.addEventListener("click", onClick);
  root.addEventListener("mousedown", onOverlayPointerDown);

  return {
    open: openPalette,
    close: () => close(true),
    isOpen: () => open,
    refresh() { if (open) { staticItems = mode === "all" ? options.getItems() : []; render(); } },
    dispose() {
      close(false);
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKeyDown);
      results.removeEventListener("mousemove", onPointerMove);
      results.removeEventListener("mousedown", onResultsMouseDown);
      results.removeEventListener("click", onClick);
      root.removeEventListener("mousedown", onOverlayPointerDown);
    },
  };
}

declare global {
  interface Window {
    SleekSshCommandPalette?: { initCommandPalette: typeof initCommandPalette; parseConnectTarget: typeof parseConnectTarget };
  }
}

if (typeof window !== "undefined") window.SleekSshCommandPalette = { initCommandPalette, parseConnectTarget };
