use crate::automation_provider::{validate_conversation_id, Provider};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, File, Metadata};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_SESSIONS: usize = 200;
const MAX_FILES: usize = 4_096;
const MAX_DIRECTORY_ENTRIES: usize = 20_000;
const MAX_RECORDS: usize = 16_384;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;
const MAX_INDEX_BYTES: usize = 2 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 256 * 1024;
const METADATA_READ_BUFFER_BYTES: usize = 4 * 1024;
const CLAUDE_WINDOW_BYTES: usize = 64 * 1024;
const MAX_TITLE_CHARACTERS: usize = 240;
const MAX_PROJECT_CHARACTERS: usize = 4_096;
const MAX_WARNINGS: usize = 8;
const MAX_ROLLOUT_DEPTH: usize = 4;
const UUID_BYTES: usize = 36;

#[derive(Debug, Default, Serialize)]
pub(crate) struct SessionList {
    pub sessions: Vec<LocalAgentSession>,
    pub warnings: Vec<String>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct LocalAgentSession {
    pub id: String,
    pub title: String,
    pub project_path: Option<String>,
    pub updated_at: Option<u64>,
}

#[derive(Default)]
struct Discovery {
    result: SessionList,
    sessions: HashMap<String, LocalAgentSession>,
    files: usize,
    entries: usize,
    records: usize,
    bytes: usize,
}

impl Discovery {
    fn warn(&mut self, message: impl Into<String>) {
        let message = message.into();
        if self.result.warnings.contains(&message) {
            return;
        }
        if self.result.warnings.len() < MAX_WARNINGS {
            self.result.warnings.push(message);
        } else {
            self.result.truncated = true;
        }
    }

    fn limit(&mut self) {
        self.result.truncated = true;
        self.warn("Local session discovery reached its scan limit");
    }

    fn claim_file(&mut self) -> bool {
        if self.files >= MAX_FILES {
            self.limit();
            return false;
        }
        self.files += 1;
        true
    }

    fn claim_record(&mut self) -> bool {
        if self.records >= MAX_RECORDS {
            self.limit();
            return false;
        }
        self.records += 1;
        true
    }

    fn insert(&mut self, session: LocalAgentSession) {
        match self.sessions.get_mut(&session.id) {
            Some(previous) if previous.updated_at >= session.updated_at => {}
            Some(previous) => *previous = session,
            None => {
                self.sessions.insert(session.id.clone(), session);
            }
        }
    }

    fn finish(mut self) -> SessionList {
        let mut sessions = self.sessions.into_values().collect::<Vec<_>>();
        sessions.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        if sessions.len() > MAX_SESSIONS {
            sessions.truncate(MAX_SESSIONS);
            self.result.truncated = true;
        }
        self.result.sessions = sessions;
        self.result
    }
}

#[tauri::command]
pub(crate) async fn list_local_agent_sessions(provider: String) -> Result<SessionList, String> {
    let provider = Provider::parse(&provider)?;
    let root = configured_root(provider)?;
    tokio::task::spawn_blocking(move || list_from_root(provider, &root))
        .await
        .map_err(|error| format!("Local session discovery task failed: {error}"))
}

fn configured_root(provider: Provider) -> Result<PathBuf, String> {
    let variable = match provider {
        Provider::Claude => "CLAUDE_CONFIG_DIR",
        Provider::Codex => "CODEX_HOME",
    };
    resolve_root(provider, std::env::var_os(variable), dirs::home_dir())
}

fn resolve_root(
    provider: Provider,
    configured: Option<OsString>,
    home: Option<PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(configured) = configured.filter(|value| !value.is_empty()) {
        let root = PathBuf::from(configured);
        if !root.is_absolute() {
            return Err("The agent configuration directory must be an absolute path".to_string());
        }
        return Ok(root);
    }
    let directory = match provider {
        Provider::Claude => ".claude",
        Provider::Codex => ".codex",
    };
    home.map(|home| home.join(directory))
        .ok_or_else(|| "The local home directory could not be located".to_string())
}

fn list_from_root(provider: Provider, root: &Path) -> SessionList {
    let mut discovery = Discovery::default();
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return discovery.finish(),
        Err(error) => {
            discovery.warn(format!(
                "Cannot inspect the agent session directory: {error}"
            ));
            return discovery.finish();
        }
    };
    if linked(&metadata) || !metadata.is_dir() {
        discovery.warn("The agent session directory must be a regular directory without links");
        return discovery.finish();
    }
    let root = match root.canonicalize() {
        Ok(root) => root,
        Err(error) => {
            discovery.warn(format!(
                "Cannot resolve the agent session directory: {error}"
            ));
            return discovery.finish();
        }
    };
    match provider {
        Provider::Claude => discover_claude(&root, &mut discovery),
        Provider::Codex => discover_codex(&root, &mut discovery),
    }
    discovery.finish()
}

fn linked(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

fn checked_metadata(path: &Path, root: &Path, discovery: &mut Discovery) -> Option<Metadata> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            discovery.warn(format!("Cannot inspect local session metadata: {error}"));
            return None;
        }
    };
    if linked(&metadata) {
        discovery.warn("Skipped a linked file or directory in local session metadata");
        return None;
    }
    match path.canonicalize() {
        Ok(path) if path.starts_with(root) => Some(metadata),
        Ok(_) => {
            discovery.warn("Skipped session metadata outside the agent directory");
            None
        }
        Err(error) => {
            discovery.warn(format!("Cannot resolve local session metadata: {error}"));
            None
        }
    }
}

