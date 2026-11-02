import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { COMMAND_HISTORY_OSC, SSH_COMMAND_HISTORY_SCRIPT } from "../src/shell-integration.ts";

const PROCESS_TIMEOUT_MS = 30_000;
const BASH_PATH = process.platform === "win32"
  ? ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files/Git/usr/bin/bash.exe"].find(existsSync)
  : "/bin/bash";
const OSC_PATTERN = /\x1b\]6973;([^\x07]*)\x07/g;

function runBash(commands: readonly string[], environment: Record<string, string> = {}) {
  assert(BASH_PATH);
  const result = spawnSync(BASH_PATH, ["--noprofile", "--norc", "-c", 'exec "$BASH" --noprofile --norc -i 2>&1'], {
    input: [SSH_COMMAND_HISTORY_SCRIPT, ...commands, "exit 0"].join("\n") + "\n",
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    env: { ...process.env, HISTFILE: "/dev/null", PS1: "test> ", ...environment },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const messages = [...result.stdout.matchAll(OSC_PATTERN)].map(match => match[1]);
  const recorded = messages.filter(message => message.startsWith("command;"))
    .map(message => Buffer.from(message.slice("command;".length), "base64").toString("utf8"));
  return { ...result, messages, recorded };
}

test("shell history integration uses the expected private OSC protocol", () => {
  assert.equal(COMMAND_HISTORY_OSC, 6973);
  for (const kind of ["prompt-start", "prompt-end", "command;", "busy"]) assert(SSH_COMMAND_HISTORY_SCRIPT.includes(kind));
  assert(!SSH_COMMAND_HISTORY_SCRIPT.includes("trap "));
  assert(!SSH_COMMAND_HISTORY_SCRIPT.includes("bind "));
  assert(!SSH_COMMAND_HISTORY_SCRIPT.includes("HISTCONTROL="));
});

test("Bash reports canonical commands before busy and marks prompt boundaries", { skip: !BASH_PATH }, () => {
  const result = runBash(["printf '%s\\n' 'one & two'", "printf '%s\\n' café", "false"]);
  assert.deepEqual(result.recorded, ["printf '%s\\n' 'one & two'", "printf '%s\\n' café", "false", "exit 0"]);
  for (const [index, message] of result.messages.entries()) {
    if (message.startsWith("command;")) assert.equal(result.messages[index + 1], "busy");
    if (message === "prompt-start") assert.equal(result.messages[index + 1], "prompt-end");
  }
  assert.match(result.stdout, /one & two/);
  assert.match(result.stdout, /café/);
});

test("Bash repeated commands remain distinct when native history retains them", { skip: !BASH_PATH }, () => {
  const result = runBash(["echo repeated", "echo repeated"], { HISTCONTROL: "" });
  assert.equal(result.recorded.filter(command => command === "echo repeated").length, 2);
});

test("Bash reports leading-space commands literally so history can honor private commands", { skip: !BASH_PATH }, () => {
  const result = runBash([" echo private"], { HISTCONTROL: "" });
  assert.equal(result.recorded[0], " echo private");
});

test("Bash history-suppressed commands emit busy without attributing stale history", { skip: !BASH_PATH }, () => {
  const result = runBash(["echo repeated", "echo repeated", " echo private", "echo ignored"], {
    HISTCONTROL: "ignoreboth",
    HISTIGNORE: "echo ignored",
  });
  assert.deepEqual(result.recorded, ["echo repeated", "exit 0"]);
  assert.equal(result.messages.filter(message => message === "busy").length, 5);
});

test("Bash without PS0 support reports retained commands at the next prompt", { skip: !BASH_PATH }, () => {
  const result = runBash(["PS0=; __sleekssh_history_has_ps0=0", "echo legacy", "echo legacy"], { HISTCONTROL: "" });
  assert.equal(result.recorded.filter(command => command === "echo legacy").length, 2);
  const commandMessage = "command;" + Buffer.from("echo legacy").toString("base64");
  for (const [index, message] of result.messages.entries()) {
    if (message === commandMessage) assert.equal(result.messages[index + 1], "prompt-start");
  }
  assert(result.recorded.every(command => command !== SSH_COMMAND_HISTORY_SCRIPT));
  assert(SSH_COMMAND_HISTORY_SCRIPT.includes("BASH_VERSINFO[0] > 4"));
  assert(SSH_COMMAND_HISTORY_SCRIPT.includes("BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4"));
});

test("Bash hooks preserve existing prompt and PS0 commands and install once", { skip: !BASH_PATH }, () => {
  const result = runBash([SSH_COMMAND_HISTORY_SCRIPT, "false"], {
    PROMPT_COMMAND: "printf 'original-prompt-status:%s\\n' \"$?\"",
    PS0: "original-preexec\n",
  });
  assert.match(result.stdout, /original-prompt-status:1/);
  assert.match(result.stdout, /original-preexec/);
  const falseIndex = result.recorded.indexOf("false");
  assert(falseIndex >= 0);
  const commandMessage = "command;" + Buffer.from("false").toString("base64");
  assert.equal(result.messages.filter(message => message === commandMessage).length, 1);
  assert.equal(result.messages.filter(message => message === "prompt-start").length, 3);
});

test("PowerShell prompt and accepted-line wrappers preserve user functions and Unicode", { skip: process.platform !== "win32" }, () => {
  const source = readFileSync(new URL("../src-tauri/src/local_terminal.rs", import.meta.url), "utf8");
  const script = source.match(/const POWERSHELL_COMMAND_HISTORY_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];
  assert(script);
  const command = [
    "Import-Module PSReadLine -ErrorAction Stop",
    "function global:prompt { 'custom> ' }",
    "function global:PSConsoleHostReadLine { 'Write-Output ''café & test''' }",
    script,
    "[Console]::Write((prompt))",
    "$line = PSConsoleHostReadLine",
    "[Console]::Write('|accepted:' + $line)",
    "$global:__SleekSSHOriginalReadLine = { '' }",
    "$blankLine = PSConsoleHostReadLine",
  ].join(";\n");
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8", timeout: PROCESS_TIMEOUT_MS,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\x1b\]6973;prompt-start\x07custom> \x1b\]6973;prompt-end\x07/);
  const messages = [...result.stdout.matchAll(OSC_PATTERN)].map(match => match[1]);
  const commandIndex = messages.findIndex(message => message.startsWith("command;"));
  assert(commandIndex >= 0);
  assert.equal(Buffer.from(messages[commandIndex].slice("command;".length), "base64").toString("utf8"), "Write-Output 'café & test'");
  assert.equal(messages[commandIndex + 1], "busy");
  assert.equal(messages.filter(message => message.startsWith("command;")).length, 1);
  assert.equal(messages.filter(message => message === "busy").length, 2);
});

test("Command Prompt expands prompt markers around the visible prompt", { skip: process.platform !== "win32" }, () => {
  const result = spawnSync("cmd.exe", ["/D", "/Q"], {
    input: "echo history-test\r\nexit\r\n", encoding: "utf8", timeout: PROCESS_TIMEOUT_MS,
    env: { ...process.env, PROMPT: "$E]6973;prompt-start$E\\$P$G$S$E]6973;prompt-end$E\\" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\x1b\]6973;prompt-start\x1b\\[^\x1b]+> \x1b\]6973;prompt-end\x1b\\/);
  assert.match(result.stdout, /history-test/);
});
