// Audio and video from the vault, played by the web view's <video> and <audio> without crossing to the page whole: a file can
// be gigabytes, far too big for `vault_read_base64`. `vault_media_url` gives the page an address on the `golemvault:` scheme,
// and `serve` answers the player's requests for it from the file, in the ranges it asks for (see docs/media.md).
//
// The address holds a token made when the app starts, so only the page that asked for it can use it, and only audio and video
// files inside the vault are served (through `vault::resolve`, which refuses `..`, absolute paths and symbolic links).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::State;

use crate::vault::Vault;

/// The scheme the player reads vault files through.
pub const SCHEME: &str = "golemvault";

/// The most one answer carries when the player asks for "the rest of the file": it asks again for the next part.
const CHUNK: u64 = 4 * 1024 * 1024;

/// The token in every address, made once per launch.
pub struct MediaToken(pub String);

impl Default for MediaToken {
    fn default() -> Self {
        use std::collections::hash_map::RandomState;
        use std::hash::{BuildHasher, Hasher};
        // Two hashers seeded at random by the standard library, and the time: unguessable enough for an address only this app's
        // own web view can reach, without a dependency for random numbers.
        let mut text = String::new();
        for salt in 0..2u64 {
            let mut hasher = RandomState::new().build_hasher();
            hasher.write_u64(salt);
            hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
            text.push_str(&format!("{:016x}", hasher.finish()));
        }
        MediaToken(text)
    }
}

/// The extensions the media viewer plays (client/src/media/mediaFiles.ts), and the type each is sent as.
fn media_type(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        _ => return None,
    })
}

/// Where the scheme is reached from the page: Windows and Android web views take a custom scheme as a `localhost` host name.
fn base() -> String {
    if cfg!(any(windows, target_os = "android")) {
        format!("http://{SCHEME}.localhost/")
    } else {
        format!("{SCHEME}://localhost/")
    }
}

/// Percent-encodes a vault path for an address, keeping `/` between names.
fn encode(path: &str) -> String {
    let mut out = String::new();
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The vault path an address's path names (`/<token>/<path>`), if the token is right.
fn path_of(address_path: &str, token: &str) -> Option<String> {
    let rest = address_path.strip_prefix('/')?.strip_prefix(token)?.strip_prefix('/')?;
    let mut bytes = Vec::with_capacity(rest.len());
    let raw = rest.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            let hex = std::str::from_utf8(&raw[i + 1..i + 3]).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else if raw[i] == b'%' {
            return None;
        } else {
            bytes.push(raw[i]);
            i += 1;
        }
    }
    String::from_utf8(bytes).ok().filter(|p| !p.is_empty())
}

/// The bytes a `Range` header asks for, first and last inclusive, in a file of `len` bytes; an open end is cut to `CHUNK`.
/// None when it can't be met (416); a missing or unreadable header is taken as "from the start".
fn byte_range(header: Option<&str>, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let (start, end) = match header.and_then(|h| h.trim().strip_prefix("bytes=")) {
        None => (0, None),
        Some(spec) => {
            // Only the first range of several is answered: players ask for one at a time.
            let first = spec.split(',').next()?.trim();
            let (from, to) = first.split_once('-')?;
            match (from.trim(), to.trim()) {
                ("", "") => return None,
                // The last `n` bytes.
                ("", suffix) => {
                    let n: u64 = suffix.parse().ok()?;
                    if n == 0 {
                        return None;
                    }
                    (len.saturating_sub(n), Some(len - 1))
                }
                (from, "") => (from.parse().ok()?, None),
                (from, to) => (from.parse().ok()?, Some(to.parse::<u64>().ok()?)),
            }
        }
    };
    if start >= len || end.is_some_and(|e| e < start) {
        return None;
    }
    let end = end.unwrap_or(start + CHUNK - 1).min(len - 1).min(start + CHUNK - 1);
    Some((start, end))
}

