import { renderAutomationMarkdown } from "./automation-markdown.ts";

type ProviderId = "claude" | "codex";
type Provider = { id: ProviderId; name: string; available: boolean; executable?: string | null };
type LocalChat = Readonly<{ id: string; title: string; project_path: string | null; updated_at: number | null }>;
type LocalChatListing = Readonly<{ sessions: LocalChat[]; warnings: string[]; truncated: boolean }>;
type Target = Readonly<{ sessionId: string; label: string; contextKey?: string }>;
type Approval = Readonly<{ requestId: string; command: string }>;
type SudoConsent = Approval & Readonly<{ message: string }>;
type SudoResponse = Readonly<{ requestId: string; approved: boolean }>;
type Run = Readonly<{ id: string; target: Target; provider: ProviderId; stopping: boolean }>;
type OutputBlock = Readonly<{ format: "markdown" | "log"; text: string }>;
type AutomationEvent = {
  run_id: string;
  session_id: string;
  kind: "status" | "output" | "command_output" | "approval" | "command" | "completed" | "failed" | "cancelled" | "session" | "sudo_approval" | "sudo_status" | "sudo_error";
  message: string;
  request_id?: string;
  command?: string;
};
type AutomationOptions = {
  invoke: (command: string, arguments_?: Record<string, unknown>) => Promise<unknown>;
  listen: (name: string, callback: (event: { payload: unknown }) => void) => Promise<() => void>;
  getSelectedTarget: () => Target | null;
  onLayoutChange: () => void;
  document?: Document;
  createRunId?: () => string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
};

const MAX_PROMPT_CHARACTERS = 16_000;
const EXPECTED_PROVIDER_IDS: readonly ProviderId[] = ["claude", "codex"];
const MAX_OUTPUT_CHARACTERS = 200_000;
const MAX_OUTPUT_BLOCKS = 200;
const OUTPUT_TRIM_NOTICE = "[Earlier output trimmed]\n";
const CONVERSATION_STORAGE_PREFIX = "sleekssh_automation_conversation:";
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VISIBLE_LOCAL_CHATS = 200;
const MAX_CHAT_TITLE_CHARACTERS = 64;
const MAX_CHAT_PROJECT_CHARACTERS = 48;
const MAX_CHAT_WARNING_CHARACTERS = 160;
const MAX_VISIBLE_CHAT_WARNINGS = 3;
const SUDO_ALLOWED_MESSAGE = "Saved sudo password allowed for this run.";
const TERMINAL_EVENT_KINDS = new Set(["completed", "failed", "cancelled"]);
const EVENT_KINDS = new Set(["status", "output", "command_output", "approval", "command", "session", "sudo_approval", "sudo_status", "sudo_error", ...TERMINAL_EVENT_KINDS]);

function conversationStorageKey(target: Target, provider: string): string {
  return CONVERSATION_STORAGE_PREFIX + JSON.stringify([target.contextKey ?? target.sessionId, provider]);
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
  if (event.kind === "approval" && (typeof event.request_id !== "string" || !event.request_id
    || typeof event.command !== "string" || !event.command)) return null;
  if ((event.kind === "sudo_approval" || event.kind === "sudo_status")
    && (typeof event.request_id !== "string" || !event.request_id.trim())) return null;
  if (event.kind === "sudo_approval" && (typeof event.command !== "string" || !event.command.trim() || !event.message.trim())) return null;
  if (event.kind === "sudo_error" && (!event.message.trim()
    || (event.request_id !== undefined && (typeof event.request_id !== "string" || !event.request_id.trim())))) return null;
  return event as AutomationEvent;
}

