package com.youcoded.app.runtime

import com.youcoded.app.bridge.MessageRouter
import org.json.JSONObject

/**
 * Specialists plans (Task 6, design §5) on the phone.
 *
 * Plans run in YouCoded's own assistant runtime, which lives on the computer;
 * this app has none yet. So each of the eight plan requests gets a typed
 * refusal: `{ok:false, unsupported:true, error}`.
 *
 * WHY a typed refusal rather than the usual not-implemented answer: the shared
 * React UI resolves this answer for plan channels (remote-shim.ts
 * RESOLVE_UNSUPPORTED) and reads it as "this device can't run plans" — the
 * plan card's buttons are disabled from the start and Settings hides its Plans
 * section. A plain `{ok:false}` would leave the buttons clickable and only
 * refuse after a tap. The error text is shown on the card as-is.
 *
 * `plans:event` (the push) is outbound-only and needs no entry here.
 */
object PlansBridge {
    val CHANNELS: Set<String> = setOf(
        "plans:approve",
        "plans:comment",
        "plans:add-budget",
        "plans:resume",
        "plans:stop",
        // Task 11 (pause handoff §6): the paused card's "Ask the assistant".
        "plans:ask-assistant",
        "plans:get-auto-approve",
        "plans:set-auto-approve",
    )

    // Worded like the shim's own phone notices ("… isn't available on the phone yet.").
    private const val REASON = "Plans aren't available on the phone yet."

    /** A fresh object per reply, so one response can never leak into the next. */
    fun unsupportedResponse(): JSONObject = MessageRouter.buildUnsupportedResponse(REASON)
}
