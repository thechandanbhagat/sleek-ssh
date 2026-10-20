use crate::automation_mcp::{BRIDGE_ARGUMENT, ENDPOINT_ENV, TOKEN_ENV};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

const MCP_TOOL_TIMEOUT_SECONDS: u32 = 480;
const CONVERSATION_ID_BYTES: usize = 36;
const UUID_SEPARATOR_POSITIONS: [usize; 4] = [8, 13, 18, 23];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Provider {
    Claude,
    Codex,
}

#[derive(Serialize)]
pub(crate) struct ProviderAvailability {
    id: &'static str,
    name: &'static str,
    available: bool,
    executable: Option<String>,
}

impl Provider {
    pub(crate) fn parse(id: &str) -> Result<Self, String> {
        match id {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            _ => Err("Choose Claude Code or Codex".to_string()),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
        }
    }

    pub(crate) fn executable(self) -> Result<PathBuf, String> {
        find_executable(self).ok_or_else(|| {
            format!(
                "{} was not found. Install its native CLI, sign in locally, and restart SleekSSH.",
                self.name()
            )
        })
    }

    pub(crate) fn command(
        self,
        executable: &Path,
        bridge_executable: &Path,
        resume_session_id: Option<&str>,
    ) -> Command {
        let mut command = Command::new(executable);
        command.args(provider_arguments(
            self,
            bridge_executable,
            resume_session_id,
        ));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command
    }
}

pub(crate) fn availability() -> Vec<ProviderAvailability> {
    [Provider::Claude, Provider::Codex]
        .into_iter()
        .map(|provider| {
            let executable = find_executable(provider);
            ProviderAvailability {
                id: provider.id(),
                name: provider.name(),
                available: executable.is_some(),
                executable: executable.map(|path| path.to_string_lossy().into_owned()),
            }
        })
        .collect()
}

