use crate::connection::{SessionInput, SshConnection, SshOutputPayload};
use crate::ssh_security::{
    self, SudoIdentity, SudoMarkerParser, SudoOutputEvent, SudoPasswordEntry, SudoPromptState,
};
use crate::DbSessionMap;
use serde::{Deserialize, Serialize};
use ssh2::{PtyModeOpcode, PtyModes, Session};
use std::io::{self, ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const INTERACTIVE_SSH_TIMEOUT_MILLISECONDS: u32 = 50;
const SSH_CONNECTION_TIMEOUT_MILLISECONDS: u32 = 10_000;
const INTERACTIVE_SSH_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const INTERACTIVE_SSH_WRITE_RETRY_INTERVAL: Duration = Duration::from_millis(5);
const SFTP_DIRECTORY_TIMEOUT_MILLISECONDS: u32 = 5_000;
const SFTP_TRANSFER_TIMEOUT_MILLISECONDS: u32 = 30_000;
const TERMINAL_SETUP_MAX_BYTES: usize = 4 * 1024 - 1;
const TERMINAL_BOOTSTRAP_MAX_OUTPUT_BYTES: usize = 256 * 1024;
const TERMINAL_BOOTSTRAP_READ_BUFFER_BYTES: usize = 8192;
const SUDO_TTY_CHECK_TIMEOUT_MILLISECONDS: u32 = 2_000;
const SUDO_TTY_CHECK_MAX_OUTPUT_BYTES: u64 = 8 * 1024;
const SUDO_TTY_CHECK_READ_BUFFER_BYTES: usize = 1024;
const MINIMUM_BOUNDED_SSH_TIMEOUT_MILLISECONDS: u32 = 1;

struct TerminalBootstrap {
    command: String,
    payload: Vec<u8>,
    started_marker: Vec<u8>,
    ready_marker: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub key_path: String,
    pub passphrase: Option<String>,
    pub password: Option<String>,
    pub use_password: bool,
    pub namespace: Option<String>,
    #[serde(default)]
    pub sudo_shortcut_enabled: bool,
    #[serde(default)]
    pub has_sudo_password: bool,
}

struct SftpSessionTimeoutReset<'a> {
    session: &'a Session,
}

impl<'a> SftpSessionTimeoutReset<'a> {
    fn new(session: &'a Session, timeout_milliseconds: u32) -> Self {
        session.set_timeout(timeout_milliseconds);
        Self { session }
    }
}

impl Drop for SftpSessionTimeoutReset<'_> {
    fn drop(&mut self) {
        self.session
            .set_timeout(INTERACTIVE_SSH_TIMEOUT_MILLISECONDS);
    }
}

#[tauri::command]
pub fn select_key_file() -> Result<Option<String>, String> {
    let home = dirs::home_dir().unwrap_or_default();
    let ssh_dir = home.join(".ssh");
    let file = rfd::FileDialog::new()
        .set_directory(if ssh_dir.exists() { &ssh_dir } else { &home })
        .pick_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn get_default_ssh_keys() -> Result<Vec<String>, String> {
    let ssh_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?
        .join(".ssh");
    if !ssh_dir.exists() {
        return Ok(Vec::new());
    }
    let mut keys = Vec::new();
    let common_keys = ["id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"];
    for key_name in &common_keys {
        let key_path = ssh_dir.join(key_name);
        if key_path.exists() {
            if let Some(path_str) = key_path.to_str() {
                keys.push(path_str.to_string());
            }
        }
    }
    Ok(keys)
}

#[tauri::command]
pub fn generate_new_ssh_key() -> Result<String, String> {
    use rand::rngs::OsRng;
    use ssh_key::private::Ed25519Keypair;

    let ssh_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?
        .join(".ssh");
    std::fs::create_dir_all(&ssh_dir)
        .map_err(|e| format!("Failed to create .ssh directory: {}", e))?;

    let private_key_path = ssh_dir.join("id_ed25519");
    let public_key_path = ssh_dir.join("id_ed25519.pub");

    if private_key_path.exists() {
        return Err("SSH key id_ed25519 already exists!".to_string());
    }

    let mut csprng = OsRng;
    let keypair = Ed25519Keypair::random(&mut csprng);
    let private_key = ssh_key::PrivateKey::from(keypair);

    let openssh_pem = private_key
        .to_openssh(ssh_key::LineEnding::LF)
        .map_err(|e| format!("Failed to generate private key format: {}", e))?;

    let public_key = private_key.public_key();
    let public_key_openssh = public_key
        .to_openssh()
        .map_err(|e| format!("Failed to generate public key format: {}", e))?;

    std::fs::write(&private_key_path, openssh_pem.as_bytes())
        .map_err(|e| format!("Failed to write private key file: {}", e))?;

    std::fs::write(&public_key_path, public_key_openssh.as_bytes())
        .map_err(|e| format!("Failed to write public key file: {}", e))?;

    Ok(public_key_openssh)
}

#[tauri::command]
pub fn load_connections() -> Result<Vec<ConnectionProfile>, String> {
    let _guard = ssh_security::lock_security_store()?;
    let config_dir = ssh_security::configuration_directory()?;
    let mut connections = read_connection_profiles(&config_dir)?;
    let passwords = ssh_security::read_sudo_passwords(&config_dir)?;
    for profile in &mut connections {
        profile.has_sudo_password = passwords
            .iter()
            .any(|entry| entry.identity == sudo_identity(profile));
    }
    Ok(connections)
}

fn read_connection_profiles(
    config_dir: &std::path::Path,
) -> Result<Vec<ConnectionProfile>, String> {
    use windows_dpapi::{decrypt_data, Scope};
    let config_file = config_dir.join("connections.enc");
    if !config_file.exists() {
        return Ok(Vec::new());
    }
    let encrypted_data =
        std::fs::read(&config_file).map_err(|e| format!("Failed to read config file: {}", e))?;
    if encrypted_data.is_empty() {
        return Ok(Vec::new());
    }
    let mut decrypted_data = decrypt_data(&encrypted_data, Scope::User)
        .map_err(|_| "Failed to decrypt config".to_string())?;
    let connections = serde_json::from_slice(&decrypted_data)
        .map_err(|_| "Failed to parse config JSON".to_string());
    ssh_security::wipe_secret_bytes(&mut decrypted_data);
    connections
}

#[tauri::command]
pub fn save_connections(connections: Vec<ConnectionProfile>) -> Result<(), String> {
    use windows_dpapi::{encrypt_data, Scope};
    let _guard = ssh_security::lock_security_store()?;
    let config_dir = ssh_security::configuration_directory()?;
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;
    let config_file = config_dir.join("connections.enc");
    let mut profiles = connections;
    let identities = profiles.iter().map(sudo_identity).collect::<Vec<_>>();
    let passwords = ssh_security::reconcile_sudo_passwords(
        ssh_security::read_sudo_passwords(&config_dir)?,
        &identities,
    );
    for profile in &mut profiles {
        profile.has_sudo_password = passwords
            .iter()
            .any(|entry| entry.identity == sudo_identity(profile));
        if profile.sudo_shortcut_enabled && !profile.has_sudo_password {
            return Err("Save a sudo password before enabling its shortcut".to_string());
        }
    }
    let mut json_bytes =
        serde_json::to_vec(&profiles).map_err(|_| "Failed to serialize config".to_string())?;
    let encrypted_data =
        encrypt_data(&json_bytes, Scope::User).map_err(|_| "Failed to encrypt config".to_string());
    ssh_security::wipe_secret_bytes(&mut json_bytes);
    ssh_security::write_sudo_passwords(&config_dir, &passwords)?;
    std::fs::write(&config_file, encrypted_data?)
        .map_err(|e| format!("Failed to write config file: {}", e))?;
    Ok(())
}

fn sudo_identity(profile: &ConnectionProfile) -> SudoIdentity {
    SudoIdentity {
        profile_id: profile.id.clone(),
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
    }
}

#[tauri::command]
pub fn save_sudo_password(profile_id: String, password: String) -> Result<(), String> {
    let mut entry = SudoPasswordEntry {
        identity: SudoIdentity {
            profile_id: profile_id.clone(),
            host: String::new(),
            port: 0,
            username: String::new(),
        },
        password,
    };
    ssh_security::validate_sudo_password(&entry.password)?;
    let _guard = ssh_security::lock_security_store()?;
    let directory = ssh_security::configuration_directory()?;
    let profiles = read_connection_profiles(&directory)?;
    let profile = profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "Connection profile not found".to_string())?;
    let mut passwords = ssh_security::read_sudo_passwords(&directory)?;
    passwords.retain(|entry| entry.identity.profile_id != profile_id);
    entry.identity = sudo_identity(profile);
    passwords.push(entry);
    ssh_security::write_sudo_passwords(&directory, &passwords)
}

#[tauri::command]
pub fn delete_sudo_password(profile_id: String) -> Result<(), String> {
    let _guard = ssh_security::lock_security_store()?;
    let directory = ssh_security::configuration_directory()?;
    let mut passwords = ssh_security::read_sudo_passwords(&directory)?;
    passwords.retain(|entry| entry.identity.profile_id != profile_id);
    ssh_security::write_sudo_passwords(&directory, &passwords)
}

pub(crate) fn read_enabled_sudo_password(identity: &SudoIdentity) -> Result<String, String> {
    let _guard = ssh_security::lock_security_store()?;
    let directory = ssh_security::configuration_directory()?;
    read_enabled_sudo_password_from(&directory, identity)
}