fn directory_paths(path: &Path, root: &Path, discovery: &mut Discovery) -> Vec<PathBuf> {
    if !checked_metadata(path, root, discovery).is_some_and(|metadata| metadata.is_dir()) {
        return Vec::new();
    }
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) => {
            discovery.warn(format!("Cannot read a local session directory: {error}"));
            return Vec::new();
        }
    };
    let mut paths = Vec::new();
    for entry in entries {
        if discovery.entries >= MAX_DIRECTORY_ENTRIES {
            discovery.limit();
            break;
        }
        discovery.entries += 1;
        match entry {
            Ok(entry) => paths.push(entry.path()),
            Err(error) => discovery.warn(format!("Cannot inspect a local session entry: {error}")),
        }
    }
    paths.sort_unstable_by(|left, right| right.file_name().cmp(&left.file_name()));
    paths
}

fn open_metadata_file(path: &Path, discovery: &mut Discovery) -> Option<File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    match options.open(path) {
        Ok(file) => match file.metadata() {
            Ok(metadata) if metadata.is_file() && !linked(&metadata) => Some(file),
            Ok(_) => {
                discovery.warn("Skipped a nonregular local session metadata file");
                None
            }
            Err(error) => {
                discovery.warn(format!(
                    "Cannot inspect an open session metadata file: {error}"
                ));
                None
            }
        },
        Err(error) => {
            discovery.warn(format!("Cannot open local session metadata: {error}"));
            None
        }
    }
}

fn read_window(
    file: &mut File,
    offset: u64,
    length: usize,
    discovery: &mut Discovery,
) -> Option<Vec<u8>> {
    let remaining = MAX_TOTAL_BYTES.saturating_sub(discovery.bytes);
    if length > remaining {
        discovery.limit();
        return None;
    }
    let mut bytes = Vec::new();
    let result = file
        .seek(SeekFrom::Start(offset))
        .and_then(|_| file.take(length as u64).read_to_end(&mut bytes));
    discovery.bytes += bytes.len();
    match result {
        Ok(_) => Some(bytes),
        Err(error) => {
            discovery.warn(format!("Cannot read local session metadata: {error}"));
            None
        }
    }
}

fn read_header(file: &mut File, file_length: u64, discovery: &mut Discovery) -> Option<Vec<u8>> {
    let remaining = MAX_TOTAL_BYTES.saturating_sub(discovery.bytes);
    let limit = remaining.min(MAX_METADATA_BYTES + 1);
    if limit == 0 {
        discovery.limit();
        return None;
    }
    let mut bytes = Vec::new();
    let result = BufReader::with_capacity(METADATA_READ_BUFFER_BYTES, file)
        .take(limit as u64)
        .read_until(b'\n', &mut bytes);
    discovery.bytes += bytes.len();
    if let Err(error) = result {
        discovery.warn(format!("Cannot read a Codex metadata header: {error}"));
        return None;
    }
    if bytes.len() > MAX_METADATA_BYTES
        || (bytes.len() == limit
            && bytes.last() != Some(&b'\n')
            && (bytes.len() as u64) < file_length)
    {
        discovery.warn("A Codex session metadata header exceeds the read limit");
        discovery.result.truncated = true;
        return None;
    }
    Some(bytes)
}

fn timestamp_ms(value: Option<&Value>, discovery: &mut Discovery) -> Option<u64> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::Number(number)) => match number.as_u64() {
            Some(timestamp) => Some(timestamp),
            None => {
                discovery.warn("A local session timestamp is invalid");
                None
            }
        },
        Some(Value::String(value)) => match chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .and_then(|timestamp| u64::try_from(timestamp.timestamp_millis()).ok())
        {
            Some(timestamp) => Some(timestamp),
            None => {
                discovery.warn("A local session timestamp is invalid");
                None
            }
        },
        Some(_) => {
            discovery.warn("A local session timestamp is invalid");
            None
        }
    }
}

fn modified_ms(metadata: &Metadata, discovery: &mut Discovery) -> Option<u64> {
    match metadata.modified() {
        Ok(modified) => modified
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|duration| u64::try_from(duration.as_millis()).ok()),
        Err(error) => {
            discovery.warn(format!(
                "Cannot read a local session modification time: {error}"
            ));
            None
        }
    }
}

fn text(value: Option<&Value>, limit: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|value| {
            value
                .trim()
                .chars()
                .take(limit)
                .map(|character| {
                    if character.is_control() {
                        ' '
                    } else {
                        character
                    }
                })
                .collect::<String>()
        })
        .filter(|value| !value.is_empty())
}

fn session_id(value: Option<&Value>, discovery: &mut Discovery) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(id) if validate_conversation_id(id).is_ok() => Some(id.to_ascii_lowercase()),
        _ => {
            discovery.warn("A local session entry has an invalid conversation ID");
            None
        }
    }
}

#[derive(Default)]
struct SessionHint {
    title: Option<String>,
    project_path: Option<String>,
    updated_at: Option<u64>,
    sidechain: bool,
}

#[derive(Deserialize)]
struct CodexIndexEntry {
    id: Option<Value>,
    thread_name: Option<Value>,
    updated_at: Option<Value>,
}

