import type { AutomationUiState, initAutomation } from "./automation.ts";

type Controller = ReturnType<typeof initAutomation>;
type CoreOptions = Parameters<typeof initAutomation>[0];
type Target = NonNullable<ReturnType<CoreOptions["getSelectedTarget"]>>;
type SessionEntry = {
  view: HTMLElement;
  controls: Map<string, HTMLElement>;
  controller: Controller | null;
  state: AutomationUiState;
  open: boolean;
};
type RunOwner = Readonly<{ key: string; transport: string; provider: string }>;
export type AutomationSessionsOptions = Omit<CoreOptions, "getSelectedTarget" | "getControl" | "isVisible"> & Readonly<{
  getSelectedSessionKey: () => string | null;
  getTargetForSession: (key: string) => Target | null;
  onFiles: () => void;
  onHistory: () => void;
  onSnippets: () => void;
  onError: (message: string) => void;
}>;

const EMPTY_STATE: AutomationUiState = Object.freeze({ open: false, running: false, review: false, targetSessionId: null });
const PROVIDER_KEY = "sleekssh_automation_provider";
const ID_REFERENCE_ATTRIBUTES = ["for", "aria-labelledby", "aria-describedby", "aria-controls"];
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const chatKey = (provider: unknown, id: unknown) => JSON.stringify([provider, typeof id === "string" ? id.toLowerCase() : id]);

