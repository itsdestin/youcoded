package com.youcoded.app.runtime

import android.speech.SpeechRecognizer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Voice prompting on Android — what the phone's speech recognition says, turned
// into what the chat box draws.
//
// The first half of this file is the GREY/SOLID TABLE. It is copied, row for row,
// from desktop/tests/voice-split.test.ts: the desktop and the phone each have their
// own implementation of that rule (the phone's recogniser hands back whole strings
// and never runs the desktop's code), and this shared table is what stops the two
// from quietly drifting apart. If a row changes here it must change there too.

/** Stands in for Android's SpeechRecognizer, which only exists on a real phone. */
private class FakeSpeechEngine : SpeechEngine {
    var starts = 0
    var stops = 0
    var cancels = 0
    var destroys = 0
    override fun startListening() { starts++ }
    override fun stopListening() { stops++ }
    override fun cancel() { cancels++ }
    override fun destroy() { destroys++ }
}

/** A deadline whose clock only moves when a test moves it. */
private class FakeDeadline : Deadline {
    private var action: (() -> Unit)? = null
    var armedFor = 0L
    override fun arm(delayMs: Long, action: () -> Unit) { armedFor = delayMs; this.action = action }
    override fun clear() { action = null }
    val armed: Boolean get() = action != null
    /** Pretend the wait elapsed. */
    fun fire() { val a = action; action = null; a?.invoke() }
}

/** A recognizer wired to a fake engine, with every event it emits captured. */
private class Harness {
    val events = mutableListOf<JSONObject>()
    val engine = FakeSpeechEngine()
    val deadline = FakeDeadline()
    val recognizer = VoiceRecognizer({ events.add(it) }, { engine }, deadline)

    fun types(): List<String> = events.map { it.getString("type") }
    fun last(): JSONObject = events.last()
    fun only(): JSONObject { assertEquals("expected exactly one event, got ${types()}", 1, events.size); return events[0] }
}

class VoiceRecognizerTest {

    // ── The grey/solid table, shared with desktop/tests/voice-split.test.ts ──

    /** what came out of the recogniser → what turns solid | what stays grey */
    private data class Case(val text: String, val committed: String, val tail: String, val why: String)

    private val cases = listOf(
        Case("", "", "", "nothing heard yet"),
        Case("so I was thinking", "", "so I was thinking",
            "no sentence has ended, so every word is still up for revision"),
        Case("Send it today.", "Send it today.", "",
            "the mark is the last character — the whole thing is settled, nothing is grey"),
        Case("Send it today. Then let", "Send it today.", "Then let",
            "the normal case: solid sentence, grey words since"),
        Case("Can you check it? I think so", "Can you check it?", "I think so",
            "a question mark ends a sentence too"),
        Case("Stop! That is wrong", "Stop!", "That is wrong",
            "so does an exclamation mark"),
        Case("One. Two. Three and", "One. Two.", "Three and",
            "the LAST mark is the cut, not the first — everything before it is solid"),
        Case("Done.   ", "Done.", "",
            "trailing space belongs to neither half"),
        Case("   still going", "", "still going",
            "leading space is trimmed off the grey half"),
        Case("Send it today.Then let", "Send it today.", "Then let",
            "no space after the mark (the engine does this) — the cut is still the mark"),
        Case("Wait... maybe not", "Wait...", "maybe not",
            "an ellipsis cuts at its last dot; the grey half never starts with a stray dot"),

        // The two documented non-exceptions. These look wrong read on their own and
        // are deliberate: we split on the punctuation the ENGINE wrote, and a list of
        // abbreviations would be a second, quieter model of English disagreeing with
        // the first. The cost is a word or two turning solid a moment early.
        Case("I met Dr. Smith", "I met Dr.", "Smith",
            "abbreviations are NOT special-cased"),
        Case("It was \$2.30 in the end", "It was \$2.", "30 in the end",
            "decimal points are NOT special-cased"),
        Case("She said \"go.\" Then we left", "She said \"go.", "\" Then we left",
            "a mark inside quotes cuts where it sits — closing punctuation is not tracked"),

        Case("Can you look at the budget spreadsheet I sent yesterday? Row 14 is",
            "Can you look at the budget spreadsheet I sent yesterday?", "Row 14 is",
            "the scripted demo sentence, mid-flight"),
    )