fn read_enabled_sudo_password_from(
    directory: &std::path::Path,
    identity: &SudoIdentity,
) -> Result<String, String> {
    let profiles = read_connection_profiles(directory)?;
    let profile = profiles
        .iter()
        .find(|profile| sudo_identity(profile) == *identity)
        .ok_or_else(|| "Sudo shortcut connection profile changed or was removed".to_string())?;
    if !profile.sudo_shortcut_enabled {
        return Err("Sudo shortcut is disabled".to_string());
    }
    let mut entry = ssh_security::read_sudo_passwords(directory)?
        .into_iter()
        .find(|entry| entry.identity == *identity)
        .ok_or_else(|| "No saved sudo password is available".to_string())?;
    let password = std::mem::take(&mut entry.password);
    if let Err(error) = ssh_security::validate_sudo_password(&password) {
        ssh_security::wipe_secret_bytes(&mut password.into_bytes());
        return Err(error);
    }
    Ok(password)
}

fn resolve_sudo_identity(
    profile_id: Option<String>,
    host: &str,
    port: u16,
    username: &str,
) -> Result<Option<SudoIdentity>, String> {
    let Some(profile_id) = profile_id else {
        return Ok(None);
    };
    let _guard = ssh_security::lock_security_store()?;
    let directory = ssh_security::configuration_directory()?;
    let profiles = read_connection_profiles(&directory)?;
    let Some(profile) = profiles.iter().find(|profile| profile.id == profile_id) else {
        return Ok(None);
    };
    if profile.host != host
        || profile.port != port
        || profile.username != username
        || !profile.sudo_shortcut_enabled
    {
        return Ok(None);
    }
    let identity = sudo_identity(profile);
    if !ssh_security::read_sudo_passwords(&directory)?
        .iter()
        .any(|entry| entry.identity == identity)
    {
        return Ok(None);
    }
    Ok(Some(identity))
}

#[tauri::command]
pub fn trust_ssh_host(host: String, port: u16, key_base64: String) -> Result<(), String> {
    let _guard = ssh_security::lock_security_store()?;
    let directory = ssh_security::configuration_directory()?;
    let mut hosts = ssh_security::read_trusted_hosts(&directory)?;
    ssh_security::trust_host_key(&mut hosts, &host, port, &key_base64)?;
    ssh_security::write_trusted_hosts(&directory, &hosts)
}

#[tauri::command]
pub async fn connect_ssh(
    app_handle: AppHandle,
    state: State<'_, DbSessionMap>,
    session_id: String,
    host: String,
    port: u16,
    username: String,
    key_path: String,
    passphrase: Option<String>,
    password: Option<String>,
    use_password: bool,
    terminal_setup: Option<String>,
    profile_id: Option<String>,
) -> Result<(), String> {
    let terminal_setup = validate_terminal_setup(terminal_setup)?;
    let task_session_id = session_id.clone();
    let connection = tauri::async_runtime::spawn_blocking(move || {
        connect_ssh_blocking(
            app_handle,
            task_session_id,
            host,
            port,
            username,
            key_path,
            passphrase,
            password,
            use_password,
            terminal_setup,
            profile_id,
        )
    })
    .await
    .map_err(|error| format!("SSH connection task failed: {}", error))??;

    let mut map = state.lock().unwrap();
    map.insert(session_id, connection);
    Ok(())
}

fn connect_ssh_blocking(
    app_handle: AppHandle,
    session_id: String,
    host: String,
    port: u16,
    username: String,
    key_path: String,
    passphrase: Option<String>,
    password: Option<String>,
    use_password: bool,
    terminal_setup: Option<String>,
    profile_id: Option<String>,
) -> Result<SshConnection, String> {
    use base64::Engine;
    use std::io::Read;
    use std::net::{TcpStream, ToSocketAddrs};

    let sudo_identity = resolve_sudo_identity(profile_id, &host, port, &username)?;
    let sudo_nonce = rand::random::<u128>();
    let terminal_setup = if sudo_identity.is_some() {
        let wrapper = ssh_security::create_sudo_shell_setup(sudo_nonce);
        let setup = terminal_setup
            .map(|setup| format!("{setup}; {wrapper}"))
            .unwrap_or(wrapper);
        validate_terminal_setup(Some(setup))?
    } else {
        terminal_setup
    };
    let mut sudo_markers = SudoMarkerParser::new(sudo_nonce);
    let mut sudo_tty = None;

    let addr = format!("{}:{}", host, port);
    let addresses = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| format!("Failed to resolve {}: {}", addr, error))?;
    let connection_timeout = Duration::from_millis(SSH_CONNECTION_TIMEOUT_MILLISECONDS.into());
    let deadline = Instant::now() + connection_timeout;
    let mut connection_result = Err(io::Error::new(
        ErrorKind::AddrNotAvailable,
        "Host resolved to no addresses",
    ));
    for address in addresses {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            connection_result = Err(io::Error::new(ErrorKind::TimedOut, "Connection timed out"));
            break;
        }
        connection_result = TcpStream::connect_timeout(&address, remaining);
        if connection_result.is_ok() {
            break;
        }
    }
    let tcp =
        connection_result.map_err(|error| format!("Failed to connect to {}: {}", addr, error))?;

    let mut sess =
        Session::new().map_err(|e| format!("Failed to initialize SSH session: {}", e))?;
    sess.set_timeout(SSH_CONNECTION_TIMEOUT_MILLISECONDS);
    sess.set_tcp_stream(
        tcp.try_clone()
            .map_err(|e| format!("Failed to clone TCP stream: {}", e))?,
    );
    sess.handshake()
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    {
        let (key, _) = sess
            .host_key()
            .ok_or_else(|| "SSH server did not provide a host key".to_string())?;
        let _guard = ssh_security::lock_security_store()?;
        let directory = ssh_security::configuration_directory()?;
        ssh_security::check_host_key(
            &ssh_security::read_trusted_hosts(&directory)?,
            &host,
            port,
            key,
        )?;
    }

    if use_password {
        let pass = password.ok_or_else(|| "Password is required".to_string())?;
        sess.userauth_password(&username, &pass)
            .map_err(|e| format!("Authentication failed: {}", e))?;
    } else {
        let private_key = std::path::Path::new(&key_path);
        if !private_key.exists() {
            return Err(format!("Private key file does not exist: {}", key_path));
        }
        sess.userauth_pubkey_file(&username, None, private_key, passphrase.as_deref())
            .map_err(|e| format!("Authentication failed: {}", e))?;
    }

    let mut channel = sess
        .channel_session()
        .map_err(|error| format!("Failed to open channel: {}", error))?;
    channel
        .handle_extended_data(ssh2::ExtendedData::Merge)
        .map_err(|error| format!("Failed to configure channel output: {}", error))?;
    let terminal_modes = terminal_setup.as_ref().map(|_| {
        let mut modes = PtyModes::new();
        modes.set_boolean(PtyModeOpcode::ECHO, false);
        modes
    });
    channel
        .request_pty("xterm-256color", terminal_modes, None)
        .map_err(|error| format!("Failed to request PTY: {}", error))?;
    channel
        .shell()
        .map_err(|error| format!("Failed to open shell: {}", error))?;
    sess.set_timeout(INTERACTIVE_SSH_TIMEOUT_MILLISECONDS);

    if let Some(setup) = terminal_setup {
        let bootstrap = create_terminal_bootstrap(&setup, rand::random());
        let output = initialize_terminal_bootstrap(&mut channel, &bootstrap, connection_timeout)
            .map_err(|error| format!("Failed to initialize terminal: {}", error))?;
        let output = if sudo_identity.is_some() {
            let (cleaned, events) = sudo_markers.push(&output);
            for event in events {
                if let SudoOutputEvent::Tty(tty) = event {
                    sudo_tty = Some(tty);
                }
            }
            cleaned
        } else {
            output
        };
        if !output.is_empty() {
            app_handle
                .emit(
                    "ssh-output",
                    SshOutputPayload {
                        session_id: session_id.clone(),
                        data: base64::engine::general_purpose::STANDARD.encode(output),
                    },
                )
                .map_err(|error| format!("Failed to deliver terminal startup output: {}", error))?;
        }
    }

    let session = Arc::new(Mutex::new(sess));
    let should_exit = Arc::new(AtomicBool::new(false));
    let sudo_prompt = Arc::new(Mutex::new(SudoPromptState::default()));

    // Channel for writing
    let (tx, mut rx) = tokio::sync::mpsc::channel::<SessionInput>(1000);

    let session_clone = Arc::clone(&session);
    let should_exit_clone = Arc::clone(&should_exit);
    let app_handle_clone = app_handle.clone();
    let session_id_clone = session_id.clone();
    let sudo_identity_clone = sudo_identity.clone();
    let sudo_prompt_clone = Arc::clone(&sudo_prompt);

    // Spawn processing thread
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        'processing: loop {
            if should_exit_clone.load(Ordering::Relaxed) {
                break;
            }

            // Read output
            let read_result = {
                let _session_guard = session_clone.lock().unwrap();
                channel.read(&mut buf)
            };
            match read_result {
                Ok(0) => {
                    let _ = app_handle_clone.emit(
                        "ssh-closed",
                        SshOutputPayload {
                            session_id: session_id_clone.clone(),
                            data: "EOF reached".to_string(),
                        },
                    );
                    break;
                }
                Ok(n) => {
                    let data = if sudo_identity_clone.is_some() {
                        let (output, events) = sudo_markers.push(&buf[..n]);
                        for event in events {
                            match event {
                                SudoOutputEvent::Tty(tty) => sudo_tty = Some(tty),
                                SudoOutputEvent::Ready => {
                                    let prompt_id =
                                        sudo_prompt_clone.lock().unwrap().ready(Instant::now());
                                    emit_sudo_prompt(
                                        &app_handle_clone,
                                        &session_id_clone,
                                        Some(prompt_id),
                                    );
                                }
                                SudoOutputEvent::Done => {
                                    sudo_prompt_clone.lock().unwrap().invalidate();
                                    emit_sudo_prompt(&app_handle_clone, &session_id_clone, None);
                                }
                            }
                        }
                        output
                    } else {
                        buf[..n].to_vec()
                    };
                    if !data.is_empty() {
                        let _ = app_handle_clone.emit(
                            "ssh-output",
                            SshOutputPayload {
                                session_id: session_id_clone.clone(),
                                data: base64::engine::general_purpose::STANDARD.encode(data),
                            },
                        );
                    }
                }
                Err(ref e)
                    if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock =>
                {
                    // Timeout (normal)
                }
                Err(e) => {
                    eprintln!("SSH read error: {:?}", e);
                    let _ = app_handle_clone.emit(
                        "ssh-error",
                        SshOutputPayload {
                            session_id: session_id_clone.clone(),
                            data: format!("Read error: {}", e),
                        },
                    );
                    break;
                }
            }

            // Write inputs
            while let Ok(input) = rx.try_recv() {
                use std::io::Write;
                match input {
                    SessionInput::Write(data) => {
                        if sudo_prompt_clone.lock().unwrap().invalidate() {
                            emit_sudo_prompt(&app_handle_clone, &session_id_clone, None);
                        }
                        let write_result = write_interactive_input(
                            &data,
                            &should_exit_clone,
                            INTERACTIVE_SSH_WRITE_TIMEOUT,
                            |remaining| {
                                let _session_guard = session_clone.lock().unwrap();
                                channel.write(remaining)
                            },
                        );
                        if let Err(error) = write_result {
                            let _ = app_handle_clone.emit(
                                "ssh-error",
                                SshOutputPayload {
                                    session_id: session_id_clone.clone(),
                                    data: format!("Write error: {}", error),
                                },
                            );
                            break 'processing;
                        }
                    }
                    SessionInput::Resize { cols, rows } => {
                        let resize_result = {
                            let _session_guard = session_clone.lock().unwrap();
                            channel.request_pty_size(cols, rows, None, None)
                        };
                        if let Err(e) = resize_result {
                            eprintln!("Failed to resize PTY: {:?}", e);
                        }
                    }
                    SessionInput::SubmitSudo {
                        prompt_id,
                        completion,
                    } => {
                        let result = submit_sudo_password(
                            &session_clone,
                            &mut channel,
                            &should_exit_clone,
                            &sudo_prompt_clone,
                            sudo_identity_clone.as_ref(),
                            sudo_tty.as_deref(),
                            &prompt_id,
                            &mut sudo_markers,
                            &app_handle_clone,
                            &session_id_clone,
                        );
                        emit_sudo_prompt(&app_handle_clone, &session_id_clone, None);
                        let failed_transport = should_exit_clone.load(Ordering::Relaxed);
                        let _ = completion.send(result);
                        if failed_transport {
                            break 'processing;
                        }
                    }
                }
            }

            if sudo_prompt_clone.lock().unwrap().expire(Instant::now()) {
                emit_sudo_prompt(&app_handle_clone, &session_id_clone, None);
            }

            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        should_exit_clone.store(true, Ordering::Relaxed);
        sudo_prompt_clone.lock().unwrap().invalidate();
        emit_sudo_prompt(&app_handle_clone, &session_id_clone, None);
        let _session_guard = session_clone.lock().unwrap();
        let _ = channel.close();
        let _ = channel.wait_close();
    });

    Ok(SshConnection {
        session,
        tcp,
        write_tx: tx,
        should_exit,
        sudo_identity,
        sudo_prompt,
    })
}

