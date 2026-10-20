use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub(crate) const SUDO_PROMPT_LIFETIME: Duration = Duration::from_secs(30);
const SUDO_PASSWORD_MAX_BYTES: usize = 255;
const HOST_KEY_MAX_BYTES: usize = 64 * 1024;
const HOST_NAME_MAX_BYTES: usize = 253;
static SECURITY_STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct SudoIdentity {
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct SudoPasswordEntry {
    pub identity: SudoIdentity,
    pub password: String,
}

impl Drop for SudoPasswordEntry {
    fn drop(&mut self) {
        let mut password = std::mem::take(&mut self.password).into_bytes();
        wipe_secret_bytes(&mut password);
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct TrustedHostKey {
    host: String,
    port: u16,
    key_base64: String,
}

#[derive(Serialize)]
struct HostKeyDetails<'a> {
    host: &'a str,
    port: u16,
    key_type: String,
    fingerprint: String,
    key_base64: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_fingerprint: Option<String>,
}

pub(crate) fn lock_security_store() -> Result<MutexGuard<'static, ()>, String> {
    SECURITY_STORE_LOCK
        .lock()
        .map_err(|_| "SSH security store lock failed".to_string())
}

pub(crate) fn configuration_directory() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|path| path.join("TauriSshTerminal"))
        .ok_or_else(|| "Could not find config directory".to_string())
}

pub(crate) fn validate_sudo_password(password: &str) -> Result<(), String> {
    if password.is_empty() {
        return Err("Sudo password must not be empty".to_string());
    }
    if password.chars().any(char::is_control) {
        return Err("Sudo password must not contain control characters".to_string());
    }
    if password.len() > SUDO_PASSWORD_MAX_BYTES {
        return Err(format!(
            "Sudo password exceeds {SUDO_PASSWORD_MAX_BYTES} bytes"
        ));
    }
    Ok(())
}

pub(crate) fn read_sudo_passwords(directory: &Path) -> Result<Vec<SudoPasswordEntry>, String> {
    let file = directory.join("sudo_passwords.enc");
    if !file.exists() {
        return Ok(Vec::new());
    }
    let encrypted =
        std::fs::read(file).map_err(|_| "Failed to read saved sudo passwords".to_string())?;
    let mut decrypted = windows_dpapi::decrypt_data(&encrypted, windows_dpapi::Scope::User)
        .map_err(|_| "Failed to decrypt saved sudo passwords".to_string())?;
    let parsed = serde_json::from_slice(&decrypted)
        .map_err(|_| "Failed to parse saved sudo passwords".to_string());
    wipe_secret_bytes(&mut decrypted);
    parsed
}

pub(crate) fn write_sudo_passwords(
    directory: &Path,
    entries: &[SudoPasswordEntry],
) -> Result<(), String> {
    std::fs::create_dir_all(directory)
        .map_err(|_| "Failed to create sudo password storage".to_string())?;
    let mut serialized = serde_json::to_vec(entries)
        .map_err(|_| "Failed to serialize saved sudo passwords".to_string())?;
    let encrypted = windows_dpapi::encrypt_data(&serialized, windows_dpapi::Scope::User)
        .map_err(|_| "Failed to encrypt saved sudo passwords".to_string());
    wipe_secret_bytes(&mut serialized);
    std::fs::write(directory.join("sudo_passwords.enc"), encrypted?)
        .map_err(|_| "Failed to write saved sudo passwords".to_string())
}

