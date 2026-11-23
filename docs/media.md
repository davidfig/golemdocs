# Plan: audio and video viewers

**Status.** Built on the `worktree-media` branch, not yet merged: steps 1–6 of the work list are done (`client/src/media/`, the `golemvault:` scheme in `desktop/src-tauri/src/media.rs`). Changed from the plan: media joins no room at all (nothing is edited), and vault files over 50 MB are listed in the library as `vault:` entries (open and Show in Finder only). Still to do: step 7 (video frames as live-block pictures), `docs/architecture/media.md` and the desktop doc, `docs/actions-status.md`, and trying the `golemvault:` scheme in a real desktop build.

**Goal.** Open and play audio and video files, and tie them to notes (captions, links to a moment). **Viewers only: no editing.** Cutting, converting and joining media is done by the external agents people point at their vault (an agent with ffmpeg does it in seconds, with every codec), the same way the app leaves ai to them. To match that in the app we would have to write our own MP4/WebM containers and an encoder pipeline, and still not cover every codec. We'll look at this again if people keep asking for simple trims. If they do, a keyframe-only trim (copying the data across without re-encoding) is the one edit worth building.

## Principles

1. **The browser plays it.** Playback uses a native `<video>` or `<audio>` element. We write no decoders and add no dependencies. What the platform can't play, we say so plainly (see *Codec gaps*).
2. **Read only, the file always wins.** Nothing is ever written to a media file. A change to the file on disk or in the account reloads the viewer, keeping the play position.
3. **One small chunk.** Everything goes in `client/src/media/`, behind a small `media/handle.ts`, as a read-only `DocumentEngine` (`client/src/documentEngine.ts`), and is opened from `main.ts` the way `openSheet` is. It will be well under 20 kB, so check the chunk list once it is built: if it is small, it can be imported statically. The layout worker must not grow at all.
4. **Never read the whole file.** A media file can be gigabytes. The player reads it in ranges as it plays and never holds it whole in memory (see *Sources*).
5. **Watch, like pictures.** Add a `media` room kind with `ROOM_POLICY` set to `'watch'` (`ops/src/multiplayer.ts`). With nothing to edit, a room only reloads the viewer when the file changes.

## File types

`formats/source.ts` gets `audio` and `video` kinds:

- **Video:** mp4, m4v, mov, webm, mkv, ogv
- **Audio:** mp3, m4a, aac, wav, ogg, oga, opus, flac

Where a container could hold either (mp4, ogg, webm), the kind comes from the extension, and the viewer switches to the audio layout when the element reports no video track.

## Sources

Where the bytes come from, by case:

- **A file picked or dropped in the browser:** `URL.createObjectURL(file)`. It plays any size and reads in ranges by itself.
- **The browser's own library (IndexedDB):** the file is stored chunked ([chunked-storage.md](chunked-storage.md)). Build a `Blob` from the chunk blobs, with no copying, and give that to the element. Any size the browser's storage quota allows.
- **The desktop and iOS vault:** today a file crosses the bridge whole, as base64 (`vault_read_base64`, see [desktop.md](architecture/desktop.md)). That's fine for documents, but not for a 2 GB video. Add a **new shell command or URI scheme that serves a vault file with Range requests** (Tauri's asset protocol, or our own scheme), and point the element at it. The page must work with an older shell (AGENTS.md, *The page runs in an older shell*): when the command is missing (`isMissingCommand`), read files up to a modest size whole as today, and for larger ones say to update the app (`ShellTooOldError`).
- **The account (cloud):** files stay under the existing 50 MB cap for now (`MAX_DOCUMENT_BYTES`). Larger media stays local, as larger files already do (`textEditor.tooBigToSync`). Cloud playback may read the whole file (≤ 50 MB) at first; range reads from `fileStore` can come later if that turns out to be slow.

## The viewer

