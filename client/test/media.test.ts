// Audio and video (src/media): which files they are, times in links, captions beside them, and the waveform's peaks.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { folderOf, itemsIn } from '../src/folders.ts';
import { captionFilesFor, srtToVtt } from '../src/media/captions.ts';
import { MEDIA_KEEP_LIMIT, mediaKindOf, mediaMime, playsInPlace } from '../src/media/mediaFiles.ts';
import { formatClock, momentFragment, parseClock, parseMoment, splitMoment } from '../src/media/timecode.ts';
import { columnPeaks, wavePeaks } from '../src/media/waveform.ts';
import { sourceFromFile, stem } from '../src/formats/source.ts';
import { FORMATS, formatAllows, kindFromName } from '../src/ui/formats.ts';
import { vaultKeeps } from '../src/desktop/vaultFormats.ts';
import { fromVaultFile, toVaultFile } from '../src/desktop/vaultCodec.ts';

test('audio and video are told by their names, and open as such', () => {
  for (const name of ['a.mp4', 'b.M4V', 'c.mov', 'd.webm', 'e.mkv', 'f.ogv']) assert.equal(mediaKindOf(name), 'video', name);
  for (const name of ['a.mp3', 'b.m4a', 'c.aac', 'd.WAV', 'e.ogg', 'f.oga', 'g.opus', 'h.flac']) assert.equal(mediaKindOf(name), 'audio', name);
  for (const name of ['a.md', 'b.mp4.txt', 'mp4', 'c.vtt']) assert.equal(mediaKindOf(name), null, name);
  assert.equal(sourceFromFile('talk.mp4', new ArrayBuffer(0))?.kind, 'video');
  assert.equal(sourceFromFile('song.flac', new ArrayBuffer(0))?.kind, 'audio');
  assert.equal(stem('Q3 review.mov'), 'Q3 review');
  assert.equal(kindFromName('x.webm'), 'video');
  assert.equal(kindFromName('x.opus'), 'audio');
  assert.equal(mediaMime('a.MP3'), 'audio/mpeg');
  assert.equal(mediaMime('a.mov'), 'video/quicktime');
  assert.equal(mediaMime('a.xyz'), 'application/octet-stream');
});

test('media over the account limit plays in place; anything else is kept', () => {
  assert.equal(playsInPlace('a.mp4', MEDIA_KEEP_LIMIT), false);
  assert.equal(playsInPlace('a.mp4', MEDIA_KEEP_LIMIT + 1), true);
  assert.equal(playsInPlace('a.pdf', MEDIA_KEEP_LIMIT + 1), false, 'only audio and video');
});

test('the vault keeps audio and video as the files themselves', async () => {
  assert.equal(vaultKeeps('talk.mp4'), true);
  assert.equal(vaultKeeps('notes.md'), true);
  assert.equal(vaultKeeps('archive.zip'), false);
  const bytes = new Uint8Array([0, 1, 2, 3, 255]);
  assert.equal(await toVaultFile(bytes, 'talk.mp4'), bytes);
  assert.equal(await fromVaultFile(bytes, 'song.mp3'), bytes);
});

test('the media viewer allows playing, a link to the moment and what any file can do, and nothing that edits', () => {
  const video = FORMATS.video;
  assert.equal(video.mediaViewer, true);
  assert.equal(video.editable, false);
  assert.equal(formatAllows(video, { kind: 'media', op: 'playPause' }), true);
  assert.equal(formatAllows(video, { kind: 'copyMomentLink' }), true);
  assert.equal(formatAllows(video, { kind: 'close' }), true);
  assert.equal(formatAllows(video, { kind: 'download' }), true);
  for (const kind of ['undo', 'paste', 'print', 'selectAll', 'copyLiveLink'] as const) assert.equal(formatAllows(video, { kind } as never), false, kind);
  assert.equal(formatAllows(video, { kind: 'convert', to: 'docx' }), false);
  assert.equal(formatAllows(video, { kind: 'dialog', name: 'find' }), false);
  assert.equal(formatAllows(FORMATS.docx, { kind: 'media', op: 'playPause' }), false);
  assert.equal(formatAllows(FORMATS.docx, { kind: 'copyMomentLink' }), false);
});

test('clock times are read the ways people write them', () => {
  assert.equal(parseClock('750'), 750);
  assert.equal(parseClock('750.5'), 750.5);
  assert.equal(parseClock('12:30'), 750);
  assert.equal(parseClock('1:02:03'), 3723);
  assert.equal(parseClock('1h2m3s'), 3723);
  assert.equal(parseClock('90s'), 90);
  assert.equal(parseClock('5m'), 300);
  assert.equal(parseClock('12:61'), null);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock('soon'), null);
});

