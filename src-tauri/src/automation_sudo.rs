use super::{
    close_channel, retry_ssh, validate_command, with_session, CommandOutput, OutputStream,
    RunControl, COMMAND_TIMEOUT, MAX_OUTPUT_BYTES, READ_BUFFER_BYTES, RETRY_INTERVAL,
};
use crate::ssh_security::{validate_sudo_password, wipe_secret_bytes};
use rand::RngCore;
use ssh2::{Channel, Session};
use std::cell::RefCell;
use std::io::{self, ErrorKind, Read, Write};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Instant;

const NONCE_BYTES: usize = 32;
const AUTH_FAILURE_EXIT: i32 = 125;
const AUTH_FAILURE: &str = "Sudo authentication failed. Verify the saved sudo password and the server's non-interactive sudo policy, then start a new run.";
const PASSWORD_UNAVAILABLE: &str = "Saved sudo password is unavailable. Save a valid sudo password for this server and start a new run.";
const PASSWORD_INVALID: &str = "Saved sudo password is invalid. Save a valid sudo password for this server and start a new run.";
const PASSWORD_WRITE_FAILURE: &str =
    "Failed to send the saved sudo password over SSH. Check the connection and start a new run.";

pub(crate) fn execute_sudo(
    session: &Arc<Mutex<Session>>,
    disconnected: &AtomicBool,
    cancelled: &AtomicBool,
    command: &str,
    password: impl FnMut() -> Result<Vec<u8>, String>,
) -> Result<CommandOutput, String> {
    validate_command(command)?;
    let control = RunControl {
        disconnected,
        cancelled,
        deadline: Instant::now() + COMMAND_TIMEOUT,
    };
    let mut channel = retry_ssh(&control, "open sudo automation channel", || {
        with_session(session, &control, Session::channel_session)
    })?;
    let result = execute_channel(session, &mut channel, &control, command, password);
    let close_result = close_channel(session, &mut channel);

    // ssh2 frees channels without its internal session lock.
    let drop_result = match session.lock() {
        Ok(_guard) => {
            drop(channel);
            Ok(())
        }
        Err(poisoned) => {
            let _guard = poisoned.into_inner();
            drop(channel);
            Err("SSH session lock failed while releasing sudo automation channel".to_string())
        }
    };
    match (result, close_result, drop_result) {
        (Ok(output), Ok(()), Ok(())) => Ok(output),
        (Err(error), Ok(()), Ok(())) => Err(error),
        (result, close_result, drop_result) => {
            Err([result.err(), close_result.err(), drop_result.err()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("; "))
        }
    }
}

fn execute_channel(
    session: &Arc<Mutex<Session>>,
    channel: &mut Channel,
    control: &RunControl<'_>,
    command: &str,
    password: impl FnMut() -> Result<Vec<u8>, String>,
) -> Result<CommandOutput, String> {
    let markers = Markers::random()?;
    let script = sudo_script(command, &markers);
    retry_ssh(control, "start sudo remote command", || {
        with_session(session, control, |_| channel.exec(&script))
    })?;

    let mut stdout = channel.stream(0);
    let mut stderr = channel.stderr();
    let channel = RefCell::new(channel);
    let (stdout, stderr, truncated) = collect_sudo_output(
        control,
        &markers,
        |stream, buffer| {
            with_session(session, control, |_| match stream {
                OutputStream::Stdout => stdout.read(buffer),
                OutputStream::Stderr => stderr.read(buffer),
            })
        },
        || with_session(session, control, |_| channel.borrow().eof()),
        |input| match input {
            Input::Write(bytes) => {
                with_session(session, control, |_| channel.borrow_mut().write(bytes))
            }
            Input::Eof => retry_ssh(control, "close sudo command input", || {
                with_session(session, control, |_| channel.borrow_mut().send_eof())
            })
            .map(|()| Ok(0)),
        },
        password,
    )?;
    let channel = channel.into_inner();
    retry_ssh(control, "wait for sudo remote command exit", || {
        with_session(session, control, |_| channel.wait_close())
    })?;
    let exit_code = retry_ssh(control, "read sudo remote command exit status", || {
        with_session(session, control, |_| channel.exit_status())
    })?;
    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code,
        truncated,
    })
}

