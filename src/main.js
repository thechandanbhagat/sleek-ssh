const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// State management
let savedProfiles = [];
let savedVpnProfiles = [];
let activeSessions = {}; // sessionId -> { id, name, host, term, fitAddon, container, isClosed }
let activeTabId = null;
let automationPanel = null;
let vpnOperationCancelRequested = false;
let vpnConnectionActive = false;
let vpnControlsBusy = false;
let pendingVpnCredentialResolver = null;
let pendingVpnCredentialProfile = null;
let pendingVpnCertificateProfile = null;
let quickConnectModalTrigger = null;
let notificationElement = null;
let notificationTimeoutId = null;
let commandPalette = null;
let agentUiState = { open: false, running: false, review: false, targetSessionId: null };
let vpnStatusSnapshot = { state: "unknown", server: null };
const NAMESPACE_SEPARATOR = "/";
const NOTIFICATION_DURATION_MS = 3500;
const SFTP_EXPLORER_STATE_STORAGE_KEY = "sleekssh_sftp_explorer_state";
const REMOTE_HOME_DIRECTORY = ".";
const ROOT_REMOTE_DIRECTORY = "/";
const SFTP_PANEL_TRANSITION_MS = 260;
const TERMINAL_DIRECTORY_SYNC_DELAY_MS = 50;
const TERMINAL_RECONNECT_RESET_SEQUENCE = "\x1b[?1049l\x1b[!p";
const TERMINAL_SCROLLBAR_WIDTH = 6;
const TERMINAL_SEARCH_REFRESH_DELAY_MS = 100;
const TERMINAL_SEARCH_MATCH_COLOR = "#3d3220";
const TERMINAL_SEARCH_ACTIVE_MATCH_COLOR = "#1f3a63";
const TERMINAL_SEARCH_MATCH_RULER_COLOR = "#f7b44e";
const TERMINAL_SEARCH_ACTIVE_MATCH_RULER_COLOR = "#65a3ff";
const LOCAL_TERMINAL_DEFAULT_COLUMNS = 80;
const LOCAL_TERMINAL_DEFAULT_ROWS = 24;
const LOCAL_TERMINAL_SHELLS = Object.freeze({
  powershell: "PowerShell",
  cmd: "Command Prompt"
});
const UI_ICONS = Object.freeze({
  server: '<rect x="3" y="4" width="18" height="7" rx="2"></rect><rect x="3" y="13" width="18" height="7" rx="2"></rect><path d="M7 7.5h.01M7 16.5h.01"></path>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"></rect><path d="M7 9.5l3 2.5-3 2.5M12.5 15H17"></path>',
  agent: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1L5 10.5l5.1-1.9z"></path>',
  agentFull: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1L5 10.5l5.1-1.9z"></path><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"></path>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"></path>',
  folder: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2h7.4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"></path>',
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"></path><path d="M14 3.5V8h4.5"></path>',
  edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z"></path><path d="M14.5 7.5l2 2"></path>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.2a1.5 1.5 0 0 0 1.5 1.3h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7"></path>',
  download: '<path d="M12 4.5V15M7.5 10.5L12 15l4.5-4.5"></path><path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"></path>',
  upload: '<path d="M12 15V4.5M7.5 9L12 4.5 16.5 9"></path><path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"></path>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"></path>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"></path><path d="M20 4.5V9h-4.5"></path>',
  folderPlus: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2h7.4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"></path><path d="M12 10.5v5M9.5 13h5"></path>',
  link: '<path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1"></path><path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"></path>',
  chevronDown: '<path d="M6 9l6 6 6-6"></path>',
  shield: '<path d="M12 3l7 3v5.5c0 4.2-2.9 7.7-7 9.5-4.1-1.8-7-5.3-7-9.5V6z"></path>',
  key: '<circle cx="8" cy="15" r="4"></circle><path d="M10.9 12.1L19 4M15.5 7.5l2.5 2.5M13.5 9.5l1.5 1.5"></path>',
  search: '<circle cx="11" cy="11" r="6.5"></circle><path d="M20 20l-4.2-4.2"></path>'
});

function uiIcon(name, className = "icon") {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${UI_ICONS[name]}</svg>`;
}

const TAB_KIND_CONFIG = Object.freeze({
  ssh: {
    label: "SSH",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true">${UI_ICONS.server}</svg>`
  },
  local: {
    label: "Local",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true">${UI_ICONS.terminal}</svg>`
  },
  settings: {
    label: "Settings",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z"></path></svg>`
  },
  ports: {
    label: "Ports",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="1.8"></circle><path d="M8.1 8.1a5.5 5.5 0 0 0 0 7.8M15.9 8.1a5.5 5.5 0 0 1 0 7.8M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4"></path></svg>`
  }
});

// DOM Elements
const sidebarTabs = document.querySelectorAll(".nav-tab");
const tabPanes = document.querySelectorAll(".tab-pane");
const btnAddProfile = document.getElementById("btn-add-profile");
const profilesList = document.getElementById("profiles-list");
const systemKeysList = document.getElementById("system-keys-list");
const btnGenerateKey = document.getElementById("btn-generate-key");
const keyDisplaySection = document.getElementById("key-display-section");
const pubkeyText = document.getElementById("pubkey-text");
const btnCopyPubkey = document.getElementById("btn-copy-pubkey");

const btnAddVpnProfile = document.getElementById("btn-add-vpn-profile");
const vpnProfilesList = document.getElementById("vpn-profiles-list");
const vpnClientPath = document.getElementById("vpn-client-path");
const vpnConnectionState = document.getElementById("vpn-connection-state");
const vpnConnectionSummary = document.getElementById("vpn-connection-summary");
const vpnStatusOutput = document.getElementById("vpn-status-output");
const btnRefreshVpnStatus = document.getElementById("btn-refresh-vpn-status");
const btnDisconnectVpn = document.getElementById("btn-disconnect-vpn");
const btnCancelVpnOperation = document.getElementById("btn-cancel-vpn-operation");
const btnScanCiscoVpnProfiles = document.getElementById("btn-scan-cisco-vpn-profiles");
const ciscoVpnProfilesList = document.getElementById("cisco-vpn-profiles-list");
const vpnProfileModal = document.getElementById("vpn-profile-modal");
const vpnProfileForm = document.getElementById("vpn-profile-form");
const vpnModalTitle = document.getElementById("vpn-modal-title");
const btnCloseVpnModal = document.getElementById("btn-close-vpn-modal");
const btnCancelVpnModal = document.getElementById("btn-cancel-vpn-modal");
const vpnCredentialModal = document.getElementById("vpn-credential-modal");
const vpnCredentialForm = document.getElementById("vpn-credential-form");
const vpnCredentialTitle = document.getElementById("vpn-credential-title");
const vpnRuntimeUsername = document.getElementById("vpn-runtime-username");
const vpnRuntimePassword = document.getElementById("vpn-runtime-password");
const btnCloseVpnCredentialModal = document.getElementById("btn-close-vpn-credential-modal");
const btnCancelVpnCredentialModal = document.getElementById("btn-cancel-vpn-credential-modal");
const vpnCertificateModal = document.getElementById("vpn-certificate-modal");
const vpnCertificateServer = document.getElementById("vpn-certificate-server");
const btnCloseVpnCertificateModal = document.getElementById("btn-close-vpn-certificate-modal");
const btnCancelVpnCertificateModal = document.getElementById("btn-cancel-vpn-certificate-modal");
const btnAcceptVpnCertificateModal = document.getElementById("btn-accept-vpn-certificate-modal");

// Quick Connect Form
const quickConnectForm = document.getElementById("quick-connect-form");
const quickConnectModal = document.getElementById("quick-connect-modal");
const btnCloseQuickConnectModal = document.getElementById("btn-close-quick-connect-modal");
const btnCancelQuickConnectModal = document.getElementById("btn-cancel-quick-connect-modal");
const qcAuthModeRadio = document.getElementsByName("qc-auth-mode");
const qcAuthKeyFields = document.getElementById("qc-auth-key-fields");
const qcAuthPasswordFields = document.getElementById("qc-auth-password-fields");
const qcKeypathInput = document.getElementById("qc-keypath");

// Modal Elements
const profileModal = document.getElementById("profile-modal");
const profileForm = document.getElementById("profile-form");
const modalTitle = document.getElementById("modal-title");
const btnCloseModal = document.getElementById("btn-close-modal");
const btnCancelModal = document.getElementById("btn-cancel-modal");
const btnSelectKeyfile = document.getElementById("btn-select-keyfile");
const profAuthModeRadio = document.getElementsByName("prof-auth-mode");
const profAuthKeyFields = document.getElementById("prof-auth-key-fields");
const profAuthPasswordFields = document.getElementById("prof-auth-password-fields");
const profKeypathInput = document.getElementById("prof-keypath");
const profSudoShortcut = document.getElementById("prof-sudo-shortcut");
const profSudoPassword = document.getElementById("prof-sudo-password");
const profSudoPasswordStatus = document.getElementById("prof-sudo-password-status");
const profDeleteSudoPassword = document.getElementById("prof-delete-sudo-password");
const profileSaveError = document.getElementById("profile-save-error");
let editingSudoIdentity = null;
let profileSavePending = false;
let profileModalTrigger = null;

// Workspace Elements
const tabsContainer = document.getElementById("tabs-container");
const btnNewTabPlus = document.getElementById("btn-new-tab-plus");
const workspaceViewport = document.getElementById("workspace-viewport");
const welcomeScreen = document.getElementById("welcome-screen");
const welcomeBtnNew = document.getElementById("welcome-btn-new");
const welcomeBtnAdd = document.getElementById("welcome-btn-add");
const welcomeBtnTerminal = document.getElementById("welcome-btn-terminal");
const btnOpenPowerShell = document.getElementById("btn-open-powershell");
const btnOpenCommandPrompt = document.getElementById("btn-open-command-prompt");

// Helper to encode string to base64 safely supporting Unicode/ANSI
function stringToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binString = "";
  for (let i = 0; i < bytes.length; i++) {
    binString += String.fromCharCode(bytes[i]);
  }
  return btoa(binString);
}

// Helper to decode base64 to Uint8Array for binary-safe terminal output
function base64ToBytes(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function createWorkspaceTab(sessionId, kind, title) {
  const kindConfig = TAB_KIND_CONFIG[kind];
  if (!kindConfig) throw new Error(`Unsupported workspace tab kind: ${kind}`);

  const tabElement = document.createElement("div");
  tabElement.className = "terminal-tab active";
  tabElement.dataset.id = sessionId;
  tabElement.dataset.kind = kind;
  tabElement.dataset.status = kind === "ssh" || kind === "local" ? "connecting" : "none";
  tabElement.setAttribute("role", "presentation");
  tabElement.innerHTML = `
    <button class="tab-activation" type="button" role="tab" aria-selected="false">
      <span class="tab-identity">
        <span class="tab-kind-icon">${kindConfig.icon}<span class="tab-status-dot" aria-hidden="true"></span></span>
        <span class="tab-title">${escapeHtml(title)}</span>
        <span class="tab-agent-indicator" title="The agent is working on this server" aria-hidden="true"><svg viewBox="0 0 24 24">${UI_ICONS.agent}</svg></span>
      </span>
    </button>
    <button class="btn-tab-close" type="button" aria-label="Close ${escapeHtml(title)}"><svg viewBox="0 0 24 24" aria-hidden="true">${UI_ICONS.close}</svg></button>
  `;

  const activationButton = tabElement.querySelector(".tab-activation");
  activationButton.addEventListener("click", () => switchTab(sessionId));
  activationButton.addEventListener("keydown", handleWorkspaceTabKeydown);
  tabElement.querySelector(".btn-tab-close").addEventListener("click", (event) => {
    event.stopPropagation();
    closeTab(sessionId);
  });
  tabsContainer.appendChild(tabElement);

  updateWorkspaceTabTitle(tabElement, title);
  return tabElement;
}

function handleWorkspaceTabKeydown(event) {
  const navigationKeys = ["ArrowLeft", "ArrowRight", "Home", "End"];
  if (!navigationKeys.includes(event.key)) return;

  event.preventDefault();
  const tabElement = event.currentTarget.closest(".terminal-tab");
  const tabs = Array.from(tabsContainer.querySelectorAll(".terminal-tab"));
  const currentIndex = tabs.indexOf(tabElement);
  const targetIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  const targetTab = tabs[targetIndex];

  targetTab.querySelector(".tab-activation").focus();
  switchTab(targetTab.dataset.id);
}

function updateWorkspaceTabTitle(tabElement, title) {
  const kindConfig = TAB_KIND_CONFIG[tabElement.dataset.kind];
  const activationButton = tabElement.querySelector(".tab-activation");
  tabElement.querySelector(".tab-title").textContent = title;
  tabElement.querySelector(".btn-tab-close").setAttribute("aria-label", `Close ${title}`);
  activationButton.setAttribute("aria-label", `${title}, ${kindConfig.label} tab`);
  activationButton.title = `${title} (${kindConfig.label})`;
}

function initNotification() {
  notificationElement = document.createElement("div");
  notificationElement.className = "app-notification";
  notificationElement.setAttribute("role", "status");
  notificationElement.setAttribute("aria-live", "polite");
  document.body.appendChild(notificationElement);
}

function showNotification(message) {
  notificationElement.textContent = message;
  notificationElement.classList.add("visible");
  window.clearTimeout(notificationTimeoutId);
  notificationTimeoutId = window.setTimeout(() => {
    notificationElement.classList.remove("visible");
  }, NOTIFICATION_DURATION_MS);
}

const TERMINAL_WORD_SEPARATORS = " \t\n()[]{}'\"`<>|,;=";
const TERMINAL_CONTEXT_MENU_INSET = 8;
const TERMINAL_CONTEXT_MENU_KEYBOARD_OFFSET = 16;
const terminalClipboardStates = new WeakMap();
let activeTerminalContextMenu = null;
const SUDO_SHORTCUT_WINDOW_MS = 2000;
const SUDO_PROMPT_EXPIRY_MS = 30_000;
const SUDO_SHORTCUT_PRESS_COUNT = 3;
const SUDO_PROMPT_ID_MAX_LENGTH = 128;
const SUDO_PASSWORD_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SUDO_PASSWORD_MAX_BYTES = 255;
const sudoShortcutStates = new WeakMap();

function getSudoShortcutState(session) {
  if (!sudoShortcutStates.has(session)) {
    sudoShortcutStates.set(session, { count: 0, startedAt: 0, readyAt: 0, pending: false, generation: 0, expiryTimer: null });
  }
  return sudoShortcutStates.get(session);
}

function resetSudoShortcut(session, clearPrompt = true) {
  if (!session) return;
  const promptChanged = clearPrompt && Boolean(session.sudoPromptReady || session.sudoPromptId);
  const state = sudoShortcutStates.get(session);
  if (!state) {
    if (clearPrompt) {
      session.sudoPromptReady = false;
      session.sudoPromptId = null;
    }
    if (promptChanged && session.container) updateSessionToolbar(session);
    return;
  }
  state.count = 0;
  state.startedAt = 0;
  state.generation += 1;
  if (clearPrompt) {
    window.clearTimeout(state.expiryTimer);
    state.expiryTimer = null;
    state.readyAt = 0;
    session.sudoPromptReady = false;
    session.sudoPromptId = null;
  }
  if (promptChanged && session.container) updateSessionToolbar(session);
}

function setSudoPromptState(session, ready, promptId) {
  const existingState = session ? sudoShortcutStates.get(session) : null;
  const pendingGeneration = ready === false && existingState?.pending && !session.sudoPromptReady && session.sudoPromptId === null
    ? existingState.generation
    : null;
  resetSudoShortcut(session);
  // The backend acknowledges prompt consumption before the password write finishes.
  if (pendingGeneration !== null) existingState.generation = pendingGeneration;
  if (ready !== true || typeof promptId !== "string" || !promptId || promptId.length > SUDO_PROMPT_ID_MAX_LENGTH || !isSudoSessionConnected(session)) return;
  const state = getSudoShortcutState(session);
  state.readyAt = Date.now();
  session.sudoPromptReady = true;
  session.sudoPromptId = promptId;
  state.expiryTimer = window.setTimeout(() => resetSudoShortcut(session), SUDO_PROMPT_EXPIRY_MS);
  if (session.container) updateSessionToolbar(session);
}

function isSudoSessionConnected(session) {
  return Boolean(session
    && session.kind === "ssh"
    && activeSessions[session.id] === session
    && session.connectionId
    && session.connectionStatus === "connected"
    && !session.isClosed
    && !session.isClosing
    && !session.isConnecting
    && session.connectionProfile?.sudo_shortcut_enabled
    && session.connectionProfile?.has_sudo_password);
}

function canSendSudoPassword(session) {
  if (!isSudoSessionConnected(session) || activeTabId !== session.id || !session.sudoPromptReady || !session.sudoPromptId) return false;
  const state = getSudoShortcutState(session);
  return !state.pending && Date.now() - state.readyAt < SUDO_PROMPT_EXPIRY_MS;
}

async function sendSudoPassword(session) {
  if (!canSendSudoPassword(session)) return false;
  const connectionId = session.connectionId;
  const promptId = session.sudoPromptId;
  const state = getSudoShortcutState(session);
  state.pending = true;
  resetSudoShortcut(session);
  const generation = state.generation;
  try {
    await invoke("send_sudo_password", { sessionId: connectionId, promptId });
    if (state.generation === generation && activeSessions[session.id] === session && session.connectionId === connectionId && activeTabId === session.id) {
      showNotification("Saved sudo password submitted.");
    }
    return true;
  } catch {
    if (state.generation === generation && activeSessions[session.id] === session && session.connectionId === connectionId && activeTabId === session.id) {
      showNotification("Could not submit the saved sudo password. Wait for a new sudo prompt or reconnect.");
    }
    return false;
  } finally {
    state.pending = false;
    if (activeSessions[session.id] === session && session.container) updateSessionToolbar(session);
  }
}

function handleSudoShortcutKeyEvent(session, event) {
  if (event.type !== "keydown") return true;
  const isF2 = event.key === "F2" || event.code === "F2";
  if (!isF2 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    resetSudoShortcut(session);
    return true;
  }
  if (!canSendSudoPassword(session)) {
    resetSudoShortcut(session, false);
    return true;
  }
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return false;
  const state = getSudoShortcutState(session);
  const now = Date.now();
  if (state.count === 0 || now - state.startedAt > SUDO_SHORTCUT_WINDOW_MS) {
    state.count = 1;
    state.startedAt = now;
  } else {
    state.count += 1;
  }
  if (state.count === SUDO_SHORTCUT_PRESS_COUNT) sendSudoPassword(session);
  return false;
}

function initSudoShortcut(session) {
  const blurHandler = () => resetSudoShortcut(session, false);
  session.term.element.addEventListener("blur", blurHandler, true);
  window.addEventListener("blur", blurHandler);
  session.sudoShortcutDispose = () => {
    resetSudoShortcut(session);
    session.term.element.removeEventListener("blur", blurHandler, true);
    window.removeEventListener("blur", blurHandler);
  };
}

function getTerminalClipboardState(term) {
  if (!terminalClipboardStates.has(term)) {
    terminalClipboardStates.set(term, { copyPending: false, pastePending: false, selectionVersion: 0, isDisposed: false });
  }
  return terminalClipboardStates.get(term);
}

function copyTerminalSelection(term, clearAfterCopy = false) {
  const selection = term.getSelection();
  if (!selection) return false;

  const state = getTerminalClipboardState(term);
  if (!state.copyPending) copyTerminalText(term, selection, clearAfterCopy);
  return true;
}

async function copyTerminalText(term, selection, clearAfterCopy) {
  const state = getTerminalClipboardState(term);
  const selectionVersion = state.selectionVersion;
  state.copyPending = true;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
    await navigator.clipboard.writeText(selection);
    if (clearAfterCopy && !state.isDisposed && state.selectionVersion === selectionVersion && term.getSelection() === selection) {
      term.clearSelection();
    }
    showNotification("Selection copied.");
  } catch (error) {
    showNotification(`Could not copy selected text: ${error?.message || error}`);
  } finally {
    state.copyPending = false;
  }
}

function canPasteTerminal(session) {
  return Boolean(session.term
    && activeSessions[session.id] === session
    && !session.isClosed
    && !session.isClosing
    && !session.isConnecting
    && (session.kind === "local" ? session.isReady : session.connectionId));
}

async function pasteTerminalClipboard(session, nativeClipboardText) {
  resetSudoShortcut(session);
  if (!canPasteTerminal(session)) {
    showNotification("Wait until this terminal is connected before pasting.");
    return false;
  }
  const term = session.term;
  const state = getTerminalClipboardState(term);
  if (state.pastePending) return false;

  const connectionId = session.connectionId || session.id;
  state.pastePending = true;
  session.terminalInteractions?.refresh();
  try {
    if (nativeClipboardText === undefined && !navigator.clipboard?.readText) {
      throw new Error("Clipboard access is unavailable.");
    }
    const text = nativeClipboardText === undefined ? await navigator.clipboard.readText() : nativeClipboardText;
    if (!canPasteTerminal(session) || session.term !== term || (session.connectionId || session.id) !== connectionId) {
      showNotification("Paste cancelled because this terminal connection changed.");
      return false;
    }
    if (!text) return false;
    term.paste(text);
    if (activeTabId === session.id) term.focus();
    return true;
  } catch (error) {
    showNotification(`Could not paste clipboard text: ${error?.message || error}`);
    return false;
  } finally {
    state.pastePending = false;
    session.terminalInteractions?.refresh();
  }
}

function handleTerminalKeyEvent(session, event) {
  if (event.type !== "keydown") return true;
  if (!handleSudoShortcutKeyEvent(session, event)) return false;
  const term = session.term;
  const key = event.key?.toLowerCase();
  const copyShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && (event.code === "KeyC" || key === "c");
  const pasteShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && (event.code === "KeyV" || key === "v");
  const menuShortcut = event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
  if (copyShortcut) {
    if (!event.shiftKey && !term.hasSelection()) return true;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat && !copyTerminalSelection(term, !event.shiftKey)) {
      showNotification("Select terminal text to copy.");
    }
    return false;
  }
  if (pasteShortcut || menuShortcut) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      if (pasteShortcut) pasteTerminalClipboard(session);
      else session.terminalInteractions.open(event);
    }
    return false;
  }
  return true;
}

