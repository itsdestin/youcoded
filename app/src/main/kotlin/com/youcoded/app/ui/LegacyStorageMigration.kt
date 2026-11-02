package com.youcoded.app.ui

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * One-time copy of the page's saved look settings from the old address to the new one.
 *
 * WHY (2026-10-30 security audit A2): the app's page used to be file:///android_asset/web and is now served from
 * https://appassets.androidplatform.net so the WebView can have file access switched off. A WebView keeps saved settings (theme,
 * layout, last conversation, ...) PER ADDRESS, so without this every phone would open to the default look once after updating.
 *
 * How: a throwaway, invisible WebView opens a blank bundled page at the OLD address and reads its saved settings; they are held in
 * memory only (never written to a file), handed to the new page by a start-up script that fills in ONLY settings the new address
 * does not have yet, and the script is removed once the page has loaded. Every step is allowed to fail: then the app opens exactly
 * as it would on a first install (default look), and the next launch tries again until one attempt completes. The old address's
 * copy is left in place (harmless, and a way back).
 */
object LegacyStorageMigration {
    private const val PREFS = "legacy_page_storage"
    private const val DONE = "copied_v1"
    private const val TIMEOUT_MS = 3000L

    private var handle: ScriptHandler? = null
    private var collected = false

    private fun done(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(DONE, false)

    /** Gets the new page ready to inherit the old settings (when there are any to inherit), then calls [proceed] — always, even on failure. */
    fun prepare(context: Context, target: WebView, proceed: () -> Unit) {
        if (done(context) || collected || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) { proceed(); return }
        collected = true
        collect(context) { json ->
            runCatching {
                if (json != null && json != "{}") {
                    val js = "(function(){try{var d=JSON.parse(${JSONObject.quote(json)});for(var k in d){if(localStorage.getItem(k)===null)localStorage.setItem(k,d[k]);}}catch(e){}})();"
                    handle = WebViewCompat.addDocumentStartJavaScript(target, js, setOf(AppWebView.PAGE_ORIGIN))
                }
                if (json == null) collected = false // nothing was learned: try again next time
                else if (json == "{}") markDone(context)
            }
            proceed()
        }
    }

    /** The new page has loaded once: the script has done its job, so it must not run again (it would bring back settings the page cleared). */
    fun onPageLoaded(context: Context) {
        val h = handle ?: return
        runCatching { h.remove() }
        handle = null
        markDone(context)
    }

    private fun markDone(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(DONE, true).apply()

    @SuppressLint("SetJavaScriptEnabled")
    private fun collect(context: Context, result: (String?) -> Unit) {
        val main = Handler(Looper.getMainLooper())
        var finished = false
        val temp = WebView(context)
        fun finish(json: String?) {
            if (finished) return
            finished = true
            runCatching { temp.stopLoading(); temp.destroy() }
            result(json)
        }
        try {
            temp.settings.javaScriptEnabled = true
            temp.settings.domStorageEnabled = true
            // File access is on for THIS throwaway view only: it must open the old file:// address to read what that address saved.
            // It loads one blank page of ours and refuses every other navigation; it has no bridge and is destroyed straight after.
            @Suppress("DEPRECATION")
            temp.settings.allowFileAccess = true
            temp.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest) = true
                override fun onPageFinished(view: WebView, url: String?) {
                    view.evaluateJavascript(
                        "(function(){try{var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=localStorage.getItem(k);}return JSON.stringify(o);}catch(e){return null;}})()",
                    ) { raw -> finish(decode(raw)) }
                }
            }
            main.postDelayed({ finish(null) }, TIMEOUT_MS)
            temp.loadUrl("file:///android_asset/legacy-migrate.html")
        } catch (e: Exception) {
            finish(null)
        }
    }

    /** evaluateJavascript hands back a JSON-encoded value: a string comes back quoted and escaped, "null" for none. */
    private fun decode(raw: String?): String? {
        if (raw == null || raw == "null") return null
        return runCatching { org.json.JSONArray("[$raw]").getString(0) }.getOrNull()
    }
}