fn validate_terminal_setup(setup: Option<String>) -> Result<Option<String>, String> {
    let Some(setup) = setup else {
        return Ok(None);
    };
    if setup.contains(['\0', '\r', '\n']) {
        return Err("Terminal setup must be a single line without NUL characters".to_string());
    }
    // Canonical terminals discard input beyond this limit before `read` receives it.
    if setup.len() > TERMINAL_SETUP_MAX_BYTES {
        return Err(format!(
            "Terminal setup exceeds {} bytes",
            TERMINAL_SETUP_MAX_BYTES
        ));
    }
    if setup.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(setup))
}

fn create_terminal_bootstrap(setup: &str, token: u64) -> TerminalBootstrap {
    let started_label = format!("9;sleekssh-{token:016x}-start");
    let ready_label = format!("9;sleekssh-{token:016x}-ready");
    TerminalBootstrap {
        command: format!(
            " stty -echo && printf '\\033]{started_label}\\007'; IFS= read -r __sleekssh_setup; eval \"$__sleekssh_setup\"; unset __sleekssh_setup; stty echo && printf '\\033]{ready_label}\\007'"
        ),
        payload: format!("{setup}\n").into_bytes(),
        started_marker: format!("\x1b]{started_label}\x07").into_bytes(),
        ready_marker: format!("\x1b]{ready_label}\x07").into_bytes(),
    }
}

fn initialize_terminal_bootstrap(
    channel: &mut (impl Read + Write),
    bootstrap: &TerminalBootstrap,
    timeout: Duration,
) -> io::Result<Vec<u8>> {
    let deadline = Instant::now() + timeout;
    let should_exit = AtomicBool::new(false);
    let command = format!("{}\n", bootstrap.command);
    write_interactive_input(command.as_bytes(), &should_exit, timeout, |remaining| {
        channel.write(remaining)
    })?;

    let mut output = Vec::new();
    let mut payload_sent = false;
    let mut buffer = [0; TERMINAL_BOOTSTRAP_READ_BUFFER_BYTES];
    loop {
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                ErrorKind::TimedOut,
                "Terminal setup did not complete before the timeout",
            ));
        }
        match channel.read(&mut buffer) {
            Ok(0) => {
                return Err(io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "SSH shell exited before terminal setup completed",
                ));
            }
            Ok(count) => {
                if output.len() + count > TERMINAL_BOOTSTRAP_MAX_OUTPUT_BYTES {
                    return Err(io::Error::new(
                        ErrorKind::InvalidData,
                        "Terminal startup output exceeded the buffer limit",
                    ));
                }
                output.extend_from_slice(&buffer[..count]);
                if !payload_sent
                    && output
                        .windows(bootstrap.started_marker.len())
                        .any(|window| window == bootstrap.started_marker)
                {
                    write_interactive_input(
                        &bootstrap.payload,
                        &should_exit,
                        deadline.saturating_duration_since(Instant::now()),
                        |remaining| channel.write(remaining),
                    )?;
                    payload_sent = true;
                }
                if payload_sent
                    && output
                        .windows(bootstrap.ready_marker.len())
                        .any(|window| window == bootstrap.ready_marker)
                {
                    return Ok(strip_terminal_bootstrap_output(&output, bootstrap));
                }
            }
            Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {
                std::thread::sleep(
                    INTERACTIVE_SSH_WRITE_RETRY_INTERVAL
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            Err(error) => return Err(error),
        }
    }
}

fn strip_terminal_bootstrap_output(output: &[u8], bootstrap: &TerminalBootstrap) -> Vec<u8> {
    let mut cleaned = output.to_vec();
    for pattern in [
        bootstrap.command.as_bytes(),
        bootstrap.started_marker.as_slice(),
        bootstrap.ready_marker.as_slice(),
    ] {
        while let Some(offset) = cleaned
            .windows(pattern.len())
            .position(|window| window == pattern)
        {
            cleaned.drain(offset..offset + pattern.len());
        }
    }
    cleaned
}

fn write_interactive_input(
    data: &[u8],
    should_exit: &AtomicBool,
    timeout: Duration,
    mut write: impl FnMut(&[u8]) -> io::Result<usize>,
) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    let mut written = 0;
    while written < data.len() {
        if should_exit.load(Ordering::Relaxed) {
            return Err(io::Error::new(
                ErrorKind::Interrupted,
                "Session disconnected",
            ));
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(ErrorKind::TimedOut, "SSH write timed out"));
        }
        match write(&data[written..]) {
            Ok(0) => return Err(io::Error::new(ErrorKind::WriteZero, "SSH channel closed")),
            Ok(count) => written += count,
            Err(error)
                if error.kind() == ErrorKind::TimedOut || error.kind() == ErrorKind::WouldBlock =>
            {
                let remaining = deadline.saturating_duration_since(Instant::now());
                std::thread::sleep(INTERACTIVE_SSH_WRITE_RETRY_INTERVAL.min(remaining));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[derive(Serialize, Clone)]
struct SudoPromptPayload {
    session_id: String,
    ready: bool,
    prompt_id: Option<String>,
}

fn emit_sudo_prompt(app: &AppHandle, session_id: &str, prompt_id: Option<String>) {
    let _ = app.emit(
        "ssh-sudo-prompt",
        SudoPromptPayload {
            session_id: session_id.to_string(),
            ready: prompt_id.is_some(),
            prompt_id,
        },
    );
}

fn verify_sudo_tty_echo(session: &Session, tty: Option<&str>) -> Result<(), String> {
    let tty = tty
        .filter(|tty| ssh_security::valid_sudo_tty(tty))
        .ok_or_else(|| "Sudo shortcut is unavailable for this terminal".to_string())?;
    let _reset = SftpSessionTimeoutReset::new(session, SUDO_TTY_CHECK_TIMEOUT_MILLISECONDS);
    let deadline =
        Instant::now() + Duration::from_millis(SUDO_TTY_CHECK_TIMEOUT_MILLISECONDS.into());
    let mut check = session
        .channel_session()
        .map_err(|_| "Could not verify sudo terminal echo".to_string())?;
    set_sudo_check_timeout(session, deadline)?;
    check
        .exec(&format!("LC_ALL=C stty -a < '{tty}'"))
        .map_err(|_| "Could not verify sudo terminal echo".to_string())?;
    let mut output = Vec::new();
    let mut buffer = [0u8; SUDO_TTY_CHECK_READ_BUFFER_BYTES];
    loop {
        set_sudo_check_timeout(session, deadline)?;
        let count = check
            .read(&mut buffer)
            .map_err(|_| "Could not verify sudo terminal echo".to_string())?;
        if count == 0 {
            break;
        }
        output.extend_from_slice(&buffer[..count]);
        if output.len() as u64 >= SUDO_TTY_CHECK_MAX_OUTPUT_BYTES {
            return Err("Could not verify sudo terminal echo".to_string());
        }
    }
    set_sudo_check_timeout(session, deadline)?;
    check
        .wait_close()
        .map_err(|_| "Could not verify sudo terminal echo".to_string())?;
    if output.len() as u64 == SUDO_TTY_CHECK_MAX_OUTPUT_BYTES
        || !check.eof()
        || check
            .exit_status()
            .map_err(|_| "Could not verify sudo terminal echo".to_string())?
            != 0
        || !ssh_security::tty_echo_is_disabled(&output)
    {
        return Err(
            "Sudo password was not sent because terminal echo is enabled or unverifiable"
                .to_string(),
        );
    }
    Ok(())
}

fn set_sudo_check_timeout(session: &Session, deadline: Instant) -> Result<(), String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("Sudo terminal echo verification timed out".to_string());
    }
    // libssh2 treats zero as an unlimited timeout.
    session
        .set_timeout((remaining.as_millis() as u32).max(MINIMUM_BOUNDED_SSH_TIMEOUT_MILLISECONDS));
    Ok(())
}