function selectTerminalOutput(term) {
  const buffer = term.buffer.active;
  for (let row = buffer.length - 1; row >= 0; row -= 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    for (let column = Math.min(line.length, term.cols) - 1; column >= 0; column -= 1) {
      const cell = line.getCell(column);
      if (!cell?.getChars().trim()) continue;
      const length = row * term.cols + column + Math.max(cell.getWidth(), 1);
      term.select(0, 0, length);
      return true;
    }
  }
  term.clearSelection();
  return false;
}

function initTerminalInteractions(session) {
  const term = session.term;
  const menu = document.createElement("div");
  menu.className = "terminal-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Terminal actions");
  const actions = [
    { label: "Copy", shortcut: "Ctrl+Shift+C", run: () => copyTerminalSelection(term) },
    { label: "Paste", shortcut: "Ctrl+Shift+V", run: () => pasteTerminalClipboard(session) },
    { label: "Select all", shortcut: "", run: () => selectTerminalOutput(term) },
    { label: "Clear selection", shortcut: "", run: () => term.clearSelection() }
  ];
  const buttons = actions.map(action => {
    const button = document.createElement("button");
    button.className = "terminal-context-action";
    button.type = "button";
    button.tabIndex = -1;
    button.setAttribute("role", "menuitem");
    const label = document.createElement("span");
    label.textContent = action.label;
    const shortcut = document.createElement("kbd");
    shortcut.textContent = action.shortcut;
    button.append(label, shortcut);
    button.addEventListener("click", () => {
      close();
      action.run();
    });
    menu.appendChild(button);
    return button;
  });
  let isOpen = false;

  function refresh() {
    buttons[0].disabled = !term.hasSelection();
    buttons[1].disabled = !canPasteTerminal(session) || getTerminalClipboardState(term).pastePending;
    buttons[1].title = buttons[1].disabled ? "Terminal must be connected and ready to paste." : "Paste clipboard text";
    buttons[3].disabled = !term.hasSelection();
  }

  function close(returnFocus = true) {
    if (!isOpen) return;
    isOpen = false;
    menu.remove();
    document.removeEventListener("pointerdown", dismissOutside, true);
    document.removeEventListener("contextmenu", dismissOutside, true);
    window.removeEventListener("blur", dismissOnBlur);
    if (activeTerminalContextMenu === controller) activeTerminalContextMenu = null;
    if (returnFocus && activeSessions[session.id] === session && activeTabId === session.id && !session.isClosing) term.focus();
  }

  function dismissOutside(event) {
    if (!menu.contains(event.target)) close(false);
  }

  function dismissOnBlur() {
    close(false);
  }

  function open(event) {
    event.preventDefault();
    event.stopPropagation();
    activeTerminalContextMenu?.close(false);
    refresh();
    isOpen = true;
    activeTerminalContextMenu = controller;
    document.body.appendChild(menu);
    const terminalBounds = term.element.getBoundingClientRect();
    const menuBounds = menu.getBoundingClientRect();
    const pointerPosition = event.type === "contextmenu" && (event.clientX || event.clientY);
    const left = pointerPosition ? event.clientX : terminalBounds.left + TERMINAL_CONTEXT_MENU_KEYBOARD_OFFSET;
    const top = pointerPosition ? event.clientY : terminalBounds.top + TERMINAL_CONTEXT_MENU_KEYBOARD_OFFSET;
    menu.style.left = `${Math.max(TERMINAL_CONTEXT_MENU_INSET, Math.min(left, window.innerWidth - menuBounds.width - TERMINAL_CONTEXT_MENU_INSET))}px`;
    menu.style.top = `${Math.max(TERMINAL_CONTEXT_MENU_INSET, Math.min(top, window.innerHeight - menuBounds.height - TERMINAL_CONTEXT_MENU_INSET))}px`;
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("contextmenu", dismissOutside, true);
    window.addEventListener("blur", dismissOnBlur);
    buttons.find(button => !button.disabled)?.focus();
  }

  menu.addEventListener("keydown", event => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const enabledButtons = buttons.filter(button => !button.disabled);
    const currentIndex = enabledButtons.indexOf(document.activeElement);
    const targetIndex = event.key === "Home" ? 0
      : event.key === "End" ? enabledButtons.length - 1
        : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + enabledButtons.length) % enabledButtons.length;
    enabledButtons[targetIndex]?.focus();
  });

  const contextMenuHandler = event => {
    event.stopImmediatePropagation();
    open(event);
  };
  const nativePasteHandler = event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.clipboardData) pasteTerminalClipboard(session, event.clipboardData.getData("text/plain"));
    else pasteTerminalClipboard(session);
  };
  const selectionListener = term.onSelectionChange(() => {
    getTerminalClipboardState(term).selectionVersion += 1;
    refresh();
  });
  term.element.addEventListener("contextmenu", contextMenuHandler, true);
  term.element.addEventListener("paste", nativePasteHandler, true);
  const controller = {
    open,
    close,
    refresh,
    dispose() {
      close(false);
      session.sudoShortcutDispose?.();
      getTerminalClipboardState(term).isDisposed = true;
      selectionListener.dispose();
      term.element.removeEventListener("contextmenu", contextMenuHandler, true);
      term.element.removeEventListener("paste", nativePasteHandler, true);
    }
  };
  return controller;
}

function markSessionTabAsDisconnected(sessionId) {
  document.querySelector(`.terminal-tab[data-id="${sessionId}"]`)?.classList.add("connection-terminated");
}

function getSavedSftpExplorerStates() {
  const saved = localStorage.getItem(SFTP_EXPLORER_STATE_STORAGE_KEY);
  if (!saved) return {};

  try {
    const states = JSON.parse(saved);
    return states && typeof states === "object" && !Array.isArray(states) ? states : {};
  } catch (error) {
    console.error("Failed to parse saved SFTP explorer state:", error);
    return {};
  }
}

function getSavedSftpExplorerState(profileId) {
  const savedState = getSavedSftpExplorerStates()[profileId];
  if (!savedState || typeof savedState !== "object") return null;

  return {
    currentPath: typeof savedState.currentPath === "string" && savedState.currentPath
      ? savedState.currentPath
      : null,
    sftpPanelOpen: savedState.sftpPanelOpen !== false
  };
}

function saveSftpExplorerState(session) {
  if (!session.sftpStateKey || !session.currentPath) return;

  const savedStates = getSavedSftpExplorerStates();
  savedStates[session.sftpStateKey] = {
    currentPath: session.currentPath,
    sftpPanelOpen: session.sftpPanelOpen
  };
  localStorage.setItem(SFTP_EXPLORER_STATE_STORAGE_KEY, JSON.stringify(savedStates));
}

// Initialize Application
window.addEventListener("DOMContentLoaded", () => {
  initNotification();
  initPanelLayout();
  initWindowControls();
  initSettings();
  initZoomControls();
  initNavigation();
  initModal();
  initProfileList();
  initKeyManager();
  initVpnManager();
  initConnectionListeners();
  initGlobalShortcutListener();
  initWorkspace();
  initSessionShortcuts();
  initPortKiller();
  initAutomationPanel();
  initWorkspaceChrome();
  initCommandPaletteIntegration();
});

function initAutomationPanel() {
  if (!window.SleekSshAutomation) {
    document.getElementById("btn-automation-toggle")?.addEventListener("click", () => {
      showNotification("The agent panel could not load. Rebuild SleekSSH with npm run tauri.");
    });
    return;
  }
  automationPanel = window.SleekSshAutomation.initAutomation({
    invoke,
    listen,
    getSelectedTarget: () => {
      const session = activeSessions[activeTabId];
      if (!session || session.kind !== "ssh" || !session.connectionId || session.connectionStatus !== "connected"
        || session.isClosed || session.isClosing || session.isConnecting) return null;
      const profile = session.connectionProfile;
      return {
        sessionId: session.connectionId,
        contextKey: JSON.stringify([profile.id || "", profile.username, session.host, profile.port]),
        label: `${session.name} · ${profile.username}@${session.host}:${profile.port}`
      };
    },
    onLayoutChange: () => {
      handleAgentPanelLayoutChange();
      const session = activeSessions[activeTabId];
      if (session?.term) requestAnimationFrame(() => fitTerminal(session));
    },
    onStateChange: (state) => {
      agentUiState = state;
      refreshWorkspaceChrome();
    }
  });
}

// --- PANEL LAYOUT ---
const PANEL_LAYOUT_STORAGE_KEY = "sleekssh_panel_layout";
const PANEL_LAYOUT_LIMITS = Object.freeze({
  sidebarDefault: 248,
  sidebarMinimum: 200,
  sidebarMaximum: 360,
  sftpDefault: 280,
  sftpMinimum: 220,
  sftpMaximum: 420,
  terminalMinimum: 320,
  keyboardStep: 16,
  keyboardLargeStep: 64
});
let panelLayoutPreferences = {
  sidebarWidth: PANEL_LAYOUT_LIMITS.sidebarDefault,
  sftpWidth: PANEL_LAYOUT_LIMITS.sftpDefault,
  sidebarOpen: true
};

function normalizePanelWidth(width, minimum, maximum, fallback) {
  return typeof width === "number" && Number.isFinite(width)
    ? Math.min(maximum, Math.max(minimum, width))
    : fallback;
}

function readPanelLayoutPreferences() {
  const defaults = {
    sidebarWidth: PANEL_LAYOUT_LIMITS.sidebarDefault,
    sftpWidth: PANEL_LAYOUT_LIMITS.sftpDefault,
    sidebarOpen: true
  };
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY) || "null");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return defaults;
    return {
      sidebarWidth: normalizePanelWidth(saved.sidebarWidth, PANEL_LAYOUT_LIMITS.sidebarMinimum, PANEL_LAYOUT_LIMITS.sidebarMaximum, defaults.sidebarWidth),
      sftpWidth: normalizePanelWidth(saved.sftpWidth, PANEL_LAYOUT_LIMITS.sftpMinimum, PANEL_LAYOUT_LIMITS.sftpMaximum, defaults.sftpWidth),
      sidebarOpen: typeof saved.sidebarOpen === "boolean" ? saved.sidebarOpen : defaults.sidebarOpen
    };
  } catch (error) {
    console.warn("Unable to read saved panel layout:", error);
    return defaults;
  }
}

function savePanelLayoutPreferences() {
  try {
    localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(panelLayoutPreferences));
  } catch (error) {
    console.error("Unable to save panel layout:", error);
    showNotification("Panel layout could not be saved.");
  }
}

function getPanelLayoutWidths(totalWidth, sidebarWidth, sftpWidth, sidebarOpen = true, sftpOpen = true) {
  const availableWidth = typeof totalWidth === "number" && Number.isFinite(totalWidth) ? Math.max(0, totalWidth) : 0;
  const requestedSidebarWidth = normalizePanelWidth(sidebarWidth, PANEL_LAYOUT_LIMITS.sidebarMinimum, PANEL_LAYOUT_LIMITS.sidebarMaximum, PANEL_LAYOUT_LIMITS.sidebarDefault);
  const requestedSftpWidth = normalizePanelWidth(sftpWidth, PANEL_LAYOUT_LIMITS.sftpMinimum, PANEL_LAYOUT_LIMITS.sftpMaximum, PANEL_LAYOUT_LIMITS.sftpDefault);
  const canShowSidebar = sidebarOpen && availableWidth >= PANEL_LAYOUT_LIMITS.sidebarMinimum + PANEL_LAYOUT_LIMITS.terminalMinimum;
  const sidebarMinimum = canShowSidebar ? PANEL_LAYOUT_LIMITS.sidebarMinimum : 0;
  const canShowSftp = sftpOpen && availableWidth >= sidebarMinimum + PANEL_LAYOUT_LIMITS.sftpMinimum + PANEL_LAYOUT_LIMITS.terminalMinimum;
  const sftpMinimum = canShowSftp ? PANEL_LAYOUT_LIMITS.sftpMinimum : 0;
  const effectiveSidebarWidth = canShowSidebar ? Math.min(requestedSidebarWidth, availableWidth - PANEL_LAYOUT_LIMITS.terminalMinimum - sftpMinimum) : 0;
  const effectiveSftpWidth = canShowSftp ? Math.min(requestedSftpWidth, availableWidth - effectiveSidebarWidth - PANEL_LAYOUT_LIMITS.terminalMinimum) : 0;
  return {
    sidebarWidth: effectiveSidebarWidth,
    sftpWidth: effectiveSftpWidth,
    terminalWidth: Math.max(0, availableWidth - effectiveSidebarWidth - effectiveSftpWidth),
    sidebarAutoCollapsed: sidebarOpen && !canShowSidebar,
    sftpAutoCollapsed: sftpOpen && !canShowSftp
  };
}

function updatePanelSeparator(handle, width, minimum, maximum) {
  if (!handle) return;
  handle.hidden = width === 0;
  handle.setAttribute("aria-valuemin", String(minimum));
  handle.setAttribute("aria-valuemax", String(Math.max(minimum, maximum)));
  handle.setAttribute("aria-valuenow", String(Math.round(width)));
  handle.setAttribute("aria-valuetext", `${Math.round(width)} pixels`);
}

function getMeasuredLayoutWidth(element) {
  return element && typeof element.getBoundingClientRect === "function" ? element.getBoundingClientRect().width : 0;
}

function refreshPanelLayout() {
  const app = document.querySelector(".app-container");
  const sidebar = document.querySelector(".sidebar");
  if (!app || !sidebar || typeof app.getBoundingClientRect !== "function") return;
  const agentPanel = document.getElementById("automation-panel");
  const agentWidth = agentPanel && agentPanel.hidden === false ? getMeasuredLayoutWidth(agentPanel) : 0;
  const agentOpen = agentWidth > 0;
  const totalWidth = Math.max(0, app.getBoundingClientRect().width - getMeasuredLayoutWidth(document.querySelector(".activity-rail")) - agentWidth);
  const activeSession = activeSessions[activeTabId];
  const sftpOpen = !agentOpen && activeSession?.kind === "ssh" && activeSession.sftpPanelOpen !== false;
  const widths = getPanelLayoutWidths(totalWidth, panelLayoutPreferences.sidebarWidth, panelLayoutPreferences.sftpWidth, panelLayoutPreferences.sidebarOpen, sftpOpen);
  app.style.setProperty("--sidebar-width", `${widths.sidebarWidth}px`);
  app.classList.toggle("sidebar-collapsed", widths.sidebarWidth === 0);
  sidebar.inert = widths.sidebarWidth === 0;
  const sidebarToggle = document.getElementById("btn-sidebar-toggle");
  if (sidebarToggle) {
    sidebarToggle.setAttribute("aria-expanded", String(widths.sidebarWidth > 0));
    sidebarToggle.title = widths.sidebarWidth > 0 ? "Hide sidebar" : widths.sidebarAutoCollapsed ? "Show sidebar when the window is wider" : "Show sidebar";
    sidebarToggle.setAttribute("aria-label", sidebarToggle.title);
  }
  updatePanelSeparator(document.getElementById("sidebar-resize-handle"), widths.sidebarWidth, PANEL_LAYOUT_LIMITS.sidebarMinimum, Math.min(PANEL_LAYOUT_LIMITS.sidebarMaximum, totalWidth - PANEL_LAYOUT_LIMITS.terminalMinimum - (sftpOpen && !widths.sftpAutoCollapsed ? PANEL_LAYOUT_LIMITS.sftpMinimum : 0)));
  Object.values(activeSessions).forEach((session) => {
    if (!session.container || session.kind !== "ssh") return;
    const sessionWidths = getPanelLayoutWidths(totalWidth - widths.sidebarWidth, 0, panelLayoutPreferences.sftpWidth, false, !agentOpen && session.sftpPanelOpen !== false);
    session.container.style.setProperty("--sftp-panel-width", `${sessionWidths.sftpWidth}px`);
    session.container.classList.toggle("sftp-auto-collapsed", !agentOpen && sessionWidths.sftpAutoCollapsed);
    const panel = session.container.querySelector(".sftp-panel");
    if (panel) panel.inert = sessionWidths.sftpWidth === 0;
    updatePanelSeparator(session.container.querySelector(".sftp-resize-handle"), sessionWidths.sftpWidth, PANEL_LAYOUT_LIMITS.sftpMinimum, Math.min(PANEL_LAYOUT_LIMITS.sftpMaximum, totalWidth - widths.sidebarWidth - PANEL_LAYOUT_LIMITS.terminalMinimum));
    if (session.term && typeof updateSessionToolbar === "function") updateSessionToolbar(session);
  });
  if (activeSession?.term) fitTerminal(activeSession);
}

function toggleSidebarPanel() {
  const app = document.querySelector(".app-container");
  panelLayoutPreferences = { ...panelLayoutPreferences, sidebarOpen: Boolean(app?.classList.contains("sidebar-collapsed")) };
  savePanelLayoutPreferences();
  refreshPanelLayout();
}

function bindPanelResizeHandle(handle, panelKind, getMeasuredWidth) {
  if (!handle) return () => {};
  const isSidebar = panelKind === "sidebar";
  const preferenceKey = isSidebar ? "sidebarWidth" : "sftpWidth";
  const minimum = isSidebar ? PANEL_LAYOUT_LIMITS.sidebarMinimum : PANEL_LAYOUT_LIMITS.sftpMinimum;
  const maximum = isSidebar ? PANEL_LAYOUT_LIMITS.sidebarMaximum : PANEL_LAYOUT_LIMITS.sftpMaximum;
  const direction = isSidebar ? 1 : -1;
  let drag = null;
  const setWidth = (width) => {
    panelLayoutPreferences = { ...panelLayoutPreferences, [preferenceKey]: normalizePanelWidth(width, minimum, maximum, minimum) };
    refreshPanelLayout();
  };
  const finishDrag = (event, cancelled = false) => {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    const completedDrag = drag;
    drag = null;
    document.body.classList.remove("panel-resizing");
    if (handle.hasPointerCapture(completedDrag.pointerId)) handle.releasePointerCapture(completedDrag.pointerId);
    if (cancelled) setWidth(completedDrag.savedWidth);
    else savePanelLayoutPreferences();
  };
  const pointerDown = (event) => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    handle.focus();
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: getMeasuredWidth(), savedWidth: panelLayoutPreferences[preferenceKey] };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("panel-resizing");
  };
  const pointerMove = (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    setWidth(drag.startWidth + (event.clientX - drag.startX) * direction);
  };
  const pointerUp = (event) => finishDrag(event);
  const pointerCancel = (event) => finishDrag(event, true);
  const keyDown = (event) => {
    const step = event.shiftKey ? PANEL_LAYOUT_LIMITS.keyboardLargeStep : PANEL_LAYOUT_LIMITS.keyboardStep;
    const delta = event.key === "ArrowRight" ? direction * step : event.key === "ArrowLeft" ? -direction * step : null;
    if (delta === null && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    setWidth(event.key === "Home" ? minimum : event.key === "End" ? maximum : getMeasuredWidth() + delta);
    savePanelLayoutPreferences();
  };
  const handlers = { pointerdown: pointerDown, pointermove: pointerMove, pointerup: pointerUp, pointercancel: pointerCancel, lostpointercapture: pointerCancel, keydown: keyDown };
  Object.entries(handlers).forEach(([eventName, handler]) => handle.addEventListener(eventName, handler));
  return () => {
    finishDrag(null, true);
    Object.entries(handlers).forEach(([eventName, handler]) => handle.removeEventListener(eventName, handler));
  };
}

function initPanelLayout() {
  panelLayoutPreferences = readPanelLayoutPreferences();
  document.getElementById("btn-sidebar-toggle")?.addEventListener("click", toggleSidebarPanel);
  bindPanelResizeHandle(document.getElementById("sidebar-resize-handle"), "sidebar", () => document.querySelector(".sidebar").getBoundingClientRect().width);
  window.addEventListener("resize", refreshPanelLayout);
  refreshPanelLayout();
}

function initSessionPanelLayout(session) {
  session.panelLayoutDispose?.();
  session.panelLayoutDispose = bindPanelResizeHandle(session.container.querySelector(".sftp-resize-handle"), "sftp", () => session.container.querySelector(".sftp-panel").getBoundingClientRect().width);
  refreshPanelLayout();
}

// --- WINDOW CONTROLS ---
function initWindowControls() {
  const { getCurrentWindow } = window.__TAURI__.window;
  const appWindow = getCurrentWindow();

  document.getElementById("titlebar-minimize").addEventListener("click", () => {
    appWindow.minimize();
  });
  document.getElementById("titlebar-maximize").addEventListener("click", () => {
    appWindow.toggleMaximize();
  });
  document.getElementById("titlebar-close").addEventListener("click", () => {
    appWindow.close();
  });

  // Re-focus the active terminal when the window gains focus so that
  // external apps sending keystrokes (e.g. password managers, macros)
  // reach the xterm.js terminal rather than being swallowed by WebView2.
  appWindow.onFocusChanged(({ payload: focused }) => {
    if (focused && activeTabId) {
      const session = activeSessions[activeTabId];
      if (session && session.term && !session.isClosed) {
        session.term.focus();
      }
    }
  });
}

// --- SETTINGS MANAGEMENT ---
let appSettings = {
  fontSize: 14,
  zoomLevel: 1.0,
  defaultUser: "",
  defaultPort: 22,
  showVpnTab: false
};

function applyVpnTabVisibility() {
  const vpnTab = document.querySelector('.nav-tab[data-tab="vpn"]');
  if (vpnTab) {
    if (appSettings.showVpnTab) {
      vpnTab.classList.remove("hidden");
    } else {
      vpnTab.classList.add("hidden");
      // If the current active tab was VPN, switch to connections
      if (vpnTab.classList.contains("active")) {
        activateSidebarView("connections", { keepOpen: true });
      }
    }
  }
  refreshWorkspaceChrome();
}

function initSettings() {
  const saved = localStorage.getItem("sleekssh_settings");
  if (saved) {
    try {
      appSettings = { ...appSettings, ...JSON.parse(saved) };
    } catch (e) {
      console.error("Failed to parse settings:", e);
    }
  }

  // Apply default zoom
  zoomLevel = appSettings.zoomLevel;
  setAppZoom(zoomLevel);

  // Apply VPN tab visibility
  applyVpnTabVisibility();

  // Autofill forms default configurations
  const qcUser = document.getElementById("qc-username");
  const qcPort = document.getElementById("qc-port");
  const profPort = document.getElementById("prof-port");

  if (qcUser) qcUser.placeholder = appSettings.defaultUser || "root";
  if (qcPort && appSettings.defaultPort) qcPort.value = appSettings.defaultPort;
  if (profPort && appSettings.defaultPort) profPort.value = appSettings.defaultPort;
}

