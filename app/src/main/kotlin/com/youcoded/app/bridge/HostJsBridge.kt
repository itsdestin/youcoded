package com.youcoded.app.bridge

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import com.youcoded.app.runtime.PairedDeviceStore
import com.youcoded.app.ui.CleartextPolicy
import com.youcoded.app.runtime.VoiceRecognizer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * `window.YouCodedHost` — what the shared page asks the Android app itself (desktop/src/renderer/android-local-bridge.ts).
 *
 * WHY (2026-10-14, Android clean rebuild): everything else the page needs is the backend's, over its socket.
 * These are the phone's own: its saved computers, its camera (QR pairing), its speech recognizer, its version,
 * and its back button. A call arrives as invoke(id, type, payloadJson); the answer goes back through
 * `window.__youcodedHost.reply(id, json, error?)`, and pushes (voice words, back presses) through
 * `window.__youcodedHost.event(type, json)`. Every channel the page may send is in [TYPES]; desktop
 * tests pin that list against the shim.
 */
class HostJsBridge(
    private val context: Context,
    private val ui: Ui,
) {
    /** What only the screen can do. Called on the main thread. */
    interface Ui {
        /** Run JavaScript in the page (replies and pushes). */
        fun evaluate(js: String)
        /** Show the QR scanner; call [done] with the scanned text, or null when dismissed. */
        fun scanQr(done: (String?) -> Unit)
        /** Ask for the microphone if needed; call [done] with whether it may be used (null: nobody could ask). */
        fun ensureMicPermission(done: (Boolean?) -> Unit)
        /** Whether the page has an overlay open (the back button closes it) or not (back leaves the app). */
        fun setBackStackEmpty(empty: Boolean)
    }

    /** This run's page token (MainActivity sets it when it loads the page). A call without it is ignored: Android
     *  hands this object to every frame, and only the app's own page knows the token (independent review, 2026-10-15). */
    @Volatile var expectedToken: String = ""

    private val main = Handler(Looper.getMainLooper())
    private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var voice: VoiceRecognizer? = null
    private var micDenied = false

    @JavascriptInterface
    fun invoke(id: String, type: String, payloadJson: String, token: String) {
        val want = expectedToken
        if (want.isEmpty() || !java.security.MessageDigest.isEqual(want.toByteArray(), token.toByteArray())) return
        val payload = runCatching { JSONObject(payloadJson) }.getOrElse { JSONObject() }
        io.launch {
            try {
                handle(id, type, payload)
            } catch (e: Exception) {
                reply(id, null, e.message ?: "The phone could not do that.")
            }
        }
    }

    private fun handle(id: String, type: String, p: JSONObject) {
        when (type) {
            "android:get-tier" -> reply(id, JSONObject().put("tier", "CORE"))
            "android:set-tier" -> reply(id, JSONObject().put("restartRequired", false))
            "android:get-about" -> {
                val info = context.packageManager.getPackageInfo(context.packageName, 0)
                reply(id, JSONObject().put("version", info.versionName ?: "unknown").put("build", info.longVersionCode.toString()))
            }
            "android:get-paired-devices" -> reply(id, JSONObject().put("devices", readDevices()))
            "android:save-paired-device" -> {
                val host = p.optString("host"); val port = p.optInt("port", 9900)
                // WHY (2026-10-30 audit A1): a computer is saved only at an address the app may reach without encryption; the page
                // shows this message as "Couldn’t save <name>: ...".
                if (!CleartextPolicy.isAllowedHost(host)) throw IllegalArgumentException(CleartextPolicy.MESSAGE)
                val kept = without(readDevices(), host, port)
                kept.put(JSONObject().put("name", p.optString("name", "Computer")).put("host", host).put("port", port).put("password", p.optString("password")))
                PairedDeviceStore.prefs(context).edit().putString(DEVICES, kept.toString()).apply()
                reply(id, true)
            }
            "android:remove-paired-device" -> {
                val kept = without(readDevices(), p.optString("host"), p.optInt("port", 9900))
                PairedDeviceStore.prefs(context).edit().putString(DEVICES, kept.toString()).apply()
                reply(id, true)
            }
            "android:scan-qr" -> main.post { ui.scanQr { url -> reply(id, JSONObject().put("url", url ?: JSONObject.NULL)) } }
            "system:notify-stack-state" -> { main.post { ui.setBackStackEmpty(p.optBoolean("empty", true)) }; reply(id, null) }
            "voice:status" -> reply(id, voiceReadiness())
            // Android listens itself: nothing to download.
            "voice:download" -> reply(id, JSONObject().put("ok", true))
            "voice:start" -> main.post {
                ui.ensureMicPermission { granted ->
                    when (granted) {
                        true -> {
                            micDenied = false
                            (voice ?: VoiceRecognizer.create(context) { event -> push("voice:event", event) }.also { voice = it }).start()
                            reply(id, JSONObject().put("ok", true))
                        }
                        // The composer reads a pushed error to return to idle (a reply alone looks like success).
                        false -> {
                            micDenied = true
                            val msg = "Microphone permission was not granted."
                            push("voice:event", JSONObject().put("type", "readiness").put("readiness", voiceReadiness()))
                            push("voice:event", JSONObject().put("type", "error").put("message", msg))
                            reply(id, JSONObject().put("ok", false).put("error", msg))
                        }
                        null -> {
                            val msg = "The YouCoded window is not open, so the microphone permission could not be requested."
                            push("voice:event", JSONObject().put("type", "error").put("message", msg))
                            reply(id, JSONObject().put("ok", false).put("error", msg))
                        }
                    }
                }
            }
            "voice:stop" -> { main.post { voice?.stop() }; reply(id, JSONObject().put("ok", true)) }
            "voice:cancel" -> { main.post { voice?.cancel() }; reply(id, JSONObject().put("ok", true)) }
            else -> reply(id, null, "The phone has no '$type'.")
        }
    }

    /** A hardware back press, for the page's overlay stack. */
    fun pressBack() = push("system:back", JSONObject())

    fun release() { main.post { voice?.release(); voice = null } }

    private fun voiceReadiness(): JSONObject = when {
        !android.speech.SpeechRecognizer.isRecognitionAvailable(context) ->
            JSONObject().put("state", "unavailable").put("reason", "This phone has no speech recognition service installed.")
        micDenied && context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED ->
            JSONObject().put("state", "unavailable").put("reason", "Microphone permission was not granted.")
        else -> JSONObject().put("state", "ready").put("engine", "your phone's speech recognition")
    }

    private fun readDevices(): JSONArray =
        runCatching { JSONArray(PairedDeviceStore.prefs(context).getString(DEVICES, "[]")) }.getOrElse { JSONArray() }

    private fun without(list: JSONArray, host: String, port: Int): JSONArray {
        val out = JSONArray()
        for (i in 0 until list.length()) {
            val d = list.optJSONObject(i) ?: continue
            if (d.optString("host") != host || d.optInt("port") != port) out.put(d)
        }
        return out
    }

    // Values reach the page as JSON text inside a JS string literal (JSONObject.quote), never as code.
    private fun reply(id: String, value: Any?, error: String? = null) {
        val json = when (value) { null -> "null"; is JSONObject, is JSONArray -> value.toString(); else -> JSONObject.wrap(value).toString() }
        val js = "window.__youcodedHost&&window.__youcodedHost.reply(${JSONObject.quote(id)},${JSONObject.quote(json)}${if (error != null) "," + JSONObject.quote(error) else ""})"
        main.post { ui.evaluate(js) }
    }

    private fun push(type: String, payload: JSONObject) {
        val js = "window.__youcodedHost&&window.__youcodedHost.event(${JSONObject.quote(type)},${JSONObject.quote(payload.toString())})"
        main.post { ui.evaluate(js) }
    }

    companion object {
        private const val DEVICES = "paired_devices"
        /** Every type [invoke] answers. Pinned against the shim by desktop/tests/android-host-channels.test.ts. */
        val TYPES = listOf(
            "android:get-tier", "android:set-tier", "android:get-about", "android:get-paired-devices",
            "android:save-paired-device", "android:remove-paired-device", "android:scan-qr",
            "system:notify-stack-state", "voice:status", "voice:download", "voice:start", "voice:stop", "voice:cancel",
        )
    }
}