test('a link names a moment or a stretch', () => {
  assert.deepEqual(parseMoment('t=12:30'), { start: 750 });
  assert.deepEqual(parseMoment('#t=750'), { start: 750 });
  assert.deepEqual(parseMoment('t=750,800'), { start: 750, end: 800 });
  assert.deepEqual(parseMoment('t=12:30-13:00'), { start: 750, end: 780 });
  assert.deepEqual(parseMoment('t=npt:10'), { start: 10 });
  assert.deepEqual(parseMoment('t=,20'), { start: 0, end: 20 });
  assert.equal(parseMoment('t=20-10'), null, 'an end before the start');
  assert.equal(parseMoment('Heading'), null);
  assert.equal(parseMoment(''), null);
  assert.deepEqual(splitMoment('talk.mp4#t=12:30'), { title: 'talk.mp4', moment: { start: 750 } });
  assert.deepEqual(splitMoment('Notes#Plan'), { title: 'Notes#Plan', moment: null });
});

test('times show as clocks, and links to them round-trip', () => {
  assert.equal(formatClock(5), '0:05');
  assert.equal(formatClock(750), '12:30');
  assert.equal(formatClock(3723), '1:02:03');
  assert.equal(formatClock(5, 3723), '0:00:05', 'hours show when the whole has them');
  assert.equal(formatClock(Number.NaN), '0:00');
  assert.equal(momentFragment({ start: 750 }), 't=12:30');
  assert.equal(momentFragment({ start: 750, end: 780 }), 't=12:30-13:00');
  assert.deepEqual(parseMoment(momentFragment({ start: 3723 })), { start: 3723 });
});

test('the caption files beside a media file are found by its name', () => {
  const names = ['talk.mp4', 'talk.vtt', 'talk.fr.srt', 'talk.en.vtt', 'talk.notes.vtt', 'other.vtt', 'Talk.pt-BR.vtt', 'talk.md'];
  assert.deepEqual(captionFilesFor('talk.mp4', names), [
    { name: 'talk.vtt', language: null },
    { name: 'talk.en.vtt', language: 'en' },
    { name: 'talk.fr.srt', language: 'fr' },
    { name: 'Talk.pt-BR.vtt', language: 'pt-BR' },
  ]);
  assert.deepEqual(captionFilesFor('none.mp3', names), []);
});

test('SubRip becomes WebVTT', () => {
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n{\\an8}<i>World</i>\r\nagain\r\n';
  assert.equal(srtToVtt(srt), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello\n\n00:00:03.000 --> 00:00:04.000\n<i>World</i>\nagain\n');
  const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n';
  assert.equal(srtToVtt(vtt), vtt, 'WebVTT stays as it is');
  assert.equal(srtToVtt('1\n00:00:01,5 --> 00:00:02,25\nShort\n'), 'WEBVTT\n\n00:00:01.500 --> 00:00:02.250\nShort\n');
});

test('the waveform holds the loudest sample of each slice', () => {
  const left = new Float32Array([0, 0.5, -0.25, 0, 0, -1, 0.1, 0.2]);
  const right = new Float32Array([0.75, 0, 0, 0, 0, 0, 0, 0.9]);
  assert.deepEqual([...wavePeaks([left, right], 4)], [0.75, 0.25, 1, 0.8999999761581421]);
  assert.deepEqual([...wavePeaks([new Float32Array(0)], 10)], [0]);
  assert.deepEqual([...wavePeaks([new Float32Array([0.5, 0.25])], 10)], [0.5, 0.25], 'no more slices than samples');
  assert.deepEqual([...columnPeaks(new Float32Array([0.1, 0.9, 0.3, 0.2]), 2)], [0.8999999761581421, 0.30000001192092896]);
});

test('a file in the vault only is listed in the folder its path puts it in', () => {
  const folders = [{ id: 'f1', name: 'Talks', parentId: null, createdAt: 0, updatedAt: 0 }];
  const entry = { vault: { path: 'Talks/keynote.mp4' }, folderId: 'f1', cloud: null, local: null };
  assert.equal(folderOf(entry, folders), 'f1');
  assert.deepEqual(itemsIn([entry], folders, 'f1'), [entry]);
  assert.equal(folderOf({ ...entry, folderId: 'gone' }, folders), null);
});
