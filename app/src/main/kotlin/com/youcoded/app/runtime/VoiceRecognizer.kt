package com.youcoded.app.runtime

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import org.json.JSONObject

// Voice prompting on Android — the phone's own speech recognition, wrapped so the
// shared React UI sees exactly the same events the desktop sends.
//
// WHY a wrapper at all: the desktop runs its own speech model and streams audio to
// it; a phone already has a recogniser built in, so on Android we hand the
// microphone to Android and translate what it tells us into the small set of
// messages the chat box understands (words-so-far, final text, loudness, error).
// Nothing here records or uploads audio itself — Android owns the microphone.
//
// Design: docs/active/specs/2026-09-05-voice-prompting-technical-design.md → "Android".
// The event shapes are the contract in desktop/src/shared/voice-types.ts.

/** The two halves of the words heard so far: solid text, and the grey tail. */
data class VoiceSplit(val committed: String, val tail: String)

/**
 * THE grey/solid rule, in Kotlin.
 *
 * WHY this exists twice: the desktop has one implementation of this rule in
 * TypeScript (`splitAtLastSentenceEnd` in `shared/voice-types.ts`). A phone's
 * recogniser hands back finished strings and never calls into that file, so the
 * rule is deliberately written a second time here. `VoiceRecognizerTest` pins it
 * against the SAME table of examples as `desktop/tests/voice-split.test.ts`, so
 * the two copies cannot quietly drift apart.
 *
 * The rule: everything up to and including the LAST sentence-ending mark
 * (`.`, `?`, `!`) is solid; whatever comes after it is still being reconsidered
 * and shows grey. No mark anywhere means nothing is settled yet. Whitespace at
 * the cut belongs to neither half — the chat box puts the single space back when
 * it joins them.
 *
 * Abbreviations ("Dr.") and decimals ("$2.30") are deliberately NOT special-cased,
 * for the reason spelled out in the TypeScript copy: a list of exceptions would be
 * a second, quieter model of English disagreeing with the first, and the worst it
 * costs is a word turning solid a moment early.
 */
fun splitAtLastSentenceEnd(text: String): VoiceSplit {
    var cut = -1
    for (i in text.length - 1 downTo 0) {
        val ch = text[i]
        if (ch == '.' || ch == '?' || ch == '!') { cut = i; break }
    }
    if (cut < 0) return VoiceSplit("", text.trim())
    return VoiceSplit(text.substring(0, cut + 1).trim(), text.substring(cut + 1).trim())
}

/**
 * The name Android gives one of its speech errors.
 *
 * WHY spell the name out: we must never invent a cause for a failure we did not
 * diagnose (docs/error-message-standards.md). The recogniser tells us a number;
 * printing the name it belongs to is the one honest, specific thing we know.
 */
fun speechRecognizerErrorName(code: Int): String = when (code) {
    SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "ERROR_NETWORK_TIMEOUT"
    SpeechRecognizer.ERROR_NETWORK -> "ERROR_NETWORK"
    SpeechRecognizer.ERROR_AUDIO -> "ERROR_AUDIO"
    SpeechRecognizer.ERROR_SERVER -> "ERROR_SERVER"
    SpeechRecognizer.ERROR_CLIENT -> "ERROR_CLIENT"
    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "ERROR_SPEECH_TIMEOUT"
    SpeechRecognizer.ERROR_NO_MATCH -> "ERROR_NO_MATCH"
    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "ERROR_RECOGNIZER_BUSY"
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "ERROR_INSUFFICIENT_PERMISSIONS"
    SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "ERROR_TOO_MANY_REQUESTS"
    SpeechRecognizer.ERROR_SERVER_DISCONNECTED -> "ERROR_SERVER_DISCONNECTED"
    SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> "ERROR_LANGUAGE_NOT_SUPPORTED"
    SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "ERROR_LANGUAGE_UNAVAILABLE"
    SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT -> "ERROR_CANNOT_CHECK_SUPPORT"
    else -> "error $code"
}

/**
 * The sentence the user reads when the phone's recogniser gives up.
 *
 * Each branch is a plain restatement of what Android documents that code to mean —
 * never a guess at a cause we did not observe — and every message carries the raw
 * error name in brackets so a bug report has something exact in it.
 */
