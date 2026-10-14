package com.golemdocs.mobile

import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.RandomAccessFile
import java.util.concurrent.FutureTask

// What the page (client/src/desktop/incoming.ts) asks the shell for: the files opened in or shared to the app. A file goes over in
// pieces of CHUNK bytes, as base64, so it is never one string. Only golemdocs.com (and localhost, for development) may ask.
class OpenBridge(private val activity: MainActivity, private val webView: android.webkit.WebView, private val incoming: IncomingFiles) {
  @JavascriptInterface
  fun pending(): String {
    val list = JSONArray()
    if (!fromOurPage()) return list.toString()
    for (item in incoming.list()) {
      list.put(JSONObject().put("id", item.id).put("name", item.name).put("type", item.type).put("size", item.file.length()))
    }
    return list.toString()
  }

  /** Piece `index` of the file as base64; empty past the end. */
  @JavascriptInterface
  fun readChunk(id: String, index: Int): String {
    if (!fromOurPage()) return ""
    val item = incoming.find(id) ?: return ""
    RandomAccessFile(item.file, "r").use { file ->
      val start = index.toLong() * CHUNK
      if (start >= file.length()) return ""
      val buffer = ByteArray(minOf(CHUNK.toLong(), file.length() - start).toInt())
      file.seek(start)
      file.readFully(buffer)
      return Base64.encodeToString(buffer, Base64.NO_WRAP)
    }
  }

  @JavascriptInterface
  fun done(id: String) {
    if (fromOurPage()) incoming.remove(id)
  }

  // WebView.getUrl must run on the main thread, and these calls come in on another.
  private fun fromOurPage(): Boolean {
    val ask = FutureTask { isOurPage(webView) }
    activity.runOnUiThread(ask)
    return ask.get()
  }

  companion object {
    /** About 768 KiB: a multiple of 3, so every piece but the last is whole base64. */
    const val CHUNK = 786_432

    fun isOurPage(webView: android.webkit.WebView): Boolean {
      val host = android.net.Uri.parse(webView.url ?: return false).host ?: return false
      return host == "golemdocs.com" || host.endsWith(".golemdocs.com") || host == "localhost" || host.endsWith(".localhost")
    }
  }
}