- **Video:** the frame fills the view, letterboxed, with a control bar below. The element is placed by the camera, like the canvas content.
- **Audio:** a waveform of the whole file with the play position on it. Click or drag to seek. The waveform comes from `decodeAudioData` on a worker. For a long file, decode it in pieces, or show a plain bar when it is too large to decode, so memory stays bounded.
- **Controls:** play/pause, a seek bar with the time, volume and mute, speed (0.5× to 2×), and full screen for video. All of them are built from the shared parts (`iconButton`, `segmented`, `dropdown`, `--wm-*`). Icons are drawn as SVGs, not characters.
- **The status bar** shows the length, plus the size and codec where the element tells us.
- **A thumbnail** for the library and Files sidebar: a frame from about 10% in for video, and the waveform for audio (`thumbnail.ts`).
- **Remembered position:** reopening a file resumes where you left off (per device, alongside `viewMemory.ts`; not synced).

## Ties to notes

- **Captions:** a `.vtt` or `.srt` file next to the media with the same name (`talk.mp4`, `talk.vtt`, or `talk.en.vtt` for each language) loads as a text track, with a menu to choose a language or turn captions off. SRT is turned into VTT on load (a small hand-written converter, with tests). Agents write transcripts as these files, and the app shows them.
- **Links to a moment:** `[[talk.mp4#t=12:30]]` (also `#t=750` and `#t=12:30-13:00`) opens the file at that time, and, for a range, stops at its end. Parse this where links are resolved (`docLinks.ts`), and rewrite it on rename like any other link (`linkRename.ts`).
- **Copy Link to Moment** (Edit menu, in the group with Copy as Live Link) copies the link for the current time.
- **A live block from video:** `talk.mp4#t=0:42` as a picture source shows that frame ([live-blocks.md](live-blocks.md)): seek, draw to a canvas, PNG. This one is optional and comes last.

## Accessibility

- **Keyboard:** Space or K plays and pauses, J and L jump 10 s, the arrow keys move 5 s, the comma and period keys step one frame while paused, Home and End go to the start and end, M mutes, F goes full screen, C turns captions on and off. Every control is reachable by Tab, and the bar joins the F6 regions (`ui/focusRegions.ts`).
- **Screen readers:** the seek bar is a `slider` whose value is spoken as the time ("12 minutes 30 seconds of 45 minutes"). Every button has a name. Seeking by key is announced (`announce()`).
- **Looks:** works with High Contrast and `forced-colors`. The waveform is drawn in system colours there.
- **Motion:** nothing plays by itself. A file opens paused, always, whatever the reduced-motion setting.
- **Tests:** e2e checks in `e2e/accessibility/` for the roles, names and keyboard path.

## Codec gaps

What plays depends on the web view: WebKit in the Mac and iOS apps and in Safari, Chromium in Chrome and in Windows' WebView2. HEVC and ProRes `.mov` play on Apple platforms but often not elsewhere. MKV plays in Chromium but not in WebKit. When the element raises `MEDIA_ERR_SRC_NOT_SUPPORTED`, show a clear message in the view (the file's codec if we can read it, and that an agent or another app can convert it), not a blank player. Don't try to transcode.

## Work list

1. Add the source kinds, the `media` room kind, and opening from `main.ts` to a stub engine. Add unit tests for kind detection.
2. The video and audio viewer, with controls, keyboard, screen-reader support and the codec-error message. Add an e2e spec in `e2e/media/`, with tiny fixture files (a few KB each, made once with ffmpeg and committed).
3. Sources: Blob URLs for picked files and chunked library files. Add the new ranged vault command to the shell, with the older-shell fallback and a `bridge.test.ts` case.
4. The waveform and thumbnails.
5. Captions (VTT, and SRT turned into VTT), with tests.
6. Links to a moment, Copy Link to Moment, and rewriting on rename, with tests.
7. Optional: video frames as live-block pictures.

Every step gets i18n strings (`t()`, in every language), a changelog line, `docs/architecture/media.md` (once the area exists), an entry in `docs/actions-status.md` for new commands, and the menu grouping rules applied.
