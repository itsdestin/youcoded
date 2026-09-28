package com.youcoded.app.runtime

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** An install that already has the PermissionRequest hook must still receive a
 *  changed timeout on the next launch — the old code only appended when the
 *  entry was missing, so every existing install kept `timeout: 300` while the
 *  relay asset (redeployed every launch) moved to 2h30m: Claude Code would kill
 *  the hook with no decision first and AskUserQuestion would wedge for good. */
class BootstrapHooksTest {

    private fun existingHooks(timeout: Int): JSONObject {
        val h = JSONObject().put("type", "command")
            .put("command", "node /old/path/hook-relay-blocking.js").put("timeout", timeout)
        val entry = JSONObject().put("matcher", ".*").put("hooks", JSONArray().put(h))
        return JSONObject().put("PermissionRequest", JSONArray().put(entry))
    }

    @Test
    fun `overwrites timeout and command on an existing entry`() {
        val hooksObj = existingHooks(300)
        Bootstrap.ensurePermissionRequestHook(hooksObj, "node /new/path/hook-relay-blocking.js", 10800)
        val h = hooksObj.getJSONArray("PermissionRequest").getJSONObject(0).getJSONArray("hooks").getJSONObject(0)
        assertEquals(10800, h.getInt("timeout"))
        assertEquals("node /new/path/hook-relay-blocking.js", h.getString("command"))
    }

    @Test
    fun `appends an entry when none exists`() {
        val hooksObj = JSONObject()
        Bootstrap.ensurePermissionRequestHook(hooksObj, "node /p/hook-relay-blocking.js", 10800)
        val arr = hooksObj.getJSONArray("PermissionRequest")
        assertEquals(1, arr.length())
        val h = arr.getJSONObject(0).getJSONArray("hooks").getJSONObject(0)
        assertEquals(10800, h.getInt("timeout"))
        assertEquals("command", h.getString("type"))
    }

    @Test
    fun `does not duplicate on repeat launches`() {
        val hooksObj = existingHooks(300)
        Bootstrap.ensurePermissionRequestHook(hooksObj, "node /p/hook-relay-blocking.js", 10800)
        Bootstrap.ensurePermissionRequestHook(hooksObj, "node /p/hook-relay-blocking.js", 10800)
        assertEquals(1, hooksObj.getJSONArray("PermissionRequest").length())
    }

    @Test
    fun `the shipped timeout is the 3h tier`() {
        assertEquals(10800, Bootstrap.PERMISSION_HOOK_TIMEOUT_SECONDS)
    }
}
