package com.youcoded.app.parser

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Must mirror desktop's `cwdToProjectSlug` in transcript-watcher.ts. Any drift
 * here means the Android transcript watcher points at a non-existent directory
 * and chat view stays empty for the whole session.
 */
class CwdToProjectSlugTest {

    @Test
    fun `encodes a Windows path without spaces`() {
        assertEquals(
            "C--Users-alice-repo",
            TranscriptWatcher.cwdToProjectSlug("C:\\Users\\alice\\repo"),
        )
    }

    @Test
    fun `encodes a POSIX path without spaces`() {
        assertEquals(
            "-home-alice-repo",
            TranscriptWatcher.cwdToProjectSlug("/home/alice/repo"),
        )
    }

    // Regression: CC itself encodes spaces as dashes, so folders like
    // "PAF 540 Final Data Project" must resolve to "PAF-540-Final-Data-Project".
    @Test
    fun `encodes spaces as dashes to match CC on Windows`() {
        assertEquals(
            "C--Users-desti-PAF-540-Final-Data-Project",
            TranscriptWatcher.cwdToProjectSlug("C:\\Users\\desti\\PAF 540 Final Data Project"),
        )
    }

    @Test
    fun `encodes spaces as dashes to match CC on POSIX`() {
        assertEquals(
            "-home-alice-My-Project",
            TranscriptWatcher.cwdToProjectSlug("/home/alice/My Project"),
        )
    }
}