fn codex_index(root: &Path, discovery: &mut Discovery) -> HashMap<String, SessionHint> {
    let path = root.join("session_index.jsonl");
    let mut hints: HashMap<String, SessionHint> = HashMap::new();
    let Some(metadata) = checked_metadata(&path, root, discovery) else {
        return hints;
    };
    if !metadata.is_file() || !discovery.claim_file() {
        return hints;
    }
    let Some(mut file) = open_metadata_file(&path, discovery) else {
        return hints;
    };
    let count = metadata.len().min(MAX_INDEX_BYTES as u64) as usize;
    let offset = metadata.len().saturating_sub(count as u64);
    if metadata.len() > MAX_INDEX_BYTES as u64 {
        discovery.limit();
    }
    let Some(bytes) = read_window(&mut file, offset, count, discovery) else {
        return hints;
    };
    for line in complete_lines(&bytes, offset == 0, true) {
        if !discovery.claim_record() {
            break;
        }
        let entry = match serde_json::from_slice::<CodexIndexEntry>(line) {
            Ok(entry) => entry,
            Err(_) => {
                discovery.warn("A Codex session index entry is malformed");
                continue;
            }
        };
        let Some(id) = session_id(entry.id.as_ref(), discovery) else {
            continue;
        };
        let hint = SessionHint {
            title: text(entry.thread_name.as_ref(), MAX_TITLE_CHARACTERS),
            updated_at: timestamp_ms(entry.updated_at.as_ref(), discovery),
            ..SessionHint::default()
        };
        match hints.get(&id) {
            Some(previous) if previous.updated_at > hint.updated_at => {}
            _ => {
                hints.insert(id, hint);
            }
        }
    }
    hints
}

#[derive(Deserialize)]
struct MetadataRecord {
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<Value>,
    #[serde(rename = "isSidechain")]
    is_sidechain: Option<bool>,
    #[serde(rename = "customTitle")]
    custom_title: Option<Value>,
    summary: Option<Value>,
    cwd: Option<Value>,
    timestamp: Option<Value>,
    payload: Option<CodexMetadata>,
}

#[derive(Deserialize)]
struct CodexMetadata {
    id: Option<Value>,
    session_id: Option<Value>,
    timestamp: Option<Value>,
    cwd: Option<Value>,
    source: Option<Value>,
    thread_source: Option<Value>,
    parent_thread_id: Option<Value>,
    agent_path: Option<Value>,
    archived: Option<bool>,
}

fn codex_subagent(metadata: &CodexMetadata) -> bool {
    let subagent_source = |source: Option<&Value>| {
        source.is_some_and(|source| {
            source.as_str() == Some("subagent") || source.get("subagent").is_some()
        })
    };
    subagent_source(metadata.source.as_ref())
        || subagent_source(metadata.thread_source.as_ref())
        || metadata
            .parent_thread_id
            .as_ref()
            .is_some_and(|value| !value.is_null())
        || metadata
            .agent_path
            .as_ref()
            .is_some_and(|value| !value.is_null())
}

fn discover_codex(root: &Path, discovery: &mut Discovery) {
    let hints = codex_index(root, discovery);
    let mut compressed = false;
    codex_rollouts(
        root,
        &root.join("sessions"),
        0,
        &hints,
        &mut compressed,
        discovery,
    );
    if compressed && discovery.sessions.is_empty() {
        discovery
            .warn("Only compressed Codex session files were found; their metadata is unavailable");
        discovery.result.truncated = true;
    }
}

