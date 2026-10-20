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
