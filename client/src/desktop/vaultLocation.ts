// Whether the vault folder is inside a folder another service syncs to its servers (iCloud Drive, Dropbox, OneDrive, Google Drive, Box),
// told from its path. An encrypted folder is decrypted into the vault only when it isn't (docs/encrypted-folders.md): the service would
// upload the readable files. macOS's "Desktop & Documents in iCloud" syncs ~/Documents without changing its path, so it can't be told
// from here; the warning before decrypting says so.

/** The service whose synced folder `path` is in, or null for none that can be told. */
export function syncedService(path: string): string | null {
  const p = path.replace(/\\/g, '/');
  if (/\/Library\/Mobile Documents\//i.test(`${p}/`) || /\/iCloud ?Drive(\/|$)/i.test(p)) return 'iCloud Drive';
  // macOS keeps every File Provider service's folder here: ~/Library/CloudStorage/<Service>-<account>.
  const provider = /\/Library\/CloudStorage\/([^/]+)/i.exec(p);
  if (provider) {
    const name = provider[1]!.toLowerCase();
    if (name.startsWith('dropbox')) return 'Dropbox';
    if (name.startsWith('onedrive')) return 'OneDrive';
    if (name.startsWith('googledrive')) return 'Google Drive';
    if (name.startsWith('box')) return 'Box';
    if (name.startsWith('icloud')) return 'iCloud Drive';
    return provider[1]!.split('-')[0]!;
  }
  if (/\/Dropbox( \([^)]*\))?(\/|$)/i.test(p)) return 'Dropbox';
  if (/\/OneDrive( - [^/]*)?(\/|$)/i.test(p)) return 'OneDrive';
  if (/\/(Google Drive|My Drive)(\/|$)/i.test(p)) return 'Google Drive';
  if (/\/Box( Sync)?(\/|$)/.test(p)) return 'Box';
  return null;
}
