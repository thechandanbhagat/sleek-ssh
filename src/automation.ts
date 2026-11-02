import { renderAutomationMarkdown } from "./automation-markdown.ts";
import { initAutomationSessions, type AutomationSessionsOptions } from "./automation-sessions.ts";
import { createAutomationPromptQueue, renderAutomationPromptQueue, AUTOMATION_QUEUE_LIMITS, type PromptQueueContext, type QueuedAgentPrompt } from "./automation-prompt-queue.ts";

type ProviderId = "claude" | "codex";
type Provider = { id: ProviderId; name: string; available: boolean; executable?: string | null };
type LocalChat = Readonly<{ id: string; title: string; project_path: string | null; updated_at: number | null }>;
type LocalChatListing = Readonly<{ sessions: LocalChat[]; warnings: string[]; truncated: boolean }>;
type Target = Readonly<{ sessionId: string; label: string; contextKey?: string; historyContextKey?: string }>;
type Approval = Readonly<{ requestId: string; command: string }>;
type SudoConsent = Approval & Readonly<{ message: string }>;
type SudoResponse = Readonly<{ requestId: string; approved: boolean }>;
type Run = Readonly<{ id: string; target: Target; provider: ProviderId; stopping: boolean }>;
type EventTone = "ok" | "danger" | "muted";
type OutputBlock = Readonly<{ id: number; format: "markdown" | "log" | "task" | "command" | "event"; text: string; agent?: string; command?: string; tone?: EventTone }>;
type Transcript = Readonly<{ blocks: readonly OutputBlock[]; trimmed: boolean }>;
type CommandState = Readonly<{ kind: "running" | "ok" | "failed" | "done" | "idle"; label: string }>;
export type AutomationUiState = Readonly<{ open: boolean; running: boolean; review: boolean; targetSessionId: string | null }>;
type AutomationEvent = {
  run_id: string;
  session_id: string;
  kind: "status" | "output" | "command_output" | "command_executed" | "approval" | "command" | "completed" | "failed" | "cancelled" | "session" | "sudo_approval" | "sudo_status" | "sudo_error";
  message: string;
  request_id?: string;
  command?: string;
};
type AutomationOptions = {
  invoke: (command: string, arguments_?: Record<string, unknown>) => Promise<unknown>;
  listen: (name: string, callback: (event: { payload: unknown }) => void) => Promise<() => void>;
  getSelectedTarget: () => Target | null;
  onLayoutChange: () => void;
  onStateChange?: (state: AutomationUiState) => void;
  onCommandExecuted?: (target: Target, command: string) => void;
  document?: Document;
  createRunId?: () => string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  getControl?: (id: string) => HTMLElement | null;
  isVisible?: () => boolean;
};

const MAX_PROMPT_CHARACTERS = 16_000;
const EXPECTED_PROVIDER_IDS: readonly ProviderId[] = ["claude", "codex"];
const MAX_OUTPUT_CHARACTERS = 200_000;
const MAX_OUTPUT_BLOCKS = 200;
const OUTPUT_TRIM_NOTICE = "[Earlier output trimmed]\n";
const CONVERSATION_STORAGE_PREFIX = "sleekssh_automation_conversation:";
const PROVIDER_STORAGE_KEY = "sleekssh_automation_provider";
const TRANSCRIPT_STORAGE_PREFIX = "sleekssh_automation_transcript:";
const TRANSCRIPT_VERSION = 1;
const MAX_TRANSCRIPT_STORAGE_CHARACTERS = 2_000_000;
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VISIBLE_LOCAL_CHATS = 200;
const MAX_CHAT_TITLE_CHARACTERS = 64;
const MAX_CHAT_PROJECT_CHARACTERS = 48;
const MAX_CHAT_WARNING_CHARACTERS = 160;
const MAX_VISIBLE_CHAT_WARNINGS = 3;
const SUDO_ALLOWED_MESSAGE = "Saved sudo password allowed for this run.";
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const SUDO_CONSENT_TIMEOUT_MS = 90_000;
const COUNTDOWN_INTERVAL_MS = 1_000;
const THREAD_FOLLOW_THRESHOLD_PX = 48;
const EXIT_STATUS_PATTERN = /Exit status: (-?\d+)/g;
const COMMAND_ICONS: Readonly<Record<CommandState["kind"], string>> = {
  running: '<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"></path>',
  ok: '<path d="M5 12.5l4.5 4.5L19 7.5"></path>',
  failed: '<path d="M7 7l10 10M17 7L7 17"></path>',
  done: '<path d="M5 12.5l4.5 4.5L19 7.5"></path>',
  idle: '<path d="M5 7l5 5-5 5M12.5 17H19"></path>',
};
const EVENT_ICONS: Readonly<Record<EventTone, string>> = {
  ok: '<path d="M5 12.5l4.5 4.5L19 7.5"></path>',
  danger: '<path d="M7 7l10 10M17 7L7 17"></path>',
  muted: '<circle cx="12" cy="12" r="3.5"></circle>',
};
const RUN_END_LABELS: Readonly<Record<string, string>> = { completed: "Run completed", failed: "Run failed", cancelled: "Run stopped" };
const TERMINAL_EVENT_KINDS = new Set(["completed", "failed", "cancelled"]);
const EVENT_KINDS = new Set(["status", "output", "command_output", "command_executed", "approval", "command", "session", "sudo_approval", "sudo_status", "sudo_error", ...TERMINAL_EVENT_KINDS]);

function conversationStorageKey(target: Target, provider: string): string {
  return CONVERSATION_STORAGE_PREFIX + JSON.stringify([target.contextKey ?? target.sessionId, provider]);
}

function transcriptStorageKey(target: Target, provider: string, conversationId: string): string {
  return TRANSCRIPT_STORAGE_PREFIX + JSON.stringify([target.contextKey ?? target.sessionId, provider, conversationId]);
}

function parseTranscript(raw: string): Transcript {
  if (raw.length > MAX_TRANSCRIPT_STORAGE_CHARACTERS) throw new Error("Saved chat history is too large");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Invalid saved chat history");
  const transcript = value as Record<string, unknown>;
  if (transcript.version !== TRANSCRIPT_VERSION || typeof transcript.trimmed !== "boolean" || !Array.isArray(transcript.blocks)
    || transcript.blocks.length > MAX_OUTPUT_BLOCKS) throw new Error("Invalid saved chat history");
  const ids = new Set<number>();
  const blocks = transcript.blocks.map((value: unknown): OutputBlock => {
    if (!value || typeof value !== "object") throw new Error("Invalid saved chat message");
    const block = value as Record<string, unknown>;
    if (typeof block.id !== "number" || !Number.isSafeInteger(block.id) || block.id < 1 || block.id >= Number.MAX_SAFE_INTEGER - MAX_OUTPUT_BLOCKS || ids.has(block.id)
      || typeof block.format !== "string" || !["markdown", "log", "task", "command", "event"].includes(block.format) || typeof block.text !== "string"
      || (block.agent !== undefined && typeof block.agent !== "string")
      || (block.command !== undefined && typeof block.command !== "string")
      || (block.tone !== undefined && (typeof block.tone !== "string" || !["ok", "danger", "muted"].includes(block.tone)))) throw new Error("Invalid saved chat message");
    ids.add(block.id);
    return { id: block.id, format: block.format as OutputBlock["format"], text: block.text,
      agent: block.agent as string | undefined, command: block.command as string | undefined, tone: block.tone as EventTone | undefined };
  });
  return { blocks, trimmed: transcript.trimmed };
}