function saveSettings() {
  const fontSizeEl = document.getElementById("setting-font-size");
  const zoomEl = document.getElementById("setting-zoom-level");
  const userEl = document.getElementById("setting-default-user");
  const portEl = document.getElementById("setting-default-port");
  const showVpnEl = document.getElementById("setting-show-vpn");

  const fontSize = fontSizeEl ? (parseInt(fontSizeEl.value, 10) || 14) : appSettings.fontSize;
  const zoomFactor = zoomEl ? (parseFloat(zoomEl.value) || 1.0) : appSettings.zoomLevel;
  const defaultUser = userEl ? userEl.value.trim() : appSettings.defaultUser;
  const defaultPort = portEl ? (parseInt(portEl.value, 10) || 22) : appSettings.defaultPort;
  const showVpnTab = showVpnEl ? showVpnEl.checked : appSettings.showVpnTab;

  appSettings = {
    fontSize,
    zoomLevel: zoomFactor,
    defaultUser,
    defaultPort,
    showVpnTab
  };

  localStorage.setItem("sleekssh_settings", JSON.stringify(appSettings));

  // Apply VPN tab visibility
  applyVpnTabVisibility();

  // Apply zoom factor
  if (zoomLevel !== zoomFactor) {
    zoomLevel = zoomFactor;
    setAppZoom(zoomLevel);
  }

  // Apply font size to active xterm instances
  Object.values(activeSessions).forEach(session => {
    if (session.term) {
      session.term.options.fontSize = fontSize;
      setTimeout(() => fitTerminal(session), 50);
    }
  });

  // Autofill forms default configurations
  const qcUser = document.getElementById("qc-username");
  const qcPort = document.getElementById("qc-port");
  if (qcUser) qcUser.placeholder = defaultUser || "root";
  if (qcPort && document.activeElement !== qcPort) {
    qcPort.value = defaultPort;
  }
}

// --- ZOOM CONTROLS ---
let zoomLevel = 1.0;

function initZoomControls() {
  window.addEventListener("keydown", async (e) => {
    if (e.ctrlKey) {
      let zoomChanged = false;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomLevel = Math.min(zoomLevel + 0.1, 2.0);
        zoomChanged = true;
      } else if (e.key === "-") {
        e.preventDefault();
        zoomLevel = Math.max(zoomLevel - 0.1, 0.5);
        zoomChanged = true;
      } else if (e.key === "0") {
        e.preventDefault();
        zoomLevel = 1.0;
        zoomChanged = true;
      }

      if (zoomChanged) {
        await setAppZoom(zoomLevel);
        
        // Update Settings Select box value
        const zoomSelect = document.getElementById("setting-zoom-level");
        if (zoomSelect) {
          zoomSelect.value = zoomLevel.toFixed(1);
        }

        // Save zoom factor to persistent storage
        appSettings.zoomLevel = zoomLevel;
        localStorage.setItem("sleekssh_settings", JSON.stringify(appSettings));
      }
    }
  });
}

async function setAppZoom(factor) {
  try {
    const { getCurrentWebview } = window.__TAURI__.webview;
    const webview = getCurrentWebview();
    await webview.setZoom(factor);
  } catch (err) {
    console.error("Zoom failed:", err);
  }
}

// --- NAVIGATION & TABS (Sidebar) ---
function isSidebarVisible() {
  const app = document.querySelector(".app-container");
  return Boolean(app) && !app.classList.contains("sidebar-collapsed");
}

// Selecting the active view again hides the sidebar, like an editor activity bar.
function activateSidebarView(view, { keepOpen = false } = {}) {
  const tab = Array.from(sidebarTabs).find(candidate => candidate.dataset.tab === view);
  if (!tab || tab.classList.contains("hidden")) return;
  const alreadyActive = tab.classList.contains("active");
  if (alreadyActive && isSidebarVisible() && !keepOpen) {
    toggleSidebarPanel();
    return;
  }
  sidebarTabs.forEach(candidate => {
    const isActive = candidate === tab;
    candidate.classList.toggle("active", isActive);
    candidate.setAttribute("aria-pressed", String(isActive));
  });
  tabPanes.forEach(pane => pane.classList.toggle("active", pane.id === `pane-${view}`));
  if (!isSidebarVisible() && !panelLayoutPreferences.sidebarOpen) toggleSidebarPanel();
  else refreshPanelLayout();
}

function initNavigation() {
  sidebarTabs.forEach(tab => {
    tab.addEventListener("click", () => activateSidebarView(tab.dataset.tab));
  });

  // Radio button toggles for auth mode
  const setupAuthToggles = (radios, keyFields, pwdFields, keypathInput) => {
    radios.forEach(radio => {
      radio.addEventListener("change", () => {
        if (radio.value === "key") {
          keyFields.classList.remove("hidden");
          pwdFields.classList.add("hidden");
          // Fill keypath with default key if empty
          if (!keypathInput.value && savedProfiles.length > 0) {
            loadDefaultKeyForInput(keypathInput);
          }
        } else {
          keyFields.classList.add("hidden");
          pwdFields.classList.remove("hidden");
        }
      });
    });
  };

  setupAuthToggles(qcAuthModeRadio, qcAuthKeyFields, qcAuthPasswordFields, qcKeypathInput);
  setupAuthToggles(profAuthModeRadio, profAuthKeyFields, profAuthPasswordFields, profKeypathInput);

  // File browser for private key paths
  const selectKeyFileHandler = async (inputEl) => {
    try {
      const selected = await invoke("select_key_file");
      if (selected) {
        inputEl.value = selected;
      }
    } catch (e) {
      console.error("Failed to select key file:", e);
    }
  };

  btnSelectKeyfile.addEventListener("click", () => selectKeyFileHandler(profKeypathInput));
  
  // Quick connect key selector - let's make it click placeholder to open dial or add direct select
  qcKeypathInput.addEventListener("click", () => selectKeyFileHandler(qcKeypathInput));

  // Add click to check default key
  loadDefaultKeyForInput(qcKeypathInput);
  loadDefaultKeyForInput(profKeypathInput);
}

async function loadDefaultKeyForInput(inputEl) {
  try {
    const keys = await invoke("get_default_ssh_keys");
    if (keys && keys.length > 0) {
      inputEl.value = keys[0];
    }
  } catch (e) {
    console.error("Error loading default keys:", e);
  }
}

// --- PROFILE STORAGE & LIST ---
async function initProfileList() {
  try {
    savedProfiles = await invoke("load_connections");
    renderProfiles();
    if (typeof updateHostIndicators === "function") updateHostIndicators();
  } catch (e) {
    console.error("Failed to load profiles:", e);
    profilesList.innerHTML = `<div class="empty-state">Could not load saved hosts: ${escapeHtml(String(e))}</div>`;
  }
}

let savedSessionFolderSequence = 0;
let hostFilterQuery = "";
const HOST_ROW_ICONS = Object.freeze({
  edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z"></path><path d="M14.5 7.5l2 2"></path>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.2a1.5 1.5 0 0 0 1.5 1.3h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7"></path>'
});

function profileMatchesFilter(profile, query) {
  if (!query) return true;
  const haystack = [profile.name, profile.host, profile.username, profile.namespace, `${profile.username}@${profile.host}`]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return query.split(/\s+/).filter(Boolean).every(term => haystack.includes(term));
}

function renderProfiles() {
  savedSessionFolderSequence = 0;
  if (savedProfiles.length === 0) {
    profilesList.innerHTML = `<div class="empty-state">No saved hosts yet. Use + to add one.</div>`;
    return;
  }

  const query = hostFilterQuery.trim().toLowerCase();
  const visibleProfiles = savedProfiles.filter(profile => profileMatchesFilter(profile, query));
  if (visibleProfiles.length === 0) {
    profilesList.innerHTML = `<div class="empty-state">No hosts match “${escapeHtml(hostFilterQuery.trim())}”.</div>`;
    return;
  }

  profilesList.innerHTML = "";
  const namespaceTree = createNamespaceTree(visibleProfiles);
  appendNamespaceFolders(namespaceTree, profilesList, [], Boolean(query));

  namespaceTree.profiles.forEach(profile => {
    profilesList.appendChild(createProfileItemElement(profile));
  });

  hookProfileActions();
}

function initHostFilter() {
  const filterInput = document.getElementById("host-filter");
  if (!filterInput) return;
  filterInput.addEventListener("input", () => {
    hostFilterQuery = filterInput.value;
    renderProfiles();
    if (typeof updateHostIndicators === "function") updateHostIndicators();
  });
  filterInput.addEventListener("keydown", event => {
    if (event.key === "Escape" && filterInput.value) {
      event.preventDefault();
      filterInput.value = "";
      hostFilterQuery = "";
      renderProfiles();
      if (typeof updateHostIndicators === "function") updateHostIndicators();
    } else if (event.key === "Enter") {
      event.preventDefault();
      profilesList.querySelector(".profile-connect")?.click();
    }
  });
}

function createNamespaceTree(profiles) {
  const root = { profiles: [], children: new Map() };

  profiles.forEach(profile => {
    const namespaceSegments = profile.namespace
      ? profile.namespace.split(NAMESPACE_SEPARATOR).map(segment => segment.trim()).filter(Boolean)
      : [];
    let node = root;

    namespaceSegments.forEach(segment => {
      if (!node.children.has(segment)) {
        node.children.set(segment, { profiles: [], children: new Map() });
      }
      node = node.children.get(segment);
    });

    node.profiles.push(profile);
  });

  return root;
}

function getNamespaceProfileCount(namespaceNode) {
  return namespaceNode.profiles.length + [...namespaceNode.children.values()]
    .reduce((count, childNode) => count + getNamespaceProfileCount(childNode), 0);
}

function savedSessionFolderStorageKey(namespaceKey) {
  return `folder_collapsed_${namespaceKey}`;
}

function readSavedSessionFolderCollapsed(namespaceKey) {
  return localStorage.getItem(savedSessionFolderStorageKey(namespaceKey)) === "true";
}

function applySavedSessionFolderState(folderEl, expanded) {
  folderEl.classList.toggle("collapsed", !expanded);
  folderEl.querySelector(".folder-header").setAttribute("aria-expanded", String(expanded));
  folderEl.querySelector(".folder-state").textContent = expanded ? "Expanded" : "Collapsed";
}

function appendNamespaceFolders(namespaceNode, parentElement, namespacePath = [], forceExpanded = false) {
  [...namespaceNode.children.entries()]
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .forEach(([namespaceName, childNode]) => {
      const childPath = [...namespacePath, namespaceName];
      const namespaceKey = childPath.join(NAMESPACE_SEPARATOR);
      const contentId = `saved-session-folder-${savedSessionFolderSequence += 1}`;
      const profileCount = getNamespaceProfileCount(childNode);
      const folderEl = document.createElement("div");
      folderEl.className = "profile-folder";

      folderEl.innerHTML = `
        <button class="folder-header" type="button" style="--depth: ${namespacePath.length}" aria-expanded="true" aria-controls="${contentId}" aria-label="${escapeHtml(namespaceName)}, ${profileCount} ${profileCount === 1 ? "host" : "hosts"}">
          <svg class="chevron-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>
          <span class="folder-heading">
            <span class="folder-name">${escapeHtml(namespaceName)}</span>
            <span class="folder-state" aria-hidden="true"></span>
          </span>
          <span class="folder-count" aria-hidden="true">${profileCount}</span>
        </button>
        <div class="folder-content" id="${contentId}" role="group" style="--depth: ${childPath.length}"></div>
      `;
      applySavedSessionFolderState(folderEl, forceExpanded || !readSavedSessionFolderCollapsed(namespaceKey));

      const contentElement = folderEl.querySelector(".folder-content");
      childNode.profiles.forEach(profile => {
        contentElement.appendChild(createProfileItemElement(profile));
      });
      appendNamespaceFolders(childNode, contentElement, childPath, forceExpanded);

      folderEl.querySelector(".folder-header").addEventListener("click", () => {
        const collapsed = !folderEl.classList.contains("collapsed");
        applySavedSessionFolderState(folderEl, !collapsed);
        localStorage.setItem(savedSessionFolderStorageKey(namespaceKey), String(collapsed));
      });

      parentElement.appendChild(folderEl);
    });
}

function createProfileItemElement(p) {
  const item = document.createElement("div");
  item.className = "profile-item";
  item.setAttribute("data-profile-id", p.id);
  const address = `${p.username}@${p.host}:${p.port}`;
  item.innerHTML = `
    <button class="profile-connect" type="button" title="${escapeHtml(address)} (${p.use_password ? "password" : "key"})">
      <span class="profile-status-dot" aria-hidden="true"></span>
      <span class="profile-name">${escapeHtml(p.name)}</span>
      <span class="sr-only profile-state-label"></span>
      <span class="profile-host" aria-hidden="true">${escapeHtml(p.host)}</span>
      <span class="sr-only">, ${escapeHtml(address)}</span>
    </button>
    <div class="profile-actions">
      <button class="btn-action edit-action" type="button" title="Edit host" aria-label="Edit ${escapeHtml(p.name)}" data-id="${escapeHtml(p.id)}">
        <svg viewBox="0 0 24 24" aria-hidden="true">${HOST_ROW_ICONS.edit}</svg>
      </button>
      <button class="btn-action delete-action" type="button" title="Delete host" aria-label="Delete ${escapeHtml(p.name)}" data-id="${escapeHtml(p.id)}">
        <svg viewBox="0 0 24 24" aria-hidden="true">${HOST_ROW_ICONS.trash}</svg>
      </button>
    </div>
  `;

  item.querySelector(".profile-connect")?.addEventListener("click", (event) => {
    if (event.ctrlKey || event.metaKey || typeof openOrSwitchToProfile !== "function") connectProfile(p);
    else openOrSwitchToProfile(p);
  });

  return item;
}

function hookProfileActions() {
  document.querySelectorAll(".edit-action").forEach(btn => {
    btn.addEventListener("click", () => {
      const profile = savedProfiles.find(p => p.id === btn.dataset.id);
      if (profile) showProfileModal(profile);
    });
  });

  document.querySelectorAll(".delete-action").forEach(btn => {
    btn.addEventListener("click", async () => {
      const profile = savedProfiles.find(p => p.id === btn.dataset.id);
      if (confirm(`Delete the saved host "${profile?.name ?? "this host"}"? Open sessions stay connected.`)) {
        savedProfiles = savedProfiles.filter(p => p.id !== btn.dataset.id);
        try {
          await invoke("save_connections", { connections: savedProfiles });
          renderProfiles();
          if (typeof updateHostIndicators === "function") updateHostIndicators();
        } catch (e) {
          alert("Failed to delete host: " + e);
        }
      }
    });
  });
}

// --- SSH KEYS MANAGER ---
async function initKeyManager() {
  try {
    const keys = await invoke("get_default_ssh_keys");
    renderSystemKeys(keys);
  } catch (e) {
    console.error("Failed to load default keys:", e);
    systemKeysList.innerHTML = `<div class="key-item">Error reading ~/.ssh</div>`;
  }

  btnGenerateKey.addEventListener("click", async () => {
    btnGenerateKey.disabled = true;
    btnGenerateKey.textContent = "Generating key…";
    try {
      const pubkey = await invoke("generate_new_ssh_key");
      pubkeyText.value = pubkey;
      keyDisplaySection.classList.remove("hidden");
      
      // Re-scan system keys
      const keys = await invoke("get_default_ssh_keys");
      renderSystemKeys(keys);
      alert("Ed25519 key generated successfully and saved to ~/.ssh/id_ed25519");
    } catch (e) {
      alert("Failed to generate SSH key: " + e);
    } finally {
      btnGenerateKey.disabled = false;
      btnGenerateKey.textContent = "Generate Ed25519 key";
    }
  });

  btnCopyPubkey.addEventListener("click", () => {
    pubkeyText.select();
    navigator.clipboard.writeText(pubkeyText.value);
    btnCopyPubkey.textContent = "Copied";
    setTimeout(() => {
      btnCopyPubkey.textContent = "Copy key to clipboard";
    }, 2000);
  });
}

function renderSystemKeys(keys) {
  if (!keys || keys.length === 0) {
    systemKeysList.innerHTML = `<div class="empty-state">No private keys found in ~/.ssh. Generate one below.</div>`;
    return;
  }

  systemKeysList.innerHTML = "";
  keys.forEach(k => {
    const item = document.createElement("div");
    item.className = "key-item";
    // Extract filename from full path
    const filename = k.split(/[\\/]/).pop();
    item.innerHTML = `
      <span class="key-item-name">${escapeHtml(filename)}</span>
      <span class="key-item-path" title="${escapeHtml(k)}">${escapeHtml(k)}</span>
    `;
    systemKeysList.appendChild(item);
  });
}

async function initVpnManager() {
  btnAddVpnProfile.addEventListener("click", () => showVpnProfileModal());
  btnCloseVpnModal.addEventListener("click", hideVpnProfileModal);
  btnCancelVpnModal.addEventListener("click", hideVpnProfileModal);
  btnRefreshVpnStatus.addEventListener("click", () => refreshVpnStatus());
  btnDisconnectVpn.addEventListener("click", disconnectVpn);
  btnCancelVpnOperation.addEventListener("click", cancelVpnOperation);
  btnScanCiscoVpnProfiles.addEventListener("click", scanCiscoVpnProfiles);
  btnCloseVpnCredentialModal.addEventListener("click", cancelVpnCredentialPrompt);
  btnCancelVpnCredentialModal.addEventListener("click", cancelVpnCredentialPrompt);
  btnCloseVpnCertificateModal.addEventListener("click", cancelVpnCertificatePrompt);
  btnCancelVpnCertificateModal.addEventListener("click", cancelVpnCertificatePrompt);
  btnAcceptVpnCertificateModal.addEventListener("click", confirmVpnCertificatePrompt);

  vpnProfileForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const id = document.getElementById("vpn-id").value || "vpn_" + Date.now();
    const name = document.getElementById("vpn-name").value.trim();
    const server = document.getElementById("vpn-server").value.trim();
    const group = document.getElementById("vpn-group").value.trim() || null;
    const username = document.getElementById("vpn-username").value.trim() || null;
    const password = document.getElementById("vpn-password").value || null;

    const newProfile = { id, name, server, group, username, password };
    const existingIndex = savedVpnProfiles.findIndex(p => p.id === id);

    if (existingIndex > -1) {
      savedVpnProfiles[existingIndex] = newProfile;
    } else {
      savedVpnProfiles.push(newProfile);
    }

    try {
      await invoke("save_vpn_profiles", { profiles: savedVpnProfiles });
      hideVpnProfileModal();
      renderVpnProfiles();
    } catch (err) {
      alert("Failed to save VPN shortcut: " + err);
    }
  });

  vpnCredentialForm.addEventListener("submit", (e) => {
    e.preventDefault();

    if (!pendingVpnCredentialResolver || !pendingVpnCredentialProfile) return;

    const username = vpnRuntimeUsername.value.trim();
    const password = vpnRuntimePassword.value;

    if (!username || !password) {
      alert("VPN username and password are required to continue.");
      return;
    }

    const profile = {
      ...pendingVpnCredentialProfile,
      username,
      password
    };
    const resolve = pendingVpnCredentialResolver;

    closeVpnCredentialPrompt();
    resolve(profile);
  });

  await loadVpnProfiles();
  await detectVpnCli();
  refreshVpnStatus();
}

async function loadVpnProfiles() {
  try {
    savedVpnProfiles = await invoke("load_vpn_profiles");
    renderVpnProfiles();
  } catch (e) {
    console.error("Failed to load VPN shortcuts:", e);
    vpnProfilesList.innerHTML = `<div class="empty-state">Error loading VPN shortcuts: ${escapeHtml(e)}</div>`;
  }
}

function renderVpnProfiles() {
  if (savedVpnProfiles.length === 0) {
    vpnProfilesList.innerHTML = `<div class="empty-state">No VPN shortcuts saved. Use + to add one.</div>`;
    return;
  }

  vpnProfilesList.innerHTML = "";
  savedVpnProfiles
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(profile => {
      vpnProfilesList.appendChild(createVpnProfileItemElement(profile));
    });

  hookVpnProfileActions();
}

function createVpnProfileItemElement(profile) {
  const item = document.createElement("div");
  item.className = "vpn-profile-item";
  const meta = [profile.server, profile.group || "Default group", profile.password ? "password saved" : null].filter(Boolean).join(" · ");
  item.innerHTML = `
    <button class="vpn-profile-connect" type="button" title="Connect to ${escapeHtml(profile.name)}">
      ${uiIcon("shield")}
      <span class="vpn-profile-text">
        <span class="profile-name">${escapeHtml(profile.name)}</span>
        <span class="vpn-profile-meta">${escapeHtml(meta)}</span>
      </span>
    </button>
    <div class="profile-actions">
      <button class="btn-action vpn-edit-action" type="button" title="Edit VPN shortcut" aria-label="Edit ${escapeHtml(profile.name)}" data-id="${escapeHtml(profile.id)}">
        <svg viewBox="0 0 24 24" aria-hidden="true">${UI_ICONS.edit}</svg>
      </button>
      <button class="btn-action vpn-delete-action" type="button" title="Delete VPN shortcut" aria-label="Delete ${escapeHtml(profile.name)}" data-id="${escapeHtml(profile.id)}">
        <svg viewBox="0 0 24 24" aria-hidden="true">${UI_ICONS.trash}</svg>
      </button>
    </div>
  `;

  item.querySelector(".vpn-profile-connect").addEventListener("click", () => {
    switchVpnProfile(profile);
  });

  return item;
}

function hookVpnProfileActions() {
  document.querySelectorAll(".vpn-edit-action").forEach(btn => {
    btn.addEventListener("click", () => {
      const profile = savedVpnProfiles.find(p => p.id === btn.dataset.id);
      if (profile) showVpnProfileModal(profile);
    });
  });

  document.querySelectorAll(".vpn-delete-action").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (confirm("Are you sure you want to delete this VPN shortcut?")) {
        savedVpnProfiles = savedVpnProfiles.filter(p => p.id !== btn.dataset.id);
        try {
          await invoke("save_vpn_profiles", { profiles: savedVpnProfiles });
          renderVpnProfiles();
        } catch (e) {
          alert("Failed to delete VPN shortcut: " + e);
        }
      }
    });
  });
}

