package com.youcoded.app.runtime

import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TerminalOutput
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

// Minimal stub that satisfies TerminalSessionClient for constructing TerminalEmulator in tests.
// All callbacks are no-ops — we only care about the RawByteListener interface.
private val NULL_CLIENT = object : TerminalSessionClient {
    override fun onTextChanged(changedSession: TerminalSession?) {}
    override fun onTitleChanged(changedSession: TerminalSession?) {}
    override fun onSessionFinished(finishedSession: TerminalSession?) {}
    override fun onCopyTextToClipboard(session: TerminalSession?, text: String?) {}
    override fun onPasteTextFromClipboard(session: TerminalSession?) {}
    override fun onBell(session: TerminalSession?) {}
    override fun onColorsChanged(session: TerminalSession?) {}
    override fun onTerminalCursorStateChange(state: Boolean) {}
    override fun getTerminalCursorStyle(): Int? = null
    override fun logError(tag: String?, message: String?) {}
    override fun logWarn(tag: String?, message: String?) {}
    override fun logInfo(tag: String?, message: String?) {}
    override fun logDebug(tag: String?, message: String?) {}
    override fun logVerbose(tag: String?, message: String?) {}
    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {}
    override fun logStackTrace(tag: String?, e: Exception?) {}
}

class RawByteListenerTest {

    // Minimal TerminalOutput stub — only the abstract methods from TerminalOutput.java are needed.
    // Actual method names confirmed from vendored source:
    //   write(byte[], int, int), titleChanged(String, String), onCopyTextToClipboard(String),
    //   onPasteTextFromClipboard(), onBell(), onColorsChanged()
    private fun makeOutput() = object : TerminalOutput() {
        override fun write(data: ByteArray?, offset: Int, count: Int) {}
        override fun titleChanged(oldTitle: String?, newTitle: String?) {}
        override fun onCopyTextToClipboard(text: String?) {}
        override fun onPasteTextFromClipboard() {}
        override fun onBell() {}
        override fun onColorsChanged() {}
    }

    @Test
    fun `listener receives exact bytes before parsing`() {
        // TerminalEmulator constructor signature (confirmed from vendored source):
        //   TerminalEmulator(TerminalOutput session, int columns, int rows, Integer transcriptRows, TerminalSessionClient client)
        val emulator = TerminalEmulator(makeOutput(), 80, 24, 1000, NULL_CLIENT)

        val captured = mutableListOf<ByteArray>()
        val listener = TerminalEmulator.RawByteListener { buffer, length ->
            // Copy the slice — the buffer may be reused across calls.
            captured.add(buffer.copyOfRange(0, length))
        }
        emulator.addRawByteListener(listener)

        val input = "hello[1m world[0m".toByteArray()
        emulator.append(input, input.size)

        assertEquals(1, captured.size)
        assertArrayEquals(input, captured[0])
    }

    @Test
    fun `listener can be removed`() {
        val emulator = TerminalEmulator(makeOutput(), 80, 24, 1000, NULL_CLIENT)

        var callCount = 0
        val listener = TerminalEmulator.RawByteListener { _, _ -> callCount++ }
        emulator.addRawByteListener(listener)

        emulator.append("first".toByteArray(), 5)
        assertEquals(1, callCount)

        emulator.removeRawByteListener(listener)
        emulator.append("second".toByteArray(), 6)
        assertEquals(1, callCount)  // Still 1 — removed listener should not fire.
    }
}
