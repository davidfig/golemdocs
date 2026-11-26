# Editing audio

**Status.** Steps 1 to 7 are built ([architecture/media.md](architecture/media.md) says how it works). Not yet tried: Safari, Firefox, the desktop and iOS apps, a real microphone, a screen reader, hour-long files.

**Goal.** A waveform editor for one mono or stereo audio file, with the everyday tools of a desktop audio editor. Not multitrack: a project of tracks and clips is not an ordinary file that other apps and agents can open. This replaces "no editing" in [media.md](media.md) for audio; video is still only played.

## Decisions (2026-11-25)

- **Scope:** a single file, in stages. Nothing should rule out tracks later (an `EditList` is what a track would hold).
- **Saving a lossy file:** an MP3 is encoded once, when the person chooses to save, never by autosave. M4A, AAC, Ogg and Opus are saved as a new FLAC, and the original is left alone. WAV and FLAC are saved in place.
- **MP3 encoder:** a lazily loaded WASM encoder (`wasm-media-encoders`, LAME) is approved. LAME is LGPL: the terms are in `THIRD_PARTY_NOTICES.md`, and its source is in `client/public/licenses/lame/`. The welcome document credits LAME with a link.

## How it will work

- **Edits are a list.** `EditList` is pieces of sounds that never change. An edit makes a new list, and undo keeps the old one. An effect renders its range to a new sound and puts that in.
- **The file's own rate.** `decodeAudioData` resamples to its context's rate, so WAV is read by us and anything else is decoded in an `OfflineAudioContext` at the rate in its header.
- **Memory.** 45 minutes of 48 kHz stereo is about 1 GB as floats, so sounds go to disk in pages past 256 MB, in IndexedDB (planned as OPFS; IndexedDB works in every browser, in private windows too). Decoding a file the browser decodes still needs it all in memory at once, so over 1.5 GB decoded is refused.
- **Unsaved edits** to a lossy file are kept on the device as the list and the sounds it uses (the original stays the stored document), so a reload loses nothing.
- **Over 50 MB** a file can't be kept in the account, so it can't be edited, and edits that would take it there are refused. A new recording is a 48 kHz mono WAV, which holds about 9 minutes.
- **Opening** still shows the player. Editing starts with a command, which loads the editor as its own chunk.
- **Rooms:** a `watch` kind: one session edits, others watch and see each save.
- **Accessibility:** selection and zoom from the keyboard, positions announced, the waveform drawn in system colors in forced colors.

## Work list

All done: the edit list and WAV; the editor; FLAC, MP3 and kept edits; gain, normalize, fades, reverse, generated sound; noise reduction, EQ, compressor, speed and pitch; recording, labels, spectrogram; pages on disk.

**Could come next:** longer recordings (as FLAC, or MP3), a 50 MB limit that depends on the kind, effects on one channel, tracks.