function showVpnProfileModal(profile = null) {
  vpnProfileForm.reset();

  if (profile) {
    vpnModalTitle.textContent = "Edit VPN shortcut";
    document.getElementById("vpn-id").value = profile.id;
    document.getElementById("vpn-name").value = profile.name;
    document.getElementById("vpn-server").value = profile.server;
    document.getElementById("vpn-group").value = profile.group || "";
    document.getElementById("vpn-username").value = profile.username || "";
    document.getElementById("vpn-password").value = profile.password || "";
  } else {
    vpnModalTitle.textContent = "New VPN shortcut";
    document.getElementById("vpn-id").value = "";
  }

  vpnProfileModal.classList.remove("hidden");
}

function hideVpnProfileModal() {
  vpnProfileModal.classList.add("hidden");
}

async function detectVpnCli() {
  try {
    vpnClientPath.textContent = await invoke("get_vpncli_path");
  } catch (e) {
    vpnClientPath.textContent = "vpncli.exe not found";
    setVpnStatus("Install Cisco Secure Client or AnyConnect, then refresh.");
  }
}

async function refreshVpnStatus(showLoading = true) {
  if (showLoading) {
    setVpnStatus("Checking VPN status...");
  }

  try {
    const result = await invoke("vpn_status");
    setVpnConnectionState(parseVpnConnectionStatus(result.output));
    setVpnStatus(result.output || (result.success ? "VPN command completed." : "VPN status unavailable."));
  } catch (e) {
    setVpnConnectionState({ state: "unknown", server: null, clientAddress: null });
    setVpnStatus("VPN status failed: " + e);
  }
}

async function disconnectVpn() {
  setVpnControlsBusy(true, true);
  vpnOperationCancelRequested = false;
  setVpnStatus("Disconnecting VPN...");

  try {
    const result = await invoke("disconnect_vpn");
    if (vpnOperationCancelRequested) {
      setVpnStatus("VPN disconnect canceled.");
      return;
    }

    setVpnStatus(result.success ? "VPN disconnected." : (result.output || "Disconnect command did not report success."));
    await refreshVpnStatus(false);
  } catch (e) {
    if (vpnOperationCancelRequested) {
      setVpnStatus("VPN disconnect canceled.");
      return;
    }

    setVpnStatus("VPN disconnect failed: " + e);
    alert("VPN disconnect failed: " + e);
  } finally {
    setVpnControlsBusy(false);
  }
}

async function switchVpnProfile(profile) {
  const connectProfile = await resolveVpnCredentials(profile);
  if (!connectProfile) return;

  await runVpnSwitch(connectProfile, false);
}

async function runVpnSwitch(profile, allowInvalidCertificate) {
  setVpnControlsBusy(true, true);
  vpnOperationCancelRequested = false;
  setVpnStatus("Switching to " + profile.name + "...");

  try {
    const result = await invoke("switch_vpn_profile", {
      profile,
      allowInvalidCertificate
    });
    if (vpnOperationCancelRequested) {
      setVpnStatus("VPN request canceled.");
      return;
    }

    if (result.requiresCertificateConfirmation) {
      await refreshVpnStatus(false);
      setVpnStatus("Cisco requires certificate confirmation before connecting.");
      showVpnCertificatePrompt(profile);
      return;
    }

    setVpnStatus(result.success
      ? "Connected to " + profile.name + ". Use Disconnect current VPN to end the tunnel."
      : (result.output || "VPN switch did not report success."));
    await refreshVpnStatus(false);
    if (!result.success) {
      alert("VPN switch command completed, but Cisco did not report a connected state.");
    }
  } catch (e) {
    if (vpnOperationCancelRequested) {
      setVpnStatus("VPN request canceled.");
      return;
    }

    setVpnStatus("VPN switch failed: " + e);
    alert("VPN switch failed: " + e);
  } finally {
    setVpnControlsBusy(false);
  }
}

async function cancelVpnOperation() {
  vpnOperationCancelRequested = true;
  btnCancelVpnOperation.disabled = true;
  setVpnStatus("Canceling VPN request...");

  try {
    await invoke("cancel_vpn_operation");
  } catch (e) {
    setVpnStatus("VPN cancel failed: " + e);
    alert("VPN cancel failed: " + e);
  }
}

function resolveVpnCredentials(profile) {
  if (profile.username && profile.password) {
    return Promise.resolve(profile);
  }

  return new Promise(resolve => {
    pendingVpnCredentialResolver = resolve;
    pendingVpnCredentialProfile = profile;
    vpnCredentialTitle.textContent = "VPN credentials";
    vpnRuntimeUsername.value = profile.username || "";
    vpnRuntimePassword.value = "";
    vpnCredentialModal.classList.remove("hidden");
    setTimeout(() => {
      if (vpnRuntimeUsername.value) {
        vpnRuntimePassword.focus();
      } else {
        vpnRuntimeUsername.focus();
      }
    }, 0);
  });
}

function cancelVpnCredentialPrompt() {
  if (pendingVpnCredentialResolver) {
    pendingVpnCredentialResolver(null);
  }

  closeVpnCredentialPrompt();
}

function closeVpnCredentialPrompt() {
  vpnCredentialModal.classList.add("hidden");
  vpnCredentialForm.reset();
  pendingVpnCredentialResolver = null;
  pendingVpnCredentialProfile = null;
}

function showVpnCertificatePrompt(profile) {
  pendingVpnCertificateProfile = profile;
  vpnCertificateServer.textContent = profile.server;
  vpnCertificateModal.classList.remove("hidden");
  btnAcceptVpnCertificateModal.focus();
}

function cancelVpnCertificatePrompt() {
  pendingVpnCertificateProfile = null;
  vpnCertificateServer.textContent = "";
  vpnCertificateModal.classList.add("hidden");
}

async function confirmVpnCertificatePrompt() {
  const profile = pendingVpnCertificateProfile;
  cancelVpnCertificatePrompt();

  if (profile) {
    await runVpnSwitch(profile, true);
  }
}

async function scanCiscoVpnProfiles() {
  setVpnControlsBusy(true);
  ciscoVpnProfilesList.innerHTML = `<div class="small-text">Scanning Cisco profile XML...</div>`;

  try {
    const profiles = await invoke("list_cisco_vpn_profiles");
    renderCiscoVpnProfiles(profiles);
  } catch (e) {
    ciscoVpnProfilesList.innerHTML = `<div class="small-text">Scan failed: ${escapeHtml(e)}</div>`;
  } finally {
    setVpnControlsBusy(false);
  }
}

function renderCiscoVpnProfiles(profiles) {
  if (!profiles || profiles.length === 0) {
    ciscoVpnProfilesList.innerHTML = `<div class="small-text">No Cisco VPN profile groups found.</div>`;
    return;
  }

  ciscoVpnProfilesList.innerHTML = "";
  profiles.forEach((profile, index) => {
    const item = document.createElement("div");
    item.className = "vpn-import-item";
    item.innerHTML = `
      <div class="vpn-import-details">
        <span class="vpn-import-name">${escapeHtml(profile.name)}</span>
        <span class="vpn-import-meta">${escapeHtml(profile.server)}${profile.group ? " / " + escapeHtml(profile.group) : ""}</span>
        <span class="vpn-import-source">${escapeHtml(profile.source)}</span>
      </div>
      <button class="btn btn-secondary btn-small" data-index="${index}">Import</button>
    `;

    item.querySelector("button").addEventListener("click", async () => {
      await importCiscoVpnProfile(profile);
    });

    ciscoVpnProfilesList.appendChild(item);
  });
}

async function importCiscoVpnProfile(profile) {
  const exists = savedVpnProfiles.some(savedProfile =>
    savedProfile.server.toLowerCase() === profile.server.toLowerCase()
    && (savedProfile.group || "").toLowerCase() === (profile.group || "").toLowerCase()
  );

  if (exists) {
    alert("That VPN shortcut already exists.");
    return;
  }

  savedVpnProfiles.push({
    id: "vpn_" + Date.now(),
    name: profile.name,
    server: profile.server,
    group: profile.group || null,
    username: null,
    password: null
  });

  try {
    await invoke("save_vpn_profiles", { profiles: savedVpnProfiles });
    renderVpnProfiles();
  } catch (e) {
    alert("Failed to import VPN shortcut: " + e);
  }
}

function setVpnStatus(message) {
  vpnStatusOutput.textContent = message;
}

function parseVpnConnectionStatus(output) {
  const connectionState = output.match(/^\s*Connection State:\s*(.+?)\s*$/im)?.[1]?.toLowerCase();
  const server = output.match(/^\s*Server Address:\s*(.+?)\s*$/im)?.[1];
  const clientAddress = output.match(/^\s*Client Address \(IPv4\):\s*(.+?)\s*$/im)?.[1];

  return {
    state: connectionState === "connected" || connectionState === "disconnected"
      ? connectionState
      : "unknown",
    server: normalizeVpnStatusValue(server),
    clientAddress: normalizeVpnStatusValue(clientAddress)
  };
}

function normalizeVpnStatusValue(value) {
  if (!value || /^not available$/i.test(value)) {
    return null;
  }

  return value;
}

function setVpnConnectionState({ state, server, clientAddress }) {
  vpnConnectionActive = state === "connected";
  vpnStatusSnapshot = { state, server };
  refreshWorkspaceChrome();
  vpnConnectionState.className = "vpn-connection-state is-" + state;

  if (state === "connected") {
    const details = [server, clientAddress ? "Client " + clientAddress : null]
      .filter(Boolean)
      .join(" · ");
    vpnConnectionSummary.textContent = details ? "VPN connected · " + details : "VPN connected.";
  } else if (state === "disconnected") {
    vpnConnectionSummary.textContent = "VPN disconnected.";
  } else {
    vpnConnectionSummary.textContent = "VPN status unavailable.";
  }

  btnDisconnectVpn.disabled = vpnControlsBusy || !vpnConnectionActive;
}

function setVpnControlsBusy(isBusy, canCancel = false) {
  vpnControlsBusy = isBusy;
  [
    btnAddVpnProfile,
    btnRefreshVpnStatus,
    btnScanCiscoVpnProfiles
  ].forEach(button => {
    button.disabled = isBusy;
  });
  btnDisconnectVpn.disabled = isBusy || !vpnConnectionActive;

  document.querySelectorAll(".vpn-profile-item").forEach(item => {
    item.classList.toggle("busy", isBusy);
  });

  btnCancelVpnOperation.classList.toggle("hidden", !(isBusy && canCancel));
  btnCancelVpnOperation.disabled = !(isBusy && canCancel);
}

// --- MODAL DIALOGS ---
function getProfileSudoIdentity(profile) {
  return JSON.stringify([profile.host, profile.port, profile.username]);
}

function updateProfileSudoFields() {
  const existingProfile = savedProfiles.find(profile => profile.id === document.getElementById("prof-id").value);
  const identity = getProfileSudoIdentity({
    host: document.getElementById("prof-host").value,
    port: parseInt(document.getElementById("prof-port").value, 10),
    username: document.getElementById("prof-username").value
  });
  const hasMatchingPassword = Boolean(existingProfile?.has_sudo_password && identity === editingSudoIdentity);
  const hasNewPassword = Boolean(profSudoPassword.value);
  document.getElementById("prof-delete-sudo-password-label").classList.toggle("hidden", !existingProfile?.has_sudo_password);
  profSudoPassword.disabled = profDeleteSudoPassword.checked;
  if (profDeleteSudoPassword.checked) {
    profSudoShortcut.checked = false;
    profSudoPassword.value = "";
    profSudoPasswordStatus.textContent = "The saved sudo password will be removed.";
  } else if (hasNewPassword) {
    profSudoPasswordStatus.textContent = "This sudo password will be encrypted for your Windows account.";
  } else if (hasMatchingPassword) {
    profSudoPasswordStatus.textContent = "A sudo password is saved. Leave this field blank to keep it.";
  } else if (existingProfile?.has_sudo_password) {
    profSudoPasswordStatus.textContent = "Server or username changed. Enter the sudo password again to enable the shortcut.";
  } else {
    profSudoPasswordStatus.textContent = "No sudo password saved. Enter one before enabling the shortcut.";
  }
  profSudoPassword.placeholder = hasMatchingPassword ? "Leave blank to keep saved password" : "Enter sudo password";
  profSudoShortcut.disabled = profDeleteSudoPassword.checked;
}

async function saveProfileFromForm() {
  if (profileSavePending) return false;
  const id = document.getElementById("prof-id").value || "prof_" + Date.now();
  const newProfile = {
    id,
    name: document.getElementById("prof-name").value,
    host: document.getElementById("prof-host").value,
    port: parseInt(document.getElementById("prof-port").value, 10),
    username: document.getElementById("prof-username").value,
    key_path: profKeypathInput.value,
    passphrase: document.getElementById("prof-passphrase").value || null,
    password: document.getElementById("prof-password").value || null,
    use_password: document.querySelector('input[name="prof-auth-mode"]:checked').value === "password",
    namespace: document.getElementById("prof-namespace").value.trim() || null,
    sudo_shortcut_enabled: profSudoShortcut.checked
  };
  const existingProfile = savedProfiles.find(profile => profile.id === id);
  const identityChanged = Boolean(existingProfile && getProfileSudoIdentity(newProfile) !== editingSudoIdentity);
  const deletePassword = profDeleteSudoPassword.checked;
  const sudoPassword = profSudoPassword.value;
  const hasMatchingPassword = Boolean(existingProfile?.has_sudo_password && !identityChanged && !deletePassword);
  profileSaveError.classList.add("hidden");
  if (SUDO_PASSWORD_CONTROL_CHARACTERS.test(sudoPassword)) {
    profSudoPassword.value = "";
    profileSaveError.textContent = "Sudo passwords cannot contain control characters. Enter the password again.";
    profileSaveError.classList.remove("hidden");
    profSudoPassword.focus();
    return false;
  }
  if (new TextEncoder().encode(sudoPassword).length > SUDO_PASSWORD_MAX_BYTES) {
    profSudoPassword.value = "";
    profileSaveError.textContent = `Sudo passwords must be ${SUDO_PASSWORD_MAX_BYTES} UTF-8 bytes or fewer. Enter the password again.`;
    profileSaveError.classList.remove("hidden");
    profSudoPassword.focus();
    return false;
  }
  if (newProfile.sudo_shortcut_enabled && !sudoPassword && !hasMatchingPassword) {
    profileSaveError.textContent = "Enter a separate sudo password before enabling the shortcut.";
    profileSaveError.classList.remove("hidden");
    profSudoPassword.focus();
    return false;
  }
  const nextProfiles = existingProfile
    ? savedProfiles.map(profile => profile.id === id ? newProfile : profile)
    : [...savedProfiles, newProfile];
  const needsPasswordChange = Boolean(sudoPassword || deletePassword || identityChanged);
  const initialProfiles = needsPasswordChange && newProfile.sudo_shortcut_enabled
    ? nextProfiles.map(profile => profile.id === id ? { ...profile, sudo_shortcut_enabled: false } : profile)
    : nextProfiles;
  profileSavePending = true;
  document.getElementById("btn-save-profile").disabled = true;
  try {
    await invoke("save_connections", { connections: initialProfiles });
    for (const session of Object.values(activeSessions)) {
      if (session.kind === "ssh" && session.connectionProfile?.id === id && (!newProfile.sudo_shortcut_enabled || needsPasswordChange)) {
        session.connectionProfile = { ...session.connectionProfile, sudo_shortcut_enabled: false, has_sudo_password: false };
        const hadSudoPrompt = Boolean(session.sudoPromptReady || session.sudoPromptId);
        resetSudoShortcut(session);
        if (!hadSudoPrompt && session.container) updateSessionToolbar(session);
      }
    }
    if (sudoPassword && !deletePassword) {
      await invoke("save_sudo_password", { profileId: id, password: sudoPassword });
    } else if (deletePassword || identityChanged) {
      await invoke("delete_sudo_password", { profileId: id });
    }
    if (initialProfiles !== nextProfiles) await invoke("save_connections", { connections: nextProfiles });
    savedProfiles = await invoke("load_connections");
    hideProfileModal();
    initProfileList();
    if (newProfile.sudo_shortcut_enabled) showNotification("Sudo shortcut saved. Reconnect this profile to activate it.");
    return true;
  } catch {
    profileSaveError.textContent = "Could not save this profile or sudo password. Check the settings and try again.";
    profileSaveError.classList.remove("hidden");
    if (profileModal.classList.contains("hidden")) showNotification(profileSaveError.textContent);
    return false;
  } finally {
    profSudoPassword.value = "";
    profileSavePending = false;
    document.getElementById("btn-save-profile").disabled = false;
    updateProfileSudoFields();
  }
}

function initModal() {
  btnAddProfile.addEventListener("click", () => showProfileModal());
  btnCloseModal.addEventListener("click", hideProfileModal);
  btnCancelModal.addEventListener("click", hideProfileModal);

  ["prof-host", "prof-port", "prof-username"].forEach(id => {
    document.getElementById(id).addEventListener("input", updateProfileSudoFields);
  });
  profSudoPassword.addEventListener("input", updateProfileSudoFields);
  profDeleteSudoPassword.addEventListener("change", updateProfileSudoFields);
  profileModal.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      hideProfileModal();
      return;
    }
    if (event.key !== "Tab") return;
    const elements = Array.from(profileModal.querySelectorAll('button:not([disabled]), input:not([disabled]):not([type="hidden"])'))
      .filter(element => element.getClientRects().length > 0);
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  profileForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await saveProfileFromForm();
  });
}

function showProfileModal(profile = null, prefill = null) {
  if (profileSavePending) return;
  if (profileModal.classList.contains("hidden") && document.activeElement instanceof HTMLElement) {
    profileModalTrigger = document.activeElement;
  }
  profileForm.reset();
  profSudoPassword.value = "";
  profDeleteSudoPassword.checked = false;
  profSudoShortcut.checked = Boolean(profile?.sudo_shortcut_enabled);
  editingSudoIdentity = profile ? getProfileSudoIdentity(profile) : null;
  profileSaveError.classList.add("hidden");
  loadDefaultKeyForInput(profKeypathInput);

  if (profile) {
    modalTitle.textContent = "Edit host";
    document.getElementById("prof-id").value = profile.id;
    document.getElementById("prof-name").value = profile.name;
    document.getElementById("prof-namespace").value = profile.namespace || "";
    document.getElementById("prof-host").value = profile.host;
    document.getElementById("prof-port").value = profile.port;
    document.getElementById("prof-username").value = profile.username;
    
    if (profile.use_password) {
      document.querySelector('input[name="prof-auth-mode"][value="password"]').checked = true;
      profAuthKeyFields.classList.add("hidden");
      profAuthPasswordFields.classList.remove("hidden");
      document.getElementById("prof-password").value = profile.password || "";
    } else {
      document.querySelector('input[name="prof-auth-mode"][value="key"]').checked = true;
      profAuthKeyFields.classList.remove("hidden");
      profAuthPasswordFields.classList.add("hidden");
      profKeypathInput.value = profile.key_path;
      document.getElementById("prof-passphrase").value = profile.passphrase || "";
    }
  } else {
    modalTitle.textContent = "New host";
    document.getElementById("prof-id").value = "";
    document.getElementById("prof-namespace").value = "";
    document.querySelector('input[name="prof-auth-mode"][value="key"]').checked = true;
    profAuthKeyFields.classList.remove("hidden");
    profAuthPasswordFields.classList.add("hidden");
    if (prefill) {
      document.getElementById("prof-name").value = prefill.name || prefill.host || "";
      document.getElementById("prof-host").value = prefill.host || "";
      document.getElementById("prof-port").value = prefill.port || appSettings.defaultPort || 22;
      document.getElementById("prof-username").value = prefill.username || "";
    }
  }

  updateProfileSudoFields();
  profileModal.classList.remove("hidden");
  window.setTimeout(() => {
    const focusTarget = prefill && !prefill.username ? document.getElementById("prof-username") : document.getElementById("prof-name");
    focusTarget.focus();
  }, 0);
}

function hideProfileModal() {
  profSudoPassword.value = "";
  document.getElementById("prof-password").value = "";
  document.getElementById("prof-passphrase").value = "";
  profileModal.classList.add("hidden");
  if (profileModalTrigger?.isConnected) profileModalTrigger.focus();
  profileModalTrigger = null;
}

function showQuickConnectModal(prefill = null) {
  if (quickConnectModal.classList.contains("hidden") && document.activeElement instanceof HTMLElement) {
    quickConnectModalTrigger = document.activeElement;
  }

  quickConnectForm.reset();
  document.getElementById("qc-port").value = prefill?.port || appSettings.defaultPort;
  const usePassword = Boolean(prefill?.usePassword);
  document.querySelector(`input[name="qc-auth-mode"][value="${usePassword ? "password" : "key"}"]`).checked = true;
  qcAuthKeyFields.classList.toggle("hidden", usePassword);
  qcAuthPasswordFields.classList.toggle("hidden", !usePassword);
  loadDefaultKeyForInput(qcKeypathInput);
  if (prefill) {
    document.getElementById("qc-host").value = prefill.host || "";
    document.getElementById("qc-username").value = prefill.username || appSettings.defaultUser || "";
    if (prefill.host) document.getElementById("qc-name").value = prefill.host;
  }
  quickConnectModal.classList.remove("hidden");
  window.setTimeout(() => {
    const target = !prefill?.host ? document.getElementById("qc-host")
      : !document.getElementById("qc-username").value ? document.getElementById("qc-username")
        : usePassword ? document.getElementById("qc-password") : quickConnectForm.querySelector('button[type="submit"]');
    target?.focus();
  }, 0);
}

function hideQuickConnectModal() {
  quickConnectModal.classList.add("hidden");

  if (quickConnectModalTrigger?.isConnected) {
    quickConnectModalTrigger.focus();
  }

  quickConnectModalTrigger = null;
}

function duplicateActiveSession() {
  const activeSession = activeTabId ? activeSessions[activeTabId] : null;

  if (activeSession?.kind === "local" && !activeSession.isClosed) {
    openLocalTerminal(activeSession.shell, activeSession.workingDirectory, activeSession.locationName);
    return;
  }

  if (!activeSession?.connectionProfile || activeSession.isClosed) {
    showQuickConnectModal();
    return;
  }

  connectProfile({ ...activeSession.connectionProfile });
}

