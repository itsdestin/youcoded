package com.destin.code.bridge

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import android.webkit.MimeTypeMap
import kotlinx.coroutines.CompletableDeferred
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * Handles Android-specific operations triggered by WebSocket messages from the React UI.
 *
 * Called by SessionService when the React UI sends dialog:open-file,
 * clipboard:save-image, or URL-opening messages through the WebSocket bridge.
 */
class PlatformBridge(
    private val context: Context,
    private val homeDir: File
) {
    companion object {
        private const val TAG = "PlatformBridge"
    }

    private val attachmentsDir: File
        get() = File(homeDir, "attachments").also { it.mkdirs() }

    /** Pending deferred awaiting file picker result; set in openFile(), resolved in onFilePickerResult/Cancelled. */
    private var pendingPicker: CompletableDeferred<List<String>>? = null

    // -------------------------------------------------------------------------
    // File picker callbacks — called by Activity when picker returns
    // -------------------------------------------------------------------------

    /**
     * Called by the Activity when the file picker returns with selected URIs.
     * Copies each URI's content to $HOME/attachments/ and completes the pending deferred.
     */
    fun onFilePickerResult(uris: List<Uri>) {
        val paths = uris.mapNotNull { uri ->
            try {
                copyToAttachments(uri)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to copy URI $uri: ${e.message}")
                null
            }
        }
        val deferred = pendingPicker
        pendingPicker = null
        deferred?.complete(paths)
    }

    /**
     * Called when the file picker is dismissed without a selection.
     * Completes the pending deferred with an empty list.
     */
    fun onFilePickerCancelled() {
        val deferred = pendingPicker
        pendingPicker = null
        deferred?.complete(emptyList())
    }

    // -------------------------------------------------------------------------
    // Suspending operations — called from a coroutine context in SessionService
    // -------------------------------------------------------------------------

    /**
     * Creates a CompletableDeferred, calls [launchPicker] to open the system file picker,
     * awaits the result from [onFilePickerResult] or [onFilePickerCancelled],
     * and returns { "paths": [...] }.
     */
    suspend fun openFile(launchPicker: () -> Unit): JSONObject {
        return try {
            val deferred = CompletableDeferred<List<String>>()
            pendingPicker = deferred
            launchPicker()
            val paths = deferred.await()
            val array = JSONArray()
            paths.forEach { array.put(it) }
            JSONObject().apply { put("paths", array) }
        } catch (e: Exception) {
            Log.w(TAG, "openFile failed: ${e.message}")
            pendingPicker = null
            JSONObject().apply { put("paths", JSONArray()) }
        }
    }

    // -------------------------------------------------------------------------
    // Synchronous operations
    // -------------------------------------------------------------------------

    /**
     * Gets an image from the ClipboardManager, saves it to
     * $HOME/attachments/clipboard-{timestamp}.png, and returns { "path": "/absolute/path" }
     * or { "path": null } if no image is available or an error occurs.
     */
    fun saveClipboardImage(): JSONObject {
        return try {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = clipboard.primaryClip
            if (clip == null || clip.itemCount == 0) {
                Log.w(TAG, "Clipboard is empty or has no items")
                return JSONObject().apply { put("path", JSONObject.NULL) }
            }

            // Try to find a URI item in the clipboard that resolves to an image
            for (i in 0 until clip.itemCount) {
                val item = clip.getItemAt(i)
                val uri = item.uri ?: continue
                val mimeType = context.contentResolver.getType(uri) ?: continue
                if (!mimeType.startsWith("image/")) continue

                val timestamp = System.currentTimeMillis()
                val outFile = File(attachmentsDir, "clipboard-$timestamp.png")
                context.contentResolver.openInputStream(uri)?.use { input ->
                    val bitmap = BitmapFactory.decodeStream(input)
                    if (bitmap != null) {
                        FileOutputStream(outFile).use { out ->
                            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                        }
                        Log.i(TAG, "Saved clipboard image to ${outFile.absolutePath}")
                        return JSONObject().apply { put("path", outFile.absolutePath) }
                    }
                }
            }

            Log.w(TAG, "No image found in clipboard")
            JSONObject().apply { put("path", JSONObject.NULL) }
        } catch (e: Exception) {
            Log.w(TAG, "saveClipboardImage failed: ${e.message}")
            JSONObject().apply { put("path", JSONObject.NULL) }
        }
    }

    /**
     * Launches an Intent.ACTION_VIEW with the given URL in the system browser.
     * Security: only allows http, https, and mailto schemes to prevent
     * intent:// URI injection that could launch arbitrary Activities.
     */
    fun openUrl(url: String) {
        try {
            val uri = Uri.parse(url)
            val scheme = uri.scheme?.lowercase()
            if (scheme !in listOf("http", "https", "mailto")) {
                Log.w(TAG, "openUrl blocked — disallowed scheme '$scheme' in '$url'")
                return
            }
            val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "openUrl failed for '$url': ${e.message}")
        }
    }

    /**
     * Returns the absolute path of the home directory.
     */
    fun getHomePath(): String = homeDir.absolutePath

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Copies URI content to $HOME/attachments/attach-{timestamp}.{ext}.
     * The extension is derived from the MIME type reported by ContentResolver.
     * Returns the absolute path of the copied file, or null on error.
     */
    private fun copyToAttachments(uri: Uri): String? {
        return try {
            val mimeType = context.contentResolver.getType(uri)
            val ext = mimeType?.let {
                MimeTypeMap.getSingleton().getExtensionFromMimeType(it)
            } ?: "bin"

            val timestamp = System.currentTimeMillis()
            val outFile = File(attachmentsDir, "attach-$timestamp.$ext")

            context.contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(outFile).use { output ->
                    input.copyTo(output)
                }
            } ?: run {
                Log.w(TAG, "ContentResolver returned null stream for $uri")
                return null
            }

            Log.i(TAG, "Copied $uri -> ${outFile.absolutePath}")
            outFile.absolutePath
        } catch (e: Exception) {
            Log.w(TAG, "copyToAttachments failed for $uri: ${e.message}")
            null
        }
    }
}