struct Markers {
    prompt: Vec<u8>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl Markers {
    fn random() -> Result<Self, String> {
        let mut nonce = [0_u8; NONCE_BYTES];
        rand::rngs::OsRng
            .try_fill_bytes(&mut nonce)
            .map_err(|_| "Failed to generate sudo authentication markers".to_string())?;
        let nonce = nonce
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok(Self {
            prompt: format!("__SLEEKSSH_SUDO_AUTH_{nonce}__").into_bytes(),
            stdout: format!("__SLEEKSSH_SUDO_STDOUT_{nonce}__").into_bytes(),
            stderr: format!("__SLEEKSSH_SUDO_STDERR_{nonce}__").into_bytes(),
        })
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn sudo_script(command: &str, markers: &Markers) -> String {
    let prompt = shell_quote(std::str::from_utf8(&markers.prompt).expect("ASCII sudo marker"));
    let stdout = shell_quote(std::str::from_utf8(&markers.stdout).expect("ASCII sudo marker"));
    let stderr = shell_quote(std::str::from_utf8(&markers.stderr).expect("ASCII sudo marker"));
    // The privileged shell must discard the authentication input before approved code runs.
    let payload = shell_quote(&format!(
        "exec </dev/null || exit {AUTH_FAILURE_EXIT}; printf '%s' {stdout}; printf '%s' {stderr} >&2;\n{command}"
    ));
    format!("command -p sudo -S -p {prompt} -- /bin/sh -c {payload}")
}

struct Secret(Vec<u8>);

impl Secret {
    fn validated(bytes: Vec<u8>) -> Result<Self, String> {
        let secret = Self(bytes);
        let value = std::str::from_utf8(&secret.0).map_err(|_| PASSWORD_INVALID.to_string())?;
        validate_sudo_password(value).map_err(|_| PASSWORD_INVALID.to_string())?;
        Ok(secret)
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        wipe_secret_bytes(&mut self.0);
    }
}

enum Input<'a> {
    Write(&'a [u8]),
    Eof,
}

enum GateEvent {
    Suppressed,
    Prompt,
    Opened,
    Output(u8),
}

struct StreamGate<'a> {
    marker: &'a [u8],
    prompt: Option<&'a [u8]>,
    pending: Vec<u8>,
    opened: bool,
}

impl<'a> StreamGate<'a> {
    fn new(marker: &'a [u8], prompt: Option<&'a [u8]>) -> Self {
        Self {
            marker,
            prompt,
            pending: Vec::with_capacity(marker.len()),
            opened: false,
        }
    }

    fn accept(&mut self, byte: u8) -> GateEvent {
        if self.opened {
            return GateEvent::Output(byte);
        }
        self.pending.push(byte);
        loop {
            if self.pending == self.marker {
                self.pending.clear();
                self.opened = true;
                return GateEvent::Opened;
            }
            if self.prompt.is_some_and(|prompt| self.pending == prompt) {
                self.pending.clear();
                return GateEvent::Prompt;
            }
            if self.marker.starts_with(&self.pending)
                || self
                    .prompt
                    .is_some_and(|prompt| prompt.starts_with(&self.pending))
            {
                return GateEvent::Suppressed;
            }
            self.pending.remove(0);
        }
    }
}

fn collect_sudo_output(
    control: &RunControl<'_>,
    markers: &Markers,
    mut read: impl FnMut(OutputStream, &mut [u8]) -> Result<io::Result<usize>, String>,
    mut eof: impl FnMut() -> Result<bool, String>,
    mut input: impl FnMut(Input<'_>) -> Result<io::Result<usize>, String>,
    mut password: impl FnMut() -> Result<Vec<u8>, String>,
) -> Result<(Vec<u8>, Vec<u8>, bool), String> {
    let mut stdout_gate = StreamGate::new(&markers.stdout, None);
    let mut stderr_gate = StreamGate::new(&markers.stderr, Some(&markers.prompt));
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut truncated = false;
    let mut password_sent = false;
    let mut input_closed = false;
    let mut buffer = [0_u8; READ_BUFFER_BYTES];
    loop {
        control.check()?;
        let mut progressed = false;
        let mut drained_streams = 0;
        for stream in [OutputStream::Stdout, OutputStream::Stderr] {
            control.check()?;
            let count = match read(stream, &mut buffer)? {
                Ok(count) => count,
                Err(error) if transient_io_error(&error) => continue,
                Err(_) => return Err("Failed to read sudo remote command output".to_string()),
            };
            progressed |= count > 0;
            drained_streams += usize::from(count == 0);
            for &byte in &buffer[..count] {
                let event = match stream {
                    OutputStream::Stdout => stdout_gate.accept(byte),
                    OutputStream::Stderr => stderr_gate.accept(byte),
                };
                match event {
                    GateEvent::Prompt => {
                        if password_sent || input_closed {
                            return Err(AUTH_FAILURE.to_string());
                        }
                        control.check()?;
                        let secret = Secret::validated(
                            password().map_err(|_| PASSWORD_UNAVAILABLE.to_string())?,
                        )?;
                        control.check()?;
                        password_sent = true;
                        write_password(control, &secret.0, &mut input)?;
                        drop(secret);
                        close_input(control, &mut input)?;
                        input_closed = true;
                    }
                    GateEvent::Opened if !input_closed => {
                        close_input(control, &mut input)?;
                        input_closed = true;
                    }
                    GateEvent::Output(byte) => {
                        if stdout.len() + stderr.len() == MAX_OUTPUT_BYTES {
                            truncated = true;
                        } else {
                            match stream {
                                OutputStream::Stdout => stdout.push(byte),
                                OutputStream::Stderr => stderr.push(byte),
                            }
                        }
                    }
                    GateEvent::Suppressed | GateEvent::Opened => {}
                }
            }
        }
        if eof()? && drained_streams == 2 {
            return if stdout_gate.opened && stderr_gate.opened {
                Ok((stdout, stderr, truncated))
            } else {
                Err(AUTH_FAILURE.to_string())
            };
        }
        if !progressed {
            std::thread::sleep(RETRY_INTERVAL);
        }
    }
}

fn transient_io_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
    )
}

fn write_password(
    control: &RunControl<'_>,
    secret: &[u8],
    input: &mut impl FnMut(Input<'_>) -> Result<io::Result<usize>, String>,
) -> Result<(), String> {
    for bytes in [secret, b"\n"] {
        let mut offset = 0;
        while offset < bytes.len() {
            control.check()?;
            match input(Input::Write(&bytes[offset..]))
                .map_err(|_| PASSWORD_WRITE_FAILURE.to_string())?
            {
                Ok(0) => return Err(PASSWORD_WRITE_FAILURE.to_string()),
                Ok(count) if count <= bytes.len() - offset => offset += count,
                Ok(_) => return Err(PASSWORD_WRITE_FAILURE.to_string()),
                Err(error) if transient_io_error(&error) => std::thread::sleep(RETRY_INTERVAL),
                Err(_) => return Err(PASSWORD_WRITE_FAILURE.to_string()),
            }
        }
    }
    Ok(())
}

fn close_input(
    control: &RunControl<'_>,
    input: &mut impl FnMut(Input<'_>) -> Result<io::Result<usize>, String>,
) -> Result<(), String> {
    loop {
        control.check()?;
        match input(Input::Eof)
            .map_err(|_| "Failed to close sudo remote command input".to_string())?
        {
            Ok(_) => return Ok(()),
            Err(error) if transient_io_error(&error) => std::thread::sleep(RETRY_INTERVAL),
            Err(_) => return Err("Failed to close sudo remote command input".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::sync::atomic::Ordering;

    const TEST_PASSWORD: &[u8] = b"fixture-secret";
    const TEST_PASSWORD_MAX_BYTES: usize = 255;

    #[derive(Default)]
    struct InputLog {
        bytes: Vec<u8>,
        eof_count: usize,
        password_count: usize,
    }

    fn markers() -> Markers {
        Markers {
            prompt: b"__AUTH_nonce__".to_vec(),
            stdout: b"__STDOUT_nonce__".to_vec(),
            stderr: b"__STDERR_nonce__".to_vec(),
        }
    }

    fn control<'a>(flag: &'a AtomicBool) -> RunControl<'a> {
        RunControl {
            disconnected: flag,
            cancelled: flag,
            deadline: Instant::now() + COMMAND_TIMEOUT,
        }
    }

    fn append(marker: &[u8], data: &[u8]) -> Vec<u8> {
        [marker, data].concat()
    }

    fn run_fixture(
        stdout: Vec<Vec<u8>>,
        stderr: Vec<Vec<u8>>,
        credential: Result<Vec<u8>, String>,
    ) -> (Result<(Vec<u8>, Vec<u8>, bool), String>, InputLog) {
        let streams = RefCell::new((VecDeque::from(stdout), VecDeque::from(stderr)));
        let log = RefCell::new(InputLog::default());
        let flag = AtomicBool::new(false);
        let result = collect_sudo_output(
            &control(&flag),
            &markers(),
            |stream, buffer| {
                let mut streams = streams.borrow_mut();
                let queue = match stream {
                    OutputStream::Stdout => &mut streams.0,
                    OutputStream::Stderr => &mut streams.1,
                };
                let chunk = queue.pop_front().unwrap_or_default();
                assert!(chunk.len() <= buffer.len());
                buffer[..chunk.len()].copy_from_slice(&chunk);
                Ok(Ok(chunk.len()))
            },
            || {
                let streams = streams.borrow();
                Ok(streams.0.is_empty() && streams.1.is_empty())
            },
            |input| {
                let mut log = log.borrow_mut();
                match input {
                    Input::Write(bytes) => {
                        assert_eq!(log.eof_count, 0);
                        log.bytes.extend_from_slice(bytes);
                        Ok(Ok(bytes.len()))
                    }
                    Input::Eof => {
                        log.eof_count += 1;
                        Ok(Ok(0))
                    }
                }
            },
            || {
                log.borrow_mut().password_count += 1;
                credential.clone()
            },
        );
        (result, log.into_inner())
    }

    #[test]
    fn execute_sudo_validates_before_ssh_access_and_never_requests_credentials() {
        let session = Arc::new(Mutex::new(Session::new().unwrap()));
        let clear = AtomicBool::new(false);
        let set = AtomicBool::new(true);
        for command in ["", " \r\n\t", "echo\0invalid"] {
            assert!(execute_sudo(&session, &clear, &clear, command, || {
                panic!("invalid commands must not read credentials")
            })
            .is_err());
        }
        assert!(execute_sudo(
            &session,
            &clear,
            &clear,
            &"x".repeat(super::super::MAX_COMMAND_BYTES + 1),
            || panic!("oversized commands must not read credentials")
        )
        .unwrap_err()
        .contains("limit"));
        for (disconnected, cancelled, expected) in
            [(&set, &clear, "disconnected"), (&clear, &set, "cancelled")]
        {
            assert!(execute_sudo(&session, disconnected, cancelled, "id", || {
                panic!("stopped commands must not read credentials")
            })
            .unwrap_err()
            .contains(expected));
        }
    }

    #[test]
    fn script_quotes_approved_commands_and_closes_input_before_markers_or_payload() {
        let command = "printf '%s\\n' \"a'b\";\n$(touch /tmp/quoted)";
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
        assert_eq!(shell_quote(""), "''");
        let script = sudo_script(command, &markers());
        assert!(script.starts_with("command -p sudo -S -p '__AUTH_nonce__' -- /bin/sh -c "));
        let payload = format!("exec </dev/null || exit {AUTH_FAILURE_EXIT}; printf '%s' '__STDOUT_nonce__'; printf '%s' '__STDERR_nonce__' >&2;\n{command}");
        assert!(script.ends_with(&shell_quote(&payload)));
        assert!(!script.contains(std::str::from_utf8(TEST_PASSWORD).unwrap()));
        assert!(!script.contains("exec sudo"));
    }

    #[test]
    fn markers_are_unpredictable_distinct_ascii_values() {
        let first = Markers::random().unwrap();
        let second = Markers::random().unwrap();
        assert_ne!(first.prompt, second.prompt);
        assert_ne!(first.prompt, first.stdout);
        assert_ne!(first.stdout, first.stderr);
        assert!(first.prompt.is_ascii());
        assert!(first.stdout.is_ascii());
        assert!(first.stderr.is_ascii());
    }

    #[test]
    fn passwordless_or_cached_authentication_never_requests_or_sends_credentials() {
        let markers = markers();
        let (result, log) = run_fixture(
            vec![append(&markers.stdout, b"uid=0\n")],
            vec![append(&markers.stderr, b"payload warning\n")],
            Err("must not call".to_string()),
        );
        let (stdout, stderr, truncated) = result.unwrap();
        assert_eq!(stdout, b"uid=0\n");
        assert_eq!(stderr, b"payload warning\n");
        assert!(!truncated);
        assert_eq!(log.password_count, 0);
        assert!(log.bytes.is_empty());
        assert_eq!(log.eof_count, 1);
    }

    #[test]
    fn fragmented_markers_suppress_all_auth_output_and_keep_payload() {
        let markers = markers();
        let stdout = append(b"untrusted authentication banner\n", &markers.stdout)
            .into_iter()
            .map(|byte| vec![byte])
            .chain([b"hello\n".to_vec()])
            .collect();
        let stderr = append(b"authentication diagnostic\n", &markers.stderr)
            .into_iter()
            .map(|byte| vec![byte])
            .chain([b"warning\n".to_vec()])
            .collect();
        let (result, log) = run_fixture(stdout, stderr, Ok(TEST_PASSWORD.to_vec()));
        let (stdout, stderr, _) = result.unwrap();
        assert_eq!(stdout, b"hello\n");
        assert_eq!(stderr, b"warning\n");
        assert_eq!(log.password_count, 0);
    }

    #[test]
    fn each_stream_opens_independently_without_dropping_early_payload() {
        let markers = markers();
        for stdout_first in [true, false] {
            let early_stdout = append(&markers.stdout, b"first output");
            let early_stderr = append(&markers.stderr, b"first error");
            let (stdout, stderr) = if stdout_first {
                (vec![early_stdout], vec![Vec::new(), early_stderr])
            } else {
                (vec![Vec::new(), early_stdout], vec![early_stderr])
            };
            let (result, log) = run_fixture(stdout, stderr, Err("not needed".to_string()));
            let (stdout, stderr, _) = result.unwrap();
            assert_eq!(stdout, b"first output");
            assert_eq!(stderr, b"first error");
            assert_eq!(log.password_count, 0);
            assert_eq!(log.eof_count, 1);
        }
    }

    #[test]
    fn exact_fragmented_stderr_prompt_requests_password_once_then_closes_input() {
        let markers = markers();
        let mut stderr = markers
            .prompt
            .iter()
            .map(|byte| vec![*byte])
            .collect::<Vec<_>>();
        let mut stdout = vec![Vec::new(); stderr.len()];
        stdout.push(append(&markers.stdout, b"root"));
        stderr.push(append(&markers.stderr, b"done"));
        let secret = "fixture unicode λ".as_bytes();
        let (result, log) = run_fixture(stdout, stderr, Ok(secret.to_vec()));
        let (stdout, stderr, _) = result.unwrap();
        assert_eq!(stdout, b"root");
        assert_eq!(stderr, b"done");
        assert_eq!(log.bytes, append(secret, b"\n"));
        assert_eq!(log.password_count, 1);
        assert_eq!(log.eof_count, 1);
    }

    #[test]
    fn stdout_prompt_and_other_stderr_password_text_never_trigger_credential_lookup() {
        let markers = markers();
        let (result, log) = run_fixture(
            vec![append(&markers.prompt, &markers.stdout)],
            vec![append(b"[sudo] Password: __AUTH_other__", &markers.stderr)],
            Err("not needed".to_string()),
        );
        let (stdout, stderr, _) = result.unwrap();
        assert!(stdout.is_empty());
        assert!(stderr.is_empty());
        assert_eq!(log.password_count, 0);
        assert!(log.bytes.is_empty());
    }

    #[test]
    fn payload_prompt_text_does_not_reenable_authentication() {
        let markers = markers();
        let (result, log) = run_fixture(
            vec![markers.stdout.clone()],
            vec![append(&markers.stderr, &markers.prompt)],
            Err("must not retrieve credentials for payload".to_string()),
        );
        let (_, stderr, _) = result.unwrap();
        assert_eq!(stderr, markers.prompt);
        assert_eq!(log.password_count, 0);
        assert!(log.bytes.is_empty());
    }

    #[test]
    fn repeated_authentication_prompt_fails_without_retry_or_secret_disclosure() {
        let markers = markers();
        let (result, log) = run_fixture(
            vec![],
            vec![append(
                &markers.prompt,
                &append(b"Sorry, try again\n", &markers.prompt),
            )],
            Ok(TEST_PASSWORD.to_vec()),
        );
        assert_eq!(result.unwrap_err(), AUTH_FAILURE);
        assert_eq!(log.password_count, 1);
        assert_eq!(log.bytes, append(TEST_PASSWORD, b"\n"));
        assert_eq!(log.eof_count, 1);
    }

    #[test]
    fn eof_or_missing_markers_returns_fixed_error_and_hides_authentication_text() {
        let markers = markers();
        for (stdout, stderr) in [
            (vec![], vec![]),
            (vec![b"server auth failure fixture-secret".to_vec()], vec![]),
            (vec![markers.stdout.clone()], vec![]),
            (vec![], vec![markers.stderr.clone()]),
            (vec![], vec![markers.prompt.clone()]),
        ] {
            let (result, log) = run_fixture(stdout, stderr, Ok(TEST_PASSWORD.to_vec()));
            assert_eq!(result.unwrap_err(), AUTH_FAILURE);
            assert!(log.password_count <= 1);
        }
    }

    #[test]
    fn invalid_credentials_are_rejected_without_writing_or_exposing_values() {
        for credential in [
            Vec::new(),
            vec![b'x'; TEST_PASSWORD_MAX_BYTES + 1],
            b"secret\0value".to_vec(),
            b"secret\nvalue".to_vec(),
            b"secret\rvalue".to_vec(),
            b"secret\tvalue".to_vec(),
            vec![0xff],
            vec![0x7f],
            "secret\u{0085}value".as_bytes().to_vec(),
        ] {
            let (result, log) = run_fixture(vec![], vec![markers().prompt], Ok(credential));
            assert_eq!(result.unwrap_err(), PASSWORD_INVALID);
            assert_eq!(log.password_count, 1);
            assert!(log.bytes.is_empty());
            assert_eq!(log.eof_count, 0);
        }
        assert!(Secret::validated(vec![b'x'; TEST_PASSWORD_MAX_BYTES]).is_ok());
    }

    #[test]
    fn credential_lookup_errors_are_replaced_with_fixed_nonsecret_message() {
        let (result, log) = run_fixture(
            vec![],
            vec![markers().prompt],
            Err("unexpected secret in upstream failure".to_string()),
        );
        assert_eq!(result.unwrap_err(), PASSWORD_UNAVAILABLE);
        assert!(log.bytes.is_empty());
    }

    #[test]
    fn output_limit_is_shared_exact_and_does_not_stop_drain() {
        let markers = markers();
        for excess in [0, 1] {
            let mut stdout = vec![markers.stdout.clone()];
            stdout.extend(vec![
                vec![b'x'; READ_BUFFER_BYTES];
                MAX_OUTPUT_BYTES / READ_BUFFER_BYTES
            ]);
            if excess != 0 {
                stdout.push(vec![b'x'; excess]);
            }
            let (result, log) = run_fixture(
                stdout,
                vec![markers.stderr.clone()],
                Ok(TEST_PASSWORD.to_vec()),
            );
            let (stdout, stderr, truncated) = result.unwrap();
            assert_eq!(stdout.len() + stderr.len(), MAX_OUTPUT_BYTES);
            assert_eq!(truncated, excess != 0);
            assert_eq!(log.password_count, 0);
        }
    }

    #[test]
    fn collection_retries_transient_reads_and_drains_after_eof_with_buffered_payload() {
        let markers = markers();
        let flag = AtomicBool::new(false);
        let mut stdout = VecDeque::from([
            Err(ErrorKind::WouldBlock),
            Ok(append(&markers.stdout, b"first")),
            Ok(b"second".to_vec()),
        ]);
        let mut stderr = VecDeque::from([
            Err(ErrorKind::Interrupted),
            Err(ErrorKind::TimedOut),
            Ok(append(&markers.stderr, b"error")),
        ]);
        let (stdout, stderr, _) = collect_sudo_output(
            &control(&flag),
            &markers,
            |stream, buffer| {
                let next = match stream {
                    OutputStream::Stdout => stdout.pop_front(),
                    OutputStream::Stderr => stderr.pop_front(),
                }
                .unwrap_or_else(|| Ok(Vec::new()));
                Ok(next
                    .map(|bytes| {
                        buffer[..bytes.len()].copy_from_slice(&bytes);
                        bytes.len()
                    })
                    .map_err(io::Error::from))
            },
            || Ok(true),
            |_| Ok(Ok(0)),
            || panic!("passwordless fixture"),
        )
        .unwrap();
        assert_eq!(stdout, b"firstsecond");
        assert_eq!(stderr, b"error");
    }

    #[test]
    fn write_retries_partial_and_transient_failures_without_duplicating_password() {
        let flag = AtomicBool::new(false);
        let mut calls = 0;
        let mut bytes_written = Vec::new();
        write_password(&control(&flag), TEST_PASSWORD, &mut |input| {
            calls += 1;
            let Input::Write(bytes) = input else {
                panic!("writes only")
            };
            match calls {
                1 => Ok(Err(io::Error::from(ErrorKind::WouldBlock))),
                3 => Ok(Err(io::Error::from(ErrorKind::Interrupted))),
                _ => {
                    let count = bytes.len().min(2);
                    bytes_written.extend_from_slice(&bytes[..count]);
                    Ok(Ok(count))
                }
            }
        })
        .unwrap();
        assert_eq!(bytes_written, append(TEST_PASSWORD, b"\n"));
    }

    #[test]
    fn write_eof_and_permanent_errors_do_not_expose_secret_or_upstream_errors() {
        let flag = AtomicBool::new(false);
        for result in [
            Ok(Ok(0)),
            Ok(Err(io::Error::new(ErrorKind::BrokenPipe, "fixture-secret"))),
            Err("fixture-secret".to_string()),
        ] {
            let mut result = Some(result);
            let error = write_password(&control(&flag), TEST_PASSWORD, &mut |_| {
                result.take().unwrap()
            })
            .unwrap_err();
            assert_eq!(error, PASSWORD_WRITE_FAILURE);
        }
    }

    #[test]
    fn cancellation_after_partial_password_write_prevents_remaining_input() {
        let disconnected = AtomicBool::new(false);
        let cancelled = AtomicBool::new(false);
        let run_control = RunControl {
            disconnected: &disconnected,
            cancelled: &cancelled,
            deadline: Instant::now() + COMMAND_TIMEOUT,
        };
        let mut writes = 0;
        let error = write_password(&run_control, TEST_PASSWORD, &mut |input| {
            assert!(matches!(input, Input::Write(_)));
            writes += 1;
            cancelled.store(true, Ordering::Relaxed);
            Ok(Ok(1))
        })
        .unwrap_err();
        assert!(error.contains("cancelled"));
        assert_eq!(writes, 1);
    }

    #[test]
    fn collector_enforces_timeout_and_hides_remote_read_errors() {
        let flag = AtomicBool::new(false);
        let mut run_control = control(&flag);
        run_control.deadline = Instant::now();
        let error = collect_sudo_output(
            &run_control,
            &markers(),
            |_, _| panic!("expired commands must not read"),
            || panic!("expired commands must not inspect EOF"),
            |_| panic!("expired commands must not write"),
            || panic!("expired commands must not retrieve credentials"),
        )
        .unwrap_err();
        assert!(error.contains("timed out"));

        let error = collect_sudo_output(
            &control(&flag),
            &markers(),
            |_, _| {
                Ok(Err(io::Error::new(
                    ErrorKind::ConnectionReset,
                    "fixture-secret",
                )))
            },
            || Ok(false),
            |_| panic!("failed reads must not write"),
            || panic!("failed reads must not retrieve credentials"),
        )
        .unwrap_err();
        assert_eq!(error, "Failed to read sudo remote command output");
    }

    #[test]
    fn cancellation_between_reads_and_after_credential_lookup_prevents_writes() {
        let flag = AtomicBool::new(false);
        let disconnected = AtomicBool::new(false);
        let run_control = RunControl {
            disconnected: &disconnected,
            cancelled: &flag,
            deadline: Instant::now() + COMMAND_TIMEOUT,
        };
        let markers = markers();
        let mut reads = 0;
        let error = collect_sudo_output(
            &run_control,
            &markers,
            |_, _| {
                reads += 1;
                flag.store(true, Ordering::Relaxed);
                Ok(Ok(0))
            },
            || Ok(false),
            |_| panic!("cancelled run must not write"),
            || panic!("cancelled run must not retrieve password"),
        )
        .unwrap_err();
        assert!(error.contains("cancelled"));
        assert_eq!(reads, 1);

        flag.store(false, Ordering::Relaxed);
        let error = collect_sudo_output(
            &run_control,
            &markers,
            |stream, buffer| {
                let bytes = match stream {
                    OutputStream::Stdout => &b""[..],
                    OutputStream::Stderr => &markers.prompt,
                };
                buffer[..bytes.len()].copy_from_slice(bytes);
                Ok(Ok(bytes.len()))
            },
            || Ok(false),
            |_| panic!("cancelled run must not write retrieved password"),
            || {
                flag.store(true, Ordering::Relaxed);
                Ok(TEST_PASSWORD.to_vec())
            },
        )
        .unwrap_err();
        assert!(error.contains("cancelled"));
    }

    #[test]
    fn input_close_retries_transient_failures_and_propagates_final_failure() {
        let flag = AtomicBool::new(false);
        let mut calls = 0;
        close_input(&control(&flag), &mut |input| {
            assert!(matches!(input, Input::Eof));
            calls += 1;
            if calls == 1 {
                Ok(Err(io::Error::from(ErrorKind::TimedOut)))
            } else {
                Ok(Ok(0))
            }
        })
        .unwrap();
        assert_eq!(calls, 2);
        assert!(close_input(&control(&flag), &mut |_| {
            Ok(Err(io::Error::from(ErrorKind::BrokenPipe)))
        })
        .unwrap_err()
        .contains("close"));
    }
}