function initSessionShortcuts() {
  window.addEventListener("keydown", async (event) => {
    const isTerminalSearchShortcut = (event.ctrlKey || event.metaKey)
      && !event.altKey
      && !event.shiftKey
      && event.code === "KeyF"
      && !event.repeat;
    const isNewSessionShortcut = (event.ctrlKey || event.metaKey)
      && !event.shiftKey
      && event.code === "KeyN"
      && !event.repeat;
    const isCloseSessionShortcut = (event.ctrlKey || event.metaKey)
      && !event.altKey
      && !event.shiftKey
      && event.code === "KeyW"
      && !event.repeat;
    // Ctrl+Shift+P keeps Ctrl+K free for readline and editors inside the terminal.
    const isCommandPaletteShortcut = (event.ctrlKey || event.metaKey)
      && event.shiftKey
      && !event.altKey
      && event.code === "KeyP"
      && !event.repeat;

    if (isCommandPaletteShortcut) {
      event.preventDefault();
      event.stopPropagation();
      if (commandPalette?.isOpen()) commandPalette.close();
      else openCommandPalette("all");
      return;
    }

    if (isTerminalSearchShortcut) {
      const activeSession = activeTabId ? activeSessions[activeTabId] : null;
      if (!activeSession?.term || activeSession.search?.isDisposed) return;

      event.preventDefault();
      event.stopPropagation();
      openTerminalSearch(activeSession);
      return;
    }

    if (isCloseSessionShortcut) {
      const sessionId = activeTabId;
      const activeSession = sessionId ? activeSessions[sessionId] : null;
      if (!activeSession) return;

      event.preventDefault();
      event.stopPropagation();
      await closeTab(sessionId);
      showNotification(`${activeSession.name} closed.`);
      return;
    }

    if (!isNewSessionShortcut) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.altKey) {
      openCommandPalette("connect");
      return;
    }

    duplicateActiveSession();
  }, { capture: true });
}

// --- WORKSPACE & TAB MANAGEMENT ---
function initWorkspace() {
  if (window.SleekSshLocalTerminals) {
    window.SleekSshLocalTerminals.initLocalTerminalPanel({
      root: document.getElementById("local-locations"),
      storage: localStorage,
      invoke,
      openTerminal: (location) => openLocalTerminal("powershell", location.path, location.name)
    });
  } else {
    const locationError = document.getElementById("local-location-error");
    locationError.hidden = false;
    locationError.textContent = "Saved locations could not load. Rebuild SleekSSH with npm run tauri.";
  }

  btnNewTabPlus.addEventListener("click", () => {
    openCommandPalette("all");
  });

  welcomeBtnNew.addEventListener("click", () => {
    openCommandPalette("connect");
  });

  welcomeBtnAdd.addEventListener("click", () => {
    showProfileModal();
  });

  welcomeBtnTerminal.addEventListener("click", () => {
    openLocalTerminal("powershell");
  });

  btnOpenPowerShell.addEventListener("click", () => {
    openLocalTerminal("powershell");
  });

  btnOpenCommandPrompt.addEventListener("click", () => {
    openLocalTerminal("cmd");
  });

  btnCloseQuickConnectModal.addEventListener("click", hideQuickConnectModal);
  btnCancelQuickConnectModal.addEventListener("click", hideQuickConnectModal);
  quickConnectModal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hideQuickConnectModal();
      return;
    }

    if (event.key !== "Tab") return;

    const focusableElements = quickConnectModal.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (!firstElement || !lastElement) return;

    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  });

  quickConnectForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("qc-name").value;
    const host = document.getElementById("qc-host").value;
    const port = parseInt(document.getElementById("qc-port").value, 10);
    const username = document.getElementById("qc-username").value;
    const usePassword = document.querySelector('input[name="qc-auth-mode"]:checked').value === "password";
    const keyPath = qcKeypathInput.value;
    const passphrase = document.getElementById("qc-passphrase").value || null;
    const password = document.getElementById("qc-password").value || null;

    const quickProfile = {
      id: "qc_" + Date.now(),
      name,
      host,
      port,
      username,
      key_path: keyPath,
      passphrase,
      password,
      use_password: usePassword
    };

    hideQuickConnectModal();
    connectProfile(quickProfile);
  });

  // Global window resize to fit terminals
  window.addEventListener("resize", () => {
    Object.values(activeSessions).forEach(session => {
      if (session.fitAddon) {
        fitTerminal(session);
      }
    });
  });
}

function switchTab(sessionId) {
  if (activeTabId !== sessionId) {
    activeSessions[activeTabId]?.terminalInteractions?.close(false);
    resetSudoShortcut(activeSessions[activeTabId], false);
    resetSudoShortcut(activeSessions[sessionId], false);
  }
  activeTabId = sessionId;
  automationPanel?.refresh();

  // Update Tab Elements UI
  document.querySelectorAll(".terminal-tab").forEach(tab => {
    const isActive = tab.dataset.id === sessionId;
    const activationButton = tab.querySelector(".tab-activation");
    tab.classList.toggle("active", isActive);
    activationButton.setAttribute("aria-selected", String(isActive));
    activationButton.tabIndex = isActive ? 0 : -1;
    if (isActive && typeof tab.scrollIntoView === "function") tab.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  // Update Container Elements UI
  document.querySelectorAll(".session-container").forEach(container => {
    if (container.dataset.id === sessionId) {
      container.classList.add("active");
    } else {
      container.classList.remove("active");
    }
  });

  refreshPanelLayout();
  refreshWorkspaceChrome();

  // Focus terminal
  const activeSession = activeSessions[sessionId];
  if (activeSession && activeSession.term) {
    activeSession.term.focus();
    // Refit after active display
    setTimeout(() => fitTerminal(activeSession), 50);
  }
}

function fitTerminal(session) {
  if (!session?.term || session.isClosing) return;
  try {
    session.fitAddon.fit();
    const cols = session.term.cols;
    const rows = session.term.rows;
    const resizeCommand = session.kind === "local" ? "resize_local_terminal" : "resize_ssh";
    if (session.isClosed) return;
    invoke(resizeCommand, { sessionId: session.connectionId || session.id, cols, rows }).catch(e => {
      console.warn("Resize failed:", e);
    });
    scheduleTerminalSearchRefresh(session);
  } catch (e) {
    console.error("Fit error:", e);
  }
}

function initTerminalSearch(session) {
  const searchForm = session.container.querySelector(".terminal-search");
  const searchInput = searchForm.querySelector(".terminal-search-input");
  const previousButton = searchForm.querySelector(".terminal-search-previous");
  const nextButton = searchForm.querySelector(".terminal-search-next");
  const closeButton = searchForm.querySelector(".terminal-search-close");

  session.search.form = searchForm;
  session.search.input = searchInput;
  session.search.count = searchForm.querySelector(".terminal-search-count");
  session.search.previousButton = previousButton;
  session.search.nextButton = nextButton;

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    moveTerminalSearchMatch(session, 1);
  });

  searchInput.addEventListener("input", () => {
    updateTerminalSearch(session, searchInput.value, { revealActiveMatch: true });
  });

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeTerminalSearch(session);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      moveTerminalSearchMatch(session, event.shiftKey ? -1 : 1);
    }
  });

  previousButton.addEventListener("click", () => moveTerminalSearchMatch(session, -1));
  nextButton.addEventListener("click", () => moveTerminalSearchMatch(session, 1));
  closeButton.addEventListener("click", () => closeTerminalSearch(session));
}

function openTerminalSearch(session) {
  const { form, input } = session.search;
  form.classList.remove("hidden");
  updateTerminalSearch(session, input.value, { revealActiveMatch: false });
  input.focus();
  input.select();
}

function closeTerminalSearch(session) {
  session.search.form.classList.add("hidden");
  clearTerminalSearchHighlights(session);
  session.search.matches = [];
  session.search.activeMatchIndex = -1;
  updateTerminalSearchControls(session);
  session.term.focus();
}

function updateTerminalSearch(session, query, { revealActiveMatch = false } = {}) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const previousActiveLine = session.search.matches[session.search.activeMatchIndex];

  clearTerminalSearchHighlights(session);
  session.search.query = normalizedQuery;
  session.search.matches = getTerminalSearchMatches(session.term, normalizedQuery);
  session.search.activeMatchIndex = session.search.matches.indexOf(previousActiveLine);

  if (session.search.activeMatchIndex === -1 && session.search.matches.length > 0) {
    session.search.activeMatchIndex = 0;
  }

  renderTerminalSearchHighlights(session);
  updateTerminalSearchControls(session);

  if (revealActiveMatch) revealTerminalSearchMatch(session);
}

function getTerminalSearchMatches(term, query) {
  if (!query) return [];

  const buffer = term.buffer.active;
  const matches = [];

  for (let lineIndex = 0; lineIndex < buffer.length; lineIndex += 1) {
    const line = buffer.getLine(lineIndex);
    const lineText = line?.translateToString(true).toLocaleLowerCase();

    if (lineText?.includes(query)) matches.push(lineIndex);
  }

  return matches;
}

function renderTerminalSearchHighlights(session) {
  const { term, search } = session;
  const buffer = term.buffer.active;

  if (!search.query || buffer.type !== "normal") return;

  const cursorLine = buffer.baseY + buffer.cursorY;

  search.matches.forEach((lineIndex, matchIndex) => {
    const marker = term.registerMarker(lineIndex - cursorLine);
    if (!marker) return;

    const isActiveMatch = matchIndex === search.activeMatchIndex;
    const decoration = term.registerDecoration({
      marker,
      x: 0,
      width: term.cols,
      backgroundColor: isActiveMatch ? TERMINAL_SEARCH_ACTIVE_MATCH_COLOR : TERMINAL_SEARCH_MATCH_COLOR,
      layer: "bottom",
      overviewRulerOptions: {
        color: isActiveMatch ? TERMINAL_SEARCH_ACTIVE_MATCH_RULER_COLOR : TERMINAL_SEARCH_MATCH_RULER_COLOR,
        position: "right"
      }
    });

    if (decoration) search.decorations.push(decoration);
  });
}

function clearTerminalSearchHighlights(session) {
  session.search.decorations.forEach(decoration => decoration.dispose());
  session.search.decorations = [];
}

function moveTerminalSearchMatch(session, direction) {
  const { matches } = session.search;
  if (matches.length === 0) return;

  const nextMatchIndex = (session.search.activeMatchIndex + direction + matches.length) % matches.length;
  session.search.activeMatchIndex = nextMatchIndex;
  clearTerminalSearchHighlights(session);
  renderTerminalSearchHighlights(session);
  updateTerminalSearchControls(session);
  revealTerminalSearchMatch(session);
}

function revealTerminalSearchMatch(session) {
  const activeLine = session.search.matches[session.search.activeMatchIndex];
  if (activeLine !== undefined) session.term.scrollToLine(activeLine);
}

function updateTerminalSearchControls(session) {
  const { query, matches, activeMatchIndex, count, previousButton, nextButton } = session.search;
  const hasMatches = matches.length > 0;

  count.textContent = query ? (hasMatches ? `${activeMatchIndex + 1} of ${matches.length}` : "No matches") : "Type to search";
  previousButton.disabled = !hasMatches;
  nextButton.disabled = !hasMatches;
}

function scheduleTerminalSearchRefresh(session) {
  if (session.search?.isDisposed || !session.search?.query || session.search.form.classList.contains("hidden")) return;

  window.clearTimeout(session.search.refreshTimeoutId);
  session.search.refreshTimeoutId = window.setTimeout(() => {
    updateTerminalSearch(session, session.search.input.value);
  }, TERMINAL_SEARCH_REFRESH_DELAY_MS);
}

function disposeTerminalSearch(session) {
  if (!session.search) return;

  session.search.isDisposed = true;
  window.clearTimeout(session.search.refreshTimeoutId);
  clearTerminalSearchHighlights(session);
}

function createTerminalSearchMarkup(sessionId) {
  return `
    <form class="terminal-search hidden" role="search" aria-label="Search terminal output">
      <label class="sr-only" for="terminal-search-${sessionId}">Search terminal output</label>
      <input class="terminal-search-input" id="terminal-search-${sessionId}" type="search" placeholder="Find in terminal" autocomplete="off" spellcheck="false" />
      <output class="terminal-search-count" aria-live="polite">Type to search</output>
      <button class="terminal-search-button terminal-search-previous" type="button" aria-label="Previous result" title="Previous result" disabled>
        <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="18 15 12 9 6 15"></polyline></svg>
      </button>
      <button class="terminal-search-button terminal-search-next" type="button" aria-label="Next result" title="Next result" disabled>
        <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </button>
      <button class="terminal-search-button terminal-search-close" type="button" aria-label="Close terminal search" title="Close search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>
      </button>
    </form>
  `;
}

function createTerminalSearchState() {
  return {
    activeMatchIndex: -1,
    decorations: [],
    isDisposed: false,
    matches: [],
    query: "",
    refreshTimeoutId: null
  };
}

function createTerminalForSession(session) {
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
    fontSize: appSettings.fontSize,
    lineHeight: 1.2,
    scrollback: 5000,
    wordSeparator: TERMINAL_WORD_SEPARATORS,
    rightClickSelectsWord: false,
    macOptionClickForcesSelection: true,
    overviewRuler: { width: TERMINAL_SCROLLBAR_WIDTH },
    theme: {
      background: "#0c0f15",
      foreground: "#e7e9ef",
      cursor: "#65a3ff",
      cursorAccent: "#0c0f15",
      selectionBackground: "#2c4a7a",
      selectionForeground: "#f4f6fa",
      selectionInactiveBackground: "#2a2f3a",
      black: "#181c24",
      red: "#f66c6d",
      green: "#58d18b",
      yellow: "#f7b44e",
      blue: "#65a3ff",
      magenta: "#ab8ef6",
      cyan: "#4cc9d6",
      white: "#b4b9c2",
      brightBlack: "#6b717d",
      brightRed: "#ff8a8a",
      brightGreen: "#7ee2a8",
      brightYellow: "#ffcb73",
      brightBlue: "#8bbcff",
      brightMagenta: "#c4adff",
      brightCyan: "#7fdde6",
      brightWhite: "#f4f6fa",
      overviewRulerBorder: "#0c0f15",
      scrollbarSliderBackground: "rgba(231, 233, 239, 0.12)",
      scrollbarSliderHoverBackground: "rgba(231, 233, 239, 0.22)",
      scrollbarSliderActiveBackground: "rgba(231, 233, 239, 0.32)"
    }
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  session.container.querySelector(".terminal-connection-loading")?.remove();
  term.open(session.container.querySelector(".terminal-viewport"));
  fitAddon.fit();

  session.term = term;
  session.fitAddon = fitAddon;
  initTerminalSearch(session);

  session.terminalInteractions = initTerminalInteractions(session);
  initSudoShortcut(session);
  term.attachCustomKeyEventHandler(event => handleTerminalKeyEvent(session, event));

  return term;
}

async function closeTab(sessionId) {
  const session = activeSessions[sessionId];
  if (!session) return;
  session.isClosing = true;
  cancelSshHostTrust(session);
  session.isClosed = true;
  resetSudoShortcut(session);
  session.panelLayoutDispose?.();
  if (session.kind === "ssh") session.sftpRequestId += 1;

  const disconnectCommand = session.kind === "ssh"
    ? "disconnect_ssh"
    : session.kind === "local"
      ? "stop_local_terminal"
      : null;

  if (disconnectCommand) {
    try {
      await invoke(disconnectCommand, { sessionId: session.connectionId || sessionId });
    } catch (e) {
      console.warn("Disconnect request failed:", e);
    }
  }

  // Remove elements
  const tabEl = document.querySelector(`.terminal-tab[data-id="${sessionId}"]`);
  if (tabEl) tabEl.remove();

  const containerEl = document.querySelector(`.session-container[data-id="${sessionId}"]`);
  if (containerEl) containerEl.remove();

  // Dispose terminal
  if (session.term) {
    session.sudoShortcutDispose?.();
    session.terminalInteractions?.dispose();
    session.toolbarSelectionListener?.dispose();
    disposeTerminalSearch(session);
    session.term.dispose();
  }

  delete activeSessions[sessionId];
  refreshPanelLayout();

  // Select next active tab
  const remainingIds = Object.keys(activeSessions);
  if (remainingIds.length > 0) {
    switchTab(remainingIds[remainingIds.length - 1]);
  } else {
    activeTabId = null;
    welcomeScreen.classList.remove("hidden");
    automationPanel?.refresh();
    refreshWorkspaceChrome();
  }
}

const SESSION_TOOLBAR_ICONS = Object.freeze({
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"></path>',
  paste: '<path d="M9 4.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6.5a2 2 0 0 0-2-2h-2"></path><rect x="9" y="3" width="6" height="3.5" rx="1"></rect>',
  search: '<circle cx="11" cy="11" r="6.5"></circle><path d="M20 20l-4.2-4.2"></path>',
  files: '<rect x="3" y="4" width="18" height="16" rx="2.5"></rect><path d="M15 4v16"></path>'
});

function createSessionToolbarMarkup(kind, profile) {
  const identity = kind === "ssh" ? `${profile.username}@${profile.host}:${profile.port}` : profile.name;
  const action = (className, label, icon) => `<button class="session-action-button ${className}" type="button" title="${label}" aria-label="${label}"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></button>`;
  const folders = kind === "ssh" && profile.namespace
    ? profile.namespace.split(NAMESPACE_SEPARATOR).map(segment => segment.trim()).filter(Boolean)
    : [];
  const breadcrumb = folders.length ? `<span class="session-breadcrumb" title="${escapeHtml(folders.join(" / "))}">${escapeHtml(folders.join(" / "))} /</span>` : "";
  const context = kind === "ssh"
    ? `${breadcrumb}
        <strong class="session-name">${escapeHtml(profile.name)}</strong>
        <span class="session-meta">
          <span class="session-identity" title="${escapeHtml(identity)}">${escapeHtml(identity)}</span>
          <span class="session-separator" aria-hidden="true">·</span>
          <span class="session-directory">Resolving directory…</span>
        </span>`
    : `<strong class="session-identity" title="${escapeHtml(identity)}">${escapeHtml(identity)}</strong>
        <span class="session-meta">
          <span class="session-separator" aria-hidden="true">·</span>
          <span class="session-directory">Local machine</span>
        </span>`;
  return `
    <div class="session-toolbar" data-kind="${kind}">
      <div class="session-context">
        ${context}
      </div>
      <span class="session-state" data-state="connecting" role="status" aria-live="polite">Connecting</span>
      <div class="session-actions" role="group" aria-label="Terminal actions">
        ${kind === "ssh" ? '<button class="btn btn-secondary btn-small session-sudo-password" type="button" title="Submit saved sudo password (F2 three times)" hidden>Sudo · F2 ×3</button>' : ""}
        ${kind === "ssh" ? '<button class="btn btn-primary btn-small btn-reconnect" type="button" hidden>Reconnect</button>' : ""}
        ${action("session-find", "Find in terminal (Ctrl+F)", SESSION_TOOLBAR_ICONS.search)}
        ${action("session-copy-selection", "Copy selection (Ctrl+Shift+C)", SESSION_TOOLBAR_ICONS.copy)}
        ${action("session-paste", "Paste (Ctrl+Shift+V)", SESSION_TOOLBAR_ICONS.paste)}
        ${kind === "ssh" ? '<span class="session-divider" aria-hidden="true"></span>' : ""}
        ${kind === "ssh" ? action("session-files-toggle", "Toggle file browser", SESSION_TOOLBAR_ICONS.files) : ""}
        ${kind === "ssh" ? `<button class="session-agent-toggle" type="button" aria-pressed="false" aria-controls="automation-panel" title="Ask Claude Code or Codex to work on this server"><svg viewBox="0 0 24 24" aria-hidden="true">${UI_ICONS.agentFull}</svg><span>Agent</span></button>` : ""}
      </div>
    </div>
  `;
}

function initSessionToolbar(session) {
  const toolbar = session.container.querySelector(".session-toolbar");
  toolbar.querySelector(".session-copy-selection").addEventListener("click", () => {
    copyTerminalSelection(session.term);
    session.term.focus();
  });
  toolbar.querySelector(".session-paste").addEventListener("click", () => pasteTerminalClipboard(session));
  toolbar.querySelector(".session-find").addEventListener("click", () => openTerminalSearch(session));
  toolbar.querySelector(".btn-reconnect")?.addEventListener("click", () => reconnectSshSession(session));
  toolbar.querySelector(".session-agent-toggle")?.addEventListener("click", () => toggleAgentPanel());
  toolbar.querySelector(".session-sudo-password")?.addEventListener("click", async () => {
    await sendSudoPassword(session);
    if (activeTabId === session.id && !session.isClosing) session.term.focus();
  });
  session.toolbarSelectionListener = session.term.onSelectionChange?.(() => updateSessionToolbar(session));
  updateSessionToolbar(session);
}

function updateSessionToolbar(session) {
  automationPanel?.refresh();
  const toolbar = session.container.querySelector(".session-toolbar");
  if (!toolbar) return;
  const status = session.kind === "ssh" ? session.connectionStatus || "connecting"
    : session.isClosed ? "disconnected" : session.isReady ? "connected" : "connecting";
  const statusLabels = { connecting: "Connecting", reconnecting: "Reconnecting", connected: session.kind === "local" ? "Ready" : "Connected", disconnected: session.kind === "local" ? "Exited" : "Disconnected" };
  const state = toolbar.querySelector(".session-state");
  state.dataset.state = status;
  state.textContent = statusLabels[status];
  const directory = toolbar.querySelector(".session-directory");
  directory.textContent = session.kind === "ssh" ? session.terminalPath || session.currentPath || "Resolving directory…" : session.workingDirectory || "Local machine";
  directory.title = directory.textContent;
  const selectedText = session.term.getSelection?.() || "";
  const copyButton = toolbar.querySelector(".session-copy-selection");
  copyButton.disabled = !selectedText;
  copyButton.title = selectedText ? `Copy ${selectedText.length} selected characters (Ctrl+Shift+C)` : "Select terminal text to copy";
  toolbar.querySelector(".session-paste").disabled = status !== "connected" || session.isConnecting || session.isClosing;
  session.term.options.disableStdin = status !== "connected" || session.isConnecting || session.isClosing;
  const filesButton = toolbar.querySelector(".session-files-toggle");
  if (session.kind === "ssh" && filesButton) {
    const filesOpen = session.sftpPanelOpen && !session.container.classList.contains("sftp-auto-collapsed") && !agentUiState.open;
    filesButton.setAttribute("aria-expanded", String(filesOpen));
    filesButton.title = filesOpen ? "Hide file browser" : "Show file browser";
  }
  const syncNote = session.container.querySelector(".sftp-sync-note");
  if (syncNote) syncNote.hidden = !session.hasDirectoryReporting;
  setWorkspaceTabStatus(session.id, status === "reconnecting" ? "connecting" : status);
  const reconnectButton = toolbar.querySelector(".btn-reconnect");
  const sudoButton = toolbar.querySelector(".session-sudo-password");
  if (session.kind === "ssh" && sudoButton) {
    const ready = canSendSudoPassword(session);
    sudoButton.hidden = !ready;
    sudoButton.disabled = !ready;
  }
  if (session.kind === "ssh" && reconnectButton) {
    reconnectButton.hidden = status !== "disconnected" && status !== "reconnecting";
    reconnectButton.disabled = status !== "disconnected" || session.isConnecting;
    reconnectButton.textContent = status === "reconnecting" ? "Reconnecting…" : "Reconnect";
  }
  session.terminalInteractions?.refresh();
  refreshWorkspaceChrome();
}