function parseLocalChats(value: unknown): LocalChatListing {
  if (!value || typeof value !== "object") throw new Error("Invalid local chat listing");
  const listing = value as Record<string, unknown>;
  if (!Array.isArray(listing.sessions) || !Array.isArray(listing.warnings)
    || !listing.warnings.every(warning => typeof warning === "string") || typeof listing.truncated !== "boolean") {
    throw new Error("Invalid local chat metadata");
  }
  const sessions = listing.sessions.slice(0, MAX_VISIBLE_LOCAL_CHATS).map((value: unknown): LocalChat => {
    if (!value || typeof value !== "object") throw new Error("Invalid local chat entry");
    const chat = value as Record<string, unknown>;
    if (typeof chat.id !== "string" || !CONVERSATION_ID_PATTERN.test(chat.id) || typeof chat.title !== "string"
      || (chat.project_path !== null && typeof chat.project_path !== "string")
      || (chat.updated_at !== null && (typeof chat.updated_at !== "number" || !Number.isFinite(chat.updated_at)))) {
      throw new Error("Invalid local chat fields");
    }
    return { id: chat.id, title: chat.title, project_path: chat.project_path as string | null, updated_at: chat.updated_at as number | null };
  });
  return { sessions, warnings: listing.warnings as string[], truncated: listing.truncated || listing.sessions.length > MAX_VISIBLE_LOCAL_CHATS };
}

function formatRemaining(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

// The backend appends "Exit status: N" to each command's output; the last one wins.
function commandState(block: OutputBlock, active: boolean): CommandState {
  if (!block.text) return active ? { kind: "running", label: "Running" } : { kind: "idle", label: "Command" };
  const exit = [...block.text.matchAll(EXIT_STATUS_PATTERN)].at(-1)?.[1];
  if (exit === undefined) return { kind: "done", label: "Ran" };
  return exit === "0" ? { kind: "ok", label: "Ran" } : { kind: "failed", label: `Failed · exit ${exit}` };
}

function boundedChatText(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maximum ? normalized.slice(0, maximum - 1) + "…" : normalized;
}

function localChatLabel(chat: LocalChat): string {
  const title = boundedChatText(chat.title, MAX_CHAT_TITLE_CHARACTERS) || `Chat ${chat.id.slice(0, 8)}`;
  const project = chat.project_path ? boundedChatText(chat.project_path, MAX_CHAT_PROJECT_CHARACTERS) : "";
  const date = chat.updated_at === null ? null : new Date(chat.updated_at);
  const updated = date && Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
  return [title, project, updated].filter(Boolean).join(" · ");
}

function parseProviders(value: unknown): Provider[] {
  if (!Array.isArray(value)) throw new Error("Local agent detection returned an invalid response.");
  const providers = value.map((provider: unknown): Provider => {
    if (!provider || typeof provider !== "object" || !("id" in provider) || !("name" in provider)
      || !("available" in provider) || (provider.id !== "claude" && provider.id !== "codex")
      || typeof provider.name !== "string" || typeof provider.available !== "boolean") {
      throw new Error("Local agent detection returned an invalid provider.");
    }
    const executable = "executable" in provider ? provider.executable : undefined;
    if (executable !== undefined && executable !== null && (typeof executable !== "string" || !executable.trim())) {
      throw new Error("Local agent detection returned an invalid executable path.");
    }
    return { id: provider.id, name: provider.name, available: provider.available, executable };
  });
  if (providers.length !== EXPECTED_PROVIDER_IDS.length
    || EXPECTED_PROVIDER_IDS.some(id => providers.filter(provider => provider.id === id).length !== 1)) {
    throw new Error("Local agent detection must return Claude Code and Codex exactly once.");
  }
  return providers;
}

function parseEvent(payload: unknown): AutomationEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as Record<string, unknown>;
  if (typeof event.run_id !== "string" || typeof event.session_id !== "string"
    || typeof event.kind !== "string" || !EVENT_KINDS.has(event.kind) || typeof event.message !== "string") return null;
  if ((event.request_id !== undefined && typeof event.request_id !== "string")
    || (event.command !== undefined && typeof event.command !== "string")) return null;
  if (event.kind === "approval" && (typeof event.request_id !== "string" || !event.request_id
    || typeof event.command !== "string" || !event.command)) return null;
  if (event.kind === "command_executed" && (typeof event.request_id !== "string" || !event.request_id
    || typeof event.command !== "string" || !event.command.trim())) return null;
  if ((event.kind === "sudo_approval" || event.kind === "sudo_status")
    && (typeof event.request_id !== "string" || !event.request_id.trim())) return null;
  if (event.kind === "sudo_approval" && (typeof event.command !== "string" || !event.command.trim() || !event.message.trim())) return null;
  if (event.kind === "sudo_error" && (!event.message.trim()
    || (event.request_id !== undefined && (typeof event.request_id !== "string" || !event.request_id.trim())))) return null;
  return event as AutomationEvent;
}

