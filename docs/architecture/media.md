# Audio and video

Audio and video files are played; audio can be edited too (*Editing audio*, below). The browser's own `<video>` and `<audio>` do the decoding; the app adds the controls, a waveform, captions and links to a moment. [media.md](../media.md) has the plan and the reasons (why a viewer only, what plays where).

## How it works

```
 file picked or dropped --File--> openMediaFile --+
 stored copy / account --bytes--> open ------------+--> openMedia --> MediaViewer (<video> / <audio>)
 vault file over 50 MB --path--> openVaultMedia ---+        blob: or golemvault: address
```

- **Kinds.** `sourceFromFile` gives `audio` or `video` by extension (`media/mediaFiles.ts`); the bytes never go to the layout worker, which refuses them. A video container with no picture is laid out as audio once its metadata is read.
- **The engine.** `mediaEngine` in `main.ts` is a `DocumentEngine` with nothing to undo or select, unless audio is being edited, when it is the audio editor's. The viewer is DOM over the canvas, and `mediaView.active` is what the rest of `main.ts` asks. While it is open the document's keyboard handler stands aside, so Tab and Space belong to the player.
- **50 MB.** `MEDIA_KEEP_LIMIT` is the account's limit for a document. A file up to it is stored and synced as any file, as its own bytes (no `.wdoc`). A larger one is marked `inPlace`: it plays from the file it was opened from, is never read whole, and is saved nowhere.
- **The waveform** comes from `decodeAudioData` and is drawn only up to 40 MB or 45 minutes; a longer file has a plain seek bar.
- **Captions.** `watchCaptions` looks in the file's folder for `talk.vtt`, `talk.srt` or `talk.en.vtt`, again at each library change (an agent may write one while it plays). SubRip is turned into WebVTT. `<audio>` draws no captions, so the viewer shows the cue itself.
- **Moments.** `[[talk.mp4#t=12:30]]` (or `#t=750`, `#t=12:30-13:00`) opens the file there and stops at a range's end (`media/timecode.ts`, `followLink`). Edit › Copy Link to This Moment writes one.
- **Rooms.** What is only played joins no room. An audio file in the account has a watched `audio` room: one session edits, the others see each save.
- **Settings.** Whether captions show follows the account (`golem.mediaCaptions`); where each file was left is per device (`golem.mediaPositions`).

## Editing audio

Audio › Edit Audio fetches `media/edit/audioEditor.ts`, which lies over the player (`mediaView.covered`). The file's samples never change: the edits are an `EditList` of pieces of sounds, and undo goes back to an earlier list. Done opens the player again on the edited file. [audio-editing.md](../audio-editing.md) has the decisions and the limits.

- **Reading** (`decode.ts`): WAV and FLAC by us, exactly; anything else by the browser, at the rate in its header. More than two channels, or over 1.5 GB decoded, is refused (`CantEdit`).
- **Saving** (`save.ts`): a WAV or FLAC is written over in place by autosave (`mediaBytes`), in its own sample format, with its other parts kept and a WAV's cue points moved. An MP3 is encoded only when the person saves (`saveLossyAudio`), at a constant rate near its own, with its tags; any other lossy file becomes a new `.flac` beside it, which opens. LAME's `.wasm` is fetched only then, and must stay a file of its own (`THIRD_PARTY_NOTICES.md`).
- **Size:** edits that would make the file pass `MEDIA_KEEP_LIMIT`, or leave it empty, are refused. A recording stops when the file is full (`recordingRoom` in `limits.ts`) and keeps what it has.
- **Sounds** (`sound.ts`) are pages of samples, in memory up to a shared budget of 256 MB and beyond it in IndexedDB (`golemdocs-audio`, `pageStore.ts`). A window's pages are swept once the window is gone (a Web Lock says so). Everything that reads samples is async.
- **Drafts:** unsaved edits of a lossy file (the list, its sounds, the labels) are kept in the same database by document, and come back when the file is edited again, if its bytes are the same. They go on saving, on Don't Save, after 60 days, on sign-out and with Clear Local Data. Opening an encrypted file removes its draft; until then a draft made before its folder was encrypted stays readable on that device.
- **Labels** (`labels.ts`) are the cues of the `.vtt` beside the file and move with the edits (`moveFrame`), as WAV cue points do. Captions in a language (`talk.en.vtt`) are not moved.
- **Effects** (`effects.ts`) are streams of samples over the range, made into a new sound; `effectDialogs.ts` is the one form they all ask with, with Preview.
- **Recording** (`recorder.ts`, with its worklet as a file of its own) is at the file's rate, with the browser's voice processing off. Leaving the document stops it and keeps it. The shells need `NSMicrophoneUsageDescription`, and the Mac's hardened runtime `Entitlements.plist`; in an older shell recording says the microphone can't be used.

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
| `client/src/media/edit/` | the audio editor: `audioEditor.ts` (the view), `editList.ts`, `sound.ts` and `pageStore.ts` (samples), `decode.ts`, `save.ts`, `limits.ts`, `wav.ts`, `flac.ts`, `mp3.ts` (files), `effects.ts`, `effectDialogs.ts`, `fft.ts`, `labels.ts`, `recorder.ts`, `spectrogram.ts`, `peaks.ts`, `player.ts` |
| `client/src/media/captions.ts` | which files are captions; SubRip to WebVTT |
| `client/src/media/timecode.ts` | clock times and `#t=` moments |
| `client/src/main.ts` | `openMedia`, `openMediaFile`, `openVaultMedia`, `watchCaptions`, `copyMomentLink`, `vaultMediaEntries` |
| `client/src/desktop/vaultSync.ts` | `report.inPlace` |
| `desktop/src-tauri/src/media.rs` | `vault_media_url` and the `golemvault:` scheme |

## Tests

`client/test/audioEdit.test.ts` (files, effects, labels, pages) and `e2e/media/edit.spec.ts` (editing), `client/test/media.test.ts` (kinds, times, captions, waveform), `vaultSync.test.ts` and `vaultEncrypted.test.ts` (files left in the vault), the Rust tests in `media.rs`, `e2e/media/` and `e2e/accessibility/media.spec.ts`. The `golemvault:` scheme has no automated end-to-end test (Playwright has no shell): it was checked by hand in the Mac app, from `https://golemdocs.com` and from a dev server, on 2026-11-25. Windows and iOS have not been tried.
