# Audio and video

Audio and video files are played, never edited. The browser's own `<video>` and `<audio>` do the decoding; the app adds the controls, a waveform, captions and links to a moment. [media.md](../media.md) has the plan and the reasons (why a viewer only, what plays where).

## How it works

```
 file picked or dropped --File--> openMediaFile --+
 stored copy / account --bytes--> open ------------+--> openMedia --> MediaViewer (<video> / <audio>)
 vault file over 50 MB --path--> openVaultMedia ---+        blob: or golemvault: address
```

- **Kinds.** `sourceFromFile` gives `audio` or `video` by extension (`media/mediaFiles.ts`); the bytes never go to the layout worker, which refuses them. A video container with no picture is laid out as audio once its metadata is read.
- **The engine.** `mediaEngine` in `main.ts` is a read-only `DocumentEngine`: no undo, selection or canvas. The viewer is DOM over the canvas, and `mediaView.active` is what the rest of `main.ts` asks. While it is open the document's keyboard handler stands aside, so Tab and Space belong to the player.
- **50 MB.** `MEDIA_KEEP_LIMIT` is the account's limit for a document. A file up to it is stored and synced as any file, as its own bytes (no `.wdoc`). A larger one is marked `inPlace`: it plays from the file it was opened from, is never read whole, and is saved nowhere.
- **The waveform** comes from `decodeAudioData` and is drawn only up to 40 MB or 45 minutes; a longer file has a plain seek bar.
- **Captions.** `watchCaptions` looks in the file's folder for `talk.vtt`, `talk.srt` or `talk.en.vtt`, again at each library change (an agent may write one while it plays). SubRip is turned into WebVTT. `<audio>` draws no captions, so the viewer shows the cue itself.
- **Moments.** `[[talk.mp4#t=12:30]]` (or `#t=750`, `#t=12:30-13:00`) opens the file there and stops at a range's end (`media/timecode.ts`, `followLink`). Edit › Copy Link to This Moment writes one.
- **Rooms.** Media joins no room: there is nothing to merge.
- **Settings.** Whether captions show follows the account (`golem.mediaCaptions`); where each file was left is per device (`golem.mediaPositions`).

## Vault files over 50 MB

The vault's sync reports them (`SyncReport.inPlace`) and otherwise leaves them alone: never read, uploaded, or taken for deleted. `main.ts` lists them in the library as entries keyed `vault:<path>` (`vaultMediaEntries`), placed by their path and placed again when the folders change, since the sync that reports a file may have just made its folder. Files shows them as on this computer only, with Open and Show in Finder; they can't be moved, renamed or deleted in the app. Under an encrypted folder they are never removed (the vault has the only copy) and are not listed while it is locked ([encrypted-folders.md](../encrypted-folders.md)).

They play through the shell's `golemvault:` scheme; see *Media from the vault* in [Desktop app](desktop.md).

## Rules

- **Nothing plays by itself.** A file opens paused.
- **Never read a large file whole.** Anything new that needs the bytes must check `inPlace` first.
- **Bundle:** the whole area is about 20 kB minified, part of it needed at every start (file kinds, link moments), so it is imported statically. If the viewer grows, `media/viewer.ts` is the piece to load on demand.

## Key files

| Path | Role |
| --- | --- |
| `client/src/media/mediaFiles.ts` | extensions, kinds, types, the 50 MB limit |
| `client/src/media/viewer.ts`, `media.css` | `MediaViewer`: the player, its controls and keys |
| `client/src/media/waveform.ts` | peaks and drawing |
| `client/src/media/captions.ts` | which files are captions; SubRip to WebVTT |
| `client/src/media/timecode.ts` | clock times and `#t=` moments |
| `client/src/main.ts` | `openMedia`, `openMediaFile`, `openVaultMedia`, `watchCaptions`, `copyMomentLink`, `vaultMediaEntries` |
| `client/src/desktop/vaultSync.ts` | `report.inPlace` |
| `desktop/src-tauri/src/media.rs` | `vault_media_url` and the `golemvault:` scheme |

## Tests

`client/test/media.test.ts` (kinds, times, captions, waveform), `vaultSync.test.ts` and `vaultEncrypted.test.ts` (files left in the vault), the Rust tests in `media.rs`, `e2e/media/` and `e2e/accessibility/media.spec.ts`. The `golemvault:` scheme has no automated end-to-end test (Playwright has no shell): it was checked by hand in the Mac app, from `https://golemdocs.com` and from a dev server, on 2026-11-25. Windows and iOS have not been tried.