export function initAutomation(options: AutomationOptions) {
  const document_ = options.document ?? document;
  const findControl = options.getControl ?? ((id: string) => document_.getElementById(id));
  const element = <T extends HTMLElement>(id: string): T => {
    const found = findControl(id);
    if (!found) throw new Error(`SSH automation control is missing: ${id}`);
    return found as T;
  };
  const panel = element("automation-panel");
  const toggle = element<HTMLButtonElement>("btn-automation-toggle");
  const activity = document_.createElement("span");
  activity.className = "automation-toggle-progress";
  activity.setAttribute("role", "progressbar");
  activity.setAttribute("aria-label", "Agent running");
  const providerSelect = element<HTMLSelectElement>("automation-provider");
  const conversation = element<HTMLInputElement>("automation-conversation");
  const newChatButton = element<HTMLButtonElement>("automation-new-chat");
  const conversationHelp = element("automation-conversation-help");
  const chatSelect = element<HTMLSelectElement>("automation-chat");
  const refreshChatsButton = element<HTMLButtonElement>("automation-refresh-chats");
  const chatHelp = element("automation-chat-help");
  const prompt = element<HTMLTextAreaElement>("automation-prompt");
  const startButton = element<HTMLButtonElement>("automation-start");
  const stopButton = element<HTMLButtonElement>("automation-stop");
  const steerButton = element<HTMLButtonElement>("automation-steer");
  const queuePanel = element("automation-queue");
  const queueList = element("automation-queue-list");
  const queueCount = element("automation-queue-count");
  const refreshButton = element<HTMLButtonElement>("automation-refresh");
  const approvalPanel = element("automation-approval");
  const approveButton = element<HTMLButtonElement>("automation-approve");
  const denyButton = element<HTMLButtonElement>("automation-deny");
  const sudoPanel = element("automation-sudo-approval");
  const sudoAllowButton = element<HTMLButtonElement>("automation-sudo-allow");
  const sudoDenyButton = element<HTMLButtonElement>("automation-sudo-deny");
  const sudoStatus = element("automation-sudo-status");
  const sudoCommand = element("automation-sudo-command");
  const sudoTarget = element("automation-sudo-target");
  const sudoRequestMessage = element("automation-sudo-message");
  const output = element("automation-output");
  const status = element("automation-status");
  const approvalExpiry = findControl("automation-approval-expiry");
  const sudoExpiry = findControl("automation-sudo-expiry");
  const bindings: Array<() => void> = [];
  const approvalReceivedAt = new Map<string, number>();
  let sudoConsentReceivedAt: number | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let providers: Provider[] = [];
  let run: Run | null = null;
  const promptQueue = createAutomationPromptQueue();
  let queueSignature = "";
  let queuePendingId: number | null = null;
  let launching: { id: string; finished: boolean } | null = null;
  let steeringRunId: string | null = null;
  let approvals: Approval[] = [];
  let approvalInFlight: string | null = null;
  let sudoConsent: SudoConsent | null = null;
  let sudoInFlight: SudoResponse | null = null;
  let sudoResolved = false;
  let sudoMessage = "";
  let sudoMessageError = false;
  const seenSudoRequests = new Set<string>();
  let providersBusy = false;
  let providerError = false;
  let listenerReady = false;
  let disposed = false;
  let unlisten: (() => void) | null = null;
  let outputBlocks: readonly OutputBlock[] = [];
  let outputTrimmed = false;
  let nextBlockId = 1;
  let runStartBlockId = 1;
  let pendingHistoryCommand: string | null = null;
  const recordedHistoryCommands = new Set<string>();
  const collapsedBlocks = new Set<number>();
  let statusMessage = "";
  let statusError = false;
  let conversationError = "";
  let displayedConversationKey: string | null | undefined;
  const conversationDrafts = new Map<string, string>();
  const transcripts = new Map<string, Transcript>();
  let displayedTranscriptKey: string | null | undefined;
  let historyError = "";
  let historyRequest = 0;
  let historyLoading = false;
  const localChats = new Map<ProviderId, LocalChatListing>();
  const loadedChatProviders = new Set<ProviderId>();
  const localChatErrors = new Map<ProviderId, string>();
  let chatsRequest = 0;
  let chatsLoadingProvider: ProviderId | null = null;
  let panelOpened = false;
  let renderedChatProvider = "";
  let renderedChatListing: LocalChatListing | undefined;
  let renderedChatSelection: string | undefined;
  let storage = options.storage ?? null;
  let storageAccessError = "";
  if (options.storage === undefined && typeof window !== "undefined") {
    try { storage = window.localStorage; }
    catch (error) { storageAccessError = `Local chat context is unavailable: ${String(error)}. Enter a conversation ID manually.`; }
  }
  try {
    const savedProvider = storage?.getItem(PROVIDER_STORAGE_KEY);
    if (savedProvider !== null && savedProvider !== undefined) {
      if (!EXPECTED_PROVIDER_IDS.includes(savedProvider as ProviderId)) throw new Error("Invalid saved local agent");
      providerSelect.value = savedProvider;
    }
  } catch (error) {
    statusMessage = `Could not restore the selected local agent: ${String(error)}. Choose Claude Code or Codex.`;
    statusError = true;
  }

  function syncConversation(target: Target | null) {
    if (run) return;
    const key = target ? conversationStorageKey(target, providerSelect.value) : null;
    if (key === displayedConversationKey) return;
    displayedConversationKey = key;
    conversationError = storageAccessError;
    conversation.value = "";
    if (!key) return;
    if (conversationDrafts.has(key)) {
      conversation.value = conversationDrafts.get(key)!;
      return;
    }
    try {
      const raw = storage?.getItem(key);
      if (raw === null || raw === undefined) return;
      const saved: unknown = JSON.parse(raw);
      if (typeof saved !== "string" || !CONVERSATION_ID_PATTERN.test(saved)) throw new Error("Saved conversation ID is invalid");
      conversation.value = saved;
      conversationDrafts.set(key, saved);
    } catch (error) {
      conversationError = `Could not load this chat context: ${String(error)}. Enter a valid ID or choose New chat.`;
    }
  }

  function saveConversation(target: Target, provider: ProviderId, id: string) {
    const key = conversationStorageKey(target, provider);
    conversationDrafts.set(key, id);
    try {
      if (id) storage?.setItem(key, JSON.stringify(id));
      else storage?.removeItem(key);
      conversationError = "";
    } catch (error) {
      conversationError = `Could not save this chat context: ${String(error)}. Copy the conversation ID to reuse it.`;
    }
  }

  function saveTranscript() {
    if (!displayedTranscriptKey) return;
    const transcript: Transcript = { blocks: outputBlocks, trimmed: outputTrimmed };
    transcripts.set(displayedTranscriptKey, transcript);
    try {
      storage?.setItem(displayedTranscriptKey, JSON.stringify({ version: TRANSCRIPT_VERSION, ...transcript }));
      historyError = "";
    } catch (error) {
      historyError = `Could not save chat history: ${String(error)}. Keep this window open to retain the transcript.`;
    }
  }

  function syncTranscript(target: Target | null) {
    if (run) return;
    const id = conversation.value.trim();
    const provider = providerSelect.value as ProviderId;
    const key = target ? transcriptStorageKey(target, provider, id) : null;
    if (displayedTranscriptKey === key) return;
    displayedTranscriptKey = key;
    historyRequest += 1;
    historyLoading = false;
    historyError = "";
    outputTrimmed = false;
    collapsedBlocks.clear();
    let transcript = key ? transcripts.get(key) : undefined;
    if (key && !transcript) {
      try {
        const raw = storage?.getItem(key);
        if (raw !== null && raw !== undefined) transcript = parseTranscript(raw);
      } catch (error) {
        historyError = `Could not load saved chat history: ${String(error)}. Reopen the chat to retry.`;
      }
    }
    outputTrimmed = transcript?.trimmed ?? false;
    nextBlockId = Math.max(0, ...(transcript?.blocks ?? []).map(block => block.id)) + 1;
    pushOutputBlocks([...(transcript?.blocks ?? [])], true, false);
    if (target && key && id && CONVERSATION_ID_PATTERN.test(id) && !transcript) {
      void loadHistory(provider, id, key, historyRequest);
    }
  }

  async function loadHistory(provider: ProviderId, id: string, key: string, request: number) {
    historyLoading = true;
    try {
      const result = await options.invoke("get_local_agent_history", { provider, sessionId: id });
      if (disposed || displayedTranscriptKey !== key || request !== historyRequest || run) return;
      if (!result || typeof result !== "object") throw new Error("Invalid conversation history");
      const history = result as Record<string, unknown>;
      if (!Array.isArray(history.messages) || history.messages.length > MAX_OUTPUT_BLOCKS || typeof history.truncated !== "boolean") {
        throw new Error("Invalid conversation history");
      }
      const blocks = history.messages.map((value: unknown): OutputBlock => {
        if (!value || typeof value !== "object") throw new Error("Invalid conversation message");
        const message = value as Record<string, unknown>;
        if ((message.role !== "user" && message.role !== "assistant") || typeof message.text !== "string") throw new Error("Invalid conversation message");
        return { id: nextBlockId++, format: message.role === "user" ? "task" : "markdown", text: message.text,
          agent: message.role === "assistant" ? providerName(provider) : undefined };
      });
      outputTrimmed = history.truncated;
      pushOutputBlocks(blocks, true);
    } catch (error) {
      if (!disposed && displayedTranscriptKey === key && request === historyRequest) {
        historyError = `Could not load conversation history: ${String(error)}. Reopen the chat to retry.`;
      }
    } finally {
      if (!disposed && displayedTranscriptKey === key && request === historyRequest) {
        historyLoading = false;
        render();
      }
    }
  }

  function render() {
    const selectedTarget = options.getSelectedTarget();
    const queued = promptQueue.state();
    syncConversation(selectedTarget);
    syncTranscript(selectedTarget);
    const provider = providers.find(candidate => candidate.id === providerSelect.value);
    const approval = approvals[0];
    panel.dataset.running = String(Boolean(run));
    element("automation-target").textContent = run
      ? `${run.target.label} · Target locked for this run`
      : selectedTarget?.label ?? "Select a connected SSH server.";
    const providerHelp = element("automation-provider-help");
    providerHelp.textContent = providersBusy ? "Checking local agents on this machine…"
      : providerError || !provider ? "Could not check local agents on this machine. Click Refresh to retry; see the error below."
        : provider.available ? provider.executable ? `Runs ${provider.name} on this machine: ${provider.executable}`
          : `Runs your configured ${provider.name} CLI on this machine.`
          : `Could not find ${provider.name} on this machine. Install it locally, sign in, then refresh. Restart SleekSSH if PATH changed.`;
    providerHelp.dataset.error = String(providerError && !providersBusy);
    const validPrompt = prompt.value.trim().length > 0 && prompt.value.length <= MAX_PROMPT_CHARACTERS;
    const conversationId = conversation.value.trim();
    renderLocalChats(conversationId, selectedTarget);
    const validConversation = !conversationId || CONVERSATION_ID_PATTERN.test(conversationId);
    startButton.disabled = !listenerReady || providersBusy || historyLoading || !selectedTarget || !provider?.available || !validPrompt || !validConversation
      || Boolean(conversationError) || Boolean(run?.stopping) || Boolean(launching && !run) || queued.prompts.length >= AUTOMATION_QUEUE_LIMITS.prompts;
    startButton.textContent = run || queued.prompts.length ? "Queue prompt" : conversationId ? "Send follow-up" : "Run task";
    conversation.disabled = Boolean(run) || !selectedTarget || (queued.prompts.length > 0 && !queued.paused);
    newChatButton.disabled = Boolean(run) || !selectedTarget || queued.prompts.length > 0;
    conversationHelp.textContent = conversationError || (!validConversation ? "Enter a complete conversation UUID, or choose New chat."
      : conversationId ? "The next task continues this saved, idle chat on this server." : "Use a saved, idle chat; leave blank to start one.");
    conversationHelp.dataset.error = String(Boolean(conversationError) || !validConversation);
    conversation.setAttribute("aria-invalid", String(!validConversation));
    providerSelect.disabled = Boolean(run) || queued.prompts.length > 0;
    prompt.disabled = false;
    prompt.placeholder = "Message the agent…";
    startButton.title = `${startButton.textContent} (Enter)`;
    refreshButton.disabled = providersBusy || Boolean(run) || queued.prompts.length > 0;
    stopButton.disabled = !run || run.stopping;
    stopButton.textContent = run?.stopping ? "Stopping…" : "Stop";
    steerButton.hidden = !run || !validPrompt;
    steerButton.disabled = startButton.disabled || !run || run.stopping || Boolean(launching) || !CONVERSATION_ID_PATTERN.test(conversationId) || queued.prompts.length >= AUTOMATION_QUEUE_LIMITS.prompts;
    queuePanel.hidden = !queued.prompts.length;
    queueCount.textContent = `${queued.prompts.length}${queued.paused ? " · paused" : ""}`;
    const queueToggleDisabled = Boolean(run?.stopping) || (queued.paused && (Boolean(launching) || !selectedTarget || !CONVERSATION_ID_PATTERN.test(conversationId)));
    const canSteerQueued = Boolean(run && !run.stopping && !launching && !queuePendingId && selectedTarget?.sessionId === run.target.sessionId
      && CONVERSATION_ID_PATTERN.test(conversationId) && !conversationError);
    const nextQueueSignature = JSON.stringify([queued.prompts, queuePendingId, queued.paused, queueToggleDisabled, canSteerQueued]);
    if (queueSignature !== nextQueueSignature) {
      queueSignature = nextQueueSignature;
      renderAutomationPromptQueue({ root: queueList, prompts: queued.prompts, pendingId: queuePendingId, paused: queued.paused, canSteer: canSteerQueued, toggleDisabled: queueToggleDisabled,
        remove: id => { if (!disposed && options.isVisible?.() !== false && id !== queuePendingId) { promptQueue.remove(id); render(); prompt.focus(); } },
        moveEarlier: id => { if (!disposed && options.isVisible?.() !== false && !queuePendingId) { promptQueue.moveEarlier(id); render(); prompt.focus(); } },
        steer: id => { if (canSteerQueued) void steerQueuedPrompt(id); },
        togglePause: () => { if (!queueToggleDisabled) void togglePromptQueue(); },
      });
    }
    element("automation-provider-help").hidden = Boolean(run);
    approvalPanel.hidden = !approval || !run;
    approveButton.disabled = Boolean(approvalInFlight) || Boolean(run?.stopping);
    denyButton.disabled = Boolean(approvalInFlight) || Boolean(run?.stopping);
    element("automation-command").textContent = approval?.command ?? "";
    element("automation-approval-target").textContent = run?.target.label ?? "";
    sudoPanel.hidden = !sudoConsent || !run;
    sudoAllowButton.disabled = Boolean(sudoInFlight) || Boolean(run?.stopping);
    sudoDenyButton.disabled = Boolean(sudoInFlight) || Boolean(run?.stopping);
    sudoCommand.textContent = sudoConsent?.command ?? "";
    sudoTarget.textContent = run?.target.label ?? "";
    sudoRequestMessage.textContent = sudoConsent?.message ?? "";
    sudoStatus.hidden = !run || run.stopping || !sudoMessage;
    sudoStatus.textContent = sudoMessage;
    sudoStatus.dataset.error = String(sudoMessageError);
    status.textContent = statusMessage || (selectedTarget ? "Describe a task. Each remote command needs your approval." : "Select a connected SSH server to begin.");
    status.dataset.error = String(statusError);
    status.className = statusError ? "automation-status" : "automation-status sr-only";
    const needsReview = Boolean(run && (approval || sudoConsent));
    const toggleLabel = needsReview ? "Approval needed" : run ? "Agent running" : "Agent idle";
    if (run && !needsReview) { if (toggle.children[0] !== activity) toggle.replaceChildren(activity); }
    else toggle.textContent = toggleLabel;
    toggle.setAttribute("aria-label", toggleLabel);
    toggle.setAttribute("title", toggleLabel);
    toggle.dataset.state = needsReview ? "review" : run ? "running" : "idle";
    syncCountdown();
    notifyState();
  }

  function notifyState() {
    options.onStateChange?.({
      open: !panel.hidden,
      running: Boolean(run),
      review: Boolean(run && (approvals.length || sudoConsent)),
      targetSessionId: run?.target.sessionId ?? null,
    });
  }

  function updateCountdowns(): boolean {
    const now = Date.now();
    let active = false;
    const approval = approvals[0];
    const approvalStart = approval ? approvalReceivedAt.get(approval.requestId) : undefined;
    if (run && approval && approvalStart !== undefined) {
      const remaining = approvalStart + APPROVAL_TIMEOUT_MS - now;
      if (approvalExpiry) approvalExpiry.textContent = remaining > 0 ? `Expires in ${formatRemaining(remaining)}` : "Expiring…";
      active = remaining > 0;
    } else if (approvalExpiry) {
      approvalExpiry.textContent = "";
    }
    if (run && sudoConsent && sudoConsentReceivedAt !== null) {
      const remaining = sudoConsentReceivedAt + SUDO_CONSENT_TIMEOUT_MS - now;
      if (sudoExpiry) sudoExpiry.textContent = remaining > 0 ? `Expires in ${formatRemaining(remaining)}` : "Expiring…";
      active ||= remaining > 0;
    } else if (sudoExpiry) {
      sudoExpiry.textContent = "";
    }
    return active;
  }

  function stopCountdown() {
    if (countdownTimer === null) return;
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  function syncCountdown() {
    if (!updateCountdowns() || disposed) {
      stopCountdown();
      return;
    }
    if (countdownTimer !== null) return;
    countdownTimer = setInterval(() => {
      if (disposed || !updateCountdowns()) stopCountdown();
    }, COUNTDOWN_INTERVAL_MS);
    // Node test runs must not stay alive for an approval nobody answers.
    (countdownTimer as unknown as { unref?: () => void }).unref?.();
  }

  function providerName(id: ProviderId): string {
    return providers.find(provider => provider.id === id)?.name ?? (id === "claude" ? "Claude Code" : "Codex");
  }

  function renderLocalChats(conversationId: string, target: Target | null) {
    const provider = providerSelect.value as ProviderId;
    const listing = localChats.get(provider);
    const error = localChatErrors.get(provider);
    const loading = chatsLoadingProvider === provider;
    chatSelect.disabled = Boolean(run) || !target || (promptQueue.state().prompts.length > 0 && !promptQueue.state().paused);
    refreshChatsButton.disabled = Boolean(run) || loading;
    chatHelp.textContent = error || (loading ? "Loading saved local chats…" : !listing ? "Open automation to load saved local chats."
      : !listing.sessions.length ? "No saved local chats found. Choose New chat or use Advanced."
        : `${listing.sessions.length} saved local chat${listing.sessions.length === 1 ? "" : "s"}. Choose an idle chat.`);
    if (listing && !error && !loading) {
      const warnings = listing.warnings.slice(0, MAX_VISIBLE_CHAT_WARNINGS).map(warning => boundedChatText(warning, MAX_CHAT_WARNING_CHARACTERS));
      chatHelp.textContent += [listing.truncated ? "Recent chats shown; use Advanced for another ID." : "", ...warnings].filter(Boolean).map(message => ` ${message}`).join("");
    }
    if (conversationError) chatHelp.textContent += ` ${conversationError}`;
    if (historyLoading) chatHelp.textContent += " Loading conversation history…";
    if (historyError) chatHelp.textContent += ` ${historyError}`;
    chatHelp.dataset.error = String(Boolean(error) || Boolean(conversationError) || Boolean(historyError));
    // A bare "N saved chats" count repeats what the picker shows, so the panel can hide it.
    chatHelp.dataset.quiet = String(Boolean(listing && !error && !loading && !conversationError && !historyError && !historyLoading && listing.sessions.length
      && !listing.truncated && !listing.warnings.length));
    if (renderedChatProvider === provider && renderedChatListing === listing && renderedChatSelection === conversationId) return;
    renderedChatProvider = provider;
    renderedChatListing = listing;
    renderedChatSelection = conversationId;
    const choices = [{ id: "", label: "New chat" }, ...(listing?.sessions ?? []).map(chat => ({ id: chat.id, label: localChatLabel(chat) }))];
    if (conversationId && !choices.some(choice => choice.id === conversationId)) {
      choices.splice(1, 0, { id: conversationId, label: `Selected chat (not in list) · ${boundedChatText(conversationId, MAX_CHAT_TITLE_CHARACTERS)}` });
    }
    chatSelect.replaceChildren(...choices.map(choice => {
      const option = document_.createElement("option");
      option.value = choice.id;
      option.textContent = choice.label;
      return option;
    }));
    chatSelect.value = conversationId;
  }

  async function loadLocalChats(refresh = false) {
    if (disposed || run) return;
    const provider = providerSelect.value as ProviderId;
    if (chatsLoadingProvider === provider || (!refresh && loadedChatProviders.has(provider))) return;
    const request = ++chatsRequest;
    chatsLoadingProvider = provider;
    localChatErrors.delete(provider);
    render();
    try {
      const listing = parseLocalChats(await options.invoke("list_local_agent_sessions", { provider }));
      if (disposed || request !== chatsRequest || providerSelect.value !== provider) return;
      localChats.set(provider, listing);
      loadedChatProviders.add(provider);
    } catch (error) {
      if (!disposed && request === chatsRequest && providerSelect.value === provider) {
        localChatErrors.set(provider, `Could not load local chats: ${String(error)}. Retry Refresh chats, choose New chat, or use Advanced.`);
      }
    } finally {
      if (!disposed && request === chatsRequest) {
        chatsLoadingProvider = null;
        render();
      }
    }
  }

  function setStatus(message: string, error = false) {
    statusMessage = message;
    statusError = error;
    render();
  }

  function appendTask(task: string) {
    pushOutputBlocks([...outputBlocks, { id: nextBlockId++, format: "task", text: task }], true);
  }

  function appendOutput(message: string, format: "markdown" | "log" = "log") {
    if (!message) return;
    const previous = outputBlocks.at(-1);
    const agent = format === "markdown" && run ? providerName(run.provider) : undefined;
    const blocks = previous?.format === format && previous.agent === agent
      ? [...outputBlocks.slice(0, -1), { ...previous, text: previous.text + message }]
      : [...outputBlocks, { id: nextBlockId++, format, text: message, agent }];
    pushOutputBlocks(blocks);
  }

  function appendCommand(command: string) {
    pushOutputBlocks([...outputBlocks, { id: nextBlockId++, format: "command", text: "", command }]);
  }

  // One-line markers for decisions and run state, such as "Approved $ uptime" or "Run completed".
  function appendEvent(text: string, tone: EventTone = "muted", command?: string) {
    pushOutputBlocks([...outputBlocks, { id: nextBlockId++, format: "event", text, tone, command }]);
  }

  // Output belongs to the command card it answers; anything else stays a plain log block.
  function appendCommandOutput(message: string) {
    if (!message) return;
    const previous = outputBlocks.filter(block => block.format === "command" && block.id >= runStartBlockId).at(-1);
    if (!previous) {
      appendOutput(message);
      return;
    }
    pushOutputBlocks(outputBlocks.map(block => block.id === previous.id ? { ...block, text: block.text + message } : block));
  }

  function renderOutputBlock(block: OutputBlock, latest: boolean): HTMLElement {
    if (block.format === "task") {
      const node = document_.createElement("div");
      node.className = "automation-output-task";
      node.innerHTML = `<p class="automation-task-text"><span class="automation-sr-only">Task: </span>${escapeText(block.text)}</p>`;
      return node;
    }
    if (block.format === "event") {
      const tone = block.tone ?? "muted";
      const node = document_.createElement("p");
      node.className = "automation-output-event";
      node.dataset.tone = tone;
      node.innerHTML = `<svg class="automation-event-icon" viewBox="0 0 24 24" aria-hidden="true">${EVENT_ICONS[tone]}</svg>`
        + `<span class="automation-event-text">${escapeText(block.text)}</span>`
        + (block.command ? ` <code class="automation-event-code">${escapeText(block.command)}</code>` : "");
      return node;
    }
    if (block.format === "command") {
      const state = commandState(block, latest && Boolean(run));
      const node = document_.createElement("details");
      node.className = "automation-output-command";
      node.dataset.state = state.kind;
      if (!collapsedBlocks.has(block.id)) node.setAttribute("open", "");
      node.innerHTML = `<summary class="automation-command-summary">`
        + `<svg class="automation-command-icon" viewBox="0 0 24 24" aria-hidden="true">${COMMAND_ICONS[state.kind]}</svg>`
        + `<span class="automation-command-label">${escapeText(state.label)}</span>`
        + `<code class="automation-command-text"><span class="automation-command-prompt">$ </span>${escapeText(block.command ?? "")}</code>`
        + `<svg class="automation-command-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>`
        + `</summary>`
        + (block.text ? `<pre class="automation-command-output">${escapeText(block.text)}</pre>` : "");
      node.addEventListener("toggle", () => {
        if ((node as HTMLDetailsElement).open) collapsedBlocks.delete(block.id);
        else collapsedBlocks.add(block.id);
      });
      return node;
    }
    const node = document_.createElement(block.format === "markdown" ? "div" : "pre");
    node.className = `automation-output-${block.format === "markdown" ? "markdown" : "log"}`;
    if (block.format === "markdown") {
      node.innerHTML = renderAutomationMarkdown(block.text).trimEnd();
      if (block.agent) node.dataset.agent = block.agent;
    } else {
      node.textContent = block.text;
    }
    return node;
  }

  // The thread (output plus approval cards) is the scrolling element in the side panel.
  function threadElement(): HTMLElement | null {
    const parent = (output as HTMLElement).parentElement;
    return parent && typeof parent.scrollHeight === "number" && typeof parent.clientHeight === "number" ? parent : null;
  }

  function scrollThreadToEnd() {
    const thread = threadElement();
    if (thread) thread.scrollTop = thread.scrollHeight;
  }

  function pushOutputBlocks(blocks: OutputBlock[], forceScroll = false, persist = true) {
    const thread = threadElement();
    const follow = forceScroll || !thread || thread.scrollHeight - thread.scrollTop - thread.clientHeight < THREAD_FOLLOW_THRESHOLD_PX;
    const characters = blocks.reduce((total, block) => total + block.text.length, 0);
    outputTrimmed ||= characters > MAX_OUTPUT_CHARACTERS || blocks.length > MAX_OUTPUT_BLOCKS;
    let remaining = MAX_OUTPUT_CHARACTERS - (outputTrimmed ? OUTPUT_TRIM_NOTICE.length : 0);
    const retained: OutputBlock[] = [];
    for (const block of blocks.slice().reverse()) {
      if (remaining === 0 || retained.length === MAX_OUTPUT_BLOCKS) break;
      const text = block.text.slice(-remaining);
      retained.push({ ...block, text });
      remaining -= text.length;
    }
    outputBlocks = retained.reverse();
    if (persist) saveTranscript();
    const latestCommand = outputBlocks.filter(block => block.format === "command" && (!run || block.id >= runStartBlockId)).at(-1);
    const nodes = outputBlocks.map(block => renderOutputBlock(block, block.id === latestCommand?.id));
    if (outputTrimmed) {
      const notice = document_.createElement("pre");
      notice.className = "automation-output-log";
      notice.textContent = OUTPUT_TRIM_NOTICE;
      nodes.unshift(notice);
    }
    if (!nodes.length) {
      const empty = document_.createElement("p");
      empty.className = "automation-empty";
      empty.textContent = "Describe a task below. The agent proposes remote commands, and nothing runs until you approve it.";
      nodes.push(empty);
    }
    output.replaceChildren(...nodes);
    output.scrollTop = output.scrollHeight;
    if (thread && follow) thread.scrollTop = thread.scrollHeight;
    if (persist) renderLocalChats(conversation.value.trim(), run?.target ?? options.getSelectedTarget());
  }

  function setOpen(open: boolean, focus = false) {
    if (open && options.isVisible?.() === false) { render(); return; }
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    notifyState();
    options.onLayoutChange();
    if (open) {
      panelOpened = true;
      retryHistory();
      void loadLocalChats();
    }
    if (focus) (open ? run ? sudoConsent && !sudoInFlight && !run.stopping ? sudoAllowButton
      : approvals.length && !approvalInFlight && !run.stopping ? approveButton : stopButton : prompt : toggle).focus();
  }

  function retryHistory() {
    if (run || historyLoading || !historyError || !displayedTranscriptKey || transcripts.has(displayedTranscriptKey)) return;
    displayedTranscriptKey = undefined;
    render();
  }

  function resetSudoConsent() {
    sudoConsent = null;
    sudoConsentReceivedAt = null;
    sudoInFlight = null;
    sudoResolved = false;
    sudoMessage = "";
    sudoMessageError = false;
    seenSudoRequests.clear();
  }

  function recordExecutedCommand(command: string | null, executionId?: string) {
    if (!run || !command || (executionId && recordedHistoryCommands.has(executionId))) return;
    pendingHistoryCommand = null;
    if (executionId) recordedHistoryCommands.add(executionId);
    try { options.onCommandExecuted?.(run.target, command); }
    catch (error) { setStatus(`Could not save command history: ${String(error)}`, true); }
  }

  function handleEvent(payload: unknown) {
    const event = parseEvent(payload);
    if (disposed || !event || !run || event.run_id !== run.id || event.session_id !== run.target.sessionId) return;
    if (event.kind === "session") {
      if (!CONVERSATION_ID_PATTERN.test(event.message)) {
        setStatus("The local agent returned an invalid conversation ID. This chat context was not saved.", true);
        return;
      }
      const previousKey = displayedTranscriptKey;
      const wasNew = !conversation.value.trim();
      displayedTranscriptKey = transcriptStorageKey(run.target, run.provider, event.message);
      conversation.value = event.message;
      saveConversation(run.target, run.provider, event.message);
      // An older metadata scan may predate the chat the CLI just created.
      if (chatsLoadingProvider === run.provider) {
        chatsRequest += 1;
        chatsLoadingProvider = null;
      }
      const listing = localChats.get(run.provider);
      const existing = listing?.sessions.find(chat => chat.id === event.message);
      const chat: LocalChat = {
        id: event.message,
        title: existing?.title ?? boundedChatText(outputBlocks.find(block => block.format === "task")?.text ?? "", MAX_CHAT_TITLE_CHARACTERS),
        project_path: existing?.project_path ?? null,
        updated_at: Date.now(),
      };
      localChats.set(run.provider, {
        sessions: [chat, ...(listing?.sessions ?? []).filter(chat => chat.id !== event.message)].slice(0, MAX_VISIBLE_LOCAL_CHATS),
        warnings: listing?.warnings ?? [],
        truncated: listing?.truncated ?? false,
      });
      if (wasNew && previousKey && previousKey !== displayedTranscriptKey) {
        transcripts.delete(previousKey);
        try { storage?.removeItem(previousKey); }
        catch (error) { historyError = `Could not clear the new-chat draft: ${String(error)}`; }
      }
      appendEvent("Conversation ID:", "muted", event.message);
      render();
    } else if (event.kind === "sudo_approval") {
      if (run.stopping || sudoResolved || sudoConsent || seenSudoRequests.has(event.request_id!)) return;
      seenSudoRequests.add(event.request_id!);
      sudoConsent = { requestId: event.request_id!, command: event.command!, message: event.message };
      sudoConsentReceivedAt = Date.now();
      setStatus("Sudo needs permission to use this server's saved password. Remote commands still require approval.");
      setOpen(true);
      scrollThreadToEnd();
      if (options.isVisible?.() !== false) sudoAllowButton.focus();
    } else if (event.kind === "sudo_status") {
      if (!sudoInFlight?.approved || event.request_id !== sudoInFlight.requestId) return;
      sudoConsent = null;
      sudoInFlight = null;
      sudoResolved = true;
      sudoMessage = SUDO_ALLOWED_MESSAGE;
      sudoMessageError = false;
      render();
    } else if (event.kind === "sudo_error") {
      if (event.request_id && !seenSudoRequests.has(event.request_id)) return;
      sudoConsent = null;
      sudoInFlight = null;
      sudoResolved = true;
      sudoMessage = event.message;
      sudoMessageError = true;
      if (run.stopping) render();
      else setStatus(event.message, true);
    } else if (event.kind === "approval") {
      if (!approvals.some(approval => approval.requestId === event.request_id)) {
        approvals = [...approvals, { requestId: event.request_id!, command: event.command! }];
        approvalReceivedAt.set(event.request_id!, Date.now());
      }
      setOpen(true);
      setStatus("Review the command for this server. The agent is waiting for your decision.");
      scrollThreadToEnd();
    } else if (event.kind === "output") {
      appendOutput(event.message, "markdown");
    } else if (event.kind === "command_executed") {
      recordExecutedCommand(event.command!, event.request_id);
    } else if (event.kind === "command_output") {
      appendCommandOutput(event.message);
      if (event.message.match(EXIT_STATUS_PATTERN)?.length) recordExecutedCommand(event.command ?? pendingHistoryCommand, event.request_id);
    } else if (TERMINAL_EVENT_KINDS.has(event.kind)) {
      const label = RUN_END_LABELS[event.kind];
      const steered = steeringRunId === run.id;
      if (launching?.id === run.id) launching.finished = true;
      if (!steered && (event.kind !== "completed" || run.stopping)) promptQueue.pause();
      steeringRunId = null;
      run = null;
      pendingHistoryCommand = null;
      appendEvent(event.message.trim() ? `${label}. ${event.message.trim()}` : `${label}.`, event.kind === "completed" ? "ok" : event.kind === "failed" ? "danger" : "muted");
      approvals = [];
      approvalReceivedAt.clear();
      approvalInFlight = null;
      resetSudoConsent();
      setStatus(event.message || `Automation ${event.kind}.`, event.kind === "failed");
      void drainPromptQueue();
    } else {
      if (event.kind === "status" && event.request_id) {
        approvals = approvals.filter(approval => approval.requestId !== event.request_id);
        approvalReceivedAt.delete(event.request_id);
        if (approvalInFlight === event.request_id) approvalInFlight = null;
      }
      if (event.kind === "command") {
        pendingHistoryCommand = event.command ?? event.message;
        appendCommand(pendingHistoryCommand);
      }
      setStatus(event.message);
    }
  }

  async function refreshProviders() {
    if (providersBusy || run || disposed || promptQueue.state().prompts.length) return;
    providersBusy = true;
    render();
    try {
      const detected = parseProviders(await options.invoke("list_automation_providers"));
      if (disposed) return;
      providers = detected;
      if (providerError) {
        providerError = false;
        statusMessage = "";
        statusError = false;
      }
      if (!providers.find(provider => provider.id === providerSelect.value)?.available) {
        const availableProvider = providers.find(provider => provider.available);
        if (availableProvider) providerSelect.value = availableProvider.id;
      }
    } catch (error) {
      if (!disposed) {
        providers = [];
        providerError = true;
        setStatus(`Could not detect local agents: ${String(error)}`, true);
      }
    } finally {
      providersBusy = false;
      if (!disposed) render();
      if (panelOpened) void loadLocalChats();
    }
  }

  async function startRun(event: Event) {
    event.preventDefault();
    if (options.isVisible?.() === false) return;
    render();
    if (startButton.disabled || disposed) return;
    const target = options.getSelectedTarget();
    if (!target) return;
    if (run || promptQueue.state().prompts.length) {
      try {
        if (run && run.target.sessionId !== target.sessionId) throw new Error("Return to this run's SSH session before adding a follow-up.");
        promptQueue.enqueue(prompt.value, queueContext(target)); prompt.value = "";
        setStatus("Prompt queued for this SSH session.");
        prompt.focus();
        void drainPromptQueue();
      } catch (error) { setStatus(String(error), true); }
      return;
    }
    await launchTask(prompt.value.trim(), target, prompt.value);
  }

  function queueContext(target: Target): PromptQueueContext {
    return { sessionId: target.sessionId, contextKey: target.contextKey ?? target.sessionId, provider: providerSelect.value };
  }

  async function launchTask(task: string, target: Target, draft?: string, queuedPrompt?: QueuedAgentPrompt) {
    const currentRun: Run = {
      id: (options.createRunId ?? (() => crypto.randomUUID()))(),
      target: { ...target },
      provider: providerSelect.value as ProviderId,
      stopping: false,
    };
    const startup = { id: currentRun.id, finished: false };
    launching = startup;
    const resumeSessionId = conversation.value.trim() || null;
    run = currentRun;
    approvals = [];
    approvalReceivedAt.clear();
    approvalInFlight = null;
    resetSudoConsent();
    runStartBlockId = nextBlockId;
    pendingHistoryCommand = null;
    recordedHistoryCommands.clear();
    appendTask(task);
    if (draft !== undefined) prompt.value = "";
    setStatus("Starting the local agent…");
    if (draft !== undefined && options.isVisible?.() !== false) prompt.focus();
    try {
      await options.invoke("start_ssh_automation", {
        runId: currentRun.id, sessionId: currentRun.target.sessionId, provider: currentRun.provider, prompt: task, resumeSessionId,
      });
      if (queuedPrompt) promptQueue.remove(queuedPrompt.id);
    } catch (error) {
      if (disposed) return;
      if (startup.finished) { if (queuedPrompt) promptQueue.remove(queuedPrompt.id); return; }
      if (run?.id !== currentRun.id) return;
      run = null;
      promptQueue.pause();
      if (draft !== undefined && !prompt.value) prompt.value = draft;
      approvals = [];
      resetSudoConsent();
      const message = `Could not start automation: ${String(error)}`;
      appendEvent(message, "danger");
      setStatus(message, true);
    } finally {
      if (launching === startup) launching = null;
      if (queuedPrompt) queuePendingId = null;
      if (!disposed) { render(); if (!run) void drainPromptQueue(); }
    }
  }

  async function drainPromptQueue() {
    if (disposed || run || launching || queuePendingId || promptQueue.state().paused || !promptQueue.state().prompts.length) return;
    try {
      const target = options.getSelectedTarget();
      if (!target) throw new Error("The SSH session disconnected. Reconnect and resume this queue explicitly.");
      const next = promptQueue.next(queueContext(target));
      if (!next) return;
      if (!CONVERSATION_ID_PATTERN.test(conversation.value.trim())) throw new Error("Choose this session's saved chat before resuming queued prompts.");
      queuePendingId = next.id;
      await launchTask(next.text, target, undefined, next);
    } catch (error) { queuePendingId = null; promptQueue.pause(); setStatus(`Queue paused: ${String(error)}`, true); }
  }

  async function steerRun() {
    if (disposed || options.isVisible?.() === false || !run || steerButton.disabled) return;
    try {
      const target = options.getSelectedTarget();
      if (!target || target.sessionId !== run.target.sessionId) throw new Error("Return to this run's SSH session before steering it.");
      promptQueue.enqueue(prompt.value, queueContext(target), true);
      promptQueue.resume(queueContext(target));
      prompt.value = ""; steeringRunId = run.id;
      prompt.focus();
      await stopRun(true);
    } catch (error) { promptQueue.pause(); setStatus(`Could not steer this task: ${String(error)}`, true); }
  }

  async function steerQueuedPrompt(id: number) {
    if (disposed || options.isVisible?.() === false || !run || run.stopping || launching || queuePendingId
      || !CONVERSATION_ID_PATTERN.test(conversation.value.trim()) || !promptQueue.state().prompts.some(prompt => prompt.id === id)) return;
    try {
      const target = options.getSelectedTarget();
      if (!target || target.sessionId !== run.target.sessionId) throw new Error("Return to this run's SSH session before steering it.");
      promptQueue.resume(queueContext(target)); promptQueue.prioritize(id);
      steeringRunId = run.id;
      prompt.focus(); await stopRun(true);
    } catch (error) { promptQueue.pause(); setStatus(`Could not steer this task: ${String(error)}`, true); }
  }

  async function togglePromptQueue() {
    if (disposed || options.isVisible?.() === false || run?.stopping) return;
    try {
      if (promptQueue.state().paused) {
        const target = options.getSelectedTarget();
        if (!target) throw new Error("Reconnect this SSH session before resuming its queue.");
        promptQueue.resume(queueContext(target)); render(); await drainPromptQueue();
      } else { promptQueue.pause(); render(); }
    } catch (error) { setStatus(String(error), true); }
    finally { if (!disposed && options.isVisible?.() !== false) prompt.focus(); }
  }

  async function stopRun(steering = false) {
    if (!steering) { promptQueue.pause(); steeringRunId = null; }
    if (!run || run.stopping || disposed) return;
    const runId = run.id;
    run = { ...run, stopping: true };
    setStatus(steering ? "Stopping this task before continuing the chat with your instruction…" : "Stopping the local agent and closing its command channel…");
    try {
      await options.invoke("stop_ssh_automation", { runId });
    } catch (error) {
      if (disposed || run?.id !== runId) return;
      if (steering) { steeringRunId = null; promptQueue.pause(); }
      run = { ...run, stopping: false };
      setStatus(`Could not stop automation: ${String(error)}. Try Stop again.`, true);
    }
  }

  async function respondToApproval(approved: boolean) {
    const approval = approvals[0];
    if (!run || !approval || approvalInFlight || run.stopping || disposed || options.isVisible?.() === false) return;
    const runId = run.id;
    approvalInFlight = approval.requestId;
    render();
    try {
      await options.invoke("respond_automation_approval", { runId, requestId: approval.requestId, approved });
      if (disposed || run?.id !== runId) return;
      approvals = approvals.filter(candidate => candidate.requestId !== approval.requestId);
      approvalReceivedAt.delete(approval.requestId);
      appendEvent(approved ? "Approved" : "Denied", approved ? "ok" : "danger", approval.command);
      setStatus(approvals.length ? "Review the next remote command." : approved ? "Command approved. The agent is continuing…" : "Command denied. The agent is continuing…");
    } catch (error) {
      if (!disposed && run?.id === runId) setStatus(`Could not submit command approval: ${String(error)}. Try again.`, true);
    } finally {
      if (!disposed && run?.id === runId && approvalInFlight === approval.requestId) {
        approvalInFlight = null;
        render();
      }
    }
  }

  async function respondToSudoConsent(approved: boolean) {
    const consent = sudoConsent;
    if (!run || !consent || sudoInFlight || run.stopping || disposed || options.isVisible?.() === false) return;
    const runId = run.id;
    const response: SudoResponse = { requestId: consent.requestId, approved };
    sudoInFlight = response;
    render();
    try {
      await options.invoke("respond_automation_sudo_consent", { runId, requestId: consent.requestId, approved });
      if (disposed || run?.id !== runId || sudoInFlight !== response) return;
      sudoConsent = null;
      sudoResolved = true;
      sudoMessage = approved ? SUDO_ALLOWED_MESSAGE : "Saved sudo password denied for this run.";
      sudoMessageError = false;
      render();
    } catch (error) {
      if (disposed || run?.id !== runId || sudoInFlight !== response) return;
      sudoConsent = consent;
      sudoResolved = false;
      sudoMessage = `Could not submit sudo permission: ${String(error)}. Try Allow for this run or Deny again.`;
      sudoMessageError = true;
      if (run.stopping) render();
      else setStatus(sudoMessage, true);
    } finally {
      if (!disposed && run?.id === runId && sudoInFlight === response) {
        sudoInFlight = null;
        render();
      }
    }
  }

  function bind(control: HTMLElement, event: string, handler: EventListener) {
    control.addEventListener(event, handler);
    bindings.push(() => control.removeEventListener(event, handler));
  }

  function clearConversation() {
    if (run || !displayedConversationKey || disposed) return;
    if (promptQueue.state().prompts.length) { setStatus("Remove queued prompts before starting a new chat.", true); return; }
    conversation.value = "";
    conversationDrafts.set(displayedConversationKey, "");
    const target = options.getSelectedTarget();
    const draftKey = target ? transcriptStorageKey(target, providerSelect.value, "") : null;
    if (draftKey) {
      transcripts.set(draftKey, { blocks: [], trimmed: false });
      displayedTranscriptKey = undefined;
    }
    try {
      storage?.removeItem(displayedConversationKey);
      if (draftKey) storage?.removeItem(draftKey);
      conversationError = "";
    }
    catch (error) { conversationError = `Could not clear this chat context: ${String(error)}. Retry New chat.`; }
    render();
  }

  bind(toggle, "click", () => setOpen(Boolean(panel.hidden), true));
  bind(element("automation-close"), "click", () => setOpen(false, true));
  bind(providerSelect, "change", () => {
    if (promptQueue.state().prompts.length) { render(); return; }
    try {
      storage?.setItem(PROVIDER_STORAGE_KEY, providerSelect.value);
    } catch (error) {
      setStatus(`Could not save the selected local agent: ${String(error)}. Select it again after reopening.`, true);
    }
    render();
    if (panelOpened) void loadLocalChats();
  });
  bind(chatSelect, "change", () => {
    if (run || disposed) return;
    if (!chatSelect.value) { clearConversation(); return; }
    conversation.value = chatSelect.value;
    const target = options.getSelectedTarget();
    if (target) saveConversation(target, providerSelect.value as ProviderId, conversation.value);
    render();
  });
  bind(refreshChatsButton, "click", () => { retryHistory(); void loadLocalChats(true); });
  bind(conversation, "input", () => {
    if (displayedConversationKey) conversationDrafts.set(displayedConversationKey, conversation.value);
    conversationError = "";
    const target = options.getSelectedTarget();
    const id = conversation.value.trim();
    if (target && (!id || CONVERSATION_ID_PATTERN.test(id))) saveConversation(target, providerSelect.value as ProviderId, id);
    render();
  });
  bind(newChatButton, "click", clearConversation);
  bind(prompt, "input", render);
  bind(prompt, "keydown", event => {
    const key = event as KeyboardEvent;
    if (key.key !== "Enter" || key.isComposing || key.shiftKey || key.altKey) return;
    key.preventDefault();
    if (key.ctrlKey || key.metaKey) void steerRun();
    else void startRun(key);
  });
  bind(element("automation-form"), "submit", startRun);
  bind(output, "click", async event => {
    const anchor = (event.target as Element | null)?.closest?.("a[href]");
    if (!anchor || !output.contains(anchor)) return;
    event.preventDefault();
    try {
      await options.invoke("plugin:opener|open_url", { url: anchor.getAttribute("href") });
    } catch (error) {
      if (!disposed) setStatus(`Could not open link: ${String(error)}`, true);
    }
  });
  bind(refreshButton, "click", refreshProviders);
  bind(stopButton, "click", async () => { if (options.isVisible?.() !== false) await stopRun(); });
  bind(steerButton, "click", steerRun);
  bind(approveButton, "click", () => { void respondToApproval(true); });
  bind(denyButton, "click", () => { void respondToApproval(false); });
  bind(sudoAllowButton, "click", () => { void respondToSudoConsent(true); });
  bind(sudoDenyButton, "click", () => { void respondToSudoConsent(false); });
  void (async () => {
    try {
      const disposeListener = await options.listen("ssh-automation-event", event => handleEvent(event.payload));
      if (disposed) disposeListener();
      else {
        unlisten = disposeListener;
        listenerReady = true;
        render();
      }
    } catch (error) {
      if (!disposed) setStatus(`Automation events could not connect: ${String(error)}. Restart SleekSSH.`, true);
    }
  })();
  void refreshProviders();
  render();

  return {
    refresh() { if (!disposed) render(); },
    open() { if (!disposed) setOpen(true, true); },
    close() { if (!disposed) setOpen(false); },
    stop: () => stopRun(),
    dispose() {
      disposed = true;
      promptQueue.pause();
      stopCountdown();
      unlisten?.();
      bindings.forEach(unbind => unbind());
    },
  };
}

declare global {
  interface Window {
    SleekSshAutomation?: { initAutomation: typeof initAutomation; initAutomationSessions: (options: AutomationSessionsOptions) => ReturnType<typeof initAutomationSessions> };
  }
}

if (typeof window !== "undefined") window.SleekSshAutomation = { initAutomation,
  initAutomationSessions: options => initAutomationSessions(options, initAutomation) };