fn submit_sudo_password(
    session: &Arc<Mutex<Session>>,
    channel: &mut (impl Read + Write),
    should_exit: &AtomicBool,
    prompt: &Mutex<SudoPromptState>,
    identity: Option<&SudoIdentity>,
    tty: Option<&str>,
    prompt_id: &str,
    markers: &mut SudoMarkerParser,
    app: &AppHandle,
    session_id: &str,
) -> Result<(), String> {
    let identity =
        identity.ok_or_else(|| "Sudo shortcut is disabled for this connection".to_string())?;
    if should_exit.load(Ordering::Relaxed) {
        return Err("Session disconnected".to_string());
    }
    if !prompt
        .lock()
        .map_err(|_| "Sudo prompt lock failed".to_string())?
        .is_reserved(prompt_id, Instant::now())
    {
        return Err("Sudo password request is stale or no confirmed prompt is active".to_string());
    }
    {
        let session_guard = session
            .lock()
            .map_err(|_| "SSH session lock failed".to_string())?;
        verify_sudo_tty_echo(&session_guard, tty)?;
    }
    drain_sudo_output_before_submission(
        session,
        channel,
        should_exit,
        prompt,
        markers,
        app,
        session_id,
    )?;
    let mut prompt_guard = prompt
        .lock()
        .map_err(|_| "Sudo prompt lock failed".to_string())?;
    if should_exit.load(Ordering::Relaxed)
        || !prompt_guard.consume_reserved(prompt_id, Instant::now())
    {
        return Err("Sudo password request is stale or no confirmed prompt is active".to_string());
    }
    // Keep ordinary input from overtaking the final prompt check and channel write.
    let mut password = read_enabled_sudo_password(identity)?.into_bytes();
    password.push(b'\r');
    let result = write_interactive_input(
        &password,
        should_exit,
        INTERACTIVE_SSH_WRITE_TIMEOUT,
        |remaining| {
            let _session_guard = session.lock().unwrap();
            if should_exit.load(Ordering::Relaxed) {
                return Err(io::Error::new(
                    ErrorKind::Interrupted,
                    "Session disconnected",
                ));
            }
            channel.write(remaining)
        },
    );
    ssh_security::wipe_secret_bytes(&mut password);
    if result.is_err() {
        should_exit.store(true, Ordering::Relaxed);
        return Err("Failed to send sudo password; SSH connection was closed".to_string());
    }
    Ok(())
}

fn drain_sudo_output_before_submission(
    session: &Mutex<Session>,
    channel: &mut impl Read,
    should_exit: &AtomicBool,
    prompt: &Mutex<SudoPromptState>,
    markers: &mut SudoMarkerParser,
    app: &AppHandle,
    session_id: &str,
) -> Result<(), String> {
    use base64::Engine;
    let deadline =
        Instant::now() + Duration::from_millis(SUDO_TTY_CHECK_TIMEOUT_MILLISECONDS.into());
    let mut bytes_read = 0;
    let mut buffer = [0u8; SUDO_TTY_CHECK_READ_BUFFER_BYTES];
    loop {
        if Instant::now() >= deadline || bytes_read >= TERMINAL_BOOTSTRAP_MAX_OUTPUT_BYTES {
            return Err("Sudo prompt could not be confirmed before submission".to_string());
        }
        let read = {
            let _guard = session
                .lock()
                .map_err(|_| "SSH session lock failed".to_string())?;
            channel.read(&mut buffer)
        };
        match read {
            Ok(0) => {
                should_exit.store(true, Ordering::Relaxed);
                return Err("SSH session ended before sudo password submission".to_string());
            }
            Ok(count) => {
                bytes_read += count;
                let (output, events) = markers.push(&buffer[..count]);
                for event in events {
                    match event {
                        SudoOutputEvent::Ready => {
                            let id = prompt
                                .lock()
                                .map_err(|_| "Sudo prompt lock failed".to_string())?
                                .ready(Instant::now());
                            emit_sudo_prompt(app, session_id, Some(id));
                        }
                        SudoOutputEvent::Done => {
                            prompt
                                .lock()
                                .map_err(|_| "Sudo prompt lock failed".to_string())?
                                .invalidate();
                            emit_sudo_prompt(app, session_id, None);
                        }
                        SudoOutputEvent::Tty(_) => {}
                    }
                }
                if !output.is_empty() {
                    app.emit(
                        "ssh-output",
                        SshOutputPayload {
                            session_id: session_id.to_string(),
                            data: base64::engine::general_purpose::STANDARD.encode(output),
                        },
                    )
                    .map_err(|_| {
                        "Could not deliver SSH output before sudo password submission".to_string()
                    })?;
                }
            }
            Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {
                return Ok(())
            }
            Err(_) => {
                should_exit.store(true, Ordering::Relaxed);
                return Err("SSH connection failed before sudo password submission".to_string());
            }
        }
    }
}

#[tauri::command]
pub async fn send_sudo_password(
    state: State<'_, DbSessionMap>,
    session_id: String,
    prompt_id: String,
) -> Result<(), String> {
    send_sudo_password_to_session(&state, session_id, prompt_id).await
}

async fn send_sudo_password_to_session(
    state: &DbSessionMap,
    session_id: String,
    prompt_id: String,
) -> Result<(), String> {
    let (write_tx, prompt) = {
        let sessions = state
            .lock()
            .map_err(|_| "SSH sessions lock failed".to_string())?;
        let connection = sessions
            .get(&session_id)
            .ok_or_else(|| "Session not found".to_string())?;
        if connection.should_exit.load(Ordering::Relaxed) {
            return Err("Session disconnected".to_string());
        }
        if connection.sudo_identity.is_none() {
            return Err("Sudo shortcut is disabled for this connection".to_string());
        }
        connection
            .sudo_prompt
            .lock()
            .map_err(|_| "Sudo prompt lock failed".to_string())?
            .reserve(&prompt_id, Instant::now())?;
        (
            connection.write_tx.clone(),
            Arc::clone(&connection.sudo_prompt),
        )
    };
    let (completion, completed) = tokio::sync::oneshot::channel();
    if write_tx
        .send(SessionInput::SubmitSudo {
            prompt_id: prompt_id.clone(),
            completion,
        })
        .await
        .is_err()
    {
        prompt
            .lock()
            .map_err(|_| "Sudo prompt lock failed".to_string())?
            .invalidate();
        return Err("Session disconnected".to_string());
    }
    completed
        .await
        .map_err(|_| "SSH session ended before sudo password submission".to_string())?
}