/// An address for the page's player to read the vault file `path` from. Only audio and video files that are in the vault.
#[tauri::command]
pub fn vault_media_url(path: String, vault: State<'_, Vault>, token: State<'_, MediaToken>) -> Result<String, String> {
    if media_type(&path).is_none() {
        return Err(format!("not audio or video: {path}"));
    }
    let file = vault.file(&path)?;
    if !file.is_file() {
        return Err(format!("no such file in the vault: {path}"));
    }
    Ok(format!("{}{}/{}", base(), token.0, encode(&path)))
}

fn answer(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Answers one request of the player: the part of the file it asks for (206), with its type and the file's length.
pub fn serve(vault: &Vault, token: &str, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(path) = path_of(request.uri().path(), token) else { return answer(StatusCode::FORBIDDEN) };
    let Some(kind) = media_type(&path) else { return answer(StatusCode::FORBIDDEN) };
    let file: PathBuf = match vault.file(&path) {
        Ok(file) => file,
        Err(_) => return answer(StatusCode::FORBIDDEN),
    };
    let Ok(mut handle) = File::open(&file) else { return answer(StatusCode::NOT_FOUND) };
    let Ok(len) = handle.metadata().map(|m| m.len()) else { return answer(StatusCode::NOT_FOUND) };
    let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    let Some((start, end)) = byte_range(range, len) else {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(Vec::new())
            .unwrap_or_else(|_| answer(StatusCode::RANGE_NOT_SATISFIABLE));
    };
    let mut body = vec![0u8; (end - start + 1) as usize];
    if handle.seek(SeekFrom::Start(start)).is_err() || handle.read_exact(&mut body).is_err() {
        return answer(StatusCode::INTERNAL_SERVER_ERROR);
    }
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, kind)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
        .header(header::CONTENT_LENGTH, body.len().to_string())
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .unwrap_or_else(|_| answer(StatusCode::INTERNAL_SERVER_ERROR))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(byte_range(Some("bytes=0-99"), 1000), Some((0, 99)));
        assert_eq!(byte_range(Some("bytes=900-"), 1000), Some((900, 999)));
        assert_eq!(byte_range(Some("bytes=-100"), 1000), Some((900, 999)));
        assert_eq!(byte_range(Some("bytes=0-5000"), 1000), Some((0, 999)));
        assert_eq!(byte_range(None, 1000), Some((0, 999)));
        assert_eq!(byte_range(Some("bytes=1000-"), 1000), None);
        assert_eq!(byte_range(Some("bytes=50-10"), 1000), None);
        assert_eq!(byte_range(Some("bytes=abc"), 1000), None);
        assert_eq!(byte_range(Some("bytes=0-0"), 0), None);
        // An open end is cut to one chunk; a closed one asks for no more than a chunk either.
        let big = 10 * CHUNK;
        assert_eq!(byte_range(Some("bytes=0-"), big), Some((0, CHUNK - 1)));
        assert_eq!(byte_range(Some(&format!("bytes={}-", CHUNK)), big), Some((CHUNK, 2 * CHUNK - 1)));
        assert_eq!(byte_range(Some("bytes=0-"), big).map(|(s, e)| e - s + 1), Some(CHUNK));
    }

    #[test]
    fn addresses() {
        let path = "Talks/Q3 review (final).mp4";
        let encoded = encode(path);
        assert_eq!(encoded, "Talks/Q3%20review%20%28final%29.mp4");
        assert_eq!(path_of(&format!("/abc/{encoded}"), "abc").as_deref(), Some(path));
        assert_eq!(path_of(&format!("/wrong/{encoded}"), "abc"), None);
        assert_eq!(path_of("/abc/", "abc"), None);
        assert_eq!(path_of("/abc/bad%2", "abc"), None);
        assert_eq!(path_of(&format!("/abc/{}", encode("Café/ünï.mp3")), "abc").as_deref(), Some("Café/ünï.mp3"));
    }

    #[test]
    fn only_media() {
        assert_eq!(media_type("a/b.MP4"), Some("video/mp4"));
        assert_eq!(media_type("song.flac"), Some("audio/flac"));
        assert_eq!(media_type("notes.md"), None);
        assert_eq!(media_type("noext"), None);
    }

    #[test]
    fn tokens_differ() {
        assert_ne!(MediaToken::default().0, MediaToken::default().0);
        assert_eq!(MediaToken::default().0.len(), 32);
    }
}
