use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::LocalTerminalMap;

const MAX_LOCAL_TERMINAL_SESSION_ID_LENGTH: usize = 128;
const POWERSHELL_START_DIRECTORY_ENV: &str = "SLEEKSSH_START_DIRECTORY";
const POWERSHELL_START_DIRECTORY_COMMAND: &str =
    "Set-Location -LiteralPath $env:SLEEKSSH_START_DIRECTORY -ErrorAction Stop; Remove-Item Env:\\SLEEKSSH_START_DIRECTORY";
#[cfg(test)]
const DEFAULT_TERMINAL_COLUMNS: u16 = 80;
#[cfg(test)]
const DEFAULT_TERMINAL_ROWS: u16 = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalShell {
    PowerShell,
    CommandPrompt,
}

impl LocalShell {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "powershell" => Ok(Self::PowerShell),
            "cmd" => Ok(Self::CommandPrompt),
            _ => Err(format!("Unsupported local shell: {value}")),
        }
    }

    fn executable(self) -> &'static str {
        match self {
            Self::PowerShell => "powershell.exe",
            Self::CommandPrompt => "cmd.exe",
        }
    }

    fn configure(self, command: &mut CommandBuilder) {
        if self == Self::PowerShell {
            command.arg("-NoLogo");
        }
    }
}

#[derive(Serialize, Clone)]
struct LocalTerminalPayload {
    session_id: String,
    data: String,
}

pub(crate) struct LocalTerminal {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    should_exit: Arc<AtomicBool>,
}

impl LocalTerminal {
    fn stop(&mut self) -> Result<(), String> {
        self.should_exit.store(true, Ordering::Relaxed);

        if self
            .child
            .try_wait()
            .map_err(|error| format!("Failed to inspect local shell: {error}"))?
            .is_none()
        {
            self.child
                .kill()
                .map_err(|error| format!("Failed to stop local shell: {error}"))?;
        }

        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn validate_local_terminal_directory(
    working_directory: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_working_directory(Some(&working_directory))?;
        Ok(working_directory)
    })
    .await
    .map_err(|error| format!("Failed to validate local terminal folder: {error}"))?
}

#[tauri::command]
pub(crate) async fn select_local_terminal_directory() -> Result<Option<String>, String> {
    let selected = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose a PowerShell folder")
            .pick_folder()
    })
    .await
    .map_err(|error| format!("Failed to select local terminal folder: {error}"))?;
    selected_local_terminal_directory(selected)
}

fn selected_local_terminal_directory(selected: Option<PathBuf>) -> Result<Option<String>, String> {
    selected
        .map(|path| {
            let path = path
                .into_os_string()
                .into_string()
                .map_err(|_| "Local terminal folder contains unsupported characters".to_string())?;
            resolve_working_directory(Some(&path))?;
            Ok(path)
        })
        .transpose()
}

#[tauri::command]
pub(crate) async fn start_local_terminal(
    app_handle: AppHandle,
    state: State<'_, LocalTerminalMap>,
    session_id: String,
    shell: String,
    working_directory: Option<String>,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    if state.lock().unwrap().contains_key(&session_id) {
        return Err("Local terminal session already exists".to_string());
    }

    let terminal = tauri::async_runtime::spawn_blocking(move || {
        create_local_terminal(
            app_handle,
            session_id,
            &shell,
            working_directory.as_deref(),
            cols,
            rows,
        )
    })
    .await
    .map_err(|error| format!("Local terminal task failed: {error}"))??;

    let (session_id, mut terminal) = terminal;
    let mut terminals = state.lock().unwrap();
    if terminals.contains_key(&session_id) {
        drop(terminals);
        terminal.stop()?;
        return Err("Local terminal session already exists".to_string());
    }

    terminals.insert(session_id, terminal);
    Ok(())
}

