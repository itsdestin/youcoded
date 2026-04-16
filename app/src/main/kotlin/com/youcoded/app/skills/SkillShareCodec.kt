package com.youcoded.app.skills

import android.util.Base64
import org.json.JSONObject

object SkillShareCodec {
    fun encode(payload: JSONObject): String {
        val json = payload.toString()
        val encoded = Base64.encodeToString(json.toByteArray(), Base64.URL_SAFE or Base64.NO_WRAP)
        val type = if (payload.optString("type") == "plugin") "plugin" else "skill"
        return "youcoded://$type/$encoded"
    }

    fun decode(url: String): JSONObject? {
        val match = Regex("^youcoded://(skill|plugin)/(.+)$").find(url) ?: return null
        return try {
            val json = String(Base64.decode(match.groupValues[2], Base64.URL_SAFE or Base64.NO_WRAP))
            JSONObject(json)
        } catch (_: Exception) {
            null
        }
    }
}