async function openLocalTerminal(shell, workingDirectory = null, locationName = null) {
  const shellLabel = LOCAL_TERMINAL_SHELLS[shell];
  if (!shellLabel) {
    showNotification("That local shell is not supported.");
    return;
  }

  welcomeScreen.classList.add("hidden");
  const sessionName = locationName ? `${shellLabel} · ${locationName}` : shellLabel;
  const sessionId = `local_${shell}_${crypto.randomUUID()}`;
  const tabEl = createWorkspaceTab(sessionId, "local", sessionName);

  const sessionContainer = document.createElement("div");
  sessionContainer.className = "session-container local-terminal-session has-session-toolbar active";
  sessionContainer.dataset.id = sessionId;
  sessionContainer.innerHTML = `
    ${createSessionToolbarMarkup("local", { name: sessionName })}
    <div class="terminal-viewport">
      ${createTerminalSearchMarkup(sessionId)}
    </div>
  `;
  workspaceViewport.appendChild(sessionContainer);

  const session = {
    id: sessionId,
    kind: "local",
    name: sessionName,
    shell,
    workingDirectory,
    locationName,
    container: sessionContainer,
    isClosed: false,
    isReady: false,
    search: createTerminalSearchState()
  };
  activeSessions[sessionId] = session;
  switchTab(sessionId);

  const term = createTerminalForSession(session);
  initSessionToolbar(session);
  term.onData((data) => {
    if (session.isClosed || !session.isReady) return;

    invoke("write_local_terminal", {
      sessionId,
      dataBase64: stringToBase64(data)
    }).catch((error) => {
      console.error("Local terminal write failed:", error);
    });
  });

  try {
    await invoke("start_local_terminal", {
      sessionId,
      shell,
      workingDirectory,
      cols: term.cols || LOCAL_TERMINAL_DEFAULT_COLUMNS,
      rows: term.rows || LOCAL_TERMINAL_DEFAULT_ROWS
    });

    if (!activeSessions[sessionId]) {
      await invoke("stop_local_terminal", { sessionId });
      return;
    }

    session.isReady = true;
    updateSessionToolbar(session);
    fitTerminal(session);
    term.focus();
  } catch (error) {
    if (!activeSessions[sessionId]) return;

    session.isClosed = true;
    updateSessionToolbar(session);
    updateWorkspaceTabTitle(tabEl, "Terminal failed");
    markSessionTabAsDisconnected(sessionId);
    term.write(`\r\n\x1b[31m[Local terminal error: ${String(error)}]\x1b[0m\r\n`);
  }
}

// --- SSH CONNECTIONS ---
async function connectProfile(profile) {
  welcomeScreen.classList.add("hidden");
  const sessionId = profile.id + "_" + Date.now();
  const savedSftpState = getSavedSftpExplorerState(profile.id);

  createWorkspaceTab(sessionId, "ssh", profile.name);

  // Create session split layout container (Terminal + SFTP Panel)
  const sessionContainer = document.createElement("div");
  sessionContainer.className = "session-container has-session-toolbar active";
  sessionContainer.dataset.id = sessionId;
  sessionContainer.innerHTML = `
    ${createSessionToolbarMarkup("ssh", profile)}
    <div class="terminal-viewport">
      <div class="terminal-connection-loading" role="status" aria-live="polite">
        <span class="terminal-connection-spinner" aria-hidden="true"></span>
        <span>Connecting to ${escapeHtml(profile.name)}…</span>
      </div>
      ${createTerminalSearchMarkup(sessionId)}
    </div>
    <div class="panel-resize-handle sftp-resize-handle" role="separator" tabindex="0" aria-label="Resize file browser" aria-orientation="vertical"></div>
    <aside class="sftp-panel" aria-label="Files on ${escapeHtml(profile.name)}">
      <div class="side-panel-header">
        <div class="side-panel-tabs" role="group" aria-label="Side panel">
          <span class="side-panel-tab is-active" aria-current="true">${uiIcon("folder")}<span>Files</span></span>
          <button class="side-panel-tab sftp-agent-tab" type="button" aria-pressed="false" title="Ask an agent to work on this server">${uiIcon("agentFull", "icon icon-agent")}<span>Agent</span><span class="attention-dot sftp-agent-attention" hidden></span></button>
        </div>
        <button class="icon-button sftp-close" type="button" title="Hide files" aria-label="Hide files">${uiIcon("close")}</button>
      </div>
      <div class="sftp-header">
        <button class="sftp-btn btn-up" type="button" title="Up one folder" aria-label="Up one folder">
          <svg viewBox="0 0 24 24" aria-hidden="true">${UI_ICONS.arrowUp}</svg>
        </button>
        <div class="sftp-path" title="Click to type a path">
          <nav class="sftp-breadcrumb" aria-label="Remote path"></nav>
          <input type="text" class="sftp-path-input" value="/" aria-label="Remote folder path" spellcheck="false" autocomplete="off" />
        </div>
        <button class="sftp-btn btn-refresh" type="button" title="Refresh" aria-label="Refresh">
          <svg viewBox="0 0 24 24" aria-hidden="true">${UI_ICONS.refresh}</svg>
        </button>
        <button class="sftp-btn btn-new-folder" type="button" title="New folder" aria-label="New folder">
          <svg viewBox="0 0 24 24" aria-hidden="true">${UI_ICONS.folderPlus}</svg>
        </button>
        <button class="sftp-btn btn-upload" type="button" title="Upload a file" aria-label="Upload a file">
          <svg viewBox="0 0 24 24" aria-hidden="true">${UI_ICONS.upload}</svg>
        </button>
      </div>
      <p class="sftp-sync-note" hidden><svg viewBox="0 0 24 24" aria-hidden="true">${UI_ICONS.link}</svg><span>Following the terminal's folder</span></p>
      <div class="sftp-columns" aria-hidden="true"><span>Name</span><span>Size</span></div>
      <div class="sftp-files-list" role="list" aria-label="Remote files">
        <!-- Files list populated dynamically -->
      </div>
    </aside>
  `;
  workspaceViewport.appendChild(sessionContainer);

  // Switch to it immediately
  switchTab(sessionId);

  // Mark in active sessions
  activeSessions[sessionId] = {
    id: sessionId,
    kind: "ssh",
    name: profile.name,
    host: profile.host,
    connectionProfile: { ...profile },
    container: sessionContainer,
    isClosed: true,
    isConnecting: false,
    isClosing: false,
    connectionId: null,
    terminalPath: null,
    currentPath: savedSftpState?.currentPath ?? null,
    sftpPanelOpen: savedSftpState?.sftpPanelOpen ?? true,
    sftpStateKey: profile.id,
    sftpRequestId: 0,
    terminalInput: "",
    canTrackTerminalInput: true,
    search: createTerminalSearchState()
  };

  const session = activeSessions[sessionId];
  const term = createTerminalForSession(session);
  initSessionToolbar(session);
  initSessionPanelLayout(session);
  const connectionStatus = document.createElement("div");
  connectionStatus.className = "terminal-connection-status hidden";
  connectionStatus.innerHTML = `
    <span class="terminal-connection-message" role="status" aria-live="polite"></span>
  `;
  sessionContainer.appendChild(connectionStatus);

  term.parser.registerOscHandler(7, (uri) => {
    const terminalDirectory = getTerminalDirectoryFromUri(uri);
    if (terminalDirectory && !session.isClosing && session.isConnecting) {
      session.pendingTerminalPath = terminalDirectory;
      session.hasDirectoryReporting = true;
    } else if (terminalDirectory && !session.isClosed && !session.isRestoringDirectory && !session.isClosing) {
      session.terminalPath = terminalDirectory;
      updateSessionToolbar(session);
      session.hasDirectoryReporting = true;
      if (terminalDirectory !== session.currentPath) loadSftpDirectory(session, terminalDirectory);
    }
    return true;
  });
  initSftpForSession(session);
  term.onData(async (data) => {
    if (session.isClosed || session.isConnecting || session.isClosing) return;
    resetSudoShortcut(session);
    const connectionId = session.connectionId;
    trackTerminalDirectoryChange(session, data);
    try {
      await invoke("write_ssh", { sessionId: connectionId, dataBase64: stringToBase64(data) });
    } catch (error) {
      if (session.connectionId === connectionId) handleSshDisconnect(session, `SSH write failed: ${error}`);
    }
  });
  await establishSshConnection(session);
}

const BASH_PROMPT_ARRAY_MINIMUM_MAJOR_VERSION = 5;
const BASH_PROMPT_ARRAY_MINIMUM_MINOR_VERSION = 1;
const TERMINAL_DIRECTORY_REPORTING_SCRIPT = [
  'if [ -z "${__SLEEKSSH_CWD_HOOK_INSTALLED-}" ]; then',
  '__sleekssh_report_cwd() {',
  'local __sleekssh_status=$? LC_ALL=C __sleekssh_path="$PWD" __sleekssh_character __sleekssh_index;',
  "printf '\\033]7;file://localhost';",
  'for ((__sleekssh_index=0; __sleekssh_index<${#__sleekssh_path}; __sleekssh_index++)); do',
  '__sleekssh_character="${__sleekssh_path:$__sleekssh_index:1}";',
  'case "$__sleekssh_character" in',
  '[a-zA-Z0-9/._~-]) printf \'%s\' "$__sleekssh_character" ;;',
  '* ) printf \'%%%02X\' "\'$__sleekssh_character" ;;',
  'esac; done;',
  "printf '\\007';",
  'if [ -n "${ZSH_VERSION-}" ]; then return 0; fi;',
  'return "$__sleekssh_status";',
  '};',
  'if [ -n "${ZSH_VERSION-}" ]; then precmd_functions+=(__sleekssh_report_cwd);',
  `elif (( BASH_VERSINFO[0] > ${BASH_PROMPT_ARRAY_MINIMUM_MAJOR_VERSION} || (BASH_VERSINFO[0] == ${BASH_PROMPT_ARRAY_MINIMUM_MAJOR_VERSION} && BASH_VERSINFO[1] >= ${BASH_PROMPT_ARRAY_MINIMUM_MINOR_VERSION}) )); then`,
  'PROMPT_COMMAND+=(__sleekssh_report_cwd);',
  'else PROMPT_COMMAND="${PROMPT_COMMAND-}"$\'\\n\'\'__sleekssh_report_cwd\'; fi;',
  '__SLEEKSSH_CWD_HOOK_INSTALLED=1;',
  'fi;'
].join(' ');

function createTerminalSetupCommand(restorePath) {
  // Keep shell-specific syntax inside eval so unsupported shells can skip it.
  const reportingCommand = `if [ -n "\${BASH_VERSION-}\${ZSH_VERSION-}" ]; then eval ${quoteRemoteShellArgument(TERMINAL_DIRECTORY_REPORTING_SCRIPT)}; fi`;
  const restoreCommand = restorePath ? `; cd ${quoteRemoteShellArgument(restorePath)}` : "";
  return `${reportingCommand}${restoreCommand}; if [ -n "\${BASH_VERSION-}\${ZSH_VERSION-}" ]; then __sleekssh_report_cwd; fi`;
}

const SSH_HOST_TRUST_REQUIRED_PREFIX = "SSH_HOST_TRUST_REQUIRED:";
const SSH_HOST_KEY_CHANGED_PREFIX = "SSH_HOST_KEY_CHANGED:";
const SSH_HOST_KEY_MAX_BASE64_LENGTH = 16_384;
const SSH_PORT_MAXIMUM = 65_535;
const pendingSshHostTrustRequests = [];
let activeSshHostTrustRequest = null;

function parseSshHostTrustError(error) {
  if (typeof error !== "string") return null;
  const prefix = error.startsWith(SSH_HOST_TRUST_REQUIRED_PREFIX) ? SSH_HOST_TRUST_REQUIRED_PREFIX
    : error.startsWith(SSH_HOST_KEY_CHANGED_PREFIX) ? SSH_HOST_KEY_CHANGED_PREFIX : null;
  if (!prefix) return null;
  try {
    const challenge = JSON.parse(error.slice(prefix.length));
    if (!challenge || typeof challenge.host !== "string" || !challenge.host.trim()
      || /[\x00-\x1f\x7f]/.test(challenge.host)
      || !Number.isInteger(challenge.port) || challenge.port < 1 || challenge.port > SSH_PORT_MAXIMUM
      || typeof challenge.key_type !== "string" || !/^[a-zA-Z0-9@._+-]+$/.test(challenge.key_type)
      || typeof challenge.fingerprint !== "string" || !/^SHA256:[a-zA-Z0-9+/]{43}$/.test(challenge.fingerprint)
      || typeof challenge.key_base64 !== "string" || !challenge.key_base64.length
      || challenge.key_base64.length > SSH_HOST_KEY_MAX_BASE64_LENGTH
      || !/^[a-zA-Z0-9+/]+={0,2}$/.test(challenge.key_base64)) return null;
    return { ...challenge, changed: prefix === SSH_HOST_KEY_CHANGED_PREFIX };
  } catch {
    return null;
  }
}

function requestSshHostTrust(session, challenge) {
  if (session.isClosing || activeSessions[session.id] !== session) return Promise.resolve(false);
  return new Promise(resolve => {
    pendingSshHostTrustRequests.push({ session, challenge, resolve });
    showNextSshHostTrustRequest();
  });
}

function showNextSshHostTrustRequest() {
  if (activeSshHostTrustRequest) return;
  const request = pendingSshHostTrustRequests.shift();
  if (!request) return;
  const { session, challenge } = request;
  if (session.isClosing || activeSessions[session.id] !== session) {
    request.resolve(false);
    showNextSshHostTrustRequest();
    return;
  }
  const previousFocus = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay ssh-host-trust-overlay";
  overlay.innerHTML = `
    <section class="modal-card ssh-host-trust-card" role="dialog" aria-modal="true" aria-labelledby="ssh-host-trust-title" aria-describedby="ssh-host-trust-description">
      <div class="modal-header"><h3 id="ssh-host-trust-title"></h3><button class="btn-close ssh-host-trust-close" type="button" aria-label="Close server fingerprint dialog"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"></path></svg></button></div>
      <div class="ssh-host-trust-body">
        <p id="ssh-host-trust-description"></p>
        <dl class="ssh-host-trust-details"><dt>Server</dt><dd class="ssh-host-trust-server"></dd><dt>Key type</dt><dd class="ssh-host-trust-key-type"></dd><dt>SHA256 fingerprint</dt><dd class="ssh-host-trust-fingerprint"></dd><dt class="ssh-host-trust-saved-label" hidden>Saved fingerprint</dt><dd class="ssh-host-trust-saved-fingerprint" hidden></dd></dl>
        <p class="ssh-host-trust-error" role="alert"></p>
        <div class="modal-footer"><button class="btn btn-secondary ssh-host-trust-cancel" type="button">Cancel</button><button class="btn btn-primary ssh-host-trust-accept" type="button">Trust and connect</button></div>
      </div>
    </section>`;
  overlay.querySelector("#ssh-host-trust-title").textContent = challenge.changed ? "Server key changed" : "Verify SSH server";
  overlay.querySelector("#ssh-host-trust-description").textContent = challenge.changed
    ? "This server's key differs from the saved key. The connection is blocked. Confirm the change with your server administrator."
    : "Compare this fingerprint with a trusted source before saving it for future connections.";
  overlay.querySelector(".ssh-host-trust-server").textContent = `${challenge.host}:${challenge.port}`;
  overlay.querySelector(".ssh-host-trust-key-type").textContent = challenge.key_type;
  overlay.querySelector(".ssh-host-trust-fingerprint").textContent = challenge.fingerprint;
  if (challenge.changed && typeof challenge.expected_fingerprint === "string") {
    overlay.querySelector(".ssh-host-trust-saved-label").hidden = false;
    const savedFingerprint = overlay.querySelector(".ssh-host-trust-saved-fingerprint");
    savedFingerprint.hidden = false;
    savedFingerprint.textContent = challenge.expected_fingerprint;
  }
  const cancelButton = overlay.querySelector(".ssh-host-trust-cancel");
  const acceptButton = overlay.querySelector(".ssh-host-trust-accept");
  acceptButton.hidden = challenge.changed;
  cancelButton.textContent = challenge.changed ? "Close" : "Cancel";
  const finish = accepted => {
    if (activeSshHostTrustRequest !== request) return;
    activeSshHostTrustRequest = null;
    overlay.remove();
    request.resolve(accepted);
    if (previousFocus?.isConnected) previousFocus.focus();
    showNextSshHostTrustRequest();
  };
  request.finish = finish;
  activeSshHostTrustRequest = request;
  overlay.querySelector(".ssh-host-trust-close").addEventListener("click", () => finish(false));
  cancelButton.addEventListener("click", () => finish(false));
  acceptButton.addEventListener("click", async () => {
    if (challenge.changed || acceptButton.disabled) return;
    acceptButton.disabled = true;
    try {
      await invoke("trust_ssh_host", { host: challenge.host, port: challenge.port, keyBase64: challenge.key_base64 });
      if (session.isClosing || activeSessions[session.id] !== session) finish(false);
      else finish(true);
    } catch {
      overlay.querySelector(".ssh-host-trust-error").textContent = "Could not save this server key. The connection remains blocked.";
      acceptButton.disabled = false;
    }
  });
  overlay.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = [...overlay.querySelectorAll("button:not([disabled]):not([hidden])")];
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  document.body.appendChild(overlay);
  cancelButton.focus();
}

function cancelSshHostTrust(session) {
  for (let index = pendingSshHostTrustRequests.length - 1; index >= 0; index -= 1) {
    const request = pendingSshHostTrustRequests[index];
    if (request.session !== session) continue;
    pendingSshHostTrustRequests.splice(index, 1);
    request.resolve(false);
  }
  if (activeSshHostTrustRequest?.session === session) activeSshHostTrustRequest.finish(false);
}

async function connectVerifiedSshSession(session, arguments_) {
  let approvalAttempted = false;
  while (!session.isClosing && activeSessions[session.id] === session) {
    try {
      await invoke("connect_ssh", arguments_);
      return;
    } catch (error) {
      const challenge = parseSshHostTrustError(error);
      if (!challenge) throw error;
      if (challenge.host !== arguments_.host || challenge.port !== arguments_.port) {
        throw new Error("SSH server verification did not match this connection.");
      }
      if (approvalAttempted) throw new Error("SSH server key changed during verification. Connection blocked.");
      const approved = await requestSshHostTrust(session, challenge);
      if (!approved) throw new Error(challenge.changed ? "SSH server key changed. Connection blocked." : "SSH server fingerprint was not approved.");
      approvalAttempted = true;
    }
  }
}

function findSshSession(connectionId) {
  return Object.values(activeSessions).find(session =>
    session.kind === "ssh" && session.connectionId === connectionId && !session.isClosing
  );
}

function setSshConnectionStatus(session, status, message) {
  session.connectionStatus = status;
  const busy = status === "connecting" || status === "reconnecting";
  const statusElement = session.container.querySelector(".terminal-connection-status");
  const bannerWasHidden = statusElement.classList.contains("hidden");
  statusElement.classList.toggle("hidden", status === "connected");
  statusElement.classList.toggle("is-busy", busy);
  statusElement.querySelector(".terminal-connection-message").textContent = message;
  statusElement.title = message;
  session.container.querySelector(".sftp-panel").inert = status !== "connected";
  session.term.options.disableStdin = status !== "connected";
  const tabElement = document.querySelector(`.terminal-tab[data-id="${session.id}"]`);
  tabElement?.classList.toggle("connection-terminated", status === "disconnected");
  if (tabElement) updateWorkspaceTabTitle(tabElement, session.name);
  updateSessionToolbar(session);
  // The status banner takes a grid row above the terminal, so refit when it appears or goes away.
  if (bannerWasHidden !== statusElement.classList.contains("hidden") && session.fitAddon) fitTerminal(session);
}

function handleSshDisconnect(session, message) {
  if (session.isClosing || session.connectionStatus === "disconnected") return;
  resetSudoShortcut(session);
  session.isClosed = true;
  session.sftpRequestId += 1;
  session.terminalInput = "";
  session.canTrackTerminalInput = true;
  setSshConnectionStatus(session, "disconnected", message);
  session.term.write("\r\n\x1b[31m[SSH connection closed. Use Reconnect to continue.]\x1b[0m\r\n", () => scheduleTerminalSearchRefresh(session));
}

async function reconnectSshSession(session) {
  if (!session.isClosed) return;
  await establishSshConnection(session, true);
}