fn create_local_terminal(
    app_handle: AppHandle,
    session_id: String,
    shell_name: &str,
    working_directory: Option<&str>,
    cols: u32,
    rows: u32,
) -> Result<(String, LocalTerminal), String> {
    let shell = LocalShell::parse(shell_name)?;
    let size = terminal_size(cols, rows)?;
    let working_directory = resolve_working_directory(working_directory)?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|error| format!("Failed to create local terminal: {error}"))?;

    let command = local_shell_command(shell, working_directory.as_deref());

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Failed to start {}: {error}", shell.executable()))?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to read local terminal: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Failed to write to local terminal: {error}"))?;
    let should_exit = Arc::new(AtomicBool::new(false));

    stream_local_terminal_output(
        app_handle,
        session_id.clone(),
        reader,
        Arc::clone(&should_exit),
    );

    Ok((
        session_id,
        LocalTerminal {
            master: pair.master,
            writer,
            child,
            should_exit,
        },
    ))
}

fn resolve_working_directory(value: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(value) = value else {
        return Ok(None);
    };

    if value.trim().is_empty() {
        return Err("Local terminal folder is required".to_string());
    }
    if value.chars().any(char::is_control) {
        return Err("Local terminal folder contains unsupported control characters".to_string());
    }

    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("Local terminal folder must be an absolute path".to_string());
    }
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("Cannot open local terminal folder {value}: {error}"))?;
    if !metadata.is_dir() {
        return Err(format!("Local terminal location is not a folder: {value}"));
    }

    Ok(Some(path))
}

fn local_shell_command(shell: LocalShell, working_directory: Option<&Path>) -> CommandBuilder {
    let mut command = CommandBuilder::new(shell.executable());
    shell.configure(&mut command);
    command.env("TERM", "xterm-256color");
    let directory = working_directory
        .map(Path::to_path_buf)
        .or_else(dirs::home_dir);
    if let Some(directory) = directory {
        command.cwd(directory);
    }
    if let (LocalShell::PowerShell, Some(directory)) = (shell, working_directory) {
        command.env(POWERSHELL_START_DIRECTORY_ENV, directory);
        // Windows PowerShell can reset a working directory containing wildcard characters.
        command.args(["-NoExit", "-Command", POWERSHELL_START_DIRECTORY_COMMAND]);
    }
    command
}

fn stream_local_terminal_output(
    app_handle: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    should_exit: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    if !should_exit.load(Ordering::Relaxed) {
                        let _ = app_handle.emit(
                            "local-terminal-closed",
                            LocalTerminalPayload {
                                session_id: session_id.clone(),
                                data: "Local shell exited".to_string(),
                            },
                        );
                    }
                    break;
                }
                Ok(bytes_read) => {
                    let data =
                        base64::engine::general_purpose::STANDARD.encode(&buffer[..bytes_read]);
                    let _ = app_handle.emit(
                        "local-terminal-output",
                        LocalTerminalPayload {
                            session_id: session_id.clone(),
                            data,
                        },
                    );
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::UnexpectedEof
                    ) =>
                {
                    if !should_exit.load(Ordering::Relaxed) {
                        let _ = app_handle.emit(
                            "local-terminal-closed",
                            LocalTerminalPayload {
                                session_id: session_id.clone(),
                                data: "Local shell exited".to_string(),
                            },
                        );
                    }
                    break;
                }
                Err(error) => {
                    if !should_exit.load(Ordering::Relaxed) {
                        let _ = app_handle.emit(
                            "local-terminal-error",
                            LocalTerminalPayload {
                                session_id: session_id.clone(),
                                data: error.to_string(),
                            },
                        );
                    }
                    break;
                }
            }
        }
    });
}

#[tauri::command]
pub(crate) fn write_local_terminal(
    state: State<'_, LocalTerminalMap>,
    session_id: String,
    data_base64: String,
) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|error| format!("Failed to decode local terminal input: {error}"))?;
    let mut terminals = state.lock().unwrap();
    let terminal = terminals
        .get_mut(&session_id)
        .ok_or_else(|| "Local terminal not found".to_string())?;

    terminal
        .writer
        .write_all(&data)
        .and_then(|_| terminal.writer.flush())
        .map_err(|error| format!("Failed to write to local terminal: {error}"))
}