export function initAutomation(options: AutomationOptions) {
  const document_ = options.document ?? document;
  const element = <T extends HTMLElement>(id: string): T => {
    const found = document_.getElementById(id);
    if (!found) throw new Error(`SSH automation control is missing: ${id}`);
    return found as T;
  };
  const panel = element("automation-panel");
  const toggle = element<HTMLButtonElement>("btn-automation-toggle");
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
  const bindings: Array<() => void> = [];
  let providers: Provider[] = [];
  let run: Run | null = null;
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
  let statusMessage = "";
  let statusError = false;
  let conversationError = "";
  let displayedConversationKey: string | null | undefined;
  const conversationDrafts = new Map<string, string>();
  const localChats = new Map<ProviderId, LocalChatListing>();
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

  function render() {
    const selectedTarget = options.getSelectedTarget();
    syncConversation(selectedTarget);
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
    startButton.disabled = !listenerReady || providersBusy || !selectedTarget || !provider?.available || !validPrompt || !validConversation || Boolean(conversationError) || Boolean(run);
    conversation.disabled = Boolean(run) || !selectedTarget;
    newChatButton.disabled = Boolean(run) || !selectedTarget;
    conversationHelp.textContent = conversationError || (!validConversation ? "Enter a complete conversation UUID, or choose New chat."
      : conversationId ? "The next task continues this saved, idle chat on this server." : "Use a saved, idle chat; leave blank to start one.");
    conversationHelp.dataset.error = String(Boolean(conversationError) || !validConversation);
    conversation.setAttribute("aria-invalid", String(!validConversation));
    providerSelect.disabled = Boolean(run);
    prompt.disabled = Boolean(run);
    refreshButton.disabled = providersBusy || Boolean(run);
    stopButton.disabled = !run || run.stopping;
    stopButton.textContent = run?.stopping ? "Stopping…" : "Stop";
    element("automation-stop-help").hidden = !run;
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
    toggle.textContent = approval || sudoConsent ? "Automation · review" : run ? "Automation · running" : "Automation";
  }

  function renderLocalChats(conversationId: string, target: Target | null) {
    const provider = providerSelect.value as ProviderId;
    const listing = localChats.get(provider);
    const error = localChatErrors.get(provider);
    const loading = chatsLoadingProvider === provider;
    chatSelect.disabled = Boolean(run) || !target;
    refreshChatsButton.disabled = Boolean(run) || loading;
    chatHelp.textContent = error || (loading ? "Loading saved local chats…" : !listing ? "Open automation to load saved local chats."
      : !listing.sessions.length ? "No saved local chats found. Choose New chat or use Advanced."
        : `${listing.sessions.length} saved local chat${listing.sessions.length === 1 ? "" : "s"}. Choose an idle chat.`);
    if (listing && !error && !loading) {
      const warnings = listing.warnings.slice(0, MAX_VISIBLE_CHAT_WARNINGS).map(warning => boundedChatText(warning, MAX_CHAT_WARNING_CHARACTERS));
      chatHelp.textContent += [listing.truncated ? "Recent chats shown; use Advanced for another ID." : "", ...warnings].filter(Boolean).map(message => ` ${message}`).join("");
    }
    if (conversationError) chatHelp.textContent += ` ${conversationError}`;
    chatHelp.dataset.error = String(Boolean(error) || Boolean(conversationError));
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
    if (chatsLoadingProvider === provider || (!refresh && localChats.has(provider))) return;
    const request = ++chatsRequest;
    chatsLoadingProvider = provider;
    localChatErrors.delete(provider);
    render();
    try {
      const listing = parseLocalChats(await options.invoke("list_local_agent_sessions", { provider }));
      if (disposed || request !== chatsRequest || providerSelect.value !== provider) return;
      localChats.set(provider, listing);
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

  function appendOutput(message: string, format: OutputBlock["format"] = "log") {
    if (!message) return;
    const previous = outputBlocks.at(-1);
    const blocks = previous?.format === format
      ? [...outputBlocks.slice(0, -1), { format, text: previous.text + message }]
      : [...outputBlocks, { format, text: message }];
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
    const nodes = outputBlocks.map(block => {
      const node = document_.createElement(block.format === "markdown" ? "div" : "pre");
      node.className = `automation-output-${block.format === "markdown" ? "markdown" : "log"}`;
      if (block.format === "markdown") node.innerHTML = renderAutomationMarkdown(block.text).trimEnd();
      else node.textContent = block.text;
      return node;
    });
    if (outputTrimmed) {
      const notice = document_.createElement("pre");
      notice.className = "automation-output-log";
      notice.textContent = OUTPUT_TRIM_NOTICE;
      nodes.unshift(notice);
    }
    output.replaceChildren(...nodes);
    output.scrollTop = output.scrollHeight;
  }

  function setOpen(open: boolean, focus = false) {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    options.onLayoutChange();
    if (open) {
      panelOpened = true;
      void loadLocalChats();
    }
    if (focus) (open ? run ? sudoConsent && !sudoInFlight && !run.stopping ? sudoAllowButton
      : approvals.length && !approvalInFlight && !run.stopping ? approveButton : stopButton : prompt : toggle).focus();
  }

  function resetSudoConsent() {
    sudoConsent = null;
    sudoInFlight = null;
    sudoResolved = false;
    sudoMessage = "";
    sudoMessageError = false;
    seenSudoRequests.clear();
  }

  function handleEvent(payload: unknown) {
    const event = parseEvent(payload);
    if (disposed || !event || !run || event.run_id !== run.id || event.session_id !== run.target.sessionId) return;
    if (event.kind === "session") {
      if (!CONVERSATION_ID_PATTERN.test(event.message)) {
        setStatus("The local agent returned an invalid conversation ID. This chat context was not saved.", true);
        return;
      }
      const key = conversationStorageKey(run.target, run.provider);
      conversation.value = event.message;
      conversationDrafts.set(key, event.message);
      try { storage?.setItem(key, JSON.stringify(event.message)); conversationError = storageAccessError; }
      catch (error) { conversationError = `Could not save this chat context: ${String(error)}. Copy the conversation ID to reuse it.`; }
      appendOutput(`\nConversation ID: ${event.message}\n`);
      render();
    } else if (event.kind === "sudo_approval") {
      if (run.stopping || sudoResolved || sudoConsent || seenSudoRequests.has(event.request_id!)) return;
      seenSudoRequests.add(event.request_id!);
      sudoConsent = { requestId: event.request_id!, command: event.command!, message: event.message };
      setStatus("Sudo needs permission to use this server's saved password. Remote commands still require approval.");
      setOpen(true);
      sudoAllowButton.focus();
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
      }
      setOpen(true);
      setStatus("Review the command for this server. The agent is waiting for your decision.");
    } else if (event.kind === "output") {
      appendOutput(event.message, "markdown");
    } else if (event.kind === "command_output") {
      appendOutput(event.message);
    } else if (TERMINAL_EVENT_KINDS.has(event.kind)) {
      appendOutput(`\n[${event.kind}] ${event.message}\n`);
      run = null;
      approvals = [];
      approvalInFlight = null;
      resetSudoConsent();
      setStatus(event.message || `Automation ${event.kind}.`, event.kind === "failed");
    } else {
      if (event.kind === "status" && event.request_id) {
        approvals = approvals.filter(approval => approval.requestId !== event.request_id);
        if (approvalInFlight === event.request_id) approvalInFlight = null;
      }
      if (event.kind === "command") appendOutput(`\n$ ${event.command ?? event.message}\n`);
      setStatus(event.message);
    }
  }

  async function refreshProviders() {
    if (providersBusy || run || disposed) return;
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
    render();
    if (startButton.disabled || disposed) return;
    const target = options.getSelectedTarget();
    if (!target) return;
    const currentRun: Run = {
      id: (options.createRunId ?? (() => crypto.randomUUID()))(),
      target: { ...target },
      provider: providerSelect.value as ProviderId,
      stopping: false,
    };
    const resumeSessionId = conversation.value.trim() || null;
    run = currentRun;
    approvals = [];
    approvalInFlight = null;
    resetSudoConsent();
    outputBlocks = [];
    outputTrimmed = false;
    appendOutput(`${providers.find(provider => provider.id === currentRun.provider)?.name} · ${target.label}\nTask: ${prompt.value.trim()}\n\n`);
    setStatus("Starting the local agent…");
    try {
      await options.invoke("start_ssh_automation", {
        runId: currentRun.id, sessionId: currentRun.target.sessionId, provider: currentRun.provider, prompt: prompt.value.trim(), resumeSessionId,
      });
    } catch (error) {
      if (disposed || run?.id !== currentRun.id) return;
      run = null;
      approvals = [];
      resetSudoConsent();
      const message = `Could not start automation: ${String(error)}`;
      appendOutput(`\n${message}\n`);
      setStatus(message, true);
    }
  }

  async function stopRun() {
    if (!run || run.stopping || disposed) return;
    const runId = run.id;
    run = { ...run, stopping: true };
    setStatus("Stopping the local agent and closing its command channel…");
    try {
      await options.invoke("stop_ssh_automation", { runId });
    } catch (error) {
      if (disposed || run?.id !== runId) return;
      run = { ...run, stopping: false };
      setStatus(`Could not stop automation: ${String(error)}. Try Stop again.`, true);
    }
  }

  async function respondToApproval(approved: boolean) {
    const approval = approvals[0];
    if (!run || !approval || approvalInFlight || run.stopping || disposed) return;
    const runId = run.id;
    approvalInFlight = approval.requestId;
    render();
    try {
      await options.invoke("respond_automation_approval", { runId, requestId: approval.requestId, approved });
      if (disposed || run?.id !== runId) return;
      approvals = approvals.filter(candidate => candidate.requestId !== approval.requestId);
      appendOutput(`\n[${approved ? "Approved" : "Denied"}] ${approval.command}\n`);
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
    if (!run || !consent || sudoInFlight || run.stopping || disposed) return;
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
    conversation.value = "";
    conversationDrafts.set(displayedConversationKey, "");
    try { storage?.removeItem(displayedConversationKey); conversationError = ""; }
    catch (error) { conversationError = `Could not clear this chat context: ${String(error)}. Retry New chat.`; }
    render();
  }

  bind(toggle, "click", () => setOpen(Boolean(panel.hidden), true));
  bind(element("automation-close"), "click", () => setOpen(false, true));
  bind(providerSelect, "change", () => {
    render();
    if (panelOpened) void loadLocalChats();
  });
  bind(chatSelect, "change", () => {
    if (run || disposed) return;
    if (!chatSelect.value) { clearConversation(); return; }
    conversation.value = chatSelect.value;
    if (displayedConversationKey) conversationDrafts.set(displayedConversationKey, conversation.value);
    conversationError = "";
    render();
  });
  bind(refreshChatsButton, "click", () => { void loadLocalChats(true); });
  bind(conversation, "input", () => {
    if (displayedConversationKey) conversationDrafts.set(displayedConversationKey, conversation.value);
    conversationError = "";
    render();
  });
  bind(newChatButton, "click", clearConversation);
  bind(prompt, "input", render);
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
  bind(stopButton, "click", stopRun);
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
    dispose() {
      disposed = true;
      unlisten?.();
      bindings.forEach(unbind => unbind());
    },
  };
}

declare global {
  interface Window {
    SleekSshAutomation?: { initAutomation: typeof initAutomation };
  }
}

if (typeof window !== "undefined") window.SleekSshAutomation = { initAutomation };
