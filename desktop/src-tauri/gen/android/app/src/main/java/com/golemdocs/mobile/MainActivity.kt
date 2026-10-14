package com.golemdocs.mobile

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private val incoming = IncomingFiles(this)
  private var page: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    incoming.take(intent, ::announceIncoming)
    // The app draws edge to edge, but the web view does not give the page dependable safe-area values. So the window
    // pads its content by the status bar, the gesture bar, a camera cut-out and the keyboard, and the page (which pads
    // itself by env(safe-area-inset-*), 0 here) is left a plain rectangle.
    val root = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  // The page shares files through this (see ShareBridge.kt and client/src/ui/saveFile.ts).
  override fun onWebViewCreate(webView: WebView) {
    page = webView
    webView.addJavascriptInterface(ShareBridge(this, webView), "GolemShare")
    // Files opened in or shared to the app (see IncomingFiles.kt and client/src/desktop/incoming.ts).
    webView.addJavascriptInterface(OpenBridge(this, webView, incoming), "GolemOpen")
  }

  // The app was already running (launchMode singleTask) and another app opened or shared a file into it.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    incoming.take(intent, ::announceIncoming)
  }

  // Tells the page there is something to take (it also looks when it starts and when the app comes to the front).
  private fun announceIncoming() {
    runOnUiThread { page?.evaluateJavascript("window.dispatchEvent(new Event('golem-incoming'))", null) }
  }
}