pub(crate) fn wipe_secret_bytes(bytes: &mut [u8]) {
    for byte in bytes {
        // Volatile writes prevent the compiler from removing a wipe before deallocation.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

pub(crate) fn reconcile_sudo_passwords(
    entries: Vec<SudoPasswordEntry>,
    identities: &[SudoIdentity],
) -> Vec<SudoPasswordEntry> {
    entries
        .into_iter()
        .filter(|entry| identities.contains(&entry.identity))
        .collect()
}

fn canonical_host(host: &str, port: u16) -> Result<String, String> {
    if host.is_empty()
        || host.len() > HOST_NAME_MAX_BYTES
        || host
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        || port == 0
    {
        return Err("Invalid SSH host or port".to_string());
    }
    Ok(host.to_ascii_lowercase())
}

fn decode_host_key(key_base64: &str) -> Result<ssh_key::PublicKey, String> {
    if key_base64.len() > HOST_KEY_MAX_BYTES {
        return Err("SSH host key exceeds the size limit".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(key_base64)
        .map_err(|_| "Invalid SSH host key encoding".to_string())?;
    ssh_key::PublicKey::from_bytes(&bytes).map_err(|_| "Invalid SSH host key".to_string())
}

pub(crate) fn read_trusted_hosts(directory: &Path) -> Result<Vec<TrustedHostKey>, String> {
    let file = directory.join("trusted_ssh_hosts.json");
    if !file.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(file).map_err(|_| "Failed to read trusted SSH hosts".to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "Failed to parse trusted SSH hosts".to_string())
}

pub(crate) fn check_host_key(
    entries: &[TrustedHostKey],
    host: &str,
    port: u16,
    key_bytes: &[u8],
) -> Result<(), String> {
    let canonical = canonical_host(host, port)?;
    let key_base64 = base64::engine::general_purpose::STANDARD.encode(key_bytes);
    let key = decode_host_key(&key_base64)?;
    let trusted = entries
        .iter()
        .find(|entry| entry.host == canonical && entry.port == port);
    if trusted.is_some_and(|entry| entry.key_base64 == key_base64) {
        return Ok(());
    }
    let expected_fingerprint = trusted
        .map(|entry| {
            decode_host_key(&entry.key_base64)
                .map(|key| key.fingerprint(ssh_key::HashAlg::Sha256).to_string())
        })
        .transpose()?;
    let details = HostKeyDetails {
        host,
        port,
        key_type: key.algorithm().to_string(),
        fingerprint: key.fingerprint(ssh_key::HashAlg::Sha256).to_string(),
        key_base64,
        expected_fingerprint,
    };
    let prefix = if trusted.is_some() {
        "SSH_HOST_KEY_CHANGED:"
    } else {
        "SSH_HOST_TRUST_REQUIRED:"
    };
    let json = serde_json::to_string(&details)
        .map_err(|_| "Failed to serialize SSH host identity".to_string())?;
    Err(format!("{prefix}{json}"))
}

pub(crate) fn trust_host_key(
    entries: &mut Vec<TrustedHostKey>,
    host: &str,
    port: u16,
    key_base64: &str,
) -> Result<(), String> {
    let canonical = canonical_host(host, port)?;
    decode_host_key(key_base64)?;
    if let Some(entry) = entries
        .iter()
        .find(|entry| entry.host == canonical && entry.port == port)
    {
        return if entry.key_base64 == key_base64 {
            Ok(())
        } else {
            Err(
                "An SSH key is already trusted for this host; changed keys cannot be accepted here"
                    .to_string(),
            )
        };
    }
    entries.push(TrustedHostKey {
        host: canonical,
        port,
        key_base64: key_base64.to_string(),
    });
    Ok(())
}

pub(crate) fn write_trusted_hosts(
    directory: &Path,
    entries: &[TrustedHostKey],
) -> Result<(), String> {
    std::fs::create_dir_all(directory)
        .map_err(|_| "Failed to create SSH trust storage".to_string())?;
    let bytes = serde_json::to_vec(entries)
        .map_err(|_| "Failed to serialize trusted SSH hosts".to_string())?;
    std::fs::write(directory.join("trusted_ssh_hosts.json"), bytes)
        .map_err(|_| "Failed to write trusted SSH hosts".to_string())
}

#[derive(Default)]
pub(crate) struct SudoPromptState {
    prompt_id: Option<String>,
    expires_at: Option<Instant>,
    reserved: bool,
}

impl SudoPromptState {
    pub(crate) fn ready(&mut self, now: Instant) -> String {
        let prompt_id = format!("{:032x}", rand::random::<u128>());
        self.prompt_id = Some(prompt_id.clone());
        self.expires_at = Some(now + SUDO_PROMPT_LIFETIME);
        self.reserved = false;
        prompt_id
    }

    pub(crate) fn invalidate(&mut self) -> bool {
        let was_ready = self.prompt_id.is_some();
        self.prompt_id = None;
        self.expires_at = None;
        self.reserved = false;
        was_ready
    }

    pub(crate) fn expire(&mut self, now: Instant) -> bool {
        if self.expires_at.is_some_and(|deadline| now >= deadline) {
            return self.invalidate();
        }
        false
    }

    pub(crate) fn reserve(&mut self, prompt_id: &str, now: Instant) -> Result<(), String> {
        self.expire(now);
        if self.reserved || self.prompt_id.as_deref() != Some(prompt_id) {
            return Err(
                "Sudo password request is stale or no confirmed prompt is active".to_string(),
            );
        }
        self.reserved = true;
        Ok(())
    }

    pub(crate) fn consume_reserved(&mut self, prompt_id: &str, now: Instant) -> bool {
        self.expire(now);
        if !self.reserved || self.prompt_id.as_deref() != Some(prompt_id) {
            return false;
        }
        self.invalidate();
        true
    }

    pub(crate) fn is_reserved(&mut self, prompt_id: &str, now: Instant) -> bool {
        self.expire(now);
        self.reserved && self.prompt_id.as_deref() == Some(prompt_id)
    }
}

pub(crate) struct SudoMarkerParser {
    ready_marker: Vec<u8>,
    done_marker: Vec<u8>,
    tty_marker_prefix: Vec<u8>,
    pending: Vec<u8>,
}

#[derive(PartialEq, Eq, Debug)]
pub(crate) enum SudoOutputEvent {
    Ready,
    Done,
    Tty(String),
}

impl SudoMarkerParser {
    pub(crate) fn new(nonce: u128) -> Self {
        Self {
            ready_marker: format!("\x1b]9;sleekssh-sudo-{nonce:032x}-ready\x07").into_bytes(),
            done_marker: format!("\x1b]9;sleekssh-sudo-{nonce:032x}-done\x07").into_bytes(),
            tty_marker_prefix: format!("\x1b]9;sleekssh-sudo-{nonce:032x}-tty;").into_bytes(),
            pending: Vec::new(),
        }
    }

    pub(crate) fn push(&mut self, data: &[u8]) -> (Vec<u8>, Vec<SudoOutputEvent>) {
        self.pending.extend_from_slice(data);
        let mut output = Vec::new();
        let mut events = Vec::new();
        loop {
            let marker = [(&self.ready_marker, true), (&self.done_marker, false)]
                .into_iter()
                .filter_map(|(marker, ready)| {
                    self.pending
                        .windows(marker.len())
                        .position(|window| window == marker)
                        .map(|offset| (offset, marker.len(), ready))
                })
                .min_by_key(|(offset, _, _)| *offset);
            let tty_offset = self
                .pending
                .windows(self.tty_marker_prefix.len())
                .position(|window| window == self.tty_marker_prefix);
            if let Some(offset) =
                tty_offset.filter(|offset| marker.is_none_or(|marker| *offset < marker.0))
            {
                output.extend(self.pending.drain(..offset));
                let prefix_length = self.tty_marker_prefix.len();
                if let Some(end) = self.pending[prefix_length..]
                    .iter()
                    .position(|byte| *byte == 7)
                {
                    let tty_bytes = &self.pending[prefix_length..prefix_length + end];
                    if let Ok(tty) = std::str::from_utf8(tty_bytes) {
                        if valid_sudo_tty(tty) {
                            events.push(SudoOutputEvent::Tty(tty.to_string()));
                        }
                    }
                    self.pending.drain(..prefix_length + end + 1);
                    continue;
                }
                if self.pending.len() > prefix_length + SUDO_TTY_MAX_BYTES {
                    output.extend(self.pending.drain(..));
                }
                return (output, events);
            }
            if let Some((offset, length, ready)) = marker {
                output.extend(self.pending.drain(..offset));
                self.pending.drain(..length);
                events.push(if ready {
                    SudoOutputEvent::Ready
                } else {
                    SudoOutputEvent::Done
                });
                continue;
            }
            let retained = (1..=self
                .pending
                .len()
                .min(self.ready_marker.len().max(self.done_marker.len()) - 1))
                .rev()
                .find(|length| {
                    let suffix = &self.pending[self.pending.len() - length..];
                    self.ready_marker.starts_with(suffix)
                        || self.done_marker.starts_with(suffix)
                        || self.tty_marker_prefix.starts_with(suffix)
                })
                .unwrap_or(0);
            output.extend(self.pending.drain(..self.pending.len() - retained));
            return (output, events);
        }
    }
}

pub(crate) fn create_sudo_shell_setup(nonce: u128) -> String {
    let ready = format!("9;sleekssh-sudo-{nonce:032x}-ready");
    let done = format!("9;sleekssh-sudo-{nonce:032x}-done");
    let tty = format!("9;sleekssh-sudo-{nonce:032x}-tty;");
    let definition = format!("sudo() {{ local __sleekssh_arg __sleekssh_status __sleekssh_value=0 __sleekssh_skip=0; case \"$-\" in *x*) command sudo \"$@\"; return $? ;; esac; for __sleekssh_arg in \"$@\"; do if [ \"$__sleekssh_value\" = 1 ]; then __sleekssh_value=0; continue; fi; case \"$__sleekssh_arg\" in --) break ;; --prompt|--prompt=*|--askpass|--stdin|--non-interactive) __sleekssh_skip=1; break ;; --user|--group|--host|--close-from|--chdir|--chroot|--role|--type|--command-timeout|--other-user|-u|-g|-h|-C|-D|-R|-r|-t|-T) __sleekssh_value=1 ;; --user=*|--group=*|--host=*|--close-from=*|--chdir=*|--chroot=*|--role=*|--type=*|--command-timeout=*|--other-user=*|--preserve-env|--preserve-env=*|--set-home|--background|--bell|--reset-timestamp|--remove-timestamp|--list|--validate|--version|--shell|--login|--preserve-groups) ;; --*) __sleekssh_skip=1; break ;; -*) case \"${{__sleekssh_arg#-}}\" in *[pASn]*) __sleekssh_skip=1; break ;; [ugCDRrtT]?*) ;; *[!EHbBklvVsiKP]*) __sleekssh_skip=1; break ;; esac ;; *=*) ;; *) break ;; esac; done; if [ \"$__sleekssh_skip\" = 1 ] || [ \"$__sleekssh_value\" = 1 ]; then command sudo \"$@\"; return $?; fi; command sudo -p $'\\033]{ready}\\007[sudo] password for %p: ' \"$@\"; __sleekssh_status=$?; printf '\\033]{done}\\007'; return \"$__sleekssh_status\"; }}");
    let quoted_definition = format!("'{}'", definition.replace('\'', "'\\''"));
    format!("case \"$-\" in *x*) ;; *) if [ -n \"${{BASH_VERSION-}}${{ZSH_VERSION-}}\" ] && ! alias sudo >/dev/null 2>&1 && ! typeset -f sudo >/dev/null 2>&1; then printf '\\033]{tty}%s\\007' \"$(tty)\"; eval {quoted_definition}; fi ;; esac")
}

const SUDO_TTY_MAX_BYTES: usize = 64;

pub(crate) fn valid_sudo_tty(tty: &str) -> bool {
    if tty.len() > SUDO_TTY_MAX_BYTES {
        return false;
    }
    tty.strip_prefix("/dev/pts/")
        .or_else(|| tty.strip_prefix("/dev/ttys"))
        .is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
        })
}

pub(crate) fn tty_echo_is_disabled(output: &[u8]) -> bool {
    let Ok(output) = std::str::from_utf8(output) else {
        return false;
    };
    output
        .split(|character: char| character.is_whitespace() || character == ';')
        .filter(|token| *token == "echo" || *token == "-echo")
        .eq(["-echo"])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(host: &str) -> SudoIdentity {
        SudoIdentity {
            profile_id: "profile".to_string(),
            host: host.to_string(),
            port: 22,
            username: "developer".to_string(),
        }
    }

    fn public_key(seed: u8) -> Vec<u8> {
        ssh_key::PrivateKey::from(ssh_key::private::Ed25519Keypair::from_seed(&[seed; 32]))
            .public_key()
            .to_bytes()
            .unwrap()
    }

    fn temporary_directory() -> PathBuf {
        std::env::temp_dir().join(format!(
            "sleekssh-security-tests-{:032x}",
            rand::random::<u128>()
        ))
    }

    #[test]
    fn secret_buffer_wipe_handles_empty_and_nonempty_buffers() {
        wipe_secret_bytes(&mut []);
        let mut bytes = b"test-secret".to_vec();
        wipe_secret_bytes(&mut bytes);
        assert!(bytes.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn sudo_password_validation_accepts_maximum_and_unicode_without_disclosing_values() {
        assert!(validate_sudo_password("different password 🔑").is_ok());
        assert!(validate_sudo_password(&"a".repeat(SUDO_PASSWORD_MAX_BYTES)).is_ok());
        for password in [
            "",
            "secret\nnext",
            "secret\r",
            "secret\0",
            "secret\u{3}",
            "secret\u{4}",
            "secret\u{15}",
            "secret\u{7f}",
            "secret\t",
        ] {
            let error = validate_sudo_password(password).unwrap_err();
            assert!(!error.contains("secret"));
        }
        assert!(validate_sudo_password(&"a".repeat(SUDO_PASSWORD_MAX_BYTES + 1)).is_err());
        assert!(validate_sudo_password(&"é".repeat(SUDO_PASSWORD_MAX_BYTES)).is_err());
    }

    #[test]
    fn sudo_vault_round_trip_is_dpapi_encrypted_and_identity_bound() {
        let directory = temporary_directory();
        assert!(read_sudo_passwords(&directory).unwrap().is_empty());
        let entries = vec![SudoPasswordEntry {
            identity: identity("example.test"),
            password: "sample-secret-only-for-test".to_string(),
        }];
        write_sudo_passwords(&directory, &entries).unwrap();
        let encrypted = std::fs::read(directory.join("sudo_passwords.enc")).unwrap();
        assert!(!encrypted
            .windows(entries[0].password.len())
            .any(|bytes| bytes == entries[0].password.as_bytes()));
        let loaded = read_sudo_passwords(&directory).unwrap();
        assert_eq!(loaded[0].password, entries[0].password);
        assert!(loaded[0].identity == entries[0].identity);
        write_sudo_passwords(&directory, &[]).unwrap();
        assert!(read_sudo_passwords(&directory).unwrap().is_empty());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn malformed_vault_returns_redacted_error() {
        let directory = temporary_directory();
        std::fs::create_dir_all(&directory).unwrap();
        let malformed = br#"[{"identity":"test-secret","password":"test-secret"}]"#;
        let encrypted = windows_dpapi::encrypt_data(malformed, windows_dpapi::Scope::User).unwrap();
        std::fs::write(directory.join("sudo_passwords.enc"), encrypted).unwrap();
        let error = match read_sudo_passwords(&directory) {
            Ok(_) => panic!("Malformed vault was accepted"),
            Err(error) => error,
        };
        assert_eq!(error, "Failed to parse saved sudo passwords");
        std::fs::write(directory.join("sudo_passwords.enc"), b"test-secret").unwrap();
        let error = match read_sudo_passwords(&directory) {
            Ok(_) => panic!("Plaintext vault was accepted"),
            Err(error) => error,
        };
        assert_eq!(error, "Failed to decrypt saved sudo passwords");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn profile_identity_changes_and_deletion_remove_saved_sudo_passwords() {
        let original = identity("original.test");
        let changed = [
            identity("changed.test"),
            SudoIdentity {
                port: 2222,
                ..original.clone()
            },
            SudoIdentity {
                username: "other".to_string(),
                ..original.clone()
            },
            SudoIdentity {
                profile_id: "other".to_string(),
                ..original.clone()
            },
        ];
        for replacement in changed {
            let entries = vec![SudoPasswordEntry {
                identity: original.clone(),
                password: "test-secret".to_string(),
            }];
            assert!(reconcile_sudo_passwords(entries, &[replacement]).is_empty());
        }
        let entries = vec![SudoPasswordEntry {
            identity: original.clone(),
            password: "test-secret".to_string(),
        }];
        assert_eq!(
            reconcile_sudo_passwords(entries, &[original.clone()]).len(),
            1
        );
        let entries = vec![SudoPasswordEntry {
            identity: original,
            password: "test-secret".to_string(),
        }];
        assert!(reconcile_sudo_passwords(entries, &[]).is_empty());
    }

    #[test]
    fn unknown_ssh_host_requires_review_before_authentication() {
        let key = public_key(1);
        let error = check_host_key(&[], "Example.test", 22, &key).unwrap_err();
        let details: serde_json::Value =
            serde_json::from_str(error.strip_prefix("SSH_HOST_TRUST_REQUIRED:").unwrap()).unwrap();
        assert_eq!(details["host"], "Example.test");
        assert_eq!(details["port"], 22);
        assert_eq!(details["key_type"], "ssh-ed25519");
        assert!(details["fingerprint"]
            .as_str()
            .unwrap()
            .starts_with("SHA256:"));
        assert_eq!(
            details["key_base64"],
            base64::engine::general_purpose::STANDARD.encode(key)
        );
    }

    #[test]
    fn matching_trusted_host_is_accepted_and_changed_key_is_rejected() {
        let key = public_key(1);
        let encoded = base64::engine::general_purpose::STANDARD.encode(&key);
        let mut hosts = Vec::new();
        trust_host_key(&mut hosts, "Example.test", 22, &encoded).unwrap();
        trust_host_key(&mut hosts, "example.test", 22, &encoded).unwrap();
        assert_eq!(hosts.len(), 1);
        assert!(check_host_key(&hosts, "EXAMPLE.test", 22, &key).is_ok());
        let changed = public_key(2);
        let error = check_host_key(&hosts, "example.test", 22, &changed).unwrap_err();
        let details: serde_json::Value =
            serde_json::from_str(error.strip_prefix("SSH_HOST_KEY_CHANGED:").unwrap()).unwrap();
        assert!(details["expected_fingerprint"]
            .as_str()
            .unwrap()
            .starts_with("SHA256:"));
        assert!(trust_host_key(
            &mut hosts,
            "example.test",
            22,
            &base64::engine::general_purpose::STANDARD.encode(changed)
        )
        .is_err());
        assert!(check_host_key(&hosts, "example.test", 2222, &key)
            .unwrap_err()
            .starts_with("SSH_HOST_TRUST_REQUIRED:"));
    }

    #[test]
    fn host_trust_validates_host_port_and_public_key() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(public_key(1));
        for host in ["", "host\n", "host name", "host\0"] {
            assert!(trust_host_key(&mut Vec::new(), host, 22, &encoded).is_err());
        }
        assert!(trust_host_key(
            &mut Vec::new(),
            &"a".repeat(HOST_NAME_MAX_BYTES + 1),
            22,
            &encoded
        )
        .is_err());
        assert!(trust_host_key(&mut Vec::new(), "host", 0, &encoded).is_err());
        for key in ["", "!not-base64", "cGxhaW50ZXh0"] {
            assert!(trust_host_key(&mut Vec::new(), "host", 22, key).is_err());
        }
        assert!(trust_host_key(
            &mut Vec::new(),
            "host",
            22,
            &"A".repeat(HOST_KEY_MAX_BYTES + 1)
        )
        .is_err());
    }

    #[test]
    fn trusted_host_storage_round_trips_public_keys() {
        let directory = temporary_directory();
        assert!(read_trusted_hosts(&directory).unwrap().is_empty());
        let key = public_key(1);
        let mut hosts = Vec::new();
        trust_host_key(
            &mut hosts,
            "example.test",
            22,
            &base64::engine::general_purpose::STANDARD.encode(&key),
        )
        .unwrap();
        write_trusted_hosts(&directory, &hosts).unwrap();
        assert!(check_host_key(
            &read_trusted_hosts(&directory).unwrap(),
            "example.test",
            22,
            &key
        )
        .is_ok());
        std::fs::write(directory.join("trusted_ssh_hosts.json"), b"bad JSON").unwrap();
        assert!(read_trusted_hosts(&directory).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn sudo_prompt_submission_is_single_use_and_requires_current_id() {
        let now = Instant::now();
        let mut prompt = SudoPromptState::default();
        assert!(prompt.reserve("", now).is_err());
        let id = prompt.ready(now);
        assert!(!id.is_empty());
        assert!(prompt.reserve("other", now).is_err());
        prompt.reserve(&id, now).unwrap();
        assert!(prompt.reserve(&id, now).is_err());
        assert!(prompt.is_reserved(&id, now));
        assert!(prompt.consume_reserved(&id, now));
        assert!(!prompt.consume_reserved(&id, now));
        assert!(prompt.reserve(&id, now).is_err());
    }

    #[test]
    fn prompt_end_manual_input_disconnect_and_new_prompt_invalidate_queued_submission() {
        let now = Instant::now();
        let mut prompt = SudoPromptState::default();
        let first = prompt.ready(now);
        prompt.reserve(&first, now).unwrap();
        assert!(prompt.invalidate());
        assert!(!prompt.consume_reserved(&first, now));
        let second = prompt.ready(now);
        prompt.reserve(&second, now).unwrap();
        let third = prompt.ready(now);
        assert_ne!(second, third);
        assert!(!prompt.consume_reserved(&second, now));
        prompt.reserve(&third, now).unwrap();
        assert!(prompt.consume_reserved(&third, now));
    }

    #[test]
    fn sudo_prompt_expires_at_deadline_even_when_submission_was_queued() {
        let now = Instant::now();
        let mut prompt = SudoPromptState::default();
        let id = prompt.ready(now);
        prompt.reserve(&id, now).unwrap();
        assert!(!prompt.consume_reserved(&id, now + SUDO_PROMPT_LIFETIME));
        let id = prompt.ready(now);
        assert!(prompt.reserve(&id, now + SUDO_PROMPT_LIFETIME).is_err());
        assert!(!prompt.expire(now + SUDO_PROMPT_LIFETIME));
    }

    #[test]
    fn sudo_markers_are_private_and_survive_every_chunk_boundary() {
        let template = SudoMarkerParser::new(7);
        let mut stream = b"banner\n".to_vec();
        stream.extend_from_slice(&template.tty_marker_prefix);
        stream.extend_from_slice(b"/dev/pts/3\x07");
        stream.extend_from_slice(&template.ready_marker);
        stream.extend_from_slice(b"[sudo] password: ");
        stream.extend_from_slice(&template.done_marker);
        stream.extend_from_slice("\r\nλ$ ".as_bytes());
        for split in 0..=stream.len() {
            let mut parser = SudoMarkerParser::new(7);
            let (mut output, mut events) = parser.push(&stream[..split]);
            let (remaining, next) = parser.push(&stream[split..]);
            output.extend(remaining);
            events.extend(next);
            assert_eq!(
                output,
                "banner\n[sudo] password: \r\nλ$ ".as_bytes(),
                "split {split}"
            );
            assert_eq!(
                events,
                vec![
                    SudoOutputEvent::Tty("/dev/pts/3".to_string()),
                    SudoOutputEvent::Ready,
                    SudoOutputEvent::Done
                ],
                "split {split}"
            );
        }
    }

    #[test]
    fn ordinary_password_text_or_other_sessions_marker_does_not_arm_shortcut() {
        let other = SudoMarkerParser::new(8);
        let mut stream = b"Password: [sudo] password for developer: ".to_vec();
        stream.extend_from_slice(&other.ready_marker);
        let mut parser = SudoMarkerParser::new(7);
        let (output, events) = parser.push(&stream);
        assert!(events.is_empty());
        assert_eq!(output, stream);
    }

    #[test]
    fn invalid_tty_marker_is_removed_and_never_used() {
        let mut parser = SudoMarkerParser::new(7);
        let mut stream = parser.tty_marker_prefix.clone();
        stream.extend_from_slice(b"/dev/pts/3; touch /tmp/injected\x07");
        let (output, events) = parser.push(&stream);
        assert!(output.is_empty());
        assert!(events.is_empty());
    }

    #[test]
    fn tty_paths_and_echo_check_fail_closed() {
        for tty in ["/dev/pts/0", "/dev/pts/123", "/dev/ttys000"] {
            assert!(valid_sudo_tty(tty));
        }
        for tty in [
            "",
            "/dev/pts/",
            "/dev/pts/1\n",
            "/dev/pts/1;id",
            "/dev/tty",
            "/dev/pts/../../etc/passwd",
            "/tmp/tty",
        ] {
            assert!(!valid_sudo_tty(tty));
        }
        assert!(tty_echo_is_disabled(
            b"speed 38400 baud; -echo echoe echok\r\n"
        ));
        for output in [
            b"echo echoe -echonl".as_slice(),
            b"-echoctl",
            b"",
            b"echo -echo",
            b"-echo -echo",
            &[255],
        ] {
            assert!(!tty_echo_is_disabled(output));
        }
    }

    #[test]
    fn sudo_shell_setup_is_single_line_and_guards_custom_modes_and_tracing() {
        let setup = create_sudo_shell_setup(7);
        assert!(!setup.contains(['\n', '\r', '\0']));
        assert!(setup.len() < 3 * 1024);
        assert!(setup.contains("! alias sudo"));
        assert!(setup.contains("! typeset -f sudo"));
        assert!(setup.contains("case \"$-\" in *x*) command sudo"));
        assert!(setup.contains("--prompt|--prompt=*|--askpass|--stdin|--non-interactive"));
        assert!(setup.contains("*[pASn]*"));
        assert!(setup.contains("__sleekssh_status=$?"));
        assert!(setup.contains("return \"$__sleekssh_status\""));
    }
}
