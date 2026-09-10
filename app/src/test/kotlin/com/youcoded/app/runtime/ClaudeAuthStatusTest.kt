package com.youcoded.app.runtime

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The Kotlin half of the `claude-code:status` channel.
 *
 * These cases are the SAME decision table as desktop's
 * `desktop/tests/claude-account.test.ts` — the two implementations feed one
 * shared React model menu, so a disagreement between them shows up as a phone
 * greying out models the desktop happily runs. Change one, change both.
 */
class ClaudeAuthStatusTest {

    /** Real output from a signed-in Max account, 2026-09-09 (email replaced). */
    private val signedInMax = """
        {"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",
         "email":"someone@example.com","orgName":"Org","subscriptionType":"max"}
    """.trimIndent()

    @Test fun `a signed-in account reports its email and plan`() {
        val out = JSONObject(DevTools.claudeAuthStatusJson(signedInMax))
        assertEquals("signed-in", out.getString("state"))
        assertEquals("someone@example.com", out.getString("email"))
        assertEquals("max", out.getString("plan"))
        assertEquals(false, out.getBoolean("apiKey"))
    }

    @Test fun `loggedIn false is a definite signed-out`() {
        // The CLI exits 0 here — only this field says anything.
        assertEquals(
            "signed-out",
            JSONObject(DevTools.claudeAuthStatusJson("""{"loggedIn":false}""")).getString("state"),
        )
    }

    @Test fun `an API-key login is signed in with no plan to promise`() {
        val out = JSONObject(
            DevTools.claudeAuthStatusJson("""{"loggedIn":true,"authMethod":"apiKey","subscriptionType":"max"}"""),
        )
        assertEquals("signed-in", out.getString("state"))
        assertEquals(true, out.getBoolean("apiKey"))
        // A per-token login has no plan windows — the card must not draw them.
        assertEquals(false, out.has("plan"))
    }

    @Test fun `unparsable output is unknown, never signed-out`() {
        // The whole point: a CLI that changed its output, or a shell profile
        // printing a banner, must not grey out a working install.
        assertEquals(
            "unknown",
            JSONObject(DevTools.claudeAuthStatusJson("claude: a banner\n{")).getString("state"),
        )
        assertEquals(
            "unknown",
            JSONObject(DevTools.claudeAuthStatusJson("")).getString("state"),
        )
    }
}
