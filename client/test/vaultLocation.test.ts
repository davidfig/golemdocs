// Whether the vault folder is in a folder another service syncs (src/desktop/vaultLocation.ts): an encrypted folder is decrypted into the
// vault only when it isn't (docs/encrypted-folders.md).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncedService } from '../src/desktop/vaultLocation.ts';

test('a vault in iCloud Drive, Dropbox, OneDrive, Google Drive or Box is told by its path, on a Mac and on Windows', () => {
  const cases: [string, string | null][] = [
    ["/Users/sam/Library/Mobile Documents/com~apple~CloudDocs/Sam's Vault", 'iCloud Drive'],
    ['/Users/sam/Library/Mobile Documents/iCloud~com~golemdocs/Documents', 'iCloud Drive'],
    ['/Users/sam/Library/CloudStorage/Dropbox/Vault', 'Dropbox'],
    ['/Users/sam/Library/CloudStorage/OneDrive-Personal/Vault', 'OneDrive'],
    ['/Users/sam/Library/CloudStorage/GoogleDrive-sam@example.com/My Drive/Vault', 'Google Drive'],
    ['/Users/sam/Library/CloudStorage/Box-Box/Vault', 'Box'],
    ['/Users/sam/Dropbox/Vault', 'Dropbox'],
    ['/Users/sam/Dropbox (Personal)/Vault', 'Dropbox'],
    ['C:\\Users\\sam\\OneDrive\\Documents\\Vault', 'OneDrive'],
    ['C:\\Users\\sam\\OneDrive - Contoso\\Vault', 'OneDrive'],
    ['C:\\Users\\sam\\iCloudDrive\\Vault', 'iCloud Drive'],
    ["/Users/sam/Documents/Sam's Vault", null],
    ['/home/sam/Vault', null],
    ['C:\\Users\\sam\\Documents\\Vault', null],
  ];
  for (const [path, service] of cases) assert.equal(syncedService(path), service, path);
});
