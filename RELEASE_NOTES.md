# SleekSSH v0.4.0

Unreleased. Documentation reviewed 2 November 2026; repository maintainers review these notes before publication.

## What's new

- **Split terminals:** Open two independent SSH or local terminals in a tab with **Split right** or **Split below**. Resize the divider, switch focus with **Ctrl+Alt+Arrow**, and close one pane with **Ctrl+Alt+W**. Files, History, snippets, and new Agent tasks follow the focused pane.
- **Command history and suggestions:** Search terminal and executed Agent commands with run counts. History persists per server or local shell. Faint inline suggestions accept **Tab** and dismiss with **Esc**; a leading space excludes a command from history. Password responses and recognized inline credentials are excluded.
- **Named snippets:** Save commands as reusable templates with `{{parameters}}`. Review the rendered command, target pane, and shell before inserting or running it. Snippets can be shared or limited to an SSH server and folder, including subfolders. Preview expiry prevents a changed target or prompt from reusing an earlier review.
- **Saved workspaces:** Save and reopen terminal tabs, launch folders, remote folders, split direction and size, active pane, and panel layout. Reopening appends fresh sessions and reports missing hosts or connection failures individually. Workspaces reference saved hosts without storing their credentials.
- **Remote folders and SSH palette:** Save named remote folders and an optional starting folder per host. Use **Ctrl+Shift+K** to find the active server's folders and snippets; **Ctrl+Shift+P** continues to open the global palette.
- **Agent follow-ups:** Queue up to 20 prompts per SSH chat, reorder them, and pause or resume the queue. **Enter** runs or queues a prompt, **Shift+Enter** inserts a newline, and **Ctrl+Enter** stops the current task and continues its chat with a steering instruction once a conversation ID is available. Failures, Stop, and connection changes pause queued work.
- **Independent Agent sessions:** Keep drafts, approvals, transcripts, and Stop controls with their owning SSH session. Different sessions can run concurrently, while a local chat stays attached to one session. Recent messages from existing Claude Code and Codex chats load from local CLI history; displayed transcripts are saved locally with bounded size.

## Fixes

- **Large SSH setup scripts:** Terminal initialization sends bounded UTF-8 chunks so canonical terminal input limits cannot truncate shell history integration or the sudo wrapper.
- **Accurate Agent history:** Commands enter shared history only after remote execution starts, and command results retain their execution identifiers.
- **Session targeting:** Tab and pane changes preserve the target of running Agent tasks and invalidate stale snippet previews.

## Upgrade and requirements