fn find_executable(provider: Provider) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut candidates = paths
        .into_iter()
        .map(|path| path.join(format!("{}{}", provider.id(), std::env::consts::EXE_SUFFIX)))
        .collect::<Vec<_>>();
    #[cfg(windows)]
    if let Some(local) = dirs::data_local_dir() {
        candidates.push(
            local
                .join("Microsoft/WinGet/Links")
                .join(format!("{}.exe", provider.id())),
        );
        if provider == Provider::Codex {
            candidates.push(local.join("Programs/OpenAI/Codex/bin/codex.exe"));
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn provider_arguments(
    provider: Provider,
    bridge: &Path,
    resume_session_id: Option<&str>,
) -> Vec<String> {
    let bridge = bridge.to_string_lossy();
    match provider {
        Provider::Claude => {
            let configuration = json!({"mcpServers":{"sleekssh":{
                "command":bridge, "args":[BRIDGE_ARGUMENT], "env":{
                    ENDPOINT_ENV: format!("${{{ENDPOINT_ENV}}}"),
                    TOKEN_ENV: format!("${{{TOKEN_ENV}}}")
                }
            }}});
            let mut arguments = [
                "--print",
                "--output-format",
                "stream-json",
                "--verbose",
                "--restricted",
                "--tools",
                "",
                "--strict-mcp-config",
                "--mcp-config",
                &configuration.to_string(),
                "--disable-slash-commands",
                "--no-chrome",
                "--system-prompt-snapshot",
                "off",
                "--permission-mode",
                "dontAsk",
                "--permission-prompts",
                "none",
                "--allowedTools",
                "mcp__sleekssh__run_command",
                "--settings",
                "{\"disableAllHooks\":true}",
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
            if let Some(session_id) = resume_session_id {
                arguments.extend(["--resume".to_string(), session_id.to_string()]);
            }
            arguments
        }
        Provider::Codex => {
            let mut arguments = [
                "exec",
                "--json",
                "--ignore-user-config",
                "--ignore-rules",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
            for setting in [
                "approval_policy=\"never\"",
                "web_search=\"disabled\"",
                "features.shell_tool=false",
                "features.shell_snapshot=false",
                "features.hooks=false",
                "features.plugins=false",
                "features.apps=false",
                "features.browser_use=false",
                "features.browser_use_external=false",
                "features.computer_use=false",
                "features.image_generation=false",
                "features.view_image=false",
                "features.multi_agent=false",
                "features.multi_agent_v2=false",
                "features.memories=false",
                "features.skill_search=false",
                "features.skill_mcp_dependency_install=false",
                "features.skip_host_skill_discovery=true",
                "features.workspace_dependencies=false",
            ] {
                arguments.extend(["-c".to_string(), setting.to_string()]);
            }
            let bridge_command =
                serde_json::to_string(bridge.as_ref()).expect("Path strings serialize");
            arguments.extend(["-c".to_string(), format!("mcp_servers.sleekssh={{command={bridge_command},args=[\"{BRIDGE_ARGUMENT}\"],env_vars=[\"{ENDPOINT_ENV}\",\"{TOKEN_ENV}\"],enabled_tools=[\"run_command\"],default_tools_approval_mode=\"approve\",tool_timeout_sec={MCP_TOOL_TIMEOUT_SECONDS},required=true}}")]);
            if let Some(session_id) = resume_session_id {
                arguments.extend(["resume".to_string(), session_id.to_string()]);
            }
            arguments.push("-".to_string());
            arguments
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AgentOutput {
    Session(String),
    Text(String),
    Failure(String),
    Completed,
    Ignore,
}

pub(crate) fn validate_conversation_id(id: &str) -> Result<(), String> {
    if id.len() != CONVERSATION_ID_BYTES
        || id.as_bytes().iter().enumerate().any(|(index, byte)| {
            if UUID_SEPARATOR_POSITIONS.contains(&index) {
                *byte != b'-'
            } else {
                !byte.is_ascii_hexdigit()
            }
        })
    {
        return Err("Conversation ID must be a UUID".to_string());
    }
    Ok(())
}

fn session_output(value: Option<&Value>) -> AgentOutput {
    match value.and_then(Value::as_str) {
        Some(id) if validate_conversation_id(id).is_ok() => AgentOutput::Session(id.to_string()),
        _ => AgentOutput::Ignore,
    }
}

pub(crate) fn parse_output(line: &str) -> AgentOutput {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return AgentOutput::Ignore;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("system") if value.get("subtype").and_then(Value::as_str) == Some("init") => {
            session_output(value.get("session_id"))
        }
        Some("thread.started") => session_output(value.get("thread_id")),
        Some("turn.completed") => AgentOutput::Completed,
        Some("assistant") => {
            let text = value
                .pointer("/message/content")
                .and_then(Value::as_array)
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|block| block.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            if text.is_empty() {
                AgentOutput::Ignore
            } else {
                AgentOutput::Text(text)
            }
        }
        Some("item.completed")
            if value.pointer("/item/type").and_then(Value::as_str) == Some("agent_message") =>
        {
            value
                .pointer("/item/text")
                .and_then(Value::as_str)
                .map(|text| AgentOutput::Text(text.to_string()))
                .unwrap_or(AgentOutput::Ignore)
        }
        Some("error" | "turn.failed") => AgentOutput::Failure(
            value
                .pointer("/error/message")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Agent request failed")
                .to_string(),
        ),
        Some("result") if value.get("is_error").and_then(Value::as_bool) == Some(true) => {
            AgentOutput::Failure(
                value
                    .get("result")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| value.get("errors").map(Value::to_string))
                    .unwrap_or_else(|| "Claude request failed".to_string()),
            )
        }
        Some("result") if value.get("is_error").and_then(Value::as_bool) == Some(false) => {
            AgentOutput::Completed
        }
        _ => AgentOutput::Ignore,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION_ID: &str = "01a15399-7b9f-7641-a520-389ad6379a30";

    #[test]
    fn providers_reject_unknown_empty_and_shell_injection_names() {
        assert_eq!(Provider::parse("claude").unwrap(), Provider::Claude);
        assert_eq!(Provider::parse("codex").unwrap(), Provider::Codex);
        for id in ["", "Claude", "codex.exe", "claude; whoami", "\0"] {
            assert!(Provider::parse(id).is_err());
        }
        assert_eq!(availability().len(), 2);
    }

    #[test]
    fn commands_preserve_literal_paths_and_restrict_local_execution() {
        let path = Path::new("C:/Program Files/SleekSSH/app.exe");
        let claude = Provider::Claude.command(Path::new("claude"), path, None);
        let args = claude
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect::<Vec<_>>();
        assert!(args.windows(2).any(|args| args == ["--tools", ""]));
        assert!(args.contains(&"--restricted"));
        assert!(args.contains(&"--strict-mcp-config"));
        assert!(args
            .windows(2)
            .any(|args| args == ["--system-prompt-snapshot", "off"]));
        assert!(!args.contains(&"--no-session-persistence"));
        assert!(!args.contains(&"--resume"));
        let config_index = args.iter().position(|arg| *arg == "--mcp-config").unwrap() + 1;
        let config: Value = serde_json::from_str(args[config_index]).unwrap();
        assert_eq!(
            config["mcpServers"]["sleekssh"]["command"],
            path.to_string_lossy().as_ref()
        );
        assert_eq!(
            config["mcpServers"]["sleekssh"]["env"][TOKEN_ENV],
            format!("${{{TOKEN_ENV}}}")
        );
        let codex = Provider::Codex.command(Path::new("codex"), path, None);
        let args = codex
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect::<Vec<_>>();
        assert!(args.contains(&"features.shell_tool=false"));
        assert!(args.contains(&"--ignore-user-config"));
        assert!(!args.contains(&"--ephemeral"));
        assert!(!args.contains(&"resume"));
        assert!(args
            .windows(2)
            .any(|args| args == ["--sandbox", "read-only"]));
        assert!(args
            .iter()
            .any(|argument| argument.contains("default_tools_approval_mode=\"approve\"")));
        assert_eq!(args.last(), Some(&"-"));
    }

    #[test]
    fn resumed_commands_preserve_configuration_and_use_provider_resume_syntax() {
        let path = Path::new("C:/Program Files/SleekSSH/app.exe");
        let fresh_claude = provider_arguments(Provider::Claude, path, None);
        let resumed_claude = Provider::Claude.command(Path::new("claude"), path, Some(SESSION_ID));
        let args = resumed_claude
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(&args[..fresh_claude.len()], fresh_claude.as_slice());
        assert_eq!(&args[fresh_claude.len()..], ["--resume", SESSION_ID]);
        assert!(!args.contains(&"--no-session-persistence"));

        let fresh_codex = provider_arguments(Provider::Codex, path, None);
        let resumed_codex = Provider::Codex.command(Path::new("codex"), path, Some(SESSION_ID));
        let args = resumed_codex
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect::<Vec<_>>();
        let configuration_argument_count = fresh_codex.len() - 1;
        assert_eq!(
            &args[..configuration_argument_count],
            &fresh_codex[..configuration_argument_count]
        );
        assert_eq!(
            &args[configuration_argument_count..],
            ["resume", SESSION_ID, "-"]
        );
        assert!(!args.contains(&"--ephemeral"));
    }

    #[test]
    fn conversation_ids_require_canonical_uuid_bytes() {
        for id in [
            SESSION_ID,
            "01A15399-7B9F-7641-A520-389AD6379A30",
            "00000000-0000-0000-0000-000000000000",
            "ffffffff-ffff-ffff-ffff-ffffffffffff",
        ] {
            assert!(validate_conversation_id(id).is_ok(), "{id}");
        }
        for id in [
            "",
            "01a153997b9f7641a520389ad6379a30",
            "01a15399_7b9f-7641-a520-389ad6379a30",
            "g1a15399-7b9f-7641-a520-389ad6379a30",
            "01a15399-7b9f-7641-a520-389ad6379a3",
            "01a15399-7b9f-7641-a520-389ad6379a300",
            "01a15399-7b9f-7641-a520-389ad6379a3\0",
            "01a15399-7b9f-7641-a520-389ad6379a3\n",
            "é1a15399-7b9f-7641-a520-389ad6379a30",
            "../../../../../../../../../../../../",
        ] {
            assert!(validate_conversation_id(id).is_err(), "{id:?}");
        }
    }

    #[test]
    fn output_extracts_valid_provider_conversation_ids() {
        assert_eq!(
            parse_output(
                &json!({"type":"system", "subtype":"init", "session_id":SESSION_ID}).to_string()
            ),
            AgentOutput::Session(SESSION_ID.to_string())
        );
        assert_eq!(
            parse_output(&json!({"type":"thread.started", "thread_id":SESSION_ID}).to_string()),
            AgentOutput::Session(SESSION_ID.to_string())
        );
    }

    #[test]
    fn output_ignores_invalid_or_unrelated_provider_conversation_ids() {
        for value in [
            json!({"type":"system", "subtype":"init"}),
            json!({"type":"system", "subtype":"init", "session_id":null}),
            json!({"type":"system", "subtype":"init", "session_id":42}),
            json!({"type":"system", "subtype":"init", "session_id":""}),
            json!({"type":"system", "subtype":"init", "session_id":"--last"}),
            json!({"type":"system", "subtype":"status", "session_id":SESSION_ID}),
            json!({"type":"thread.started"}),
            json!({"type":"thread.started", "thread_id":null}),
            json!({"type":"thread.started", "thread_id":[]}),
            json!({"type":"thread.started", "thread_id":""}),
            json!({"type":"thread.started", "thread_id":"../../history"}),
            json!({"type":"thread.completed", "thread_id":SESSION_ID}),
        ] {
            assert_eq!(parse_output(&value.to_string()), AgentOutput::Ignore);
        }
    }

    #[test]
    fn output_extracts_messages_and_errors_without_tool_metadata() {
        assert_eq!(
            parse_output(
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"},{"type":"tool_use","name":"secret"}]}}"#
            ),
            AgentOutput::Text("hello".to_string())
        );
        assert_eq!(
            parse_output(
                r#"{"type":"item.completed","item":{"type":"agent_message","text":"done"}}"#
            ),
            AgentOutput::Text("done".to_string())
        );
        assert_eq!(
            parse_output(r#"{"type":"turn.failed","error":{"message":"auth required"}}"#),
            AgentOutput::Failure("auth required".to_string())
        );
        assert_eq!(
            parse_output(r#"{"type":"turn.completed"}"#),
            AgentOutput::Completed
        );
        assert_eq!(
            parse_output(r#"{"type":"result","is_error":false}"#),
            AgentOutput::Completed
        );
        assert_eq!(
            parse_output(r#"{"type":"result","is_error":true,"errors":["login"]}"#),
            AgentOutput::Failure("[\"login\"]".to_string())
        );
        for line in [
            "",
            "not json",
            "null",
            r#"{"type":"assistant"}"#,
            r#"{"type":"item.completed","item":{"type":"mcp_tool_call"}}"#,
        ] {
            assert_eq!(parse_output(line), AgentOutput::Ignore);
        }
    }
}