fun voiceErrorMessage(code: Int): String {
    val plain = when (code) {
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ->
            "Microphone permission was not granted."
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT ->
            "Your phone's speech recognition could not reach the network."
        SpeechRecognizer.ERROR_AUDIO ->
            "Your phone could not record from the microphone."
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY ->
            "Your phone's speech recognition is busy with something else."
        SpeechRecognizer.ERROR_SERVER, SpeechRecognizer.ERROR_SERVER_DISCONNECTED ->
            "Your phone's speech recognition service returned an error."
        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ->
            "Your phone's speech recognition does not have this language."
        else ->
            "Your phone's speech recognition stopped."
    }
    return "$plain (${speechRecognizerErrorName(code)})"
}

/**
 * The part of the phone's speech engine [VoiceRecognizer] actually drives.
 *
 * WHY an interface instead of using `SpeechRecognizer` directly: `SpeechRecognizer`
 * can only exist on a real phone (it has no public constructor and talks to a
 * system service), so tests substitute a fake that records what was asked of it
 * and replays the callbacks a real one would fire.
 */
interface SpeechEngine {
    fun startListening()
    fun stopListening()
    fun cancel()
    fun destroy()
}

/**
 * "Call me back in N milliseconds, unless I say otherwise."
 *
 * WHY this is a seam rather than a plain `Handler`: the thing it guards is a
 * recogniser that never answers, and a test that had to wait twenty real seconds
 * to prove that would never be written. [MainThreadDeadline] is the real one.
 */
interface Deadline {
    fun arm(delayMs: Long, action: () -> Unit)
    fun clear()
}

/** The real deadline: a message posted to the main thread, cancellable. */
class MainThreadDeadline : Deadline {
    private val handler = Handler(Looper.getMainLooper())
    private var pending: Runnable? = null
    override fun arm(delayMs: Long, action: () -> Unit) {
        clear()
        val r = Runnable { pending = null; action() }
        pending = r
        handler.postDelayed(r, delayMs)
    }
    override fun clear() {
        pending?.let { handler.removeCallbacks(it) }
        pending = null
    }
}

/**
 * Turns Android's speech callbacks into the four events the chat box understands.
 *
 * **Main thread only.** `SpeechRecognizer` throws if it is touched from any other
 * thread, and bridge messages arrive on the web-socket thread — so every caller
 * hops to `Handler(Looper.getMainLooper())` first, the same hop `SessionService`
 * already makes for the terminal.
 *
 * @param emit receives one finished event object, ready to be pushed to the UI.
 * @param engineFactory builds the speech engine, given this recognizer to call back into.
 */
