//! Printing on a Mac. The system web view ignores `window.print()` and has no tabs for a preview, so the page hands the shell the
//! document as a PDF, and it opens in Preview: every page, and the system's own print panel.
//!
//! The page is a website, so what it may do here is narrow: bytes that are a PDF, written to a new folder under the temporary
//! one, under a name with no path in it, and opened only by Preview.

use crate::vault::base64_decode;
use std::{fs, path::Path, time::SystemTime};

/// The name to save under: its last part, without what a file name can't hold, and always ending in `.pdf`.
fn pdf_name(name: &str) -> String {
    let base = Path::new(name).file_name().and_then(|n| n.to_str()).unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':')).collect();
    let stem = clean.strip_suffix(".pdf").unwrap_or(&clean).trim();
    format!("{}.pdf", if stem.is_empty() || stem.starts_with('.') { "Document" } else { stem })
}

/// Opens a PDF (base64, as the vault's `_base64` commands carry a file) in Preview, where the person prints it. macOS only.
#[tauri::command]
pub fn print_open_pdf(name: String, data: String) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("not available on this system".to_string());
    }
    let bytes = base64_decode(&data)?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("expected a PDF".to_string());
    }
    let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis();
    let folder = std::env::temp_dir().join("GolemDocs Print").join(stamp.to_string());
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let file = folder.join(pdf_name(&name));
    fs::write(&file, bytes).map_err(|e| e.to_string())?;
    std::process::Command::new("open").args(["-a", "Preview"]).arg(file).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::pdf_name;

    #[test]
    fn a_name_is_only_ever_a_pdf_in_the_folder() {
        assert_eq!(pdf_name("Plan.pdf"), "Plan.pdf");
        assert_eq!(pdf_name("Plan"), "Plan.pdf");
        assert_eq!(pdf_name("../../etc/passwd"), "passwd.pdf");
        assert_eq!(pdf_name("/tmp/evil.app"), "evil.app.pdf");
        assert_eq!(pdf_name(".."), "Document.pdf");
        assert_eq!(pdf_name(""), "Document.pdf");
    }
}