async function establishSshConnection(session, reconnecting = false) {
  if (session.isConnecting || session.isClosing || activeSessions[session.id] !== session) return;
  const previousConnectionId = session.connectionId;
  const connectionId = crypto.randomUUID();
  const restorePath = session.terminalPath || session.currentPath;
  const profile = session.connectionProfile;
  session.connectionId = connectionId;
  resetSudoShortcut(session);
  session.isConnecting = true;
  session.isClosed = true;
  session.isRestoringDirectory = true;
  session.hasDirectoryReporting = false;
  session.pendingTerminalPath = null;
  session.sftpRequestId += 1;
  session.terminalInput = "";
  session.canTrackTerminalInput = true;
  setSshConnectionStatus(session, reconnecting ? "reconnecting" : "connecting", `${reconnecting ? "Reconnecting" : "Connecting"} to ${session.name}…`);

  try {
    if (previousConnectionId) await invoke("disconnect_ssh", { sessionId: previousConnectionId });
    if (session.isClosing || activeSessions[session.id] !== session) return;
    if (reconnecting) session.term.write(TERMINAL_RECONNECT_RESET_SEQUENCE);
    await connectVerifiedSshSession(session, {
      sessionId: connectionId,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      keyPath: profile.key_path || "",
      passphrase: profile.passphrase,
      password: profile.password,
      usePassword: profile.use_password,
      profileId: profile.id || null,
      terminalSetup: createTerminalSetupCommand(restorePath)
    });
    if (session.isClosing || activeSessions[session.id] !== session || session.connectionStatus === "disconnected") {
      await invoke("disconnect_ssh", { sessionId: connectionId });
      return;
    }

    session.isClosed = false;
    session.terminalPath = session.pendingTerminalPath || restorePath || null;
    if (session.isClosed || session.isClosing || activeSessions[session.id] !== session) return;
    session.isRestoringDirectory = false;
    setSshConnectionStatus(session, "connected", "Connected");
    fitTerminal(session);
    await loadSftpDirectory(session, session.terminalPath || REMOTE_HOME_DIRECTORY);
    if (activeTabId === session.id && !session.isClosed) session.term.focus();
  } catch (error) {
    if (session.isClosing || activeSessions[session.id] !== session) return;
    console.error("SSH connection failed:", error);
    handleSshDisconnect(session, `Connection failed: ${error}`);
    try {
      await invoke("disconnect_ssh", { sessionId: connectionId });
    } catch (cleanupError) {
      console.error("Failed to clean up SSH connection:", cleanupError);
    }
  } finally {
    session.isConnecting = false;
    session.isRestoringDirectory = false;
    if (!session.isClosing && activeSessions[session.id] === session) {
      if (!session.isClosed && session.pendingTerminalPath) {
        session.terminalPath = session.pendingTerminalPath;
        if (session.currentPath !== session.terminalPath) loadSftpDirectory(session, session.terminalPath);
      }
      session.pendingTerminalPath = null;
      updateSessionToolbar(session);
    }
  }
}

// --- CONFIGURE TAURI EVENT LISTENERS ---
function initConnectionListeners() {
  listen("ssh-sudo-prompt", (event) => {
    const session = findSshSession(event.payload.session_id);
    if (!session || session.isClosed || session.isConnecting) return;
    setSudoPromptState(session, event.payload.ready === true, event.payload.prompt_id);
  });
  listen("ssh-output", (event) => {
    const session = findSshSession(event.payload.session_id);
    if (!session?.term || session.connectionStatus === "disconnected") return;
    session.term.write(base64ToBytes(event.payload.data), () => scheduleTerminalSearchRefresh(session));
  });

  listen("ssh-closed", (event) => {
    const session = findSshSession(event.payload.session_id);
    if (session) handleSshDisconnect(session, "Connection closed. Reconnect to resume in the last directory.");
  });

  listen("ssh-error", (event) => {
    const session = findSshSession(event.payload.session_id);
    if (session) handleSshDisconnect(session, `SSH connection error: ${event.payload.data}`);
  });

  listen("local-terminal-output", (event) => {
    const payload = event.payload;
    const session = activeSessions[payload.session_id];
    if (!session?.term) return;

    const bytes = base64ToBytes(payload.data);
    session.term.write(bytes, () => scheduleTerminalSearchRefresh(session));
  });

  listen("local-terminal-closed", (event) => {
    const payload = event.payload;
    const session = activeSessions[payload.session_id];
    if (!session) return;

    session.isClosed = true;
    markSessionTabAsDisconnected(payload.session_id);
    updateSessionToolbar(session);
    session.term?.write("\r\n\x1b[33m[Local shell exited]\x1b[0m\r\n");
  });

  listen("local-terminal-error", (event) => {
    const payload = event.payload;
    const session = activeSessions[payload.session_id];
    if (!session) return;

    session.isClosed = true;
    markSessionTabAsDisconnected(payload.session_id);
    updateSessionToolbar(session);
    session.term?.write(`\r\n\x1b[31m[Local terminal error: ${payload.data}]\x1b[0m\r\n`);
  });
}

function initGlobalShortcutListener() {
  listen("open-local-terminal", () => {
    openLocalTerminal("powershell");
  }).catch((error) => {
    console.error("Failed to listen for the global terminal shortcut:", error);
  });
}

// --- HELPER FUNCTIONS ---
function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// --- SFTP FRONTEND INTEGRATION ---

function initSftpForSession(session) {
  const container = session.container;
  const toggleBtn = container.querySelector(".session-files-toggle");
  const btnUp = container.querySelector(".btn-up");
  const btnRefresh = container.querySelector(".btn-refresh");
  const btnNewFolder = container.querySelector(".btn-new-folder");
  const btnUpload = container.querySelector(".btn-upload");
  const pathInput = container.querySelector(".sftp-path-input");

  applySftpPanelVisibility(session);

  const setFilesOpen = (open) => {
    session.sftpPanelOpen = open;
    applySftpPanelVisibility(session);
    refreshPanelLayout();
    updateSessionToolbar(session);
    saveSftpExplorerState(session);
    setTimeout(() => fitTerminal(session), SFTP_PANEL_TRANSITION_MS);
  };

  toggleBtn.addEventListener("click", () => {
    // With the agent open, the files button brings the file browser back instead of hiding it.
    if (agentUiState.open) {
      closeAgentPanel();
      if (!session.sftpPanelOpen) setFilesOpen(true);
      return;
    }
    setFilesOpen(!session.sftpPanelOpen);
  });

  container.querySelector(".sftp-close")?.addEventListener("click", () => {
    setFilesOpen(false);
    toggleBtn.focus();
  });

  container.querySelector(".sftp-agent-tab")?.addEventListener("click", () => openAgentPanel());

  const pathField = container.querySelector(".sftp-path");
  const setPathEditing = (editing) => {
    if (!pathField) return;
    pathField.classList.toggle("is-editing", editing);
    if (editing) {
      pathInput.value = session.currentPath || pathInput.value;
      pathInput.focus();
      pathInput.select();
    }
  };
  pathField?.addEventListener("click", (event) => {
    if (event.target.closest(".sftp-crumb") || pathField.classList.contains("is-editing")) return;
    setPathEditing(true);
  });
  pathInput.addEventListener("blur", () => setPathEditing(false));
  pathInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setPathEditing(false);
      session.term?.focus();
    }
  });
  container.querySelector(".sftp-breadcrumb")?.addEventListener("click", (event) => {
    const crumb = event.target.closest(".sftp-crumb");
    if (!crumb) return;
    loadSftpDirectory(session, crumb.dataset.path, { syncTerminal: true });
  });

  btnUp.addEventListener("click", () => {
    let parts = (session.currentPath || ROOT_REMOTE_DIRECTORY).split("/").filter(Boolean);
    parts.pop();
    let parentPath = ROOT_REMOTE_DIRECTORY + parts.join("/");
    loadSftpDirectory(session, parentPath, { syncTerminal: true });
  });

  btnRefresh.addEventListener("click", () => {
    loadSftpDirectory(session, session.currentPath || REMOTE_HOME_DIRECTORY);
  });

  // Create directory
  btnNewFolder.addEventListener("click", async () => {
    const folderName = prompt("Enter new folder name:");
    if (!folderName || !folderName.trim()) return;
    if (!session.currentPath) return;
    
    let path = session.currentPath;
    if (!path.endsWith("/")) path += "/";
    path += folderName.trim();

    try {
      await invoke("sftp_create_directory", { sessionId: session.connectionId || session.id, path });
      loadSftpDirectory(session, session.currentPath);
    } catch (e) {
      alert("Failed to create folder: " + e);
    }
  });

  // Upload file
  btnUpload.addEventListener("click", async () => {
    try {
      if (!session.currentPath) return;
      const localPath = await invoke("select_upload_file");
      if (!localPath) return;

      const filename = localPath.split(/[\\/]/).pop();
      let remotePath = session.currentPath;
      if (!remotePath.endsWith("/")) remotePath += "/";
      remotePath += filename;

      // Show upload indicator
      const fileListEl = container.querySelector(".sftp-files-list");
      fileListEl.innerHTML = `<div class="sftp-status">Uploading: ${escapeHtml(filename)}...</div>`;

      await invoke("sftp_upload_file", { sessionId: session.connectionId || session.id, localPath, remotePath });
      loadSftpDirectory(session, session.currentPath);
    } catch (e) {
      alert("Upload failed: " + e);
      loadSftpDirectory(session, session.currentPath);
    }
  });

  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      loadSftpDirectory(session, pathInput.value.trim(), { syncTerminal: true });
      pathInput.blur();
    }
  });

}

const SFTP_BREADCRUMB_VISIBLE_SEGMENTS = 3;

function renderSftpBreadcrumb(session, path) {
  const breadcrumb = session.container.querySelector(".sftp-breadcrumb");
  if (!breadcrumb || typeof breadcrumb.replaceChildren !== "function" || typeof document.createElement !== "function") return;
  const segments = String(path || ROOT_REMOTE_DIRECTORY).split("/").filter(Boolean);
  const parts = [];
  const addCrumb = (label, crumbPath, current) => {
    const crumb = document.createElement("button");
    crumb.type = "button";
    crumb.className = "sftp-crumb";
    crumb.textContent = label;
    crumb.dataset.path = crumbPath;
    crumb.title = crumbPath;
    if (current) crumb.setAttribute("aria-current", "page");
    parts.push(crumb);
  };
  const addText = (className, text) => {
    const span = document.createElement("span");
    span.className = className;
    span.setAttribute("aria-hidden", "true");
    span.textContent = text;
    parts.push(span);
  };
  addCrumb("/", ROOT_REMOTE_DIRECTORY, segments.length === 0);
  const firstVisible = Math.max(0, segments.length - SFTP_BREADCRUMB_VISIBLE_SEGMENTS);
  if (firstVisible > 0) addText("sftp-crumb-ellipsis", "…/");
  segments.forEach((segment, index) => {
    if (index < firstVisible) return;
    if (index > firstVisible || firstVisible === 0 && index > 0) addText("sftp-crumb-separator", "/");
    addCrumb(segment, ROOT_REMOTE_DIRECTORY + segments.slice(0, index + 1).join("/"), index === segments.length - 1);
  });
  breadcrumb.replaceChildren(...parts);
}

function applySftpPanelVisibility(session) {
  session.container.classList.toggle("sftp-collapsed", !session.sftpPanelOpen);
}

function getTerminalDirectoryFromUri(uri) {
  try {
    const url = new URL(uri);
    const path = decodeURIComponent(url.pathname);
    return url.protocol === "file:" && path.startsWith(ROOT_REMOTE_DIRECTORY) && !/[\x00-\x1f\x7f]/.test(path) ? path : null;
  } catch (error) {
    console.warn("Ignoring invalid terminal working-directory URI:", error);
    return null;
  }
}

function quoteRemoteShellArgument(value) {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Remote directory contains invalid control characters.");
  }
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function synchronizeTerminalDirectory(session, path) {
  if (!session.term || session.isClosed || session.terminalInput || session.isClosing) return;
  const command = `cd ${quoteRemoteShellArgument(path)}\r`;
  await invoke("write_ssh", { sessionId: session.connectionId, dataBase64: stringToBase64(command) });
}

function getTerminalCdPath(session, command) {
  const match = command.match(/^\s*cd(?:\s+(.+?))?\s*$/);
  if (!match || !session.currentPath) return null;

  const rawPath = match[1] ?? "~";
  const quotedPath = rawPath.match(/^'((?:[^']|'\\'')*)'$/) || rawPath.match(/^"([^"$`\\]*)"$/);
  const path = quotedPath ? quotedPath[1].replaceAll("'\\''", "'") : rawPath;
  if (!quotedPath && /[\s;&|<>`$\\]/.test(path)) return null;

  if (path === "~") return REMOTE_HOME_DIRECTORY;
  if (path === "-") return null;
  if (path.startsWith("~/")) return `.${path.slice(1)}`;
  if (path.startsWith(ROOT_REMOTE_DIRECTORY)) return path;
  return `${session.currentPath}/${path}`;
}

function trackTerminalDirectoryChange(session, data) {
  if (session.hasDirectoryReporting) {
    session.terminalInput = "";
    session.canTrackTerminalInput = true;
    return;
  }
  for (const character of data) {
    if (character === "\r") {
      const terminalPath = session.canTrackTerminalInput
        && !session.hasDirectoryReporting ? getTerminalCdPath(session, session.terminalInput)
        : null;
      session.terminalInput = "";
      session.canTrackTerminalInput = true;
      if (terminalPath) {
        const connectionId = session.connectionId;
        setTimeout(() => {
          if (session.isClosed || session.isClosing || session.connectionId !== connectionId) return;
          loadSftpDirectory(session, terminalPath);
        }, TERMINAL_DIRECTORY_SYNC_DELAY_MS);
      }
    } else if (character === "\x03" || character === "\x15") {
      session.terminalInput = "";
      session.canTrackTerminalInput = true;
    } else if (character === "\x7f") {
      session.terminalInput = session.terminalInput.slice(0, -1);
    } else if (character >= " ") {
      session.terminalInput += character;
    } else {
      session.canTrackTerminalInput = false;
    }
  }
}

async function loadSftpDirectory(session, path, { syncTerminal = false } = {}) {
  const container = session.container;
  const fileListEl = container.querySelector(".sftp-files-list");
  const pathInput = container.querySelector(".sftp-path-input");

  if (!fileListEl || session.isClosed || session.isClosing) return;

  const requestId = ++session.sftpRequestId;
  const connectionId = session.connectionId;

  fileListEl.innerHTML = `<div class="sftp-status">Loading files...</div>`;

  if (!path || path.trim() === "") {
    path = REMOTE_HOME_DIRECTORY;
  }

  try {
    const resolvedPath = await invoke("sftp_resolve_path", { sessionId: connectionId, path });
    if (session.isClosed || connectionId !== session.connectionId || requestId !== session.sftpRequestId) return;
    const files = await invoke("sftp_list_directory", { sessionId: connectionId, path: resolvedPath });
    if (session.isClosed || requestId !== session.sftpRequestId) return;
    
    session.currentPath = resolvedPath;
    updateSessionToolbar(session);
    if (pathInput) pathInput.value = resolvedPath;
    renderSftpBreadcrumb(session, resolvedPath);
    saveSftpExplorerState(session);
    if (syncTerminal) await synchronizeTerminalDirectory(session, resolvedPath);

    if (files.length === 0) {
      fileListEl.innerHTML = `<div class="sftp-status">This folder is empty.</div>`;
      return;
    }

    fileListEl.innerHTML = "";
    files.forEach(file => {
      const item = document.createElement("div");
      item.className = "sftp-item";
      item.setAttribute("role", "listitem");
      item.dataset.path = file.path;
      item.dataset.isDir = file.is_dir;

      const sizeStr = file.is_dir ? "" : formatBytes(file.size);
      const openLabel = file.is_dir ? `Open folder ${file.name}` : `${file.name}, ${sizeStr}. Press Enter to download.`;

      item.innerHTML = `
        <button class="sftp-item-main" type="button" title="${escapeHtml(file.name)}" aria-label="${escapeHtml(openLabel)}">
          <span class="sftp-item-icon ${file.is_dir ? 'folder' : 'file'}"><svg viewBox="0 0 24 24" aria-hidden="true">${file.is_dir ? UI_ICONS.folder : UI_ICONS.file}</svg></span>
          <span class="sftp-item-name">${escapeHtml(file.name)}</span>
          <span class="sftp-item-size">${sizeStr}</span>
        </button>
        <div class="sftp-item-actions">
          ${!file.is_dir ? `
            <button class="btn-sftp-download sftp-btn" type="button" title="Download" aria-label="Download ${escapeHtml(file.name)}">
              <svg viewBox="0 0 24 24" aria-hidden="true">${UI_ICONS.download}</svg>
            </button>
          ` : ''}
          <button class="btn-sftp-delete sftp-btn danger" type="button" title="Delete" aria-label="Delete ${escapeHtml(file.name)}">
            <svg viewBox="0 0 24 24" aria-hidden="true">${UI_ICONS.trash}</svg>
          </button>
        </div>
      `;

      const openItem = () => {
        if (file.is_dir) {
          loadSftpDirectory(session, file.path, { syncTerminal: true });
        } else {
          const downloadBtn = item.querySelector(".btn-sftp-download");
          if (downloadBtn) downloadBtn.click();
        }
      };
      const mainButton = item.querySelector(".sftp-item-main");
      mainButton.addEventListener("dblclick", openItem);
      mainButton.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        openItem();
      });

      // Selection indicator
      mainButton.addEventListener("click", () => {
        container.querySelectorAll(".sftp-item").forEach(el => el.classList.remove("selected"));
        item.classList.add("selected");
      });

      // Download file handler
      const downloadBtn = item.querySelector(".btn-sftp-download");
      if (downloadBtn) {
        downloadBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            const localDestination = await invoke("select_download_destination", { filename: file.name });
            if (!localDestination) return;

            fileListEl.innerHTML = `<div class="sftp-status">Downloading: ${escapeHtml(file.name)}...</div>`;
            await invoke("sftp_download_file", { sessionId: session.connectionId || session.id, remotePath: file.path, localPath: localDestination });
            
            // Reload list
            loadSftpDirectory(session, session.currentPath);
          } catch (err) {
            alert("Download failed: " + err);
            loadSftpDirectory(session, session.currentPath);
          }
        });
      }

      // Delete file / folder handler
      const deleteBtn = item.querySelector(".btn-sftp-delete");
      if (deleteBtn) {
        deleteBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (confirm(`Are you sure you want to delete "${file.name}"?`)) {
            try {
              if (file.is_dir) {
                await invoke("sftp_delete_directory", { sessionId: session.connectionId || session.id, path: file.path });
              } else {
                await invoke("sftp_delete_file", { sessionId: session.connectionId || session.id, path: file.path });
              }
              loadSftpDirectory(session, session.currentPath);
            } catch (err) {
              alert("Deletion failed: " + err);
            }
          }
        });
      }

      fileListEl.appendChild(item);
    });

  } catch (err) {
    if (session.isClosed || requestId !== session.sftpRequestId) return;
    console.error("SFTP List failed:", err);
    fileListEl.innerHTML = `<div class="sftp-status error">Error: ${escapeHtml(String(err))}</div>`;
  }
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// --- WORKSPACE CHROME ---
// Status bar, rail badges, host status dots and agent indicators. These helpers tolerate
// partial DOMs so session code can call them from anywhere.
let defaultSshKeyPath = "";

function setChromeAttribute(element, name, value) {
  if (element && typeof element.setAttribute === "function") element.setAttribute(name, value);
}

function setChromeClass(element, className, enabled) {
  const classList = element?.classList;
  if (!classList || typeof classList.add !== "function" || typeof classList.remove !== "function") return;
  if (enabled) classList.add(className);
  else classList.remove(className);
}

function setWorkspaceTabStatus(sessionId, status) {
  if (typeof document.querySelector !== "function") return;
  setChromeAttribute(document.querySelector(`.terminal-tab[data-id="${sessionId}"]`), "data-status", status);
}

function getSessionConnectionState(session) {
  if (!session) return "none";
  if (session.kind === "ssh") {
    const status = session.connectionStatus || "connecting";
    return status === "reconnecting" ? "connecting" : status;
  }
  if (session.kind === "local") return session.isClosed ? "disconnected" : session.isReady ? "connected" : "connecting";
  return "none";
}

function findSessionsForProfile(profileId) {
  return Object.values(activeSessions).filter(session =>
    session.kind === "ssh" && !session.isClosing && session.connectionProfile?.id === profileId
  );
}

function openOrSwitchToProfile(profile) {
  const existing = findSessionsForProfile(profile.id).at(-1);
  if (existing) switchTab(existing.id);
  else connectProfile(profile);
}

function updateHostIndicators() {
  if (typeof document.querySelectorAll !== "function") return;
  const rank = { connected: 3, connecting: 2, disconnected: 1 };
  const states = new Map();
  Object.values(activeSessions).forEach(session => {
    const profileId = session.kind === "ssh" && !session.isClosing ? session.connectionProfile?.id : null;
    if (!profileId) return;
    const state = getSessionConnectionState(session);
    const current = states.get(profileId);
    if (!current || rank[state] > rank[current]) states.set(profileId, state);
  });
  const activeSession = activeSessions[activeTabId];
  const activeProfileId = activeSession?.kind === "ssh" ? activeSession.connectionProfile?.id : null;
  const stateLabels = { connected: ", connected", connecting: ", connecting", disconnected: ", disconnected" };
  document.querySelectorAll(".profile-item[data-profile-id]").forEach(item => {
    const profileId = item.getAttribute("data-profile-id");
    const state = states.get(profileId);
    setChromeClass(item, "is-connected", state === "connected");
    setChromeClass(item, "is-connecting", state === "connecting");
    setChromeClass(item, "is-disconnected", state === "disconnected");
    setChromeClass(item, "is-active", Boolean(activeProfileId) && profileId === activeProfileId);
    const stateLabel = item.querySelector(".profile-state-label");
    if (stateLabel) stateLabel.textContent = stateLabels[state] || "";
  });
}

function normalizeVpnServer(value) {
  return String(value || "").trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/:].*$/, "");
}

// Prefer the saved shortcut name ("Corporate") over the raw server address vpncli reports.
function getVpnDisplayName() {
  const server = normalizeVpnServer(vpnStatusSnapshot.server);
  if (!server) return null;
  const profiles = typeof savedVpnProfiles !== "undefined" && Array.isArray(savedVpnProfiles) ? savedVpnProfiles : [];
  return profiles.find(profile => normalizeVpnServer(profile.server) === server)?.name || vpnStatusSnapshot.server;
}

