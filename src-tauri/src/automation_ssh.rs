use serde::Serialize;
use ssh2::{Channel, ErrorCode, Session};
use std::io::{self, ErrorKind, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[path = "automation_sudo.rs"]
mod sudo;

pub(crate) use sudo::execute_sudo;

const MAX_COMMAND_BYTES: usize = 16 * 1024;
const MAX_OUTPUT_BYTES: usize = 128 * 1024;
const READ_BUFFER_BYTES: usize = 8 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const CHANNEL_CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
const RETRY_INTERVAL: Duration = Duration::from_millis(5);
const SSH_ERROR_TIMEOUT: i32 = -9;
const SSH_ERROR_SOCKET_TIMEOUT: i32 = -30;
const SSH_ERROR_EAGAIN: i32 = -37;

#[derive(Debug, Serialize)]
pub(crate) struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub truncated: bool,
}

struct RunControl<'a> {
    disconnected: &'a AtomicBool,
    cancelled: &'a AtomicBool,
    deadline: Instant,
}

impl RunControl<'_> {
    fn check(&self) -> Result<(), String> {
        if self.disconnected.load(Ordering::Relaxed) {
            return Err("SSH connection disconnected during automation".to_string());
        }
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(
                "Remote command cancelled; detached processes may continue running".to_string(),
            );
        }
        if Instant::now() >= self.deadline {
            return Err(
                "Remote command timed out; detached processes may continue running".to_string(),
            );
        }
        Ok(())
    }
}

pub(crate) fn execute(
    session: &Arc<Mutex<Session>>,
    disconnected: &AtomicBool,
    cancelled: &AtomicBool,
    command: &str,
) -> Result<CommandOutput, String> {
    validate_command(command)?;
    let control = RunControl {
        disconnected,
        cancelled,
        deadline: Instant::now() + COMMAND_TIMEOUT,
    };
    let mut channel = retry_ssh(&control, "open automation channel", || {
        with_session(session, &control, Session::channel_session)
    })?;
    let result = execute_channel(session, &mut channel, &control, command);
    let close_result = close_channel(session, &mut channel);

    // ssh2 frees channels without its internal session lock, so serialize the final drop too.
    let drop_result = match session.lock() {
        Ok(_guard) => {
            drop(channel);
            Ok(())
        }
        Err(poisoned) => {
            let _guard = poisoned.into_inner();
            drop(channel);
            Err("SSH session lock failed while releasing automation channel".to_string())
        }
    };
    match (result, close_result, drop_result) {
        (Ok(output), Ok(()), Ok(())) => Ok(output),
        (Err(error), Ok(()), Ok(())) => Err(error),
        (result, close_result, drop_result) => {
            let errors = [result.err(), close_result.err(), drop_result.err()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            Err(errors.join("; "))
        }
    }
}

fn validate_command(command: &str) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("Remote command must not be empty".to_string());
    }
    if command.contains('\0') {
        return Err("Remote command must not contain a NUL byte".to_string());
    }
    if command.len() > MAX_COMMAND_BYTES {
        return Err(format!(
            "Remote command exceeds the {MAX_COMMAND_BYTES}-byte limit"
        ));
    }
    Ok(())
}

fn with_session<T>(
    session: &Arc<Mutex<Session>>,
    control: &RunControl<'_>,
    operation: impl FnOnce(&Session) -> T,
) -> Result<T, String> {
    control.check()?;
    // Queuing for the mutex avoids starvation behind the terminal's repeated 50ms reads.
    let guard = session
        .lock()
        .map_err(|_| "SSH session lock failed".to_string())?;
    control.check()?;
    Ok(operation(&guard))
}

fn retry_ssh<T>(
    control: &RunControl<'_>,
    operation_name: &str,
    mut operation: impl FnMut() -> Result<Result<T, ssh2::Error>, String>,
) -> Result<T, String> {
    loop {
        control.check()?;
        match operation()? {
            Ok(value) => return Ok(value),
            Err(error) if retryable_ssh_error(&error) => std::thread::sleep(RETRY_INTERVAL),
            Err(error) => return Err(format!("Failed to {operation_name}: {error}")),
        }
    }
}