#[tauri::command]
pub(crate) fn resize_local_terminal(
    state: State<'_, LocalTerminalMap>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let size = terminal_size(cols, rows)?;
    let terminals = state.lock().unwrap();
    let terminal = terminals
        .get(&session_id)
        .ok_or_else(|| "Local terminal not found".to_string())?;

    terminal
        .master
        .resize(size)
        .map_err(|error| format!("Failed to resize local terminal: {error}"))
}

#[tauri::command]
pub(crate) fn stop_local_terminal(
    state: State<'_, LocalTerminalMap>,
    session_id: String,
) -> Result<(), String> {
    let mut terminal = state
        .lock()
        .unwrap()
        .remove(&session_id)
        .ok_or_else(|| "Local terminal not found".to_string())?;

    terminal.stop()
}

fn terminal_size(cols: u32, rows: u32) -> Result<PtySize, String> {
    let cols = u16::try_from(cols).map_err(|_| "Terminal columns exceed 65535".to_string())?;
    let rows = u16::try_from(rows).map_err(|_| "Terminal rows exceed 65535".to_string())?;

    if cols == 0 || rows == 0 {
        return Err("Terminal dimensions must be greater than zero".to_string());
    }

    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty() {
        return Err("Local terminal session ID is required".to_string());
    }

    if session_id.len() > MAX_LOCAL_TERMINAL_SESSION_ID_LENGTH {
        return Err(format!(
            "Local terminal session ID must be at most {MAX_LOCAL_TERMINAL_SESSION_ID_LENGTH} characters"
        ));
    }

    if !session_id
        .bytes()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, b'_' | b'-'))
    {
        return Err("Local terminal session ID contains unsupported characters".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "sleekssh-local-terminal-{}-{}",
                std::process::id(),
                rand::random::<u64>()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn working_directory_defaults_to_home_when_omitted() {
        assert_eq!(resolve_working_directory(None).unwrap(), None);
        let command = local_shell_command(LocalShell::PowerShell, None);
        assert_eq!(command.get_cwd().map(PathBuf::from), dirs::home_dir());
        assert_eq!(
            command.get_argv(),
            &[
                std::ffi::OsString::from("powershell.exe"),
                std::ffi::OsString::from("-NoLogo")
            ]
        );
        assert!(command.get_env(POWERSHELL_START_DIRECTORY_ENV).is_none());
    }

    #[tokio::test]
    async fn validate_directory_command_returns_existing_folder_and_rejects_invalid_input() {
        let directory = TestDirectory::new();
        let path = directory.0.to_str().unwrap().to_string();
        assert_eq!(
            validate_local_terminal_directory(path.clone())
                .await
                .unwrap(),
            path
        );
        assert!(validate_local_terminal_directory(String::new())
            .await
            .is_err());
        assert!(validate_local_terminal_directory("relative".to_string())
            .await
            .is_err());
    }

    #[test]
    fn folder_selection_preserves_cancellation_and_validates_selected_folder() {
        let directory = TestDirectory::new();
        assert_eq!(selected_local_terminal_directory(None).unwrap(), None);
        assert_eq!(
            selected_local_terminal_directory(Some(directory.0.clone())).unwrap(),
            Some(directory.0.to_str().unwrap().to_string())
        );
        assert!(selected_local_terminal_directory(Some(directory.0.join("missing"))).is_err());
    }

    #[test]
    fn working_directory_accepts_existing_folder_with_shell_metacharacters() {
        let directory = TestDirectory::new();
        let folder = directory.0.join("project [test] & 'quoted' $value; café");
        std::fs::create_dir(&folder).unwrap();

        assert_eq!(
            resolve_working_directory(Some(folder.to_str().unwrap())).unwrap(),
            Some(folder)
        );
    }

    #[test]
    fn working_directory_rejects_empty_relative_and_control_character_paths() {
        for path in [
            "",
            "   ",
            ".",
            "relative/folder",
            "C:\\project\n",
            "C:\\project\0",
        ] {
            assert!(resolve_working_directory(Some(path)).is_err(), "{path:?}");
        }
    }

    #[test]
    fn working_directory_rejects_missing_folders_and_files() {
        let directory = TestDirectory::new();
        let missing = directory.0.join("missing");
        let file = directory.0.join("file.txt");
        std::fs::write(&file, "file").unwrap();

        assert!(resolve_working_directory(Some(missing.to_str().unwrap())).is_err());
        assert!(resolve_working_directory(Some(file.to_str().unwrap())).is_err());
    }

    #[test]
    fn shell_command_sets_directory_without_turning_it_into_shell_arguments() {
        let path = Path::new("C:\\project [test] & 'quoted' $value; café");
        let command = local_shell_command(LocalShell::PowerShell, Some(path));

        assert_eq!(command.get_cwd().unwrap(), path.as_os_str());
        assert_eq!(
            command.get_argv(),
            &[
                std::ffi::OsString::from("powershell.exe"),
                std::ffi::OsString::from("-NoLogo"),
                std::ffi::OsString::from("-NoExit"),
                std::ffi::OsString::from("-Command"),
                std::ffi::OsString::from(POWERSHELL_START_DIRECTORY_COMMAND)
            ]
        );
        assert_eq!(
            command.get_env(POWERSHELL_START_DIRECTORY_ENV).unwrap(),
            path.as_os_str()
        );
    }

    #[test]
    fn shell_command_supports_command_prompt_and_no_directory() {
        let command = local_shell_command(LocalShell::CommandPrompt, None);

        assert_eq!(command.get_cwd().map(PathBuf::from), dirs::home_dir());
        assert_eq!(command.get_argv(), &[std::ffi::OsString::from("cmd.exe")]);
    }

    #[cfg(windows)]
    #[test]
    fn powershell_process_starts_in_folder_with_shell_metacharacters() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        const CAPTURE_COLUMNS: u32 = 512;
        const PROCESS_TIMEOUT: Duration = Duration::from_secs(15);
        const OUTPUT_TIMEOUT: Duration = Duration::from_secs(5);
        const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(20);
        const CURSOR_QUERY: &[u8] = b"\x1b[6n";
        const CURSOR_REPORT: &[u8] = b"\x1b[1;1R";
        const CAPTURE_BUFFER_BYTES: usize = 4096;
        const PROMPT_SUFFIX: &[u8] = b"> ";
        const DIRECTORY_MARKER: &str = "SLEEKSSH_CWD=";
        const CAPTURE_COMMAND: &[u8] =
            b"[Console]::WriteLine('SLEEKSSH_CWD=' + (Get-Location).Path); exit\r";

        let directory = TestDirectory::new();
        let folder = directory.0.join("project [test] & 'quoted' $value");
        std::fs::create_dir(&folder).unwrap();
        let mut command = local_shell_command(LocalShell::PowerShell, Some(&folder));
        command
            .get_argv_mut()
            .insert(1, std::ffi::OsString::from("-NoProfile"));

        let pair = native_pty_system()
            .openpty(terminal_size(CAPTURE_COLUMNS, DEFAULT_TERMINAL_ROWS.into()).unwrap())
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (sender, receiver) = mpsc::channel();
        let reader_thread = std::thread::spawn(move || {
            let result = (|| -> std::io::Result<Vec<u8>> {
                let mut output = Vec::new();
                let mut buffer = [0; CAPTURE_BUFFER_BYTES];
                let mut queries_answered = 0;
                let mut command_sent = false;
                loop {
                    let count = reader.read(&mut buffer)?;
                    if count == 0 {
                        return Ok(output);
                    }
                    output.extend_from_slice(&buffer[..count]);
                    let queries = output
                        .windows(CURSOR_QUERY.len())
                        .filter(|window| *window == CURSOR_QUERY)
                        .count();
                    // ConPTY waits for the terminal's cursor report before PowerShell can proceed.
                    for _ in queries_answered..queries {
                        writer.write_all(CURSOR_REPORT)?;
                        writer.flush()?;
                    }
                    queries_answered = queries;
                    if !command_sent
                        && output
                            .windows(PROMPT_SUFFIX.len())
                            .any(|window| window == PROMPT_SUFFIX)
                    {
                        writer.write_all(CAPTURE_COMMAND)?;
                        writer.flush()?;
                        command_sent = true;
                    }
                }
            })();
            sender.send(result).unwrap();
        });
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let deadline = Instant::now() + PROCESS_TIMEOUT;
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break Some(status);
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                break None;
            }
            std::thread::sleep(PROCESS_POLL_INTERVAL);
        };
        drop(pair.master);
        let output = receiver.recv_timeout(OUTPUT_TIMEOUT).unwrap().unwrap();
        reader_thread.join().unwrap();

        let output = String::from_utf8(output).unwrap();
        assert!(status
            .unwrap_or_else(|| panic!("PowerShell exceeded its timeout: {output:?}"))
            .success());
        let marker = output
            .rfind(DIRECTORY_MARKER)
            .unwrap_or_else(|| panic!("PowerShell did not report its directory: {output:?}"));
        let reported_directory = output[marker + DIRECTORY_MARKER.len()..]
            .split(['\r', '\n', '\x1b'])
            .next()
            .unwrap();
        assert_eq!(
            std::fs::canonicalize(reported_directory).unwrap(),
            std::fs::canonicalize(&folder).unwrap(),
            "PowerShell reported an unexpected directory: {output:?}"
        );
    }

    #[test]
    fn local_shell_parse_accepts_supported_shells() {
        assert_eq!(LocalShell::parse("powershell"), Ok(LocalShell::PowerShell));
        assert_eq!(LocalShell::parse("cmd"), Ok(LocalShell::CommandPrompt));
    }

    #[test]
    fn local_shell_parse_rejects_empty_and_unknown_shells() {
        assert!(LocalShell::parse("").is_err());
        assert!(LocalShell::parse("bash").is_err());
    }

    #[test]
    fn terminal_size_accepts_default_and_maximum_dimensions() {
        assert_eq!(
            terminal_size(
                u32::from(DEFAULT_TERMINAL_COLUMNS),
                u32::from(DEFAULT_TERMINAL_ROWS)
            )
            .unwrap(),
            PtySize {
                cols: DEFAULT_TERMINAL_COLUMNS,
                rows: DEFAULT_TERMINAL_ROWS,
                pixel_width: 0,
                pixel_height: 0,
            }
        );
        assert_eq!(
            terminal_size(u16::MAX.into(), u16::MAX.into())
                .unwrap()
                .cols,
            u16::MAX
        );
    }

    #[test]
    fn terminal_size_rejects_zero_and_overflow_dimensions() {
        assert!(terminal_size(0, u32::from(DEFAULT_TERMINAL_ROWS)).is_err());
        assert!(terminal_size(u32::from(DEFAULT_TERMINAL_COLUMNS), 0).is_err());
        assert!(terminal_size(u32::from(u16::MAX) + 1, 1).is_err());
        assert!(terminal_size(1, u32::from(u16::MAX) + 1).is_err());
    }

    #[test]
    fn session_id_validation_accepts_generated_and_maximum_length_ids() {
        assert!(validate_session_id("local_powershell_1234567890").is_ok());
        assert!(validate_session_id(&"a".repeat(MAX_LOCAL_TERMINAL_SESSION_ID_LENGTH)).is_ok());
    }

    #[test]
    fn session_id_validation_rejects_empty_oversized_and_unsafe_ids() {
        assert!(validate_session_id("").is_err());
        assert!(
            validate_session_id(&"a".repeat(MAX_LOCAL_TERMINAL_SESSION_ID_LENGTH + 1)).is_err()
        );
        assert!(validate_session_id("local terminal").is_err());
        assert!(validate_session_id("local/terminal").is_err());
    }
}