#[tauri::command]
pub async fn write_ssh(
    app_handle: AppHandle,
    state: State<'_, DbSessionMap>,
    session_id: String,
    data_base64: String,
) -> Result<(), String> {
    use base64::Engine;

    let write_tx = ssh_input_sender(&state, &session_id)?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("Failed to decode base64 write data: {}", e))?;
    let prompt = {
        let sessions = state
            .lock()
            .map_err(|_| "SSH sessions lock failed".to_string())?;
        let connection = sessions
            .get(&session_id)
            .ok_or_else(|| "Session not found".to_string())?;
        Arc::clone(&connection.sudo_prompt)
    };
    if prompt
        .lock()
        .map_err(|_| "Sudo prompt lock failed".to_string())?
        .invalidate()
    {
        emit_sudo_prompt(&app_handle, &session_id, None);
    }
    write_tx
        .send(SessionInput::Write(decoded))
        .await
        .map_err(|e| format!("Failed to send write command: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn resize_ssh(
    state: State<'_, DbSessionMap>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let write_tx = ssh_input_sender(&state, &session_id)?;
    write_tx
        .send(SessionInput::Resize { cols, rows })
        .await
        .map_err(|e| format!("Failed to send resize command: {}", e))?;
    Ok(())
}

fn ssh_input_sender(
    state: &DbSessionMap,
    session_id: &str,
) -> Result<tokio::sync::mpsc::Sender<SessionInput>, String> {
    let map = state.lock().unwrap();
    let connection = map
        .get(session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    if connection.should_exit.load(Ordering::Relaxed) {
        return Err("Session disconnected".to_string());
    }
    Ok(connection.write_tx.clone())
}

#[tauri::command]
pub fn disconnect_ssh(state: State<'_, DbSessionMap>, session_id: String) -> Result<(), String> {
    disconnect_ssh_session(&state, &session_id);
    Ok(())
}

fn disconnect_ssh_session(state: &DbSessionMap, session_id: &str) {
    let connection = state.lock().unwrap().remove(session_id);
    if let Some(conn) = connection {
        conn.disconnect();
    }
}

#[derive(Serialize, Clone)]
pub struct RemoteFile {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

fn sftp_session_for(state: &DbSessionMap, session_id: &str) -> Result<Arc<Mutex<Session>>, String> {
    let map = state.lock().unwrap();
    map.get(session_id)
        .map(|connection| Arc::clone(&connection.session))
        .ok_or_else(|| "Session not found".to_string())
}

async fn run_sftp_task<T>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("SFTP task failed: {}", e))?
}

#[tauri::command]
pub async fn sftp_list_directory(
    state: State<'_, DbSessionMap>,
    session_id: String,
    path: String,
) -> Result<Vec<RemoteFile>, String> {
    let session = sftp_session_for(&state, &session_id)?;
    run_sftp_task(move || sftp_list_directory_internal(&session, &path)).await
}

fn sftp_list_directory_internal(
    session: &Arc<Mutex<Session>>,
    path: &str,
) -> Result<Vec<RemoteFile>, String> {
    let sess = session.lock().unwrap();
    let _timeout_reset = SftpSessionTimeoutReset::new(&sess, SFTP_DIRECTORY_TIMEOUT_MILLISECONDS);
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    let target_path = std::path::Path::new(path);
    let files = sftp
        .readdir(target_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut result = Vec::new();
    for (path_buf, stat) in files {
        let name = path_buf
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let path_str = path_buf.to_string_lossy().to_string();
        let is_dir = stat.is_dir();
        let size = stat.size.unwrap_or(0);

        result.push(RemoteFile {
            name,
            path: path_str,
            is_dir,
            size,
        });
    }

    // Sort directories first, then files alphabetically
    result.sort_by(|a, b| {
        if a.is_dir && !b.is_dir {
            std::cmp::Ordering::Less
        } else if !a.is_dir && b.is_dir {
            std::cmp::Ordering::Greater
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Ok(result)
}

#[tauri::command]
pub async fn sftp_resolve_path(
    state: State<'_, DbSessionMap>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let session = sftp_session_for(&state, &session_id)?;
    run_sftp_task(move || sftp_resolve_path_internal(&session, &path)).await
}

fn sftp_resolve_path_internal(session: &Arc<Mutex<Session>>, path: &str) -> Result<String, String> {
    let sess = session.lock().unwrap();
    let _timeout_reset = SftpSessionTimeoutReset::new(&sess, SFTP_DIRECTORY_TIMEOUT_MILLISECONDS);
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    sftp.realpath(std::path::Path::new(path))
        .map(|resolved_path| resolved_path.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to resolve directory path: {}", e))
}

#[tauri::command]
pub async fn sftp_download_file(
    state: State<'_, DbSessionMap>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let session = sftp_session_for(&state, &session_id)?;
    run_sftp_task(move || sftp_download_file_internal(&session, &remote_path, &local_path)).await
}

fn sftp_download_file_internal(
    session: &Arc<Mutex<Session>>,
    remote_path: &str,
    local_path: &str,
) -> Result<(), String> {
    use std::io::{Read, Write};

    let mut local_file = std::fs::File::create(local_path)
        .map_err(|e| format!("Failed to create local file: {}", e))?;

    let sess = session.lock().unwrap();
    let _timeout_reset = SftpSessionTimeoutReset::new(&sess, SFTP_TRANSFER_TIMEOUT_MILLISECONDS);
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    let mut remote_file = sftp
        .open(std::path::Path::new(remote_path))
        .map_err(|e| format!("Failed to open remote file: {}", e))?;

    let mut buf = [0u8; 16384];
    loop {
        match remote_file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                local_file
                    .write_all(&buf[..n])
                    .map_err(|e| format!("Failed to write to local file: {}", e))?;
            }
            Err(e) => return Err(format!("Failed to read remote file: {}", e)),
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn sftp_upload_file(
    state: State<'_, DbSessionMap>,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let session = sftp_session_for(&state, &session_id)?;
    run_sftp_task(move || sftp_upload_file_internal(&session, &local_path, &remote_path)).await
}

fn sftp_upload_file_internal(
    session: &Arc<Mutex<Session>>,
    local_path: &str,
    remote_path: &str,
) -> Result<(), String> {
    use std::io::{Read, Write};

    let mut local_file =
        std::fs::File::open(local_path).map_err(|e| format!("Failed to open local file: {}", e))?;

    let sess = session.lock().unwrap();
    let _timeout_reset = SftpSessionTimeoutReset::new(&sess, SFTP_TRANSFER_TIMEOUT_MILLISECONDS);
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    let mut remote_file = sftp
        .create(std::path::Path::new(remote_path))
        .map_err(|e| format!("Failed to create remote file: {}", e))?;

    let mut buf = [0u8; 16384];
    loop {
        match local_file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                remote_file
                    .write_all(&buf[..n])
                    .map_err(|e| format!("Failed to write to remote file: {}", e))?;
            }
            Err(e) => return Err(format!("Failed to read local file: {}", e)),
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn sftp_create_directory(
    state: State<'_, DbSessionMap>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let session = sftp_session_for(&state, &session_id)?;
    run_sftp_task(move || sftp_create_directory_internal(&session, &path)).await
}

fn sftp_create_directory_internal(session: &Arc<Mutex<Session>>, path: &str) -> Result<(), String> {
    let sess = session.lock().unwrap();
    let _timeout_reset = SftpSessionTimeoutReset::new(&sess, SFTP_DIRECTORY_TIMEOUT_MILLISECONDS);
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    sftp.mkdir(std::path::Path::new(path), 0o755)
        .map_err(|e| format!("Failed to create directory: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_delete_file(
    state: State<'_, DbSessionMap>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let session = sftp_session_for(&state, &session_id)?;
    run_sftp_task(move || sftp_delete_file_internal(&session, &path)).await
}

fn sftp_delete_file_internal(session: &Arc<Mutex<Session>>, path: &str) -> Result<(), String> {
    let sess = session.lock().unwrap();
    let _timeout_reset = SftpSessionTimeoutReset::new(&sess, SFTP_DIRECTORY_TIMEOUT_MILLISECONDS);
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    sftp.unlink(std::path::Path::new(path))
        .map_err(|e| format!("Failed to delete file: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_delete_directory(
    state: State<'_, DbSessionMap>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let session = sftp_session_for(&state, &session_id)?;
    run_sftp_task(move || sftp_delete_directory_internal(&session, &path)).await
}

fn sftp_delete_directory_internal(session: &Arc<Mutex<Session>>, path: &str) -> Result<(), String> {
    let sess = session.lock().unwrap();
    let _timeout_reset = SftpSessionTimeoutReset::new(&sess, SFTP_DIRECTORY_TIMEOUT_MILLISECONDS);
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    sftp.rmdir(std::path::Path::new(path))
        .map_err(|e| format!("Failed to delete directory: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn select_download_destination(filename: String) -> Result<Option<String>, String> {
    let file = rfd::FileDialog::new().set_file_name(&filename).save_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn select_upload_file() -> Result<Option<String>, String> {
    let file = rfd::FileDialog::new().pick_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[derive(Debug, Serialize, Clone)]
pub struct PortEntry {
    pub protocol: String,
    pub local_port: u16,
    pub state: String,
    pub pid: u32,
    pub process_name: String,
}

#[tauri::command]
pub fn list_listening_ports() -> Result<Vec<PortEntry>, String> {
    use std::collections::HashMap;
    use std::process::Command;

    let netstat = Command::new("netstat")
        .args(["-ano"])
        .output()
        .map_err(|e| format!("Failed to run netstat: {}", e))?;
    let netstat_out = String::from_utf8_lossy(&netstat.stdout).to_string();

    let tasklist = Command::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .output()
        .map_err(|e| format!("Failed to run tasklist: {}", e))?;
    let tasklist_out = String::from_utf8_lossy(&tasklist.stdout).to_string();

    let mut pid_to_name: HashMap<u32, String> = HashMap::new();
    for line in tasklist_out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // CSV: "name","pid","session","num","mem"
        let parts: Vec<&str> = line.splitn(6, ',').collect();
        if parts.len() >= 2 {
            let name = parts[0].trim_matches('"').to_string();
            if let Ok(pid) = parts[1].trim_matches('"').parse::<u32>() {
                pid_to_name.insert(pid, name);
            }
        }
    }

    let mut entries = Vec::new();
    for line in netstat_out.lines() {
        let line = line.trim();
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }
        let proto = parts[0];
        if proto != "TCP" && proto != "UDP" {
            continue;
        }
        if parts.len() < 4 {
            continue;
        }
        let local_addr = parts[1];
        let local_port = match local_addr.rfind(':') {
            Some(pos) => match local_addr[pos + 1..].parse::<u16>() {
                Ok(p) => p,
                Err(_) => continue,
            },
            None => continue,
        };
        let (state, pid_str) = if proto == "TCP" {
            if parts.len() < 5 {
                continue;
            }
            (parts[3].to_string(), parts[4])
        } else {
            (String::new(), parts[3])
        };
        let pid = match pid_str.parse::<u32>() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let process_name = pid_to_name
            .get(&pid)
            .cloned()
            .unwrap_or_else(|| format!("PID {}", pid));

        entries.push(PortEntry {
            protocol: proto.to_string(),
            local_port,
            state,
            pid,
            process_name,
        });
    }

    entries.sort_by_key(|e| e.local_port);
    Ok(entries)
}

#[tauri::command]
pub fn kill_port_process(pid: u32) -> Result<String, String> {
    use std::process::Command;

    let output = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .output()
        .map_err(|e| format!("Failed to run taskkill: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        Ok(stdout)
    } else {
        Err(if !stderr.is_empty() { stderr } else { stdout })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod enabled_sudo_password {
        use super::super::{read_enabled_sudo_password_from, sudo_identity, ConnectionProfile};
        use crate::ssh_security::{self, SudoIdentity, SudoPasswordEntry};
        use std::path::PathBuf;

        const FIXTURE_PREFIX: &str = "sleekssh-enabled-sudo-test-";
        const SAVED_PASSWORD: &str = "fixture-saved-sudo-secret";
        const UPDATED_PASSWORD: &str = "fixture-updated-sudo-secret";
        const CORRUPT_SECRET: &str = "fixture-corrupt-sudo-secret";
        const MAX_PASSWORD_BYTES: usize = 255;

        struct Fixture {
            root: PathBuf,
            directory: PathBuf,
        }

        impl Fixture {
            fn new() -> Self {
                let root = std::env::temp_dir().canonicalize().unwrap();
                let directory = root.join(format!(
                    "{FIXTURE_PREFIX}{}-{:016x}",
                    std::process::id(),
                    rand::random::<u64>()
                ));
                std::fs::create_dir(&directory).unwrap();
                Self { root, directory }
            }

            fn write_encrypted(&self, filename: &str, mut plaintext: Vec<u8>) {
                let encrypted = windows_dpapi::encrypt_data(&plaintext, windows_dpapi::Scope::User);
                ssh_security::wipe_secret_bytes(&mut plaintext);
                std::fs::write(self.directory.join(filename), encrypted.unwrap()).unwrap();
            }

            fn profiles(&self, profiles: &[ConnectionProfile]) {
                self.write_encrypted("connections.enc", serde_json::to_vec(profiles).unwrap());
            }

            fn password(&self, identity: &SudoIdentity, password: &str) {
                ssh_security::write_sudo_passwords(
                    &self.directory,
                    &[SudoPasswordEntry {
                        identity: identity.clone(),
                        password: password.to_string(),
                    }],
                )
                .unwrap();
            }

            fn assert_password(&self, identity: &SudoIdentity, expected: &str) {
                let mut actual = read_enabled_sudo_password_from(&self.directory, identity)
                    .unwrap()
                    .into_bytes();
                let matches = actual == expected.as_bytes();
                ssh_security::wipe_secret_bytes(&mut actual);
                assert!(matches, "Saved sudo password does not match the fixture");
            }

            fn assert_error(&self, identity: &SudoIdentity, expected: &str) {
                let error = read_enabled_sudo_password_from(&self.directory, identity).unwrap_err();
                assert!(
                    error.contains(expected),
                    "Unexpected saved sudo password error"
                );
                for secret in [SAVED_PASSWORD, UPDATED_PASSWORD, CORRUPT_SECRET] {
                    assert!(
                        !error.contains(secret),
                        "Saved sudo password error disclosed fixture data"
                    );
                }
            }
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                let directory = self.directory.canonicalize().unwrap();
                assert_eq!(directory.parent(), Some(self.root.as_path()));
                assert!(directory
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(FIXTURE_PREFIX)));
                assert!(directory.is_absolute());
                std::fs::remove_dir_all(directory).unwrap();
            }
        }

        fn profile() -> ConnectionProfile {
            ConnectionProfile {
                id: "fixture-profile".to_string(),
                name: "Fixture".to_string(),
                host: "fixture.example.invalid".to_string(),
                port: 22,
                username: "fixture-user".to_string(),
                key_path: String::new(),
                passphrase: None,
                password: None,
                use_password: false,
                namespace: None,
                sudo_shortcut_enabled: true,
                has_sudo_password: true,
            }
        }

        fn identities_with_one_field_changed(identity: &SudoIdentity) -> Vec<SudoIdentity> {
            vec![
                SudoIdentity {
                    profile_id: "another-profile".to_string(),
                    ..identity.clone()
                },
                SudoIdentity {
                    host: "another.example.invalid".to_string(),
                    ..identity.clone()
                },
                SudoIdentity {
                    port: identity.port + 1,
                    ..identity.clone()
                },
                SudoIdentity {
                    username: "another-user".to_string(),
                    ..identity.clone()
                },
            ]
        }

        #[test]
        fn exact_identity_reads_the_enabled_profiles_dpapi_password() {
            let fixture = Fixture::new();
            let profile = profile();
            let identity = sudo_identity(&profile);
            fixture.profiles(&[profile]);
            fixture.password(&identity, SAVED_PASSWORD);

            fixture.assert_password(&identity, SAVED_PASSWORD);
            let encrypted = std::fs::read(fixture.directory.join("sudo_passwords.enc")).unwrap();
            assert!(!encrypted
                .windows(SAVED_PASSWORD.len())
                .any(|bytes| bytes == SAVED_PASSWORD.as_bytes()));
        }

        #[test]
        fn each_changed_connection_identity_field_is_rejected_before_password_access() {
            let fixture = Fixture::new();
            let profile = profile();
            let identity = sudo_identity(&profile);
            fixture.profiles(&[profile]);
            fixture.password(&identity, SAVED_PASSWORD);

            for changed_identity in identities_with_one_field_changed(&identity) {
                fixture.assert_error(&changed_identity, "profile changed or was removed");
            }
        }

        #[test]
        fn disabled_removed_and_missing_profiles_cannot_read_a_saved_password() {
            let fixture = Fixture::new();
            let mut profile = profile();
            let identity = sudo_identity(&profile);
            fixture.password(&identity, SAVED_PASSWORD);

            fixture.assert_error(&identity, "profile changed or was removed");
            profile.sudo_shortcut_enabled = false;
            fixture.profiles(&[profile]);
            fixture.assert_error(&identity, "disabled");
            fixture.profiles(&[]);
            fixture.assert_error(&identity, "profile changed or was removed");
        }

        #[test]
        fn missing_vault_and_each_mismatched_vault_identity_are_rejected() {
            let fixture = Fixture::new();
            let profile = profile();
            let identity = sudo_identity(&profile);
            fixture.profiles(&[profile]);

            fixture.assert_error(&identity, "No saved sudo password");
            for changed_identity in identities_with_one_field_changed(&identity) {
                fixture.password(&changed_identity, SAVED_PASSWORD);
                fixture.assert_error(&identity, "No saved sudo password");
            }
        }

        #[test]
        fn invalid_passwords_in_the_encrypted_vault_fail_without_disclosure() {
            let fixture = Fixture::new();
            let profile = profile();
            let identity = sudo_identity(&profile);
            fixture.profiles(&[profile]);
            let oversized = format!("{CORRUPT_SECRET}{}", "x".repeat(MAX_PASSWORD_BYTES));
            for password in ["", "fixture-corrupt-sudo-secret\n", oversized.as_str()] {
                fixture.password(&identity, password);
                fixture.assert_error(&identity, "Sudo password");
            }
            ssh_security::wipe_secret_bytes(&mut oversized.into_bytes());
        }

        #[test]
        fn corrupt_or_malformed_encrypted_vault_data_fails_without_disclosure() {
            let fixture = Fixture::new();
            let profile = profile();
            let identity = sudo_identity(&profile);
            fixture.profiles(&[profile]);
            std::fs::write(
                fixture.directory.join("sudo_passwords.enc"),
                CORRUPT_SECRET.as_bytes(),
            )
            .unwrap();
            fixture.assert_error(&identity, "decrypt saved sudo passwords");
            fixture.write_encrypted("sudo_passwords.enc", CORRUPT_SECRET.as_bytes().to_vec());
            fixture.assert_error(&identity, "parse saved sudo passwords");
            fixture.write_encrypted(
                "sudo_passwords.enc",
                format!(r#"[{{"identity":"{CORRUPT_SECRET}","password":"{SAVED_PASSWORD}"}}]"#)
                    .into_bytes(),
            );
            fixture.assert_error(&identity, "parse saved sudo passwords");
        }

        #[test]
        fn corrupt_or_malformed_encrypted_connection_profiles_fail_without_disclosure() {
            let fixture = Fixture::new();
            let identity = sudo_identity(&profile());
            fixture.password(&identity, SAVED_PASSWORD);
            std::fs::write(
                fixture.directory.join("connections.enc"),
                CORRUPT_SECRET.as_bytes(),
            )
            .unwrap();
            fixture.assert_error(&identity, "decrypt config");
            fixture.write_encrypted("connections.enc", CORRUPT_SECRET.as_bytes().to_vec());
            fixture.assert_error(&identity, "parse config JSON");
        }

        #[test]
        fn saved_password_changes_removal_and_profile_changes_are_reread_each_use() {
            let fixture = Fixture::new();
            let mut profile = profile();
            let identity = sudo_identity(&profile);
            fixture.profiles(&[profile.clone()]);
            fixture.password(&identity, SAVED_PASSWORD);
            fixture.assert_password(&identity, SAVED_PASSWORD);

            fixture.password(&identity, UPDATED_PASSWORD);
            fixture.assert_password(&identity, UPDATED_PASSWORD);
            ssh_security::write_sudo_passwords(&fixture.directory, &[]).unwrap();
            fixture.assert_error(&identity, "No saved sudo password");
            fixture.password(&identity, SAVED_PASSWORD);
            fixture.assert_password(&identity, SAVED_PASSWORD);

            profile.sudo_shortcut_enabled = false;
            fixture.profiles(&[profile.clone()]);
            fixture.assert_error(&identity, "disabled");
            profile.sudo_shortcut_enabled = true;
            fixture.profiles(&[profile]);
            fixture.assert_password(&identity, SAVED_PASSWORD);
            fixture.profiles(&[]);
            fixture.assert_error(&identity, "profile changed or was removed");
        }
    }

    #[test]
    fn existing_profiles_default_to_disabled_sudo_shortcut_without_secret_metadata() {
        let profile: ConnectionProfile = serde_json::from_str(r#"{"id":"profile","name":"Dev","host":"host","port":22,"username":"developer","key_path":"","use_password":false}"#).unwrap();
        assert!(!profile.sudo_shortcut_enabled);
        assert!(!profile.has_sudo_password);
        let serialized = serde_json::to_value(&profile).unwrap();
        assert_eq!(serialized["sudo_shortcut_enabled"], false);
        assert_eq!(serialized["has_sudo_password"], false);
        assert!(serialized.get("sudo_password").is_none());
        let identity = sudo_identity(&profile);
        assert_eq!(identity.profile_id, "profile");
        assert_eq!(identity.host, "host");
        assert_eq!(identity.port, 22);
        assert_eq!(identity.username, "developer");
    }

    #[test]
    fn saving_sudo_password_rejects_invalid_input_before_any_storage_operation() {
        for password in ["", "secret\n", "secret\u{3}", "secret\u{7f}"] {
            let error = save_sudo_password("missing-profile".to_string(), password.to_string())
                .unwrap_err();
            assert!(!error.contains("secret"));
        }
        assert!(
            save_sudo_password("missing-profile".to_string(), "a".repeat(256))
                .unwrap_err()
                .contains("255")
        );
    }

    #[test]
    fn sudo_tty_verification_rejects_unknown_or_unsafe_paths_without_a_channel() {
        let session = Session::new().unwrap();
        for tty in [None, Some("/dev/pts/0;id"), Some("/dev/tty"), Some("")] {
            assert_eq!(
                verify_sudo_tty_echo(&session, tty).unwrap_err(),
                "Sudo shortcut is unavailable for this terminal"
            );
        }
        assert_eq!(
            set_sudo_check_timeout(&session, Instant::now()).unwrap_err(),
            "Sudo terminal echo verification timed out"
        );
    }

    fn sudo_test_connection(
        identity: Option<SudoIdentity>,
    ) -> (SshConnection, tokio::sync::mpsc::Receiver<SessionInput>) {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let tcp = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (write_tx, receiver) = tokio::sync::mpsc::channel(1);
        (
            SshConnection {
                session: Arc::new(Mutex::new(Session::new().unwrap())),
                tcp,
                write_tx,
                should_exit: Arc::new(AtomicBool::new(false)),
                sudo_identity: identity,
                sudo_prompt: Arc::new(Mutex::new(SudoPromptState::default())),
            },
            receiver,
        )
    }

    #[tokio::test]
    async fn sudo_submission_rejects_missing_disabled_disconnected_and_unconfirmed_sessions() {
        let state = Mutex::new(std::collections::HashMap::new());
        assert_eq!(
            send_sudo_password_to_session(&state, "missing".to_string(), "prompt".to_string())
                .await
                .unwrap_err(),
            "Session not found"
        );
        let (connection, _receiver) = sudo_test_connection(None);
        state
            .lock()
            .unwrap()
            .insert("disabled".to_string(), connection);
        assert_eq!(
            send_sudo_password_to_session(&state, "disabled".to_string(), "prompt".to_string())
                .await
                .unwrap_err(),
            "Sudo shortcut is disabled for this connection"
        );
        let identity = SudoIdentity {
            profile_id: "profile".to_string(),
            host: "host".to_string(),
            port: 22,
            username: "developer".to_string(),
        };
        let (connection, _receiver) = sudo_test_connection(Some(identity));
        state
            .lock()
            .unwrap()
            .insert("enabled".to_string(), connection);
        assert!(
            send_sudo_password_to_session(&state, "enabled".to_string(), "prompt".to_string())
                .await
                .unwrap_err()
                .contains("no confirmed prompt")
        );
        state
            .lock()
            .unwrap()
            .get("enabled")
            .unwrap()
            .should_exit
            .store(true, Ordering::Relaxed);
        assert_eq!(
            send_sudo_password_to_session(&state, "enabled".to_string(), "prompt".to_string())
                .await
                .unwrap_err(),
            "Session disconnected"
        );
    }

    #[tokio::test]
    async fn queued_sudo_submission_contains_only_prompt_id_and_manual_input_cancels_it() {
        let identity = SudoIdentity {
            profile_id: "profile".to_string(),
            host: "host".to_string(),
            port: 22,
            username: "developer".to_string(),
        };
        let (connection, mut receiver) = sudo_test_connection(Some(identity));
        let prompt = Arc::clone(&connection.sudo_prompt);
        let id = prompt.lock().unwrap().ready(Instant::now());
        let state = Mutex::new(std::collections::HashMap::from([(
            "session".to_string(),
            connection,
        )]));
        let submit = send_sudo_password_to_session(&state, "session".to_string(), id.clone());
        let process = async {
            let SessionInput::SubmitSudo {
                prompt_id,
                completion,
            } = receiver.recv().await.unwrap()
            else {
                panic!("Raw password must never be queued as ordinary terminal input");
            };
            assert_eq!(prompt_id, id);
            assert!(prompt
                .lock()
                .unwrap()
                .is_reserved(&prompt_id, Instant::now()));
            prompt.lock().unwrap().invalidate();
            assert!(!prompt
                .lock()
                .unwrap()
                .consume_reserved(&prompt_id, Instant::now()));
            completion
                .send(Err(
                    "Manual input cancelled sudo password submission".to_string()
                ))
                .unwrap();
        };
        let (result, ()) = tokio::join!(submit, process);
        assert_eq!(
            result.unwrap_err(),
            "Manual input cancelled sudo password submission"
        );
    }

    struct BootstrapChannel {
        reads: std::collections::VecDeque<io::Result<Vec<u8>>>,
        written: Vec<u8>,
    }

    impl Read for BootstrapChannel {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let Some(chunk) = self.reads.pop_front() else {
                return Ok(0);
            };
            let mut chunk = chunk?;
            let count = buffer.len().min(chunk.len());
            buffer[..count].copy_from_slice(&chunk[..count]);
            if count < chunk.len() {
                let remaining = chunk.split_off(count);
                self.reads.push_front(Ok(remaining));
            }
            Ok(count)
        }
    }

    impl Write for BootstrapChannel {
        fn write(&mut self, data: &[u8]) -> io::Result<usize> {
            self.written.extend_from_slice(data);
            Ok(data.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn terminal_setup_accepts_missing_empty_and_single_line_input() {
        for setup in [None, Some(String::new()), Some(" \t ".to_string())] {
            assert!(validate_terminal_setup(setup).unwrap().is_none());
        }
        let setup = " if [ -n \"${BASH_VERSION-}\" ]; then printf 'directory'; fi";
        assert_eq!(
            validate_terminal_setup(Some(setup.to_string())).unwrap(),
            Some(setup.to_string())
        );
    }

    #[test]
    fn terminal_setup_rejects_control_delimiters() {
        for setup in ["echo first\necho second", "echo first\r", "echo\0first"] {
            assert!(validate_terminal_setup(Some(setup.to_string())).is_err());
        }
    }

    #[test]
    fn terminal_setup_enforces_the_canonical_terminal_byte_limit() {
        let maximum = "a".repeat(TERMINAL_SETUP_MAX_BYTES);
        assert!(validate_terminal_setup(Some(maximum)).is_ok());
        assert!(validate_terminal_setup(Some("a".repeat(TERMINAL_SETUP_MAX_BYTES + 1))).is_err());
        assert!(validate_terminal_setup(Some("é".repeat(TERMINAL_SETUP_MAX_BYTES))).is_err());
    }

    #[test]
    fn terminal_bootstrap_reads_the_script_without_sending_it_through_the_line_editor() {
        let setup = "printf 'PRIVATE_SETUP'; cd '/srv/project with spaces'";
        let bootstrap = create_terminal_bootstrap(setup, 1);

        assert!(!bootstrap.command.contains(setup));
        assert!(bootstrap.command.contains("IFS= read -r __sleekssh_setup"));
        assert!(bootstrap.command.contains("eval \"$__sleekssh_setup\""));
        assert!(bootstrap.command.contains("stty echo && printf"));
        assert_eq!(bootstrap.payload, format!("{setup}\n").as_bytes());
        assert_eq!(
            bootstrap.started_marker,
            b"\x1b]9;sleekssh-0000000000000001-start\x07"
        );
        assert_ne!(bootstrap.started_marker, bootstrap.ready_marker);
    }

    #[test]
    fn terminal_bootstrap_output_preserves_banner_utf8_errors_and_directory_reports() {
        let bootstrap = create_terminal_bootstrap("printf directory", 1);
        let banner = "Welcome, José\r\n$ ";
        let setup_output = b"\r\ncd: missing directory\r\n\x1b]7;file://host/home/user\x07";
        let trailing_prompt = b"\x1b[?2004h$ ";
        let output = [
            banner.as_bytes(),
            bootstrap.command.as_bytes(),
            b"\r\n",
            &bootstrap.started_marker,
            setup_output,
            &bootstrap.ready_marker,
            trailing_prompt,
        ]
        .concat();

        assert_eq!(
            strip_terminal_bootstrap_output(&output, &bootstrap),
            [banner.as_bytes(), b"\r\n", setup_output, trailing_prompt].concat()
        );
        assert!(strip_terminal_bootstrap_output(&[], &bootstrap).is_empty());
    }

    #[test]
    fn terminal_bootstrap_waits_for_split_markers_and_sends_the_payload_once() {
        let bootstrap = create_terminal_bootstrap("printf setup", 1);
        let split = bootstrap.started_marker.len() / 2;
        let ready_split = bootstrap.ready_marker.len() / 2;
        let mut channel = BootstrapChannel {
            reads: [
                Ok([b"BANNER\r\n".as_slice(), &bootstrap.started_marker[..split]].concat()),
                Err(io::Error::from(ErrorKind::TimedOut)),
                Ok(bootstrap.started_marker[split..].to_vec()),
                Ok([
                    b"SETUP\r\n".as_slice(),
                    &bootstrap.ready_marker[..ready_split],
                ]
                .concat()),
                Ok([&bootstrap.ready_marker[ready_split..], b"$ "].concat()),
            ]
            .into(),
            written: Vec::new(),
        };

        let output =
            initialize_terminal_bootstrap(&mut channel, &bootstrap, INTERACTIVE_SSH_WRITE_TIMEOUT)
                .unwrap();

        assert_eq!(output, b"BANNER\r\nSETUP\r\n$ ");
        assert_eq!(
            channel.written,
            [
                format!("{}\n", bootstrap.command).as_bytes(),
                &bootstrap.payload
            ]
            .concat()
        );
    }

    #[test]
    fn terminal_bootstrap_never_sends_the_setup_before_echo_is_disabled() {
        let bootstrap = create_terminal_bootstrap("printf setup", 1);
        let mut channel = BootstrapChannel {
            reads: [Ok(b"BANNER\r\n$ ".to_vec())].into(),
            written: Vec::new(),
        };

        let error =
            initialize_terminal_bootstrap(&mut channel, &bootstrap, INTERACTIVE_SSH_WRITE_TIMEOUT)
                .unwrap_err();

        assert_eq!(error.kind(), ErrorKind::UnexpectedEof);
        assert_eq!(
            channel.written,
            format!("{}\n", bootstrap.command).as_bytes()
        );
    }

    #[test]
    fn terminal_bootstrap_rejects_excess_output_and_expired_timeouts() {
        let bootstrap = create_terminal_bootstrap("printf setup", 1);
        let mut excessive_output = BootstrapChannel {
            reads: [Ok(vec![b'a'; TERMINAL_BOOTSTRAP_MAX_OUTPUT_BYTES + 1])].into(),
            written: Vec::new(),
        };
        assert_eq!(
            initialize_terminal_bootstrap(
                &mut excessive_output,
                &bootstrap,
                INTERACTIVE_SSH_WRITE_TIMEOUT,
            )
            .unwrap_err()
            .kind(),
            ErrorKind::InvalidData
        );
        let mut expired = BootstrapChannel {
            reads: std::collections::VecDeque::new(),
            written: Vec::new(),
        };
        assert_eq!(
            initialize_terminal_bootstrap(&mut expired, &bootstrap, Duration::ZERO)
                .unwrap_err()
                .kind(),
            ErrorKind::TimedOut
        );
        assert!(expired.written.is_empty());
    }

    #[test]
    fn terminal_bootstrap_propagates_fatal_read_errors() {
        let bootstrap = create_terminal_bootstrap("printf setup", 1);
        let mut channel = BootstrapChannel {
            reads: [Err(io::Error::from(ErrorKind::ConnectionReset))].into(),
            written: Vec::new(),
        };
        assert_eq!(
            initialize_terminal_bootstrap(&mut channel, &bootstrap, INTERACTIVE_SSH_WRITE_TIMEOUT)
                .unwrap_err()
                .kind(),
            ErrorKind::ConnectionReset
        );
    }

    #[test]
    fn interactive_write_accepts_empty_input_without_writing() {
        let should_exit = AtomicBool::new(false);

        let result = write_interactive_input(&[], &should_exit, Duration::ZERO, |_| {
            panic!("Empty input must not write to the channel")
        });

        assert!(result.is_ok());
    }

    #[test]
    fn interactive_write_retries_transient_errors_and_preserves_partial_progress() {
        let should_exit = AtomicBool::new(false);
        let mut attempts = 0;
        let mut received = Vec::new();

        let result = write_interactive_input(
            b"hello",
            &should_exit,
            INTERACTIVE_SSH_WRITE_TIMEOUT,
            |remaining| {
                attempts += 1;
                match attempts {
                    1 => Err(io::Error::from(ErrorKind::WouldBlock)),
                    2 => {
                        received.extend_from_slice(&remaining[..2]);
                        Ok(2)
                    }
                    3 => Err(io::Error::from(ErrorKind::TimedOut)),
                    _ => {
                        received.extend_from_slice(remaining);
                        Ok(remaining.len())
                    }
                }
            },
        );

        assert!(result.is_ok());
        assert_eq!(received, b"hello");
        assert_eq!(attempts, 4);
    }

    #[test]
    fn interactive_write_rejects_a_closed_channel() {
        let should_exit = AtomicBool::new(false);

        let result = write_interactive_input(
            b"hello",
            &should_exit,
            INTERACTIVE_SSH_WRITE_TIMEOUT,
            |_| Ok(0),
        );

        assert_eq!(result.unwrap_err().kind(), ErrorKind::WriteZero);
    }

    #[test]
    fn interactive_write_returns_fatal_errors_without_retrying() {
        let should_exit = AtomicBool::new(false);
        let mut attempts = 0;

        let result = write_interactive_input(
            b"hello",
            &should_exit,
            INTERACTIVE_SSH_WRITE_TIMEOUT,
            |_| {
                attempts += 1;
                Err(io::Error::from(ErrorKind::BrokenPipe))
            },
        );

        assert_eq!(result.unwrap_err().kind(), ErrorKind::BrokenPipe);
        assert_eq!(attempts, 1);
    }

    #[test]
    fn interactive_write_stops_when_already_disconnected() {
        let should_exit = AtomicBool::new(true);

        let result = write_interactive_input(
            b"hello",
            &should_exit,
            INTERACTIVE_SSH_WRITE_TIMEOUT,
            |_| panic!("Disconnected sessions must not write"),
        );

        assert_eq!(result.unwrap_err().kind(), ErrorKind::Interrupted);
    }

    #[test]
    fn interactive_write_stops_if_disconnected_during_retry() {
        let should_exit = AtomicBool::new(false);
        let mut attempts = 0;

        let result = write_interactive_input(
            b"hello",
            &should_exit,
            INTERACTIVE_SSH_WRITE_TIMEOUT,
            |_| {
                attempts += 1;
                should_exit.store(true, Ordering::Relaxed);
                Err(io::Error::from(ErrorKind::WouldBlock))
            },
        );

        assert_eq!(result.unwrap_err().kind(), ErrorKind::Interrupted);
        assert_eq!(attempts, 1);
    }

    #[test]
    fn interactive_write_fails_when_the_retry_deadline_expires() {
        let should_exit = AtomicBool::new(false);
        let timeout = Duration::from_millis(1);

        let result = write_interactive_input(b"hello", &should_exit, timeout, |_| {
            Err(io::Error::from(ErrorKind::WouldBlock))
        });

        assert_eq!(result.unwrap_err().kind(), ErrorKind::TimedOut);
    }

    #[test]
    fn interactive_write_with_no_time_remaining_does_not_write() {
        let should_exit = AtomicBool::new(false);

        let result = write_interactive_input(b"hello", &should_exit, Duration::ZERO, |_| {
            panic!("Expired writes must not reach the channel")
        });

        assert_eq!(result.unwrap_err().kind(), ErrorKind::TimedOut);
    }

    #[test]
    fn disconnect_ssh_session_tolerates_missing_and_repeated_cleanup() {
        use std::collections::HashMap;
        use std::net::{TcpListener, TcpStream};

        let state = Mutex::new(HashMap::new());
        disconnect_ssh_session(&state, "");
        disconnect_ssh_session(&state, "missing");

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let tcp = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let should_exit = Arc::new(AtomicBool::new(false));
        let (write_tx, _write_rx) = tokio::sync::mpsc::channel(1);
        state.lock().unwrap().insert(
            "active".to_string(),
            SshConnection {
                session: Arc::new(Mutex::new(Session::new().unwrap())),
                tcp,
                write_tx,
                should_exit: Arc::clone(&should_exit),
                sudo_identity: None,
                sudo_prompt: Arc::new(Mutex::new(SudoPromptState::default())),
            },
        );

        disconnect_ssh_session(&state, "active");
        disconnect_ssh_session(&state, "active");

        assert!(should_exit.load(Ordering::Relaxed));
        assert!(state.lock().unwrap().is_empty());
    }

    #[test]
    fn ssh_input_sender_rejects_missing_or_disconnected_sessions() {
        use std::collections::HashMap;
        use std::net::{TcpListener, TcpStream};

        let state = Mutex::new(HashMap::new());
        assert_eq!(
            ssh_input_sender(&state, "").unwrap_err(),
            "Session not found"
        );
        assert_eq!(
            ssh_input_sender(&state, "missing").unwrap_err(),
            "Session not found"
        );

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let tcp = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let should_exit = Arc::new(AtomicBool::new(false));
        let (write_tx, _write_rx) = tokio::sync::mpsc::channel(1);
        state.lock().unwrap().insert(
            "active".to_string(),
            SshConnection {
                session: Arc::new(Mutex::new(Session::new().unwrap())),
                tcp,
                write_tx,
                should_exit: Arc::clone(&should_exit),
                sudo_identity: None,
                sudo_prompt: Arc::new(Mutex::new(SudoPromptState::default())),
            },
        );

        assert!(ssh_input_sender(&state, "active").is_ok());
        should_exit.store(true, Ordering::Relaxed);
        assert_eq!(
            ssh_input_sender(&state, "active").unwrap_err(),
            "Session disconnected"
        );
    }

    #[test]
    fn sftp_timeouts_allow_remote_operations_to_wait_longer_than_terminal_polls() {
        assert!(SFTP_DIRECTORY_TIMEOUT_MILLISECONDS > INTERACTIVE_SSH_TIMEOUT_MILLISECONDS);
        assert!(SFTP_TRANSFER_TIMEOUT_MILLISECONDS > SFTP_DIRECTORY_TIMEOUT_MILLISECONDS);
    }

    #[tokio::test]
    async fn run_sftp_task_returns_the_background_task_result() {
        let result = run_sftp_task(|| Ok("completed".to_string())).await;

        assert_eq!(result.unwrap(), "completed");
    }
}
