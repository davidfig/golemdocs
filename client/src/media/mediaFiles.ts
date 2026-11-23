// Which files are audio and video, by name, and the limit past which one is only played from where it is (see docs/media.md).
// Names only, and small: the vault, the Files sidebar and opening a file ask this without loading the player.

export type MediaKind = 'audio' | 'video';

/** Containers that hold pictures (or may: an `.mp4` or `.webm` of sound alone plays in the audio layout once the element says it has no picture). */
const VIDEO_FILE = /\.(mp4|m4v|mov|webm|mkv|ogv)$/i;
const AUDIO_FILE = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;

/** The extensions, for the file picker and the format table. */
export const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv'];
export const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac'];

/** Whether a file is audio or video by its name, or null for anything else. */
export function mediaKindOf(name: string): MediaKind | null {
  if (VIDEO_FILE.test(name)) return 'video';
  if (AUDIO_FILE.test(name)) return 'audio';
  return null;
}

export const isMediaName = (name: string): boolean => mediaKindOf(name) !== null;

/**
 * The most a media file may be to be kept like any other file (in this browser, in the account and synced with the vault): the
 * account's limit (`MAX_DOCUMENT_BYTES` in cloud.ts, `MAX_BYTES` on the server). A larger one is never copied anywhere: it plays
 * from the file that was opened, or from the vault (`vault:` entries in the library).
 */
export const MEDIA_KEEP_LIMIT = 50 * 1024 * 1024;

/** Whether a media file of this size is too big to be kept, and so only ever played from where it is. */
export const playsInPlace = (name: string, size: number): boolean => isMediaName(name) && size > MEDIA_KEEP_LIMIT;

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
};

/** The media type of a file by its name, for the blob the player is given (some browsers won't play a blob with none). */
export function mediaMime(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && MIME[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}