class VoiceRecognizer(
    private val emit: (JSONObject) -> Unit,
    private val engineFactory: (VoiceRecognizer) -> SpeechEngine,
    private val deadline: Deadline,
) {
    private var engine: SpeechEngine? = null

    /** True between start() and the one final event that ends the turn. */
    private var listening = false

    /** The best text we have heard this turn. WHY keep it: if the engine ends the
     *  turn with "I heard nothing", the words it already showed the user are still
     *  the right thing to deliver — dropping them would look like the app ate them. */
    private var heard = ""

    /** Guards the "exactly one final per turn" half of the contract. */
    private var finalSent = false

    /** Open the microphone. Must be called on the main thread. */
    fun start() {
        if (listening) return
        listening = true
        heard = ""
        finalSent = false
        val e = engine ?: engineFactory(this).also { engine = it }
        e.startListening()
    }

    /**
     * Stop listening and deliver the words. Must be called on the main thread.
     *
     * The `final` event is NOT sent from here: we ask Android to stop and send it
     * when Android reports the outcome, so the last words spoken are included.
     */
    fun stop() {
        if (!listening) return
        engine?.stopListening()
        // Fix (whole-branch review F2): a recogniser that never calls back used to
        // park the chat box on "Finishing…" with no way out but typing, because
        // the one `final` that ends the turn is only ever sent from a callback and
        // the composer's own give-up clock is deliberately off on a phone (the
        // phone, not the app, owns the microphone). The desktop defends this same
        // case with a stop deadline of its own; this is the phone's copy of it.
        deadline.arm(STOP_DEADLINE_MS) {
            if (!finalSent) {
                deliverFinal()
                emit(JSONObject().put("type", "error").put("message", STOP_TIMEOUT_SENTENCE))
            }
        }
    }

    /**
     * Throw the words away. Must be called on the main thread.
     *
     * Emits nothing at all — not even a final — because cancelling means whatever
     * the user had typed before must be left exactly as it was. Clearing
     * [listening] here is also what silences the results Android may still deliver
     * a moment later.
     */
    fun cancel() {
        if (!listening) return
        deadline.clear()
        listening = false
        finalSent = true
        heard = ""
        engine?.cancel()
    }

    /** Let go of the phone's recogniser (app shutting down). Main thread. */
    fun release() {
        deadline.clear()
        listening = false
        engine?.destroy()
        engine = null
    }

    // --- What the phone's recogniser tells us -------------------------------

    /** Words so far, still being revised — split into solid text and a grey tail. */
    fun onPartialText(text: String) {
        if (!listening) return
        heard = text
        val split = splitAtLastSentenceEnd(text)
        emit(JSONObject()
            .put("type", "partial")
            .put("committed", split.committed)
            .put("tail", split.tail))
    }

    /** The finished utterance. */
    fun onFinalText(text: String) {
        if (!listening) return
        if (text.isNotEmpty()) heard = text
        deliverFinal()
    }

    /**
     * Microphone loudness, for the ring around the mic button.
     *
     * Android reports this in decibels over a range of roughly -2 (silence) to 10
     * (loud); the UI wants 0..1, so that is the conversion, clamped at both ends
     * because the documented range is approximate and phones do exceed it.
     */
    fun onLevel(rmsDb: Float) {
        if (!listening) return
        val value = ((rmsDb + 2f) / 12f).coerceIn(0f, 1f)
        emit(JSONObject().put("type", "level").put("value", value.toDouble()))
    }

    /**
     * The recogniser gave up.
     *
     * "I heard nothing" is not a failure worth showing — it is what happens when
     * someone taps the mic and says nothing — so those two codes end the turn with
     * a normal final instead of an alarming error. Every other code produces an
     * error the user can read AND a final, because the chat box only returns to
     * normal when a final arrives; without one it would sit there listening forever.
     */
    fun onEngineError(code: Int) {
        if (!listening) return
        if (code == SpeechRecognizer.ERROR_NO_MATCH || code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
            deliverFinal()
            return
        }
        // FINAL FIRST, then the error. WHY the order is load-bearing: the composer
        // returns itself to idle the instant it sees an `error`, and then drops any
        // `final` that arrives afterwards — so emitting the error first threw away
        // the words the user had already watched appear. Found reviewing T8,
        // 2026-09-05.
        deliverFinal()
        emit(JSONObject().put("type", "error").put("message", voiceErrorMessage(code)))
    }

    private fun deliverFinal() {
        if (finalSent) return
        deadline.clear()
        finalSent = true
        listening = false
        emit(JSONObject().put("type", "final").put("text", heard.trim()))
    }

    companion object {
        /** How long the phone gets to deliver the last words after we ask it to stop.
         *  Matches the desktop's own STOP_DEADLINE_MS so the two platforms give up
         *  at the same moment. Generous on purpose: a slow phone finishing normally
         *  must never be cut off. */
        const val STOP_DEADLINE_MS = 20_000L

        /** Said only when the phone's recogniser genuinely stopped answering — never
         *  guessed at a cause we did not observe. */
        const val STOP_TIMEOUT_SENTENCE =
            "Your phone's speech recognition stopped responding. Anything it had already heard is in the box."

        /** The real thing: a [VoiceRecognizer] driving Android's own speech service. */
        fun create(context: Context, emit: (JSONObject) -> Unit): VoiceRecognizer =
            VoiceRecognizer(emit, { recognizer -> AndroidSpeechEngine(context, recognizer) }, MainThreadDeadline())
    }
}

/**
 * The real [SpeechEngine] — Android's `SpeechRecognizer`.
 *
 * `EXTRA_PARTIAL_RESULTS` is what makes words appear while the user is still
 * talking; without it Android stays silent until the very end.
 */
private class AndroidSpeechEngine(
    context: Context,
    recognizer: VoiceRecognizer,
) : SpeechEngine {
    private val speech: SpeechRecognizer = SpeechRecognizer.createSpeechRecognizer(context)

    private val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
    }

    init {
        speech.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) = recognizer.onLevel(rmsdB)
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onError(error: Int) = recognizer.onEngineError(error)
            override fun onResults(results: Bundle?) = recognizer.onFinalText(topHypothesis(results))
            override fun onPartialResults(partialResults: Bundle?) =
                recognizer.onPartialText(topHypothesis(partialResults))
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
    }

    /** Android returns a ranked list of guesses; the first one is the best guess. */
    private fun topHypothesis(bundle: Bundle?): String =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()

    override fun startListening() { speech.startListening(intent) }
    override fun stopListening() { speech.stopListening() }
    override fun cancel() { speech.cancel() }
    override fun destroy() { speech.destroy() }
}
