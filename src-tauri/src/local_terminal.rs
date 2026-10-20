use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::LocalTerminalMap;

const MAX_LOCAL_TERMINAL_SESSION_ID_LENGTH: usize = 128;
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
pub(crate) async fn start_local_terminal(
    app_handle: AppHandle,
    state: State<'_, LocalTerminalMap>,
    session_id: String,
    shell: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    if state.lock().unwrap().contains_key(&session_id) {
        return Err("Local terminal session already exists".to_string());
    }

    let terminal = tauri::async_runtime::spawn_blocking(move || {
        create_local_terminal(app_handle, session_id, &shell, cols, rows)
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
    cols: u32,
    rows: u32,
) -> Result<(String, LocalTerminal), String> {
    let shell = LocalShell::parse(shell_name)?;
    let size = terminal_size(cols, rows)?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|error| format!("Failed to create local terminal: {error}"))?;

    let mut command = CommandBuilder::new(shell.executable());
    shell.configure(&mut command);
    command.env("TERM", "xterm-256color");

    if let Some(home_directory) = dirs::home_dir() {
        command.cwd(home_directory);
    }

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