export function initAutomationSessions(options: AutomationSessionsOptions, createAutomation: typeof initAutomation) {
  const document_ = options.document ?? document;
  const foundRoot = document_.getElementById("automation-panel");
  const foundToggle = document_.getElementById("btn-automation-toggle") as HTMLButtonElement | null;
  if (!foundRoot || !foundToggle) throw new Error("SSH session agent controls are missing.");
  const root = foundRoot;
  const toggle = foundToggle;
  const activity = document_.createElement("span");
  activity.className = "automation-toggle-progress";
  activity.setAttribute("role", "progressbar");
  activity.setAttribute("aria-label", "Agent running");
  const template = root.cloneNode(true) as HTMLElement;
  root.replaceChildren();
  const entries = new Map<string, SessionEntry>();
  const closedSessions = new Set<string>();
  const runs = new Map<string, RunOwner>();
  const chatOwners = new Map<string, string>();
  const listeners = new Set<(event: { payload: unknown }) => void>();
  let selectedKey: string | null = null;
  let sequence = 0;
  let refreshing = false;
  let disposed = false;
  let unlisten: (() => void) | null = null;
  const listenerReady = options.listen("ssh-automation-event", event => {
    const payload = event.payload as Record<string, unknown> | null;
    if (payload && typeof payload === "object" && typeof payload.run_id === "string") {
      const owner = runs.get(payload.run_id);
      if (owner && payload.session_id === owner.transport) {
        if (payload.kind === "session" && typeof payload.message === "string" && CONVERSATION_ID.test(payload.message)) {
          const conversationKey = chatKey(owner.provider, payload.message);
          const existing = chatOwners.get(conversationKey);
          if (existing && existing !== owner.key) {
            options.onError("The agent returned a chat belonging to another SSH session. This run is being stopped.");
            void (async () => {
              try { await options.invoke("stop_ssh_automation", { runId: payload.run_id }); }
              catch (error) { options.onError(`Could not stop the conflicting agent: ${String(error)}`); }
            })();
            return;
          }
          chatOwners.set(conversationKey, owner.key);
        }
        if (["completed", "failed", "cancelled"].includes(String(payload.kind))) runs.delete(payload.run_id);
      }
    }
    if (!disposed) listeners.forEach(listener => listener(event));
  });
  void (async () => {
    try { const dispose = await listenerReady; if (disposed) dispose(); else unlisten = dispose; }
    catch (error) { if (!disposed) options.onError(`Agent events could not connect: ${String(error)}`); }
  })();

  function publish() {
    if (disposed) return;
    const entry = selectedKey ? entries.get(selectedKey) : undefined;
    const state = entry ? { ...entry.state, open: entry.open } : EMPTY_STATE;
    root.hidden = !state.open;
    root.dataset.running = String(state.running);
    root.querySelectorAll<HTMLElement>('[data-automation-control="automation-attention"]').forEach(dot => {
      const entry = [...entries.values()].find(candidate => candidate.view.contains(dot));
      dot.hidden = !entry?.state.review;
    });
    toggle.disabled = !selectedKey;
    toggle.setAttribute("aria-expanded", String(state.open));
    toggle.dataset.state = state.review ? "review" : state.running ? "running" : "idle";
    const toggleLabel = state.review ? "Approval needed" : state.running ? "Agent running" : "Agent";
    if (state.running && !state.review) { if (toggle.children[0] !== activity) toggle.replaceChildren(activity); }
    else toggle.textContent = toggleLabel;
    toggle.setAttribute("aria-label", toggleLabel);
    toggle.setAttribute("title", toggleLabel);
    const title = entry?.controls.get("automation-title");
    if (title) root.setAttribute("aria-labelledby", title.id);
    options.onStateChange?.(state);
  }

  function targetFor(key: string): Target | null {
    const target = options.getTargetForSession(key);
    return target ? { ...target, historyContextKey: target.contextKey, contextKey: JSON.stringify(["ssh-session", key]) } : null;
  }

  function createEntry(key: string): SessionEntry {
    const view = document_.createElement("div");
    view.className = "automation-session-view"; view.hidden = true; view.dataset.sessionKey = key;
    view.append(...[...template.childNodes].map(node => node.cloneNode(true)));
    const controls = new Map<string, HTMLElement>([["automation-panel", view], ["btn-automation-toggle", document_.createElement("button")]]);
    const prefix = `agent-session-${++sequence}-`;
    view.querySelectorAll<HTMLElement>("[id]").forEach(element => {
      const id = element.id; controls.set(id, element); element.id = prefix + id;
      element.dataset.automationControl = id;
    });
    view.querySelectorAll<HTMLElement>("*").forEach(element => {
      ID_REFERENCE_ATTRIBUTES.forEach(attribute => {
        const reference = element.getAttribute(attribute);
        if (reference) element.setAttribute(attribute, reference.split(/\s+/).map(id => controls.get(id)?.id ?? id).join(" "));
      });
    });
    root.append(view);
    const entry: SessionEntry = { view, controls, controller: null, state: EMPTY_STATE, open: false };
    entries.set(key, entry);
    controls.get("automation-files-tab")?.addEventListener("click", () => {
      if (!disposed && selectedKey === key && entries.has(key)) options.onFiles();
    });
    controls.get("automation-history-tab")?.addEventListener("click", () => {
      if (!disposed && selectedKey === key && entries.has(key)) options.onHistory();
    });
    controls.get("automation-snippets-tab")?.addEventListener("click", () => {
      if (!disposed && selectedKey === key && entries.has(key)) options.onSnippets();
    });
    let storage = options.storage;
    if (storage === undefined) {
      try { storage = document_.defaultView?.localStorage ?? null; }
      catch (error) { storage = null; options.onError(`Agent chat storage is unavailable: ${String(error)}`); }
    }
    const sessionStorage = storage;
    const storageKey = (name: string) => name === PROVIDER_KEY ? `${name}:${key}` : name;
    entry.controller = createAutomation({
      ...options, document: document_,
      storage: sessionStorage ? {
        getItem: name => sessionStorage.getItem(storageKey(name)),
        setItem: (name, value) => sessionStorage.setItem(storageKey(name), value),
        removeItem: name => sessionStorage.removeItem(storageKey(name)),
      } : null,
      getControl: id => controls.get(id) ?? null,
      isVisible: () => !disposed && selectedKey === key,
      getSelectedTarget: () => targetFor(key),
      async listen(_name, callback) {
        await listenerReady;
        listeners.add(callback);
        return () => { listeners.delete(callback); };
      },
      async invoke(command, arguments_) {
        if (disposed || !entries.has(key)) throw new Error("This SSH session's agent is closed.");
        const start = command === "start_ssh_automation";
        const runId = arguments_?.runId;
        let claimedChat: string | null = null;
        if (command === "get_local_agent_history") {
          const conversationKey = chatKey(arguments_?.provider, arguments_?.sessionId);
          const owner = chatOwners.get(conversationKey);
          if (owner && owner !== key) throw new Error("This chat belongs to another SSH session. Choose New chat for this session.");
          if (!owner) { chatOwners.set(conversationKey, key); claimedChat = conversationKey; }
        }
        if (start) {
          const target = targetFor(key);
          if (!target || target.sessionId !== arguments_?.sessionId) throw new Error("This SSH connection changed. Start the task again in its session.");
          const conversationKey = chatKey(arguments_?.provider, arguments_?.resumeSessionId);
          const owner = arguments_?.resumeSessionId ? chatOwners.get(conversationKey) : undefined;
          if (owner && owner !== key) throw new Error("This chat belongs to another SSH session. Choose New chat for this session.");
          if (arguments_?.resumeSessionId && !owner) { chatOwners.set(conversationKey, key); claimedChat = conversationKey; }
          runs.set(String(runId), { key, transport: target.sessionId, provider: String(arguments_?.provider) });
        }
        try {
          const result = await options.invoke(command, arguments_);
          if (command === "list_local_agent_sessions" && result && typeof result === "object" && "sessions" in result && Array.isArray(result.sessions)) {
            return { ...result, sessions: result.sessions.filter((chat: unknown) => {
              if (!chat || typeof chat !== "object" || !("id" in chat)) return true;
              const owner = chatOwners.get(chatKey(arguments_?.provider, chat.id));
              return !owner || owner === key;
            }) };
          }
          return result;
        } catch (error) {
          if (start) runs.delete(String(runId));
          if (claimedChat && chatOwners.get(claimedChat) === key) chatOwners.delete(claimedChat);
          throw error;
        }
      },
      onStateChange(state) {
        entry.state = state;
        if (selectedKey === key) entry.open = state.open;
        if (selectedKey !== key) entry.view.hidden = true;
        publish();
      },
      onLayoutChange() { if (selectedKey === key && !refreshing) options.onLayoutChange(); },
    });
    return entry;
  }

  function refresh() {
    if (disposed || refreshing) return;
    refreshing = true;
    const previous = selectedKey;
    try {
      const selected = options.getSelectedSessionKey();
      selectedKey = selected && !closedSessions.has(selected) ? selected : null;
      if (previous && previous !== selectedKey) {
        const entry = entries.get(previous);
        if (entry) entry.view.hidden = true;
      }
      if (selectedKey) {
        const entry = entries.get(selectedKey) ?? createEntry(selectedKey);
        entry.view.hidden = !entry.open;
        entry.controller?.refresh();
      }
      publish();
    } finally { refreshing = false; }
    if (previous !== selectedKey) options.onLayoutChange();
  }

  function toggleSelected() {
    refresh();
    const entry = selectedKey ? entries.get(selectedKey) : undefined;
    if (!entry) return;
    if (entry.open) entry.controller?.close(); else entry.controller?.open();
  }
  toggle.addEventListener("click", toggleSelected);
  refresh();
  return {
    refresh,
    states() { return [...entries].map(([sessionKey, entry]) => ({ sessionKey, ...entry.state, open: selectedKey === sessionKey && entry.open })); },
    async releaseSession(key: string) {
      const entry = entries.get(key);
      if (!entry) return;
      closedSessions.add(key);
      try { await entry.controller?.stop(); }
      finally {
        entry.controller?.dispose(); entry.view.remove(); entries.delete(key);
        refresh();
      }
    },
    dispose() {
      disposed = true; unlisten?.(); toggle.removeEventListener("click", toggleSelected);
      entries.forEach(entry => { entry.controller?.dispose(); entry.view.remove(); });
      entries.clear(); listeners.clear(); root.hidden = true;
    },
  };
}