fn codex_rollouts(
    root: &Path,
    directory: &Path,
    depth: usize,
    hints: &HashMap<String, SessionHint>,
    compressed: &mut bool,
    discovery: &mut Discovery,
) {
    for path in directory_paths(directory, root, discovery) {
        if discovery.files >= MAX_FILES || discovery.entries >= MAX_DIRECTORY_ENTRIES {
            discovery.limit();
            return;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if matches!(name, "archived_sessions" | "subagents" | "archive") {
            continue;
        }
        let Some(metadata) = checked_metadata(&path, root, discovery) else {
            continue;
        };
        if metadata.is_dir() {
            if depth < MAX_ROLLOUT_DEPTH {
                codex_rollouts(root, &path, depth + 1, hints, compressed, discovery);
            } else {
                discovery.limit();
            }
            continue;
        }
        if name.ends_with(".jsonl.zst") || name.ends_with(".zst") {
            *compressed = true;
            continue;
        }
        let Some(stem) = name
            .strip_prefix("rollout-")
            .and_then(|name| name.strip_suffix(".jsonl"))
        else {
            continue;
        };
        let Some(filename_id) = stem
            .len()
            .checked_sub(UUID_BYTES)
            .and_then(|start| stem.get(start..))
        else {
            continue;
        };
        if validate_conversation_id(filename_id).is_err()
            || !metadata.is_file()
            || !discovery.claim_file()
        {
            continue;
        }
        let Some(mut file) = open_metadata_file(&path, discovery) else {
            continue;
        };
        let Some(bytes) = read_header(&mut file, metadata.len(), discovery) else {
            continue;
        };
        if !discovery.claim_record() {
            return;
        }
        let record = match serde_json::from_slice::<MetadataRecord>(&bytes) {
            Ok(record) if record.kind.as_deref() == Some("session_meta") => record,
            _ => {
                discovery.warn("A Codex session metadata header is malformed");
                continue;
            }
        };
        let Some(payload) = record.payload else {
            discovery.warn("A Codex session metadata header has no payload");
            continue;
        };
        if codex_subagent(&payload) || payload.archived == Some(true) {
            continue;
        }
        let Some(id) = session_id(
            payload.id.as_ref().or(payload.session_id.as_ref()),
            discovery,
        ) else {
            continue;
        };
        if !id.eq_ignore_ascii_case(filename_id) {
            discovery.warn("A Codex session ID does not match its session file");
            continue;
        }
        let hint = hints.get(&id);
        let updated_at = [
            hint.and_then(|hint| hint.updated_at),
            modified_ms(&metadata, discovery),
            timestamp_ms(payload.timestamp.as_ref(), discovery),
            timestamp_ms(record.timestamp.as_ref(), discovery),
        ]
        .into_iter()
        .flatten()
        .max();
        discovery.insert(LocalAgentSession {
            title: hint
                .and_then(|hint| hint.title.clone())
                .unwrap_or_else(|| format!("Codex session {id}")),
            project_path: text(payload.cwd.as_ref(), MAX_PROJECT_CHARACTERS),
            updated_at,
            id,
        });
    }
}

#[derive(Deserialize)]
struct ClaudeIndex {
    #[serde(default)]
    entries: Vec<ClaudeIndexEntry>,
}

#[derive(Deserialize)]
struct ClaudeIndexEntry {
    #[serde(rename = "sessionId")]
    session_id: Option<Value>,
    summary: Option<Value>,
    #[serde(rename = "projectPath")]
    project_path: Option<Value>,
    modified: Option<Value>,
    #[serde(rename = "fileMtime")]
    file_mtime: Option<Value>,
    #[serde(rename = "isSidechain")]
    is_sidechain: Option<bool>,
}

fn claude_index(
    root: &Path,
    project: &Path,
    discovery: &mut Discovery,
) -> HashMap<String, SessionHint> {
    let path = project.join("sessions-index.json");
    let mut hints: HashMap<String, SessionHint> = HashMap::new();
    let Some(metadata) = checked_metadata(&path, root, discovery) else {
        return hints;
    };
    if !metadata.is_file() || !discovery.claim_file() {
        return hints;
    }
    if metadata.len() > MAX_INDEX_BYTES as u64 {
        discovery.limit();
        return hints;
    }
    let Some(mut file) = open_metadata_file(&path, discovery) else {
        return hints;
    };
    let Some(bytes) = read_window(&mut file, 0, metadata.len() as usize, discovery) else {
        return hints;
    };
    let index = match serde_json::from_slice::<ClaudeIndex>(&bytes) {
        Ok(index) => index,
        Err(_) => {
            discovery.warn("A Claude session index is malformed");
            return hints;
        }
    };
    for entry in index.entries {
        if !discovery.claim_record() {
            break;
        }
        let Some(id) = session_id(entry.session_id.as_ref(), discovery) else {
            continue;
        };
        hints.insert(
            id,
            SessionHint {
                title: text(entry.summary.as_ref(), MAX_TITLE_CHARACTERS),
                project_path: text(entry.project_path.as_ref(), MAX_PROJECT_CHARACTERS),
                updated_at: [
                    timestamp_ms(entry.modified.as_ref(), discovery),
                    timestamp_ms(entry.file_mtime.as_ref(), discovery),
                ]
                .into_iter()
                .flatten()
                .max(),
                sidechain: entry.is_sidechain == Some(true),
            },
        );
    }
    hints
}

fn complete_lines(
    bytes: &[u8],
    complete_start: bool,
    complete_end: bool,
) -> impl Iterator<Item = &[u8]> {
    let start = if complete_start {
        0
    } else {
        bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |position| position + 1)
    };
    let end = if complete_end {
        bytes.len()
    } else {
        bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .unwrap_or(start)
    };
    bytes[start..end.max(start)]
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
}

fn discover_claude(root: &Path, discovery: &mut Discovery) {
    for project in directory_paths(&root.join("projects"), root, discovery) {
        if discovery.files >= MAX_FILES
            || discovery.records >= MAX_RECORDS
            || discovery.bytes >= MAX_TOTAL_BYTES
        {
            discovery.limit();
            return;
        }
        if !checked_metadata(&project, root, discovery).is_some_and(|metadata| metadata.is_dir()) {
            continue;
        }
        let hints = claude_index(root, &project, discovery);
        for path in directory_paths(&project, root, discovery) {
            if discovery.files >= MAX_FILES
                || discovery.records >= MAX_RECORDS
                || discovery.bytes >= MAX_TOTAL_BYTES
            {
                discovery.limit();
                return;
            }
            let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl")
                || validate_conversation_id(id).is_err()
            {
                continue;
            }
            let id = id.to_ascii_lowercase();
            if hints.get(&id).is_some_and(|hint| hint.sidechain) {
                continue;
            }
            let Some(metadata) = checked_metadata(&path, root, discovery) else {
                continue;
            };
            if !metadata.is_file() || !discovery.claim_file() {
                continue;
            }
            let Some(mut file) = open_metadata_file(&path, discovery) else {
                continue;
            };
            let hint = hints.get(&id);
            let mut session = LocalAgentSession {
                id: id.clone(),
                title: hint
                    .and_then(|hint| hint.title.clone())
                    .unwrap_or_else(|| format!("Claude session {id}")),
                project_path: hint.and_then(|hint| hint.project_path.clone()),
                updated_at: [
                    hint.and_then(|hint| hint.updated_at),
                    modified_ms(&metadata, discovery),
                ]
                .into_iter()
                .flatten()
                .max(),
            };
            let head_length = metadata.len().min(CLAUDE_WINDOW_BYTES as u64) as usize;
            let Some(head) = read_window(&mut file, 0, head_length, discovery) else {
                continue;
            };
            let mut sidechain = false;
            let mut custom_title = false;
            claude_records(
                &head,
                true,
                head_length as u64 >= metadata.len(),
                &mut session,
                &mut sidechain,
                &mut custom_title,
                discovery,
            );
            if discovery.records >= MAX_RECORDS || discovery.bytes >= MAX_TOTAL_BYTES {
                discovery.limit();
                return;
            }
            if metadata.len() > head_length as u64 && !sidechain {
                let tail_start = metadata
                    .len()
                    .saturating_sub(CLAUDE_WINDOW_BYTES as u64)
                    .max(head_length as u64);
                let tail_offset = tail_start.saturating_sub(1);
                let tail_length = (metadata.len() - tail_offset) as usize;
                if let Some(tail) = read_window(&mut file, tail_offset, tail_length, discovery) {
                    claude_records(
                        &tail,
                        false,
                        true,
                        &mut session,
                        &mut sidechain,
                        &mut custom_title,
                        discovery,
                    );
                }
            }
            if discovery.records >= MAX_RECORDS || discovery.bytes >= MAX_TOTAL_BYTES {
                discovery.limit();
                return;
            }
            if !sidechain {
                discovery.insert(session);
            }
        }
    }
}