    @Test
    fun `the grey solid split matches the desktop table row for row`() {
        for (c in cases) {
            val split = splitAtLastSentenceEnd(c.text)
            assertEquals("committed for ${c.text.let { "\"$it\"" }} — ${c.why}", c.committed, split.committed)
            assertEquals("tail for ${c.text.let { "\"$it\"" }} — ${c.why}", c.tail, split.tail)
        }
    }

    @Test
    fun `the split never loses or invents a character`() {
        // The invariant behind every row: the split MOVES the boundary, it never
        // eats words. Only whitespace may differ from the original.
        val bare = { s: String -> s.filterNot { it.isWhitespace() } }
        for (c in cases) {
            val split = splitAtLastSentenceEnd(c.text)
            assertEquals(c.text, bare(c.text), bare(split.committed + split.tail))
        }
    }

    @Test
    fun `the solid half only grows as more words arrive`() {
        // The recogniser re-sends the whole open sentence every time, so what is
        // already solid must never go backwards while someone keeps talking.
        val words = "One two. Three four? Five six! Seven".split(" ")
        var previous = ""
        for (n in 1..words.size) {
            val committed = splitAtLastSentenceEnd(words.take(n).joinToString(" ")).committed
            assertTrue("solid half went backwards at word $n: \"$committed\" after \"$previous\"",
                committed.startsWith(previous))
            previous = committed
        }
        assertEquals("One two. Three four? Five six!", previous)
    }

    // ── What each Android callback turns into ───────────────────────────────

    @Test
    fun `words heard so far become a partial event, split grey and solid`() {
        val h = Harness()
        h.recognizer.start()
        h.recognizer.onPartialText("Send it today. Then let")

        val e = h.only()
        assertEquals("partial", e.getString("type"))
        assertEquals("Send it today.", e.getString("committed"))
        assertEquals("Then let", e.getString("tail"))
    }

    @Test
    fun `the finished utterance becomes exactly one final event`() {
        val h = Harness()
        h.recognizer.start()
        h.recognizer.onPartialText("Send it")
        h.recognizer.stop()
        h.recognizer.onFinalText("Send it today.")

        assertEquals(1, h.engine.stops)
        assertEquals(listOf("partial", "final"), h.types())
        assertEquals("Send it today.", h.last().getString("text"))
    }

    @Test
    fun `a second final from the engine is ignored`() {
        // Contract: stop emits exactly one final — never zero, never two. A second
        // one would paste the same sentence into the chat box twice.
        val h = Harness()
        h.recognizer.start()
        h.recognizer.onFinalText("Send it today.")
        h.recognizer.onFinalText("Send it today.")

        assertEquals(listOf("final"), h.types())
    }

    @Test
    fun `loudness maps onto nought to one, clamped at both ends`() {
        val h = Harness()
        h.recognizer.start()
        h.recognizer.onLevel(-2f)   // silence, the bottom of Android's range
        h.recognizer.onLevel(4f)    // the middle
        h.recognizer.onLevel(10f)   // the top
        h.recognizer.onLevel(-40f)  // below the range — phones do this
        h.recognizer.onLevel(40f)   // above it

        assertEquals(listOf("level", "level", "level", "level", "level"), h.types())
        val values = h.events.map { it.getDouble("value") }
        assertEquals(0.0, values[0], 0.0001)
        assertEquals(0.5, values[1], 0.0001)
        assertEquals(1.0, values[2], 0.0001)
        assertEquals(0.0, values[3], 0.0001)
        assertEquals(1.0, values[4], 0.0001)
    }

    @Test
    fun `an error carries the name Android gave it, never a guessed cause`() {
        val h = Harness()
        h.recognizer.start()
        // Words the user has already watched appear on screen.
        h.recognizer.onPartialText("hello there")
        h.recognizer.onEngineError(SpeechRecognizer.ERROR_NETWORK)

        // FINAL FIRST. The composer returns itself to idle the moment it sees an
        // error and drops any final after it, so this order is what decides whether
        // the user keeps the words they already watched appear. Reviewing T8 found
        // the opposite order shipping, and this assertion is what pins it.
        assertEquals(listOf("partial", "final", "error"), h.types())
        val message = h.events[2].getString("message")
        assertTrue("the SpeechRecognizer error name must appear in the message: $message",
            message.contains("ERROR_NETWORK"))
        assertEquals("the words already shown must survive a non-fatal error",
            "hello there", h.events[1].getString("text"))
    }

    @Test
    fun `every error code is spelled out under its own name`() {
        // Each code must map to its OWN name. (This also proves the framework's
        // constants reach us as distinct numbers rather than collapsing to zero.)
        val codes = listOf(
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT to "ERROR_NETWORK_TIMEOUT",
            SpeechRecognizer.ERROR_NETWORK to "ERROR_NETWORK",
            SpeechRecognizer.ERROR_AUDIO to "ERROR_AUDIO",
            SpeechRecognizer.ERROR_SERVER to "ERROR_SERVER",
            SpeechRecognizer.ERROR_CLIENT to "ERROR_CLIENT",
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT to "ERROR_SPEECH_TIMEOUT",
            SpeechRecognizer.ERROR_NO_MATCH to "ERROR_NO_MATCH",
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY to "ERROR_RECOGNIZER_BUSY",
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS to "ERROR_INSUFFICIENT_PERMISSIONS",
        )
        for ((code, name) in codes) {
            assertEquals(name, speechRecognizerErrorName(code))
        }
        // An unknown code still says something exact rather than pretending.
        assertEquals("error 999", speechRecognizerErrorName(999))
    }

    @Test
    fun `the microphone error says the permission was not granted`() {
        assertTrue(voiceErrorMessage(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS)
            .startsWith("Microphone permission was not granted."))
    }

    @Test
    fun `hearing nothing ends the turn quietly instead of showing an error`() {
        // Tapping the mic and saying nothing is not a failure — it must not put a
        // red message in front of the user, but it must still end the turn.
        val h = Harness()
        h.recognizer.start()
        h.recognizer.onEngineError(SpeechRecognizer.ERROR_NO_MATCH)

        assertEquals(listOf("final"), h.types())
        assertEquals("", h.only().getString("text"))
    }

    @Test
    fun `words already shown survive an engine that ends with no result`() {
        val h = Harness()
        h.recognizer.start()
        h.recognizer.onPartialText("Send it today")
        h.recognizer.onEngineError(SpeechRecognizer.ERROR_SPEECH_TIMEOUT)

        assertEquals(listOf("partial", "final"), h.types())
        assertEquals("Send it today", h.last().getString("text"))
    }

    @Test
    fun `cancel emits nothing at all and silences late callbacks`() {
        // Contract: cancel throws the words away, so whatever the user had typed
        // before is left exactly as it was — no final, no error.
        val h = Harness()
        h.recognizer.start()
        h.recognizer.onPartialText("Send it today")
        h.events.clear()

        h.recognizer.cancel()
        // Android can still deliver these a moment after cancel.
        h.recognizer.onPartialText("Send it today.")
        h.recognizer.onFinalText("Send it today.")
        h.recognizer.onLevel(5f)
        h.recognizer.onEngineError(SpeechRecognizer.ERROR_CLIENT)

        assertEquals(1, h.engine.cancels)
        assertEquals(emptyList<String>(), h.types())
    }

    @Test
    fun `events before the microphone is open are ignored`() {
        val h = Harness()
        h.recognizer.onPartialText("stray")
        h.recognizer.onFinalText("stray")
        h.recognizer.onLevel(5f)

        assertEquals(emptyList<String>(), h.types())
        assertEquals(0, h.engine.starts)
    }

    @Test
    fun `a second turn starts clean`() {
        val h = Harness()
        h.recognizer.start()
        h.recognizer.onPartialText("first turn")
        h.recognizer.onFinalText("first turn.")
        h.events.clear()

        h.recognizer.start()
        h.recognizer.onEngineError(SpeechRecognizer.ERROR_NO_MATCH)

        assertEquals(2, h.engine.starts)
        // Empty, not "first turn." — the previous turn's words must not leak in.
        assertEquals("", h.only().getString("text"))
    }

    // ── The phone stops answering (review finding F2) ──────────────────────

    @Test
    fun `a recogniser that never answers still ends the turn`() {
        // WHY this matters to a person: the chat box shows "Finishing…" and
        // disables the mic button until one final event arrives, and on a phone
        // that event can only ever come from Android calling us back. If Android
        // goes quiet the box used to sit there forever, with typing the only way
        // out. Now the wait has an end, and whatever was already heard is kept.
        val h = Harness()
        h.recognizer.start()
        h.recognizer.onPartialText("book the table")
        h.events.clear()
        h.recognizer.stop()
        assertTrue("stop must start the clock", h.deadline.armed)
        assertEquals(VoiceRecognizer.STOP_DEADLINE_MS, h.deadline.armedFor)

        h.deadline.fire()

        assertEquals(listOf("final", "error"), h.types())
        assertEquals("book the table", h.events[0].getString("text"))
        assertEquals(VoiceRecognizer.STOP_TIMEOUT_SENTENCE, h.events[1].getString("message"))
    }

    @Test
    fun `a phone that answers in time is never cut off`() {
        val h = Harness()
        h.recognizer.start()
        h.recognizer.stop()
        h.recognizer.onFinalText("on my way")
        assertTrue("the answer must stop the clock", !h.deadline.armed)

        // Even if the clock somehow fired late, there is exactly one final.
        h.deadline.fire()
        assertEquals(listOf("final"), h.types())
    }

    @Test
    fun `cancelling stops the clock so a cancelled turn stays silent`() {
        val h = Harness()
        h.recognizer.start()
        h.recognizer.stop()
        h.recognizer.cancel()
        assertTrue(!h.deadline.armed)
        h.deadline.fire()
        assertEquals(emptyList<String>(), h.types())
    }
}
