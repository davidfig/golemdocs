package com.golemdocs.mobile

import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
    webView.addJavascriptInterface(ShareBridge(this, webView), "GolemShare")
  }
}