fn claude_records(
    bytes: &[u8],
    complete_start: bool,
    complete_end: bool,
    session: &mut LocalAgentSession,
    sidechain: &mut bool,
    custom_title: &mut bool,
    discovery: &mut Discovery,
) {
    for line in complete_lines(bytes, complete_start, complete_end) {
        if !discovery.claim_record() {
            return;
        }
        // Retaining only outer metadata keeps prompt content out of the session listing.
        let record = match serde_json::from_slice::<MetadataRecord>(line) {
            Ok(record) => record,
            Err(_) => {
                discovery.warn("A Claude session metadata record is malformed");
                continue;
            }
        };
        if let Some(id) = record.session_id.as_ref() {
            if id
                .as_str()
                .is_none_or(|id| !id.eq_ignore_ascii_case(&session.id))
            {
                discovery.warn("A Claude metadata record has a mismatched session ID");
                continue;
            }
        }
        if record.is_sidechain == Some(true) {
            *sidechain = true;
            return;
        }
        if let Some(cwd) = text(record.cwd.as_ref(), MAX_PROJECT_CHARACTERS) {
            session.project_path = Some(cwd);
        }
        session.updated_at = [
            session.updated_at,
            timestamp_ms(record.timestamp.as_ref(), discovery),
        ]
        .into_iter()
        .flatten()
        .max();
        let title = match record.kind.as_deref() {
            Some("custom-title") => {
                let title = text(record.custom_title.as_ref(), MAX_TITLE_CHARACTERS);
                *custom_title |= title.is_some();
                title
            }
            Some("summary") if !*custom_title => {
                text(record.summary.as_ref(), MAX_TITLE_CHARACTERS)
            }
            _ => None,
        };
        if let Some(title) = title {
            session.title = title;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SESSION_ID: &str = "01a15399-7b9f-7641-a520-389ad6379a30";
    const SECOND_ID: &str = "01a15399-7b9f-7641-a520-389ad6379a31";

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "sleekssh-session-list-{:032x}",
                rand::random::<u128>()
            ));
            fs::create_dir(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }

        fn write(&self, path: impl AsRef<Path>, contents: &str) -> PathBuf {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, contents).unwrap();
            path
        }

        fn rollout(&self, id: &str, source: Value) {
            self.write(
                format!("sessions/2026/10/19/rollout-2026-10-19T00-00-00-{id}.jsonl"),
                &json!({"type":"session_meta","payload":{"id":id,"cwd":"/srv/example","source":source,"timestamp":"2026-10-19T00:00:00Z"}}).to_string(),
            );
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let temporary_root = std::env::temp_dir().canonicalize().unwrap();
            assert!(self.0.starts_with(temporary_root));
            assert!(self
                .0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("sleekssh-session-list-"));
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[tokio::test]
    async fn listing_rejects_invalid_provider_before_reading_files() {
        for provider in ["", "Claude", "../codex", "codex; whoami"] {
            assert!(list_local_agent_sessions(provider.to_string())
                .await
                .is_err());
        }
    }

    #[test]
    fn roots_respect_provider_overrides_and_missing_home() {
        let fixture = Fixture::new();
        assert_eq!(
            resolve_root(Provider::Claude, None, Some(fixture.0.clone())).unwrap(),
            fixture.0.join(".claude")
        );
        assert_eq!(
            resolve_root(
                Provider::Codex,
                Some(fixture.0.as_os_str().to_owned()),
                None
            )
            .unwrap(),
            fixture.0
        );
        assert!(resolve_root(
            Provider::Codex,
            Some(OsString::from("../other")),
            Some(fixture.0.clone())
        )
        .is_err());
        assert!(resolve_root(Provider::Claude, None, None).is_err());
        assert_eq!(
            resolve_root(
                Provider::Codex,
                Some(OsString::new()),
                Some(fixture.0.clone())
            )
            .unwrap(),
            fixture.0.join(".codex")
        );
    }

    #[test]
    fn missing_stores_and_empty_directories_are_empty() {
        let fixture = Fixture::new();
        for provider in [Provider::Claude, Provider::Codex] {
            let missing = list_from_root(provider, &fixture.0.join("missing"));
            assert!(missing.sessions.is_empty());
            assert!(missing.warnings.is_empty());
            let empty = list_from_root(provider, &fixture.0);
            assert!(empty.sessions.is_empty());
            assert!(empty.warnings.is_empty());
        }
    }

    #[test]
    fn codex_uses_native_titles_and_falls_back_to_unindexed_root_headers() {
        let fixture = Fixture::new();
        fixture.rollout(SESSION_ID, json!("cli"));
        fixture.rollout(SECOND_ID, json!("vscode"));
        fixture.write("session_index.jsonl", &format!("{}\n{}\n", json!({"id":SESSION_ID,"thread_name":"Inspect nginx","updated_at":"2026-10-19T12:00:00.1234567Z"}), json!({"id":"01a15399-7b9f-7641-a520-389ad6379a32","thread_name":"Archived","updated_at":null})));
        let result = list_from_root(Provider::Codex, &fixture.0);
        assert_eq!(result.sessions.len(), 2);
        let indexed = result
            .sessions
            .iter()
            .find(|session| session.id == SESSION_ID)
            .unwrap();
        assert_eq!(indexed.title, "Inspect nginx");
        assert_eq!(indexed.project_path.as_deref(), Some("/srv/example"));
        assert!(indexed.updated_at.unwrap() >= 1_792_411_200_123);
        assert!(result
            .sessions
            .iter()
            .find(|session| session.id == SECOND_ID)
            .unwrap()
            .title
            .starts_with("Codex session "));
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn codex_skips_subagents_archives_mismatched_ids_and_nonmetadata_files() {
        let fixture = Fixture::new();
        fixture.rollout(SESSION_ID, json!({"subagent":{"thread_spawn":{}}}));
        fixture.write(
            format!("archived_sessions/rollout-{SECOND_ID}.jsonl"),
            "not parsed",
        );
        fixture.write("auth.json", "credentials must not be parsed");
        fixture.write("history.jsonl", "private prompt must not be parsed");
        fixture.write(
            format!("sessions/rollout-{SECOND_ID}.jsonl"),
            &json!({"type":"session_meta","payload":{"id":SESSION_ID,"source":"cli"}}).to_string(),
        );
        let result = list_from_root(Provider::Codex, &fixture.0);
        assert!(result.sessions.is_empty());
        assert_eq!(
            result.warnings,
            ["A Codex session ID does not match its session file"]
        );
    }

    #[test]
    fn compressed_only_codex_sessions_warn_even_when_the_native_index_has_entries() {
        let fixture = Fixture::new();
        fixture.write(
            "session_index.jsonl",
            &json!({"id":SESSION_ID,"thread_name":"Named session","updated_at":null}).to_string(),
        );
        fixture.write(
            format!("sessions/rollout-{SESSION_ID}.jsonl.zst"),
            "compressed data must not be parsed",
        );
        let result = list_from_root(Provider::Codex, &fixture.0);
        assert!(result.sessions.is_empty());
        assert!(result.truncated);
        assert_eq!(
            result.warnings,
            ["Only compressed Codex session files were found; their metadata is unavailable"]
        );
    }

    #[test]
    fn codex_header_reads_do_not_consume_a_large_transcript_body() {
        let fixture = Fixture::new();
        let header = format!(
            "{}\n",
            json!({"type":"session_meta","payload":{"id":SESSION_ID,"source":"cli"}})
        );
        let path = fixture.write(
            "metadata.jsonl",
            &format!("{header}{}", "x".repeat(MAX_METADATA_BYTES * 2)),
        );
        let mut file = File::open(path).unwrap();
        let length = file.metadata().unwrap().len();
        let mut discovery = Discovery::default();
        let bytes = read_header(&mut file, length, &mut discovery).unwrap();
        assert_eq!(bytes, header.as_bytes());
        assert_eq!(discovery.bytes, header.len());
        assert!(!discovery.result.truncated);
    }

    #[test]
    fn codex_recognizes_explicit_subagents_and_preserves_other_source_objects() {
        for value in [
            json!({"source":{"plugin":{"name":"root"}},"thread_source":{"hook":{"name":"root"}}}),
            json!({"source":"cli","thread_source":"{\"hook\":{\"name\":\"root\"}}"}),
        ] {
            let metadata: CodexMetadata = serde_json::from_value(value).unwrap();
            assert!(!codex_subagent(&metadata));
        }
        for value in [
            json!({"source":{"subagent":{"thread_spawn":{}}}}),
            json!({"source":"cli","thread_source":{"subagent":{}}}),
            json!({"source":"cli","thread_source":"subagent"}),
            json!({"source":"cli","agent_path":"child"}),
            json!({"source":"cli","parent_thread_id":SESSION_ID}),
        ] {
            let metadata: CodexMetadata = serde_json::from_value(value).unwrap();
            assert!(codex_subagent(&metadata));
        }
    }

    #[test]
    fn native_index_times_cannot_hide_newer_session_file_activity() {
        let fixture = Fixture::new();
        fixture.rollout(SESSION_ID, json!("cli"));
        fixture.write(
            "session_index.jsonl",
            &json!({"id":SESSION_ID,"thread_name":"Old index","updated_at":"1970-01-01T00:00:00Z"})
                .to_string(),
        );
        let result = list_from_root(Provider::Codex, &fixture.0);
        assert!(result.sessions[0].updated_at.unwrap() > 0);
        fixture.write(format!("projects/example/{SESSION_ID}.jsonl"), "");
        fixture.write("projects/example/sessions-index.json", &json!({"entries":[{"sessionId":SESSION_ID,"summary":"Old index","modified":"1970-01-01T00:00:00Z","fileMtime":0}]}).to_string());
        let result = list_from_root(Provider::Claude, &fixture.0);
        assert!(result.sessions[0].updated_at.unwrap() > 0);
    }

    #[test]
    fn malformed_index_entries_preserve_valid_sessions_and_bound_warnings() {
        let fixture = Fixture::new();
        fixture.rollout(SESSION_ID, json!("cli"));
        fixture.write(
            "session_index.jsonl",
            &format!(
                "not json\n{}\n{}\n",
                json!({"id":"../../outside","thread_name":"invalid"}),
                json!({"id":SESSION_ID,"thread_name":"Valid","updated_at":null})
            ),
        );
        let result = list_from_root(Provider::Codex, &fixture.0);
        assert_eq!(result.sessions.len(), 1);
        assert_eq!(result.sessions[0].title, "Valid");
        assert_eq!(result.warnings.len(), 2);
        let mut discovery = Discovery::default();
        for index in 0..MAX_WARNINGS + 1 {
            discovery.warn(format!("warning {index}"));
        }
        assert_eq!(discovery.result.warnings.len(), MAX_WARNINGS);
        assert!(discovery.result.truncated);
    }

    #[test]
    fn claude_reads_outer_metadata_and_last_native_title_without_index_or_prompts() {
        let fixture = Fixture::new();
        fixture.write(format!("projects/example/{SESSION_ID}.jsonl"), &format!("{}\n{}\n{}\n", json!({"type":"user","sessionId":SESSION_ID,"isSidechain":false,"cwd":"/srv/app","message":{"content":"PRIVATE_FIRST_PROMPT"}}), json!({"type":"custom-title","sessionId":SESSION_ID,"customTitle":"Old title"}), json!({"type":"custom-title","sessionId":SESSION_ID,"customTitle":"Latest title"})));
        let result = list_from_root(Provider::Claude, &fixture.0);
        assert_eq!(result.sessions.len(), 1);
        assert_eq!(result.sessions[0].title, "Latest title");
        assert_eq!(result.sessions[0].project_path.as_deref(), Some("/srv/app"));
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("PRIVATE_FIRST_PROMPT"));
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn claude_index_ignores_first_prompt_and_preserves_null_fields() {
        let fixture = Fixture::new();
        fixture.write(format!("projects/example/{SESSION_ID}.jsonl"), "");
        fixture.write("projects/example/sessions-index.json", &json!({"entries":[{"sessionId":SESSION_ID,"summary":null,"firstPrompt":"PRIVATE_PROMPT","projectPath":null,"modified":null}]}).to_string());
        let result = list_from_root(Provider::Claude, &fixture.0);
        assert_eq!(result.sessions.len(), 1);
        assert!(result.sessions[0].title.starts_with("Claude session "));
        assert!(result.sessions[0].project_path.is_none());
        let serialized = serde_json::to_value(&result.sessions[0]).unwrap();
        assert!(serialized["project_path"].is_null());
        assert!(serialized["updated_at"].is_u64());
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("PRIVATE_PROMPT"));
    }

    #[test]
    fn claude_explicit_custom_title_takes_priority_over_later_summaries() {
        let fixture = Fixture::new();
        fixture.write(
            format!("projects/example/{SESSION_ID}.jsonl"),
            &format!(
                "{}\n{}\n{}\n",
                json!({"type":"custom-title","sessionId":SESSION_ID,"customTitle":"Chosen title"}),
                json!({"type":"summary","summary":"Generated summary"}),
                json!({"type":"summary","summary":"Later generated summary"})
            ),
        );
        let result = list_from_root(Provider::Claude, &fixture.0);
        assert_eq!(result.sessions[0].title, "Chosen title");
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn claude_excludes_sidechains_nested_agents_and_invalid_filenames() {
        let fixture = Fixture::new();
        fixture.write(
            format!("projects/example/{SESSION_ID}.jsonl"),
            &json!({"sessionId":SESSION_ID,"isSidechain":true,"cwd":"/sidechain"}).to_string(),
        );
        fixture.write(
            format!("projects/example/{SECOND_ID}/subagents/agent-test.jsonl"),
            "not parsed",
        );
        fixture.write("projects/example/invalid.jsonl", "not parsed");
        let result = list_from_root(Provider::Claude, &fixture.0);
        assert!(result.sessions.is_empty());
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn claude_native_index_sidechains_cannot_reenter_through_file_fallback() {
        let fixture = Fixture::new();
        fixture.write(format!("projects/example/{SESSION_ID}.jsonl"), "");
        fixture.write(
            "projects/example/sessions-index.json",
            &json!({"entries":[{"sessionId":SESSION_ID,"summary":"Child session","isSidechain":true}]}).to_string(),
        );
        let result = list_from_root(Provider::Claude, &fixture.0);
        assert!(result.sessions.is_empty());
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn exhausted_scan_budgets_cannot_add_unclassified_claude_sidechains() {
        let fixture = Fixture::new();
        fixture.write(
            format!("projects/example/{SESSION_ID}.jsonl"),
            &format!(
                "{}\n{}\n",
                json!({"type":"custom-title","sessionId":SESSION_ID,"customTitle":"Child session"}),
                json!({"type":"user","sessionId":SESSION_ID,"isSidechain":true})
            ),
        );
        for (records, bytes) in [(MAX_RECORDS, 0), (MAX_RECORDS - 1, 0), (0, MAX_TOTAL_BYTES)] {
            let mut discovery = Discovery {
                records,
                bytes,
                ..Discovery::default()
            };
            discover_claude(&fixture.0, &mut discovery);
            let result = discovery.finish();
            assert!(result.sessions.is_empty());
            assert!(result.truncated);
        }
    }

    #[test]
    fn claude_tail_finds_titles_after_a_large_unparsed_message() {
        let fixture = Fixture::new();
        let prefix =
            json!({"sessionId":SESSION_ID,"cwd":"/project","isSidechain":false}).to_string();
        let message = "x".repeat(CLAUDE_WINDOW_BYTES * 3);
        fixture.write(
            format!("projects/example/{SESSION_ID}.jsonl"),
            &format!(
                "{prefix}\n{{\"type\":\"user\",\"message\":{{\"content\":\"{message}\"}}}}\n{}\n",
                json!({"type":"custom-title","sessionId":SESSION_ID,"customTitle":"Tail title"})
            ),
        );
        let result = list_from_root(Provider::Claude, &fixture.0);
        assert_eq!(result.sessions[0].title, "Tail title");
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn discovery_deduplicates_sorts_and_caps_sessions() {
        let mut discovery = Discovery::default();
        for index in 0..MAX_SESSIONS + 1 {
            let id = format!("00000000-0000-0000-0000-{index:012x}");
            discovery.insert(LocalAgentSession {
                id,
                title: "Session".to_string(),
                project_path: None,
                updated_at: Some(index as u64),
            });
        }
        let id = "00000000-0000-0000-0000-000000000000".to_string();
        discovery.insert(LocalAgentSession {
            id: id.clone(),
            title: "Newest".to_string(),
            project_path: None,
            updated_at: Some(u64::MAX),
        });
        let result = discovery.finish();
        assert_eq!(result.sessions.len(), MAX_SESSIONS);
        assert_eq!(result.sessions[0].id, id);
        assert_eq!(result.sessions[0].title, "Newest");
        assert!(result.truncated);
    }

    #[test]
    fn scan_limits_are_explicit_and_oversized_headers_are_not_parsed() {
        let fixture = Fixture::new();
        fixture.write(
            format!("sessions/rollout-{SESSION_ID}.jsonl"),
            &"x".repeat(MAX_METADATA_BYTES + 1),
        );
        let result = list_from_root(Provider::Codex, &fixture.0);
        assert!(result.sessions.is_empty());
        assert!(result.truncated);
        let mut discovery = Discovery::default();
        discovery.files = MAX_FILES;
        assert!(!discovery.claim_file());
        discovery.records = MAX_RECORDS;
        assert!(!discovery.claim_record());
        assert_eq!(discovery.result.warnings.len(), 1);
    }

    #[test]
    fn metadata_paths_cannot_escape_the_provider_root() {
        let root = Fixture::new();
        let outside = Fixture::new();
        let path = outside.write("metadata.jsonl", "private outside data");
        let mut discovery = Discovery::default();
        assert!(checked_metadata(&path, &root.0, &mut discovery).is_none());
        assert_eq!(
            discovery.result.warnings,
            ["Skipped session metadata outside the agent directory"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn linked_provider_roots_and_linked_session_directories_are_skipped() {
        use std::os::unix::fs::symlink;
        let root = Fixture::new();
        let outside = Fixture::new();
        outside.rollout(SESSION_ID, json!("cli"));
        symlink(outside.0.join("sessions"), root.0.join("sessions")).unwrap();
        let result = list_from_root(Provider::Codex, &root.0);
        assert!(result.sessions.is_empty());
        assert!(!result.warnings.is_empty());
        let link = root.0.join("linked-root");
        symlink(&outside.0, &link).unwrap();
        let result = list_from_root(Provider::Codex, &link);
        assert!(result.sessions.is_empty());
        assert!(!result.warnings.is_empty());
    }

    #[test]
    fn timestamps_and_display_text_have_explicit_null_and_size_boundaries() {
        let mut discovery = Discovery::default();
        assert_eq!(timestamp_ms(None, &mut discovery), None);
        assert_eq!(timestamp_ms(Some(&Value::Null), &mut discovery), None);
        assert_eq!(timestamp_ms(Some(&json!(0)), &mut discovery), Some(0));
        assert_eq!(
            timestamp_ms(Some(&json!(u64::MAX)), &mut discovery),
            Some(u64::MAX)
        );
        assert_eq!(
            timestamp_ms(Some(&json!("1970-01-01T01:00:00+01:00")), &mut discovery),
            Some(0)
        );
        for value in [json!(-1), json!("bad"), json!(true)] {
            assert_eq!(timestamp_ms(Some(&value), &mut discovery), None);
        }
        assert_eq!(discovery.result.warnings.len(), 1);
        assert_eq!(
            text(Some(&json!("  title\nvalue  ")), MAX_TITLE_CHARACTERS).as_deref(),
            Some("title value")
        );
        assert_eq!(
            text(
                Some(&json!("é".repeat(MAX_TITLE_CHARACTERS + 1))),
                MAX_TITLE_CHARACTERS
            )
            .unwrap()
            .chars()
            .count(),
            MAX_TITLE_CHARACTERS
        );
        assert_eq!(text(Some(&Value::Null), MAX_TITLE_CHARACTERS), None);
    }
}