fn retryable_ssh_error(error: &ssh2::Error) -> bool {
    matches!(
        error.code(),
        ErrorCode::Session(SSH_ERROR_TIMEOUT | SSH_ERROR_SOCKET_TIMEOUT | SSH_ERROR_EAGAIN)
    )
}

fn execute_channel(
    session: &Arc<Mutex<Session>>,
    channel: &mut Channel,
    control: &RunControl<'_>,
    command: &str,
) -> Result<CommandOutput, String> {
    retry_ssh(control, "start remote command", || {
        with_session(session, control, |_| channel.exec(command))
    })?;
    retry_ssh(control, "close remote command input", || {
        with_session(session, control, |_| channel.send_eof())
    })?;

    let mut stdout = channel.stream(0);
    let mut stderr = channel.stderr();
    let (stdout, stderr, truncated) = collect_output(
        control,
        |stream, buffer| {
            with_session(session, control, |_| match stream {
                OutputStream::Stdout => stdout.read(buffer),
                OutputStream::Stderr => stderr.read(buffer),
            })
        },
        || with_session(session, control, |_| channel.eof()),
    )?;
    retry_ssh(control, "wait for remote command exit", || {
        with_session(session, control, |_| channel.wait_close())
    })?;
    let exit_code = retry_ssh(control, "read remote command exit status", || {
        with_session(session, control, |_| channel.exit_status())
    })?;
    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code,
        truncated,
    })
}

#[derive(Clone, Copy)]
enum OutputStream {
    Stdout,
    Stderr,
}

