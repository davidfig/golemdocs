package com.golemdocs.mobile

import android.content.Intent
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import java.io.File
import java.io.OutputStream

// File sharing for the page (client/src/ui/saveFile.ts): Android's web view has no navigator.share, so the page hands a
// file over here and the system share sheet (Save to Drive, Files, Mail, Nearby Share...) opens for it.
//
// The page sends the bytes in chunks (begin, chunk..., finish), so a big file (File > Download All) is never one string.
// They go to a file in the app's cache, which the share sheet reads through the FileProvider (res/xml/file_paths.xml).
// Only golemdocs.com (and localhost, for development) may use it: the web view could end up on another page (OpenBridge.isOurPage).
class ShareBridge(private val activity: MainActivity, private val webView: WebView) {
  private var out: OutputStream? = null
  private var file: File? = null
  private var mime = "application/octet-stream"

  @JavascriptInterface
  fun begin(name: String, type: String) {
    discard()
    val dir = File(activity.cacheDir, "share").apply { mkdirs() }
    dir.listFiles()?.forEach { it.delete() } // earlier shares are no longer needed
    val safe = name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").take(120).ifBlank { "document" }
    val target = File(dir, safe)
    file = target
    out = target.outputStream().buffered()
    mime = if (Regex("^[\\w.+-]+/[\\w.+-]+$").matches(type)) type else "application/octet-stream"
  }

  @JavascriptInterface
  fun chunk(base64: String) {
    out?.write(Base64.decode(base64, Base64.DEFAULT))
  }

  @JavascriptInterface
  fun finish() {
    out?.close()
    out = null
    val shared = file ?: return
    val type = mime
    activity.runOnUiThread {
      if (!fromOurPage()) return@runOnUiThread shared.delete().let { }
      val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", shared)
      val send = Intent(Intent.ACTION_SEND).apply {
        this.type = type
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.startActivity(Intent.createChooser(send, null))
    }
  }

  @JavascriptInterface
  fun cancel() = discard()

  private fun discard() {
    out?.close()
    out = null
    file?.delete()
    file = null
  }

  // Runs on the main thread (WebView.getUrl needs it).
  private fun fromOurPage(): Boolean = OpenBridge.isOurPage(webView)
}
