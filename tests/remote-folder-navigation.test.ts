import assert from "node:assert/strict";
import test from "node:test";
import { navigateRemoteFolder } from "../src/remote-folder-navigation.ts";
import type { SnippetSession } from "../src/named-snippets-integration.ts";

function harness() {
  let token: object | null = {};
  const writes: string[] = [];
  const resolutions: string[] = [];
  let beforeWrite = () => {};
  const session = {
    id: "tab", kind: "ssh", name: "API", connectionId: "transport", isClosed: false, isClosing: false, isConnecting: false,
    term: { focus() {} }, commandHistory: {
      getPromptToken: () => token,
      async sendSnippet(command: string, run: boolean, expected: object, write: (text: string) => Promise<void>) {
        assert.equal(expected, token); assert.equal(run, true); token = null;
        beforeWrite(); await write(command + "\r");
      },
    } as SnippetSession["commandHistory"],
  };
  let active: SnippetSession | null = session;
  const options = {
    session, getSession: () => active, path: "~/app files",
    async resolvePath(id: string, path: string) { assert.equal(id, "transport"); resolutions.push(path); return "/home/deploy/app files"; },
    async writeText(id: string, text: string) { assert.equal(id, "transport"); writes.push(text); },
  };
  return { options, session, writes, resolutions,
    active(value: SnippetSession | null) { active = value; },
    busy() { token = null; },
    prompt() { token = {}; },
    beforeWrite(callback: () => void) { beforeWrite = callback; },
  };
}

test("saved folders resolve home paths and navigate exactly once in the selected SSH session", async () => {
  const h = harness();
  assert.equal(await navigateRemoteFolder(h.options), "/home/deploy/app files");
  assert.deepEqual(h.resolutions, ["./app files"]);
  assert.deepEqual(h.writes, ["cd '/home/deploy/app files'\r"]);
  await assert.rejects(navigateRemoteFolder(h.options), /ready shell prompt/);
});

test("empty, malformed, busy, disconnected and cross-session navigation never writes", async () => {
  for (const change of [
    (h: ReturnType<typeof harness>) => { h.options.path = ""; },
    (h: ReturnType<typeof harness>) => { h.options.path = null as unknown as string; },
    (h: ReturnType<typeof harness>) => h.busy(),
    (h: ReturnType<typeof harness>) => { h.session.isClosed = true; },
    (h: ReturnType<typeof harness>) => { h.session.isConnecting = true; },
    (h: ReturnType<typeof harness>) => { h.session.isClosing = true; },
    (h: ReturnType<typeof harness>) => h.active(null),
  ]) {
    const h = harness(); change(h);
    await assert.rejects(navigateRemoteFolder(h.options));
    assert.deepEqual(h.writes, []); assert.deepEqual(h.resolutions, []);
  }
});

test("navigation rejects changed prompts, panes and transports while resolving", async () => {
  for (const change of [
    (h: ReturnType<typeof harness>) => h.prompt(),
    (h: ReturnType<typeof harness>) => h.active({ ...h.session, id: "other" }),
    (h: ReturnType<typeof harness>) => { h.session.connectionId = "replacement"; },
    (h: ReturnType<typeof harness>) => { h.session.isClosed = true; },
    (h: ReturnType<typeof harness>) => { h.session.term = { focus() {} }; },
  ]) {
    const h = harness();
    h.options.resolvePath = async () => { change(h); return "/app"; };
    await assert.rejects(navigateRemoteFolder(h.options), /terminal or prompt changed/);
    assert.deepEqual(h.writes, []);
  }
});

test("a session change at the writer and resolver or writer failures propagate", async () => {
  const changed = harness(); changed.beforeWrite(() => changed.active(null));
  await assert.rejects(navigateRemoteFolder(changed.options), /target SSH session changed/);
  assert.deepEqual(changed.writes, []);
  const missing = harness(); missing.options.resolvePath = async () => { throw new Error("Folder does not exist"); };
  await assert.rejects(navigateRemoteFolder(missing.options), /does not exist/);
  assert.deepEqual(missing.writes, []);
  const failed = harness(); failed.options.writeText = async () => { throw new Error("Write failed"); };
  await assert.rejects(navigateRemoteFolder(failed.options), /Write failed/);
});