fn collect_output(
    control: &RunControl<'_>,
    mut read: impl FnMut(OutputStream, &mut [u8]) -> Result<io::Result<usize>, String>,
    mut eof: impl FnMut() -> Result<bool, String>,
) -> Result<(Vec<u8>, Vec<u8>, bool), String> {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut truncated = false;
    let mut buffer = [0_u8; READ_BUFFER_BYTES];
    loop {
        control.check()?;
        let mut progressed = false;
        for stream in [OutputStream::Stdout, OutputStream::Stderr] {
            control.check()?;
            match read(stream, &mut buffer)? {
                Ok(count) => {
                    progressed |= count > 0;
                    let available = MAX_OUTPUT_BYTES.saturating_sub(stdout.len() + stderr.len());
                    let retained = count.min(available);
                    truncated |= retained < count;
                    match stream {
                        OutputStream::Stdout => stdout.extend_from_slice(&buffer[..retained]),
                        OutputStream::Stderr => stderr.extend_from_slice(&buffer[..retained]),
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(format!("Failed to read remote command output: {error}")),
            }
        }
        if eof()? {
            return Ok((stdout, stderr, truncated));
        }
        if !progressed {
            std::thread::sleep(RETRY_INTERVAL);
        }
    }
}

fn close_channel(session: &Arc<Mutex<Session>>, channel: &mut Channel) -> Result<(), String> {
    let cleanup_flag = AtomicBool::new(false);
    let cleanup_control = RunControl {
        disconnected: &cleanup_flag,
        cancelled: &cleanup_flag,
        deadline: Instant::now() + CHANNEL_CLOSE_TIMEOUT,
    };
    retry_ssh(&cleanup_control, "close automation channel", || {
        with_session(session, &cleanup_control, |_| channel.close())
    })
    .map_err(|error| format!("Automation channel cleanup failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn session() -> Arc<Mutex<Session>> {
        Arc::new(Mutex::new(Session::new().unwrap()))
    }

    #[test]
    fn execute_rejects_empty_and_nul_commands_before_ssh_access() {
        let session = session();
        let flag = AtomicBool::new(false);
        for command in ["", " \r\n\t", "echo\0invalid"] {
            assert!(execute(&session, &flag, &flag, command).is_err());
        }
    }

    #[test]
    fn command_byte_limit_has_explicit_boundaries() {
        assert!(validate_command(&"x".repeat(MAX_COMMAND_BYTES)).is_ok());
        assert!(validate_command(&"x".repeat(MAX_COMMAND_BYTES + 1)).is_err());
        assert!(validate_command(&"é".repeat(MAX_COMMAND_BYTES / 2)).is_ok());
        assert!(validate_command(&"é".repeat(MAX_COMMAND_BYTES / 2 + 1)).is_err());
        let flag = AtomicBool::new(false);
        assert!(
            execute(&session(), &flag, &flag, &"x".repeat(MAX_COMMAND_BYTES + 1))
                .unwrap_err()
                .contains("limit")
        );
    }

    #[test]
    fn execute_stops_before_channel_creation_when_disconnected_or_cancelled() {
        let session = session();
        let clear = AtomicBool::new(false);
        let set = AtomicBool::new(true);
        assert!(execute(&session, &set, &clear, "pwd")
            .unwrap_err()
            .contains("disconnected"));
        assert!(execute(&session, &clear, &set, "pwd")
            .unwrap_err()
            .contains("cancelled"));
    }

    #[test]
    fn collection_drains_both_streams_after_empty_reads_and_transient_failures() {
        let flag = AtomicBool::new(false);
        let control = RunControl {
            disconnected: &flag,
            cancelled: &flag,
            deadline: Instant::now() + COMMAND_TIMEOUT,
        };
        let mut stdout = VecDeque::from([
            Ok(Vec::new()),
            Err(ErrorKind::TimedOut),
            Ok(b"out".to_vec()),
            Ok(b"put".to_vec()),
        ]);
        let mut stderr = VecDeque::from([
            Err(ErrorKind::WouldBlock),
            Ok(b"error".to_vec()),
            Err(ErrorKind::Interrupted),
            Ok(Vec::new()),
        ]);
        let mut polls = 0;
        let (out, err, truncated) = collect_output(
            &control,
            |stream, buffer| {
                let next = match stream {
                    OutputStream::Stdout => stdout.pop_front(),
                    OutputStream::Stderr => stderr.pop_front(),
                }
                .unwrap();
                Ok(next
                    .map(|bytes| {
                        buffer[..bytes.len()].copy_from_slice(&bytes);
                        bytes.len()
                    })
                    .map_err(io::Error::from))
            },
            || {
                polls += 1;
                Ok(polls == 4)
            },
        )
        .unwrap();
        assert_eq!(out, b"output");
        assert_eq!(err, b"error");
        assert!(!truncated);
    }

    #[test]
    fn output_limit_is_combined_and_keeps_draining_after_truncation() {
        let flag = AtomicBool::new(false);
        let control = RunControl {
            disconnected: &flag,
            cancelled: &flag,
            deadline: Instant::now() + COMMAND_TIMEOUT,
        };
        let mut polls = 0;
        let iterations = MAX_OUTPUT_BYTES / READ_BUFFER_BYTES + 1;
        let (out, err, truncated) = collect_output(
            &control,
            |_, buffer| {
                buffer.fill(b'x');
                Ok(Ok(buffer.len()))
            },
            || {
                polls += 1;
                Ok(polls == iterations)
            },
        )
        .unwrap();
        assert_eq!(out.len() + err.len(), MAX_OUTPUT_BYTES);
        assert!(truncated);
        assert_eq!(polls, iterations);
    }

    #[test]
    fn output_at_exact_combined_limit_is_not_truncated() {
        let flag = AtomicBool::new(false);
        let control = RunControl {
            disconnected: &flag,
            cancelled: &flag,
            deadline: Instant::now() + COMMAND_TIMEOUT,
        };
        let mut polls = 0;
        let iterations = MAX_OUTPUT_BYTES / (READ_BUFFER_BYTES * 2);
        let (out, err, truncated) = collect_output(
            &control,
            |_, buffer| {
                buffer.fill(b'x');
                Ok(Ok(buffer.len()))
            },
            || {
                polls += 1;
                Ok(polls == iterations)
            },
        )
        .unwrap();
        assert_eq!(out.len() + err.len(), MAX_OUTPUT_BYTES);
        assert!(!truncated);
    }

    #[test]
    fn collection_accepts_empty_output_without_truncation() {
        let flag = AtomicBool::new(false);
        let control = RunControl {
            disconnected: &flag,
            cancelled: &flag,
            deadline: Instant::now() + COMMAND_TIMEOUT,
        };
        let (out, err, truncated) =
            collect_output(&control, |_, _| Ok(Ok(0)), || Ok(true)).unwrap();
        assert!(out.is_empty());
        assert!(err.is_empty());
        assert!(!truncated);
    }

    #[test]
    fn collection_fails_on_timeout_and_permanent_read_error() {
        let flag = AtomicBool::new(false);
        let mut control = RunControl {
            disconnected: &flag,
            cancelled: &flag,
            deadline: Instant::now(),
        };
        let timed_out = collect_output(
            &control,
            |_, _| panic!("expired runs must not read"),
            || panic!("expired runs must not inspect EOF"),
        )
        .unwrap_err();
        assert!(timed_out.contains("timed out"));
        control.deadline = Instant::now() + COMMAND_TIMEOUT;
        let error = collect_output(
            &control,
            |_, _| Ok(Err(io::Error::from(ErrorKind::ConnectionReset))),
            || Ok(false),
        )
        .unwrap_err();
        assert!(error.contains("Failed to read"));
    }

    #[test]
    fn collection_observes_cancellation_between_stream_reads() {
        let disconnected = AtomicBool::new(false);
        let cancelled = AtomicBool::new(false);
        let control = RunControl {
            disconnected: &disconnected,
            cancelled: &cancelled,
            deadline: Instant::now() + COMMAND_TIMEOUT,
        };
        let mut reads = 0;
        let error = collect_output(
            &control,
            |_, _| {
                reads += 1;
                cancelled.store(true, Ordering::Relaxed);
                Ok(Ok(0))
            },
            || Ok(false),
        )
        .unwrap_err();
        assert!(error.contains("cancelled"));
        assert_eq!(reads, 1);
    }

    #[test]
    fn retry_recognizes_only_transient_ssh_codes() {
        for code in [
            SSH_ERROR_TIMEOUT,
            SSH_ERROR_SOCKET_TIMEOUT,
            SSH_ERROR_EAGAIN,
        ] {
            assert!(retryable_ssh_error(&ssh2::Error::from_errno(
                ErrorCode::Session(code)
            )));
        }
        assert!(!retryable_ssh_error(&ssh2::Error::from_errno(
            ErrorCode::Session(-1)
        )));
        assert!(!retryable_ssh_error(&ssh2::Error::from_errno(
            ErrorCode::SFTP(SSH_ERROR_EAGAIN)
        )));
    }

    #[test]
    fn retries_timeout_and_eagain_then_returns_value() {
        let flag = AtomicBool::new(false);
        let control = RunControl {
            disconnected: &flag,
            cancelled: &flag,
            deadline: Instant::now() + COMMAND_TIMEOUT,
        };
        let mut attempts = 0;
        let result = retry_ssh(&control, "test operation", || {
            attempts += 1;
            Ok(match attempts {
                1 => Err(ssh2::Error::from_errno(ErrorCode::Session(
                    SSH_ERROR_EAGAIN,
                ))),
                2 => Err(ssh2::Error::from_errno(ErrorCode::Session(
                    SSH_ERROR_TIMEOUT,
                ))),
                _ => Ok(42),
            })
        })
        .unwrap();
        assert_eq!(result, 42);
        assert_eq!(attempts, 3);
    }

    #[test]
    fn permanent_ssh_failures_include_operation_context_without_retrying() {
        let flag = AtomicBool::new(false);
        let control = RunControl {
            disconnected: &flag,
            cancelled: &flag,
            deadline: Instant::now() + COMMAND_TIMEOUT,
        };
        let mut attempts = 0;
        let result = retry_ssh::<()>(&control, "open automation channel", || {
            attempts += 1;
            Ok(Err(ssh2::Error::from_errno(ErrorCode::Session(-1))))
        });
        assert!(result.unwrap_err().contains("open automation channel"));
        assert_eq!(attempts, 1);
    }

    #[test]
    fn session_lock_wait_checks_deadline() {
        let session = session();
        let thread_session = Arc::clone(&session);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _guard = thread_session.lock().unwrap();
            ready_tx.send(()).unwrap();
            std::thread::sleep(RETRY_INTERVAL * 2);
        });
        ready_rx.recv().unwrap();
        let flag = AtomicBool::new(false);
        let control = RunControl {
            disconnected: &flag,
            cancelled: &flag,
            deadline: Instant::now() + RETRY_INTERVAL,
        };
        let result = with_session(&session, &control, |_| ());
        worker.join().unwrap();
        assert!(result.unwrap_err().contains("timed out"));
    }
}