function refreshWorkspaceChrome() {
  if (typeof document.getElementById !== "function") return;
  const activeSession = activeSessions[activeTabId];

  const connectionLabel = document.getElementById("status-connection-label");
  if (connectionLabel) {
    let state = "none";
    let label = "No session";
    let detail = "";
    if (activeSession?.kind === "ssh") {
      state = getSessionConnectionState(activeSession);
      label = state === "connected" ? "Connected"
        : state === "disconnected" ? "Disconnected"
          : activeSession.connectionStatus === "reconnecting" ? "Reconnecting" : "Connecting";
      const profile = activeSession.connectionProfile || {};
      detail = `${profile.username}@${activeSession.host}:${profile.port}`;
    } else if (activeSession?.kind === "local") {
      state = getSessionConnectionState(activeSession);
      label = state === "connected" ? "Ready" : state === "disconnected" ? "Exited" : "Starting";
      detail = activeSession.workingDirectory || LOCAL_TERMINAL_SHELLS[activeSession.shell] || "";
    } else if (activeSession) {
      label = activeSession.name;
    }
    setChromeAttribute(document.getElementById("status-connection-dot"), "data-state", state);
    connectionLabel.textContent = label;
    const connectionDetail = document.getElementById("status-connection-detail");
    if (connectionDetail) connectionDetail.textContent = detail;
  }

  const vpnState = vpnStatusSnapshot.state === "connected" || vpnStatusSnapshot.state === "disconnected" ? vpnStatusSnapshot.state : "unknown";
  const vpnItem = document.getElementById("status-vpn");
  setChromeClass(vpnItem, "hidden", !appSettings.showVpnTab);
  setChromeAttribute(document.getElementById("status-vpn-dot"), "data-state", vpnState);
  const vpnLabel = document.getElementById("status-vpn-label");
  if (vpnLabel) {
    vpnLabel.textContent = vpnState === "connected" ? `VPN ${getVpnDisplayName() || "connected"}`
      : vpnState === "disconnected" ? "VPN off" : "VPN";
  }
  setChromeAttribute(document.getElementById("rail-vpn-badge"), "data-state", vpnState);

  const agentOpen = Boolean(agentUiState.open);
  if (typeof document.querySelector === "function") setChromeClass(document.querySelector(".app-container"), "agent-open", agentOpen);
  const attention = document.getElementById("automation-attention");
  if (attention) attention.hidden = !agentUiState.review;
  const filesTab = document.getElementById("automation-files-tab");
  if (filesTab) {
    filesTab.disabled = activeSession?.kind !== "ssh";
    filesTab.title = activeSession?.kind === "ssh" ? "Show files for this server" : "Files are available for SSH sessions";
  }
  if (typeof document.querySelectorAll === "function") {
    document.querySelectorAll(".session-agent-toggle").forEach(button => setChromeAttribute(button, "aria-pressed", String(agentOpen)));
    document.querySelectorAll(".sftp-agent-attention").forEach(dot => { dot.hidden = !agentUiState.review; });
    const agentSession = agentUiState.running && agentUiState.targetSessionId
      ? Object.values(activeSessions).find(session => session.kind === "ssh" && session.connectionId === agentUiState.targetSessionId)
      : null;
    document.querySelectorAll(".terminal-tab").forEach(tab => {
      setChromeClass(tab, "has-agent", Boolean(agentSession) && tab.getAttribute?.("data-id") === agentSession.id);
    });
  }

  updateHostIndicators();
}

function handleAgentPanelLayoutChange() {
  const panel = typeof document.getElementById === "function" ? document.getElementById("automation-panel") : null;
  agentUiState = { ...agentUiState, open: Boolean(panel && panel.hidden === false) };
  refreshPanelLayout();
  Object.values(activeSessions).forEach(session => {
    if (session.kind === "ssh" && session.term && session.container) updateSessionToolbar(session);
  });
  refreshWorkspaceChrome();
}

function toggleAgentPanel() {
  document.getElementById("btn-automation-toggle")?.click();
}

function openAgentPanel() {
  if (!agentUiState.open) toggleAgentPanel();
}

function closeAgentPanel() {
  if (agentUiState.open) toggleAgentPanel();
}

async function refreshDefaultKeyCache() {
  try {
    const keys = await invoke("get_default_ssh_keys");
    defaultSshKeyPath = Array.isArray(keys) && keys.length ? String(keys[0]) : "";
  } catch {
    defaultSshKeyPath = "";
  }
}

function closeOpenMenus(except = null) {
  document.querySelectorAll("details.menu[open]").forEach(menu => {
    if (menu !== except) menu.removeAttribute("open");
  });
}

function initWorkspaceChrome() {
  document.getElementById("rail-settings")?.addEventListener("click", openSettingsTab);
  document.getElementById("btn-quick-connect")?.addEventListener("click", () => openCommandPalette("connect"));
  document.getElementById("btn-command-palette")?.addEventListener("click", () => openCommandPalette("all"));
  document.getElementById("status-palette")?.addEventListener("click", () => openCommandPalette("all"));
  document.getElementById("status-vpn")?.addEventListener("click", () => activateSidebarView("vpn", { keepOpen: true }));
  document.getElementById("automation-files-tab")?.addEventListener("click", () => {
    const session = activeSessions[activeTabId];
    if (session?.kind !== "ssh") return;
    closeAgentPanel();
    if (!session.sftpPanelOpen) session.container.querySelector(".session-files-toggle")?.click();
    session.container.querySelector(".sftp-close")?.focus();
  });

  document.addEventListener("click", event => {
    const menu = event.target?.closest?.("details.menu");
    closeOpenMenus(menu || null);
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    const openMenu = document.querySelector("details.menu[open]");
    if (!openMenu) return;
    openMenu.removeAttribute("open");
    openMenu.querySelector("summary")?.focus();
  });

  initHostFilter();
  refreshDefaultKeyCache();
  document.fonts?.ready?.then(() => {
    Object.values(activeSessions).forEach(session => {
      if (session.term && session.fitAddon) fitTerminal(session);
    });
  });
  refreshWorkspaceChrome();
}

// --- COMMAND PALETTE ---
function openCommandPalette(mode = "all") {
  if (commandPalette) {
    closeOpenMenus();
    commandPalette.open(mode);
    return;
  }
  if (mode === "connect") showQuickConnectModal();
  else showNotification("The command palette could not load. Rebuild SleekSSH with npm run tauri.");
}

function readSavedLocalLocations() {
  try {
    const load = window.SleekSshLocalTerminals?.loadLocations;
    return typeof load === "function" ? load(localStorage) : [];
  } catch {
    return [];
  }
}

function buildCommandPaletteItems() {
  const items = [];
  const activeSession = activeSessions[activeTabId];
  const hostRank = profile => (findSessionsForProfile(profile.id).length ? 0 : 1);
  [...savedProfiles]
    .sort((left, right) => hostRank(left) - hostRank(right) || left.name.localeCompare(right.name))
    .forEach(profile => {
      const session = findSessionsForProfile(profile.id).at(-1);
      const folders = profile.namespace ? profile.namespace.split(NAMESPACE_SEPARATOR).map(segment => segment.trim()).filter(Boolean) : [];
      items.push({
        id: `host:${profile.id}`,
        group: "Hosts",
        title: profile.name,
        subtitle: `${profile.username}@${profile.host}:${profile.port}`,
        detail: folders.join(" / "),
        keywords: [profile.host, profile.username, profile.namespace].filter(Boolean).join(" "),
        icon: "server",
        status: session ? getSessionConnectionState(session) : null,
        hint: session ? "Switch to tab" : "Connect",
        run: ({ ctrlKey }) => (ctrlKey ? connectProfile(profile) : openOrSwitchToProfile(profile))
      });
    });

  items.push({ id: "shell:powershell", group: "Local shells", title: "PowerShell", icon: "terminal", shortcut: ["Ctrl", "Alt", "T"], hint: "Open", run: () => openLocalTerminal("powershell") });
  items.push({ id: "shell:cmd", group: "Local shells", title: "Command Prompt", icon: "terminal", hint: "Open", run: () => openLocalTerminal("cmd") });
  readSavedLocalLocations().forEach(location => {
    items.push({
      id: `location:${location.id}`,
      group: "Local shells",
      title: `PowerShell in ${location.name}`,
      subtitle: location.path,
      keywords: location.path,
      icon: "folder",
      hint: "Open",
      run: () => openLocalTerminal("powershell", location.path, location.name)
    });
  });

  const actions = [];
  if (activeSession?.kind === "ssh" && activeSession.connectionStatus === "disconnected") {
    actions.push({ id: "action:reconnect", title: `Reconnect ${activeSession.name}`, icon: "refresh", run: () => reconnectSshSession(activeSession) });
  }
  if (activeSession?.kind === "ssh") {
    actions.push({ id: "action:agent", title: agentUiState.open ? "Hide the agent" : "Ask the agent to work on this server", detail: "Claude Code or Codex", icon: "agent", run: toggleAgentPanel });
  }
  if (activeSession?.term) {
    actions.push({ id: "action:find", title: "Find in terminal", icon: "search", shortcut: ["Ctrl", "F"], run: () => openTerminalSearch(activeSession) });
  }
  actions.push({ id: "action:new-host", title: "New host", detail: "Save a server to Hosts", icon: "plus", run: () => showProfileModal() });
  actions.push({ id: "action:quick-connect", title: "Quick connect form", detail: "Key file, passphrase or password", icon: "form", keywords: "connect ssh password", run: () => showQuickConnectModal() });
  actions.push({ id: "action:ports", title: "Port Killer", detail: "Find and stop local listeners", icon: "ports", keywords: "ports kill process", run: openPortKillerTab });
  actions.push({ id: "action:keys", title: "SSH keys", detail: "Browse ~/.ssh or generate Ed25519", icon: "key", run: () => activateSidebarView("keys", { keepOpen: true }) });
  if (appSettings.showVpnTab) {
    const vpnName = vpnStatusSnapshot.state === "connected" ? getVpnDisplayName() : null;
    const vpnDetail = vpnStatusSnapshot.state === "connected" ? (vpnName ? `${vpnName} · connected` : "Connected") : "Cisco VPN shortcuts";
    actions.push({ id: "action:vpn", title: "VPN", detail: vpnDetail, icon: "shield", status: vpnStatusSnapshot.state === "connected" ? "connected" : null, run: () => activateSidebarView("vpn", { keepOpen: true }) });
  }
  actions.push({ id: "action:sidebar", title: isSidebarVisible() ? "Hide sidebar" : "Show sidebar", icon: "panel", run: toggleSidebarPanel });
  actions.push({ id: "action:settings", title: "Settings", detail: "Font size, zoom, SSH defaults", icon: "gear", run: openSettingsTab });
  if (activeSession) {
    actions.push({ id: "action:close-tab", title: `Close ${activeSession.name}`, icon: "close", shortcut: ["Ctrl", "W"], run: () => closeTab(activeSession.id) });
  }
  actions.forEach(action => items.push({ group: "Actions", ...action }));
  return items;
}

function buildQuickConnectPaletteItems(target) {
  if (!target) {
    return [{
      id: "connect:form",
      group: "Quick connect",
      title: "Open the connection form",
      subtitle: "Choose a key file, passphrase or password",
      icon: "form",
      run: () => showQuickConnectModal()
    }];
  }
  const username = target.username || appSettings.defaultUser || "";
  const port = target.port || appSettings.defaultPort || 22;
  const prefill = { host: target.host, port, username };
  const keyName = defaultSshKeyPath ? defaultSshKeyPath.split(/[\\/]/).pop() : "";
  const items = [];
  if (username) {
    items.push({
      id: "connect:key",
      group: "Quick connect",
      title: "Connect to",
      code: `${username}@${target.host}:${port}`,
      subtitle: `User ${username} · Port ${port} · ${keyName ? `Key ~/.ssh/${keyName}` : "Key from ~/.ssh"} · Not saved`,
      icon: "bolt",
      shortcut: ["Enter"],
      run: ({ ctrlKey, shiftKey }) => {
        if (ctrlKey) showProfileModal(null, { ...prefill, name: target.host });
        else if (shiftKey) showQuickConnectModal({ ...prefill, usePassword: true });
        else quickConnectWithDefaultKey(prefill);
      }
    });
  } else {
    items.push({
      id: "connect:needs-user",
      group: "Quick connect",
      title: "Connect to",
      code: `${target.host}:${port}`,
      subtitle: "Add a username in the connection form, or set a default user in Settings",
      icon: "bolt",
      shortcut: ["Enter"],
      run: ({ ctrlKey }) => (ctrlKey ? showProfileModal(null, { ...prefill, name: target.host }) : showQuickConnectModal(prefill))
    });
  }
  items.push({
    id: "connect:password",
    group: "Quick connect",
    title: "Connect with a password",
    subtitle: "You are asked for it next. Nothing is saved.",
    icon: "lock",
    shortcut: ["Shift", "Enter"],
    run: () => showQuickConnectModal({ ...prefill, usePassword: true })
  });
  items.push({
    id: "connect:save",
    group: "Quick connect",
    title: "Save as a new host",
    subtitle: "Opens the host form with these details filled in.",
    icon: "plus",
    shortcut: ["Ctrl", "Enter"],
    run: () => showProfileModal(null, { ...prefill, name: target.host })
  });
  return items;
}

async function quickConnectWithDefaultKey({ host, port, username }) {
  if (!defaultSshKeyPath) await refreshDefaultKeyCache();
  if (!defaultSshKeyPath) {
    showNotification("No private key found in ~/.ssh. Choose a key file or use a password.");
    showQuickConnectModal({ host, port, username });
    return;
  }
  connectProfile({
    id: `qc_${Date.now()}`,
    name: host,
    host,
    port,
    username,
    key_path: defaultSshKeyPath,
    passphrase: null,
    password: null,
    use_password: false
  });
}

function initCommandPaletteIntegration() {
  const root = document.getElementById("command-palette");
  if (!root || !window.SleekSshCommandPalette) return;
  commandPalette = window.SleekSshCommandPalette.initCommandPalette({
    root,
    getItems: buildCommandPaletteItems,
    getConnectItems: buildQuickConnectPaletteItems,
    connectNote: "A server you have not trusted yet shows its SHA256 fingerprint before you log in. Compare it with a trusted source, then choose Trust and connect."
  });
}

// --- PORT KILLER ---
let allPorts = [];

function initPortKiller() {
  document.getElementById("rail-port-killer")?.addEventListener("click", openPortKillerTab);
}

function openPortKillerTab() {
  const tabId = "port-killer";

  const existing = document.querySelector(`.terminal-tab[data-id="${tabId}"]`);
  if (existing) {
    switchTab(tabId);
    return;
  }

  welcomeScreen.classList.add("hidden");

  const tabEl = createWorkspaceTab(tabId, "ports", "Port Killer");

  const container = document.createElement("div");
  container.className = "session-container active";
  container.dataset.id = tabId;
  container.innerHTML = `
    <div class="tool-page port-killer-viewport">
      <div class="tool-page-inner">
        <header class="tool-page-header">
          <div>
            <h2>Port Killer</h2>
            <p id="port-killer-count" class="port-killer-count" role="status" aria-live="polite">Local listening ports and the processes that own them.</p>
          </div>
          <div class="tool-page-controls">
            <div class="pane-search">
              <label class="sr-only" for="port-filter">Filter ports</label>
              ${uiIcon("search")}
              <input type="search" id="port-filter" placeholder="Filter by port or process" autocomplete="off" spellcheck="false" />
            </div>
            <button class="btn btn-secondary btn-small" id="btn-refresh-ports" type="button">Refresh</button>
          </div>
        </header>
        <div class="ports-table-header" aria-hidden="true">
          <span>Protocol</span><span>Port</span><span>State</span><span>Process</span><span>PID</span><span></span>
        </div>
        <div id="ports-list" class="ports-table"></div>
      </div>
    </div>
  `;
  workspaceViewport.appendChild(container);

  container.querySelector("#btn-refresh-ports").addEventListener("click", loadPorts);
  container.querySelector("#port-filter").addEventListener("input", renderPorts);

  activeSessions[tabId] = {
    id: tabId,
    kind: "ports",
    name: "Port Killer",
    container,
    isClosed: false
  };

  switchTab(tabId);
  loadPorts();
}

async function loadPorts() {
  const listEl = document.getElementById("ports-list");
  const countEl = document.getElementById("port-killer-count");
  if (!listEl) return;

  listEl.innerHTML = `<div class="empty-state">Scanning ports…</div>`;
  if (countEl) countEl.textContent = "Scanning local ports…";

  try {
    allPorts = await invoke("list_listening_ports");
    renderPorts();
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state">Error: ${escapeHtml(String(e))}</div>`;
  }
}

function renderPorts() {
  const listEl = document.getElementById("ports-list");
  const countEl = document.getElementById("port-killer-count");
  if (!listEl) return;

  const filter = (document.getElementById("port-filter")?.value ?? "").trim().toLowerCase();

  const filtered = allPorts.filter(p => {
    if (!filter) return true;
    return String(p.local_port).includes(filter) ||
           p.process_name.toLowerCase().includes(filter) ||
           p.state.toLowerCase().includes(filter);
  });

  if (countEl) {
    countEl.textContent = filter
      ? `${filtered.length} of ${allPorts.length} port${allPorts.length !== 1 ? "s" : ""} match “${filter}”`
      : `${filtered.length} port${filtered.length !== 1 ? "s" : ""} in use on this machine`;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty-state">${filter ? "No matching ports." : "No ports found."}</div>`;
    return;
  }

  listEl.innerHTML = "";
  filtered.forEach(entry => {
    const row = document.createElement("div");
    row.className = "port-row";

    const stateClass = entry.state.toLowerCase() === "listening" ? " listening" : "";

    row.innerHTML = `
      <span class="port-badge ${escapeHtml(entry.protocol.toLowerCase())}">${escapeHtml(entry.protocol)}</span>
      <span class="port-number">:${entry.local_port}</span>
      <span class="port-state${stateClass}">${escapeHtml(entry.state) || "Unknown"}</span>
      <span class="port-process" title="${escapeHtml(entry.process_name)}">${escapeHtml(entry.process_name)}</span>
      <span class="port-pid">${entry.pid}</span>
      <button class="btn-kill" type="button" aria-label="Kill ${escapeHtml(entry.process_name)} on port ${entry.local_port}">Kill</button>
    `;

    row.querySelector(".btn-kill").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!confirm(`Kill "${entry.process_name}" (PID ${entry.pid}) on port ${entry.local_port}?`)) return;

      btn.disabled = true;
      btn.textContent = "Killing...";

      try {
        await invoke("kill_port_process", { pid: entry.pid });
        await loadPorts();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Kill";
        const errEl = document.createElement("div");
        errEl.className = "port-kill-error";
        errEl.textContent = String(err);
        row.appendChild(errEl);
        setTimeout(() => errEl.remove(), 5000);
      }
    });

    listEl.appendChild(row);
  });
}

function openSettingsTab() {
  const settingsTabId = "settings";
  
  // Check if already open
  const existingTab = document.querySelector(`.terminal-tab[data-id="${settingsTabId}"]`);
  if (existingTab) {
    switchTab(settingsTabId);
    return;
  }
  
  welcomeScreen.classList.add("hidden");
  
  const tabEl = createWorkspaceTab(settingsTabId, "settings", "Settings");
  
  // Create settings container in workspace
  const settingsContainer = document.createElement("div");
  settingsContainer.className = "session-container active";
  settingsContainer.dataset.id = settingsTabId;
  settingsContainer.innerHTML = `
    <div class="tool-page settings-tab-viewport">
      <div class="tool-page-inner settings-page">
        <header class="tool-page-header">
          <div>
            <h2>Settings</h2>
            <p>Changes save and apply right away.</p>
          </div>
        </header>
        <section class="settings-section" aria-labelledby="settings-terminal-heading">
          <h3 class="section-label" id="settings-terminal-heading">Terminal and window</h3>
          <div class="settings-row">
            <div class="settings-row-text">
              <label for="setting-font-size">Terminal font size</label>
              <p>Size of terminal text, in pixels.</p>
            </div>
            <input type="number" id="setting-font-size" min="10" max="30" value="${escapeHtml(String(appSettings.fontSize))}" required />
          </div>
          <div class="settings-row">
            <div class="settings-row-text">
              <label for="setting-zoom-level">Window zoom</label>
              <p>Scales the whole window. Ctrl+Plus and Ctrl+Minus also work.</p>
            </div>
            <select id="setting-zoom-level">
              <option value="0.5">50%</option>
              <option value="0.6">60%</option>
              <option value="0.7">70%</option>
              <option value="0.8">80%</option>
              <option value="0.9">90%</option>
              <option value="1.0">100%</option>
              <option value="1.1">110%</option>
              <option value="1.2">120%</option>
              <option value="1.3">130%</option>
              <option value="1.4">140%</option>
              <option value="1.5">150%</option>
              <option value="1.75">175%</option>
              <option value="2.0">200%</option>
            </select>
          </div>
        </section>
        <section class="settings-section" aria-labelledby="settings-ssh-heading">
          <h3 class="section-label" id="settings-ssh-heading">SSH defaults</h3>
          <div class="settings-row">
            <div class="settings-row-text">
              <label for="setting-default-user">Default username</label>
              <p>Used by quick connect when you type a host without a user.</p>
            </div>
            <input type="text" id="setting-default-user" value="${escapeHtml(appSettings.defaultUser)}" placeholder="root" />
          </div>
          <div class="settings-row">
            <div class="settings-row-text">
              <label for="setting-default-port">Default port</label>
              <p>Used for new hosts and quick connect.</p>
            </div>
            <input type="number" id="setting-default-port" value="${escapeHtml(String(appSettings.defaultPort))}" />
          </div>
        </section>
        <section class="settings-section" aria-labelledby="settings-integrations-heading">
          <h3 class="section-label" id="settings-integrations-heading">Integrations</h3>
          <div class="settings-row switch-group">
            <div class="switch-label-wrapper">
              <label class="switch-title" for="setting-show-vpn">Cisco VPN switcher</label>
              <span class="switch-description">Adds a VPN view to the left rail for Cisco Secure Client or AnyConnect.</span>
            </div>
            <span class="switch">
              <input type="checkbox" id="setting-show-vpn" ${appSettings.showVpnTab ? "checked" : ""} />
              <span class="slider" aria-hidden="true"></span>
            </span>
          </div>
        </section>
      </div>
    </div>
  `;
  workspaceViewport.appendChild(settingsContainer);
  
  // Set current selected values
  settingsContainer.querySelector("#setting-zoom-level").value = appSettings.zoomLevel.toFixed(1);
  
  // Bind input listeners
  settingsContainer.querySelector("#setting-font-size").addEventListener("input", saveSettings);
  settingsContainer.querySelector("#setting-zoom-level").addEventListener("change", saveSettings);
  settingsContainer.querySelector("#setting-default-user").addEventListener("input", saveSettings);
  settingsContainer.querySelector("#setting-default-port").addEventListener("input", saveSettings);
  settingsContainer.querySelector("#setting-show-vpn").addEventListener("change", saveSettings);

  activeSessions[settingsTabId] = {
    id: settingsTabId,
    kind: "settings",
    name: "Settings",
    container: settingsContainer,
    isClosed: false
  };

  switchTab(settingsTabId);
}
