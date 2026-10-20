# SleekSSH & VPN Terminal Utility

A lightweight, modern desktop application combining a full-featured SSH terminal client, SFTP file browser, and Cisco VPN profile manager. Built with Tauri, Rust, and xterm.js.

![App Icon](src/assets/sleekssh-icon.png)

## Features

### 🖥️ SSH Terminal
- **xterm.js Integration:** Full terminal emulation supporting standard ANSI escapes, colors, and keybindings.
- **Responsive Layout:** Automatically handles terminal resizing (`resize_ssh`) on window size changes.
- **Session Management:** Securely store and load connections using Windows DPAPI encryption.

### 📁 SFTP File Manager
- **Remote Operations:** Browse remote directories, list files, and view metadata.
- **File Actions:** Download, upload, delete files/directories, and create folders directly from the interface.
- **File Dialogs:** Native file picker integration via Tauri for uploads and download destinations.

### 🔒 SSH Key Management
- **Key Generation:** Generate new secure SSH keypairs directly within the app.
- **Auto-Discovery:** Automatically scans default paths (`~/.ssh`) to list existing private keys.
- **Import Key:** Easily select custom private key files using native dialogs.

### 🌐 Cisco VPN Integration
- **Profile Swapper:** Detects and lists installed Cisco AnyConnect profiles on the host machine.
- **One-Click Switch:** Switch VPN profiles or disconnect from the UI, with automatic CLI tracking.
- **Status Monitoring:** Tracks VPN connection state and manages credentials securely.

### Local Claude/Codex automation

Connect to an SSH server, select its terminal tab, and open **Automation**. Choose **Claude Code** or **Codex**, enter a task, and select **Run task**. Review each proposed command and choose **Approve once** or **Deny**. Output and results appear in the panel.

Agent responses render Markdown headings, lists, tables, links, and code blocks. Remote command output stays literal and monospaced. Web and email links open in their default application; embedded HTML is shown as text and images are not fetched.

Choose a saved conversation from **Local chat**, or select **New chat** to start fresh. The list follows the selected provider and shows available titles, project paths, and update times, newest first. **Refresh chats** reloads local metadata; **Advanced** retains manual UUID entry when needed. SleekSSH records the CLI's returned ID and automatically resumes it for later tasks on the same server and provider. **New chat** clears that association without deleting CLI history. Use an idle saved chat rather than a conversation currently running in another terminal. The app uses `claude --print --resume <UUID>` or `codex exec ... resume <UUID> -`, with the SSH bridge and command approvals supplied again on every invocation.

Chat discovery reads local metadata from `CLAUDE_CONFIG_DIR` (default `~/.claude`) or `CODEX_HOME` (default `~/.codex`). It does not start the CLI, call a model, or load full conversations. Results are limited to 200 chats, with a notice when discovery is partial. A saved conversation that is absent from the latest listing stays selectable by its ID.

The native CLI runs locally with its configured authentication; SleekSSH adds no OAuth sign-in. Install and configure Claude Code or Codex before starting SleekSSH; use **Refresh** after installation, or restart the app if PATH changed. This integration was verified with Claude Code 2.1.268 and Codex CLI 0.154.0. Older versions that lack the isolation flags need updating. Conversation history is retained by the CLI; SleekSSH stores only conversation IDs per server/provider and uses a stable local application-data workspace.

Automation uses the selected connection's existing authenticated SSH session through a local, per-run authenticated MCP bridge. The target stays fixed when tabs change. Disconnecting or reconnecting ends that run; start a new task for the new connection. Neither CLI needs installing on the server, and SSH credentials are not passed to the CLI.

Elevated commands are marked **[sudo]** in command approval. The first time a saved password is needed, choose **Allow for this run** or **Deny**. Allowing reuses the separate saved sudo password configured for the connection's F2 shortcut; enable that setting and reconnect before starting automation. Later password requests in the same run are handled automatically, while each command still needs approval. Passwordless or cached sudo does not load the saved password. Consent ends with the run or Stop, and missing, changed, or rejected credentials require correcting the profile and starting a new run. Passwords stay inside the native app and are never included in agent input, logs, or tool results. Sudo authentication that requires an interactive terminal or additional factors is not supported.

Commands run in separate noninteractive remote shells, so use explicit `cd` commands where needed. Commands have a 120-second limit and bounded output; command approval requests expire after five minutes, saved-password consent expires after 90 seconds, and runs stop after twenty minutes. One automation run can be active at a time. **Stop** terminates the local agent and closes its remote command channel; detached remote processes may continue.

---

## Technology Stack

- **Frontend:** HTML5, Vanilla CSS, Vanilla JavaScript
- **Terminal Emulator:** [xterm.js](https://xtermjs.org/) (with Fit Addon)
- **Framework:** [Tauri v2](https://v2.tauri.app/) (Desktop Application Framework)
- **Backend:** Rust (async handling using `tokio`, SSH connection via `ssh2`, DPAPI encryption, and system command interfaces)

---

## Development & Setup

### Prerequisites

To build and run this application locally, you will need:
1. **Node.js** (v22.18 or higher for the TypeScript test runner)
2. **Rust & Cargo** (latest stable release)
3. **Tauri Prerequisites** (System dependencies depending on your platform; see the [Tauri Getting Started Guide](https://v2.tauri.app/start/prerequisites/))

### Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/thechandanbhagat/terminal-utility.git
   cd terminal-utility
   ```

2. Install npm dependencies:
   ```bash
   npm install
   ```

### Running the App

Start the Tauri development server:
```bash
npm run tauri dev
```

The npm command compiles the automation TypeScript module before launching Tauri. Use it instead of invoking the Tauri binary directly. Generated files under `src/generated/` are ignored by Git.

### Building the Production App

To package the application for production:
```bash
npm run tauri build
```

### Tests

```bash
npm test
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

---

## License

This project is private/licensed for personal use. See the workspace configurations for details.