This version is prepared for review; v0.4.0 installers have not been published. Build from source using the [development instructions](README.md#development). Published v0.3.0 downloads remain linked below.

Saved hosts and encrypted credentials continue to use the existing application data. History, snippets, remote folder shortcuts, and workspaces are stored locally. Older single-pane saved workspaces remain readable; updating their format preserves a version 1 backup. Workspaces start fresh terminals without resuming remote processes or Agent tasks.

Claude Code or Codex still requires a locally installed, authenticated CLI. Every remote command requires approval, and saved sudo-password use requires separate consent for the run. Existing command, run, and approval time limits remain unchanged.

---

# SleekSSH v0.3.0

Released 27 October 2026.

## What's new

- **Command palette:** Press **Ctrl+Shift+P** or use the title-bar search to find hosts, local shells, and tools. Type `user@host` or `user@host:port` to start a quick connection; **Ctrl+Alt+N** opens quick connect mode.
- **Saved PowerShell folders:** Save a named folder under **Local shells → Saved locations**, then open PowerShell there with one click. Browse, edit, or remove shortcuts; saved folders survive app restarts. Paths containing spaces, brackets, apostrophes, and shell metacharacters open literally.
- **Refreshed workspace:** A compact activity rail, searchable host list, session controls, and a status bar make navigation and connection state easier to scan. Selecting an already-open host switches to its tab; **Ctrl+click** opens another session.
- **Bundled fonts:** Geist and JetBrains Mono ship with the app, so the interface does not need to fetch its fonts from Google Fonts.
- **Agent conversation view:** Tasks, agent responses, and command results appear as a conversation. Expand or collapse command output, see exit status, and review approval and run-state markers. **Ctrl+Enter** submits a task. Pending command and sudo approvals show their remaining time, and session tabs and the status bar signal when review is needed.

## Fixes

- **Reliable Cargo builds:** `cargo tauri build` now typechecks and compiles all frontend modules before packaging. This fixes the installed app reporting that the command palette could not load because its generated JavaScript was absent. Development launches also wait for frontend compilation, and the npm wrapper avoids compiling twice.
- **Literal PowerShell startup folders:** Saved locations are validated as existing absolute directories and passed as data, with a literal-path startup command to handle Windows PowerShell's special-character directory behavior.
- **Command result cards:** Command output stays with its result card when approval updates or streamed agent responses arrive in between, preserving running and exit-state feedback.

## Upgrade and requirements

Close SleekSSH before installing either Windows x64 installer, then reopen it. Saved hosts, credentials, and layout preferences continue to use the existing application data. This release introduces no storage migration.

Claude Code and Codex still require a locally installed, authenticated CLI. Each remote command requires approval; saved sudo-password use requires separate consent for the run. Existing execution and approval time limits are unchanged.

## Windows x64 downloads

- MSI installer: `SleekSSH_0.3.0_x64_en-US.msi`
- EXE installer: `SleekSSH_0.3.0_x64-setup.exe`
- SHA-256 checksums: `SHA256SUMS.txt`

Download installers from the [v0.3.0 release](https://github.com/thechandanbhagat/sleek-ssh/releases/tag/v0.3.0).

[Full changelog: v0.2.0...v0.3.0](https://github.com/thechandanbhagat/sleek-ssh/compare/v0.2.0...v0.3.0).

---

# SleekSSH v0.2.0

Released 20 October 2026.

## What's new

- **Native Windows terminals:** Open PowerShell or Command Prompt inside SleekSSH. While the app is running, **Ctrl+Alt+T** brings it forward and opens PowerShell. SleekSSH registers itself to launch at Windows startup.
- **Workspace improvements:** Distinct tabs for SSH, local terminals, settings, and ports; terminal copy/paste, search, and context menus; resizable sidebar and SFTP panes with saved layout preferences; and nested saved-connection folders with remembered collapse state.
- **SSH trust and reconnect:** Review server key fingerprints before trusting a new host. Changed host keys block connections and show the saved and presented fingerprints. Reconnect disconnected sessions from their terminal toolbar.
- **Saved sudo shortcut:** Store a separate sudo password encrypted with Windows DPAPI. Enable the shortcut in the connection profile, reconnect, and press **F2 three times within two seconds** at a recognized standard Bash/Zsh sudo password prompt.
- **Local Claude Code and Codex automation:** Run tasks against the selected SSH connection through your locally installed CLI. Approve or deny each proposed remote command, browse and resume saved local chats, and read agent responses formatted as Markdown.
- **Sudo consent for automation:** Elevated commands are identified during approval. Choose **Allow for this run** to use the connection's enabled saved sudo password when required; each command still needs approval. Passwords remain inside the native app and are excluded from agent input, logs, and tool results.

## Setup and limits

Install and authenticate Claude Code or Codex locally before using automation. Refresh CLI detection after installation, or restart SleekSSH after PATH changes. The CLI runs locally; the remote server needs no agent installation.

Automation runs one task at a time against a fixed SSH connection. Commands use separate noninteractive shells, have a 120-second limit, and return bounded output. Runs stop after twenty minutes. Disconnecting or reconnecting ends the run. **Stop** terminates the local agent and closes its remote command channel; detached remote processes may continue. Sudo flows requiring an interactive terminal or additional authentication factors are unsupported in automation.

## Windows x64 downloads

- MSI installer: `SleekSSH_0.2.0_x64_en-US.msi`
- EXE installer: `SleekSSH_0.2.0_x64-setup.exe`

Download installers from the [v0.2.0 release](https://github.com/thechandanbhagat/sleek-ssh/releases/tag/v0.2.0).
