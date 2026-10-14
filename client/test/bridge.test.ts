// The page is the live website, so it can run in a shell older than itself: calls to commands that shell lacks must not break it.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { desktopBridge, isMissingCommand, ShellTooOldError } from '../src/desktop/bridge.ts';

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
