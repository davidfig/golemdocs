// The page is the live website, so it can run in a shell older than itself: calls to commands that shell lacks must not break it.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { desktopBridge, fromBase64, isMissingCommand, ShellTooOldError, toBase64 } from '../src/desktop/bridge.ts';

/** A shell with only the commands in `have`; any other call rejects the way Tauri does. */
function shell(have: Record<string, unknown>, rejection = (command: string) => `Command ${command} not found`) {
  const g = globalThis as Record<string, unknown>;
  g.__TAURI__ = { core: { invoke: async (command: string) => (command in have ? have[command] : Promise.reject(rejection(command))) } };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI__;
});

test('isMissingCommand tells a missing or disallowed command from other failures', () => {
  assert.equal(isMissingCommand('Command vault_check not found'), true);
  assert.equal(isMissingCommand('vault_check not allowed by ACL'), true);
  assert.equal(isMissingCommand(new Error('Command x not found')), true);
  assert.equal(isMissingCommand('The folder was not found'), false);
  assert.equal(isMissingCommand('Golem Docs can’t read this folder'), false);
});

test('the access check is skipped by a shell that lacks it, but a real refusal still comes through', async () => {
  shell({});
  await desktopBridge()!.check();
  shell({ vault_check: Promise.reject('Operation not permitted') });
  await assert.rejects(desktopBridge()!.check(), /Operation not permitted/);
});

test('Show in Finder and Open Privacy Settings say the app needs updating when the shell lacks them', async () => {
  shell({});
  await assert.rejects(desktopBridge()!.reveal(), ShellTooOldError);
  await assert.rejects(desktopBridge()!.openPrivacy(), ShellTooOldError);
  shell({}, (command) => `${command} not allowed by ACL`);
  await assert.rejects(desktopBridge()!.reveal(), ShellTooOldError);
});

test('a shell that has the commands works as before', async () => {
  shell({ vault_check: undefined, vault_reveal: undefined, vault_open_privacy: undefined });
  const bridge = desktopBridge()!;
  await bridge.check();
  await bridge.reveal();
  await bridge.openPrivacy();
});

/** A shell that records each call, answering from `answer` (a missing command rejects as Tauri does). */
function recordingShell(answer: Record<string, (args: Record<string, unknown> | undefined) => unknown>) {
  const calls: { command: string; args: unknown }[] = [];
  (globalThis as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return command in answer ? answer[command](args) : Promise.reject(`Command ${command} not found`);
      },
    },
  };
  return calls;
}

test('base64 goes both ways, also for files too large for one call', () => {
  for (const bytes of [new Uint8Array(), Uint8Array.of(0, 255, 254, 62, 63), Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7) % 256)]) {
    const text = toBase64(bytes);
    assert.equal(text, Buffer.from(bytes).toString('base64'));
    assert.deepEqual(fromBase64(text), bytes);
  }
});

test('files are read and written as base64 text, which crosses as one string however the web view carries it', async () => {
  const file = Uint8Array.of(1, 2, 3, 250);
  const calls = recordingShell({ vault_read_base64: () => toBase64(file), vault_write_base64: () => 42 });
  const bridge = desktopBridge()!;
  assert.deepEqual(await bridge.read('a/b.pdf'), file);
  assert.equal(await bridge.write('a/b.pdf', file), 42);
  assert.deepEqual(calls, [
    { command: 'vault_read_base64', args: { path: 'a/b.pdf' } },
    { command: 'vault_write_base64', args: { path: 'a/b.pdf', data: 'AQID+g==' } },
  ]);
});

test('a shell without the base64 commands is sent the raw bytes, and not asked for them again', async () => {
  const file = Uint8Array.of(9, 8, 7);
  const calls = recordingShell({ vault_read: () => [9, 8, 7], vault_write: () => 7 });
  const bridge = desktopBridge()!;
  assert.deepEqual(await bridge.read('x.png'), file);
  assert.equal(await bridge.write('x.png', file), 7);
  assert.equal(await bridge.write('y.png', file), 7);
  assert.deepEqual(calls.map((c) => c.command), ['vault_read_base64', 'vault_read', 'vault_write', 'vault_write']);
  assert.equal(calls[2].args, file, 'the bytes are the body');
});

test('a real failure of the base64 commands comes through', async () => {
  recordingShell({ vault_write_base64: () => Promise.reject('No space left on device'), vault_write: () => 1 });
  await assert.rejects(desktopBridge()!.write('a.md', Uint8Array.of(1)), /No space left/);
});
