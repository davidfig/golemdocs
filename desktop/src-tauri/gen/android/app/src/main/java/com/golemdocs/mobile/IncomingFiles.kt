package com.golemdocs.mobile

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

// Files other apps open or share into GolemDocs (VIEW and SEND intents, see AndroidManifest.xml). Each is copied at once into the
// app's cache (a content:// permission lasts only as long as the intent), and the page asks for the list through OpenBridge.kt.
class IncomingFiles(private val activity: MainActivity) {
  class Item(val id: String, val name: String, val type: String, val file: File)

  private val items = ArrayList<Item>()
  private val worker = Executors.newSingleThreadExecutor()
  // Looked up when first needed: this is made while the activity is being built, before it has a cache folder.
  private val dir by lazy { File(activity.cacheDir, "incoming").apply { mkdirs() } }

  /** Takes the files an intent brings, if it brings any, and tells the page when they are ready. */
  fun take(intent: Intent?, announce: () -> Unit) {
    val uris = urisOf(intent ?: return)
    if (uris.isEmpty()) return
    val resolver = activity.contentResolver
    worker.execute {
      for (uri in uris) copy(resolver, uri)
      announce()
    }
  }

  @Synchronized
  fun list(): List<Item> = items.toList()

  @Synchronized
  fun find(id: String): Item? = items.find { it.id == id }

  @Synchronized
  fun remove(id: String) {
    val item = items.find { it.id == id } ?: return
    items.remove(item)
    item.file.parentFile?.deleteRecursively()
  }

  private fun urisOf(intent: Intent): List<Uri> = when (intent.action) {
    Intent.ACTION_VIEW -> listOfNotNull(intent.data)
    Intent.ACTION_SEND -> listOfNotNull(streamOf(intent))
    Intent.ACTION_SEND_MULTIPLE -> streamsOf(intent)
    else -> emptyList()
  }

  @Suppress("DEPRECATION")
  private fun streamOf(intent: Intent): Uri? =
    if (android.os.Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri

  @Suppress("DEPRECATION")
  private fun streamsOf(intent: Intent): List<Uri> =
    (if (android.os.Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)) ?: emptyList()

  private fun copy(resolver: ContentResolver, uri: Uri) {
    try {
      val name = nameOf(resolver, uri)
      val id = UUID.randomUUID().toString()
      val target = File(File(dir, id).apply { mkdirs() }, name)
      resolver.openInputStream(uri)?.use { input -> target.outputStream().use { input.copyTo(it) } } ?: return
      synchronized(this) { items.add(Item(id, name, resolver.getType(uri) ?: "", target)) }
    } catch (e: Exception) {
      // Unreadable (permission gone, the sender removed it): nothing to open.
    }
  }

  /** A file name that is safe to use as one: the sender's display name, else the last part of the address. */
  private fun nameOf(resolver: ContentResolver, uri: Uri): String {
    var name: String? = null
    if (uri.scheme == "content") {
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
        if (it.moveToFirst()) name = it.getString(0)
      }
    }
    val raw = name ?: uri.lastPathSegment ?: "document"
    return raw.substringAfterLast('/').replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").take(120).ifBlank { "document" }
  }
}
