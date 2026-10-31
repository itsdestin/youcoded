package com.youcoded.app.ui

/**
 * Which hosts the app may reach WITHOUT encryption (http:// and ws://).
 *
 * WHY (2026-10-30 security audit A1, Destin: "Tailscale only"): plain connections used to be allowed to every address, so the
 * pairing password and conversations could cross a shared Wi-Fi in the open. Tailscale already encrypts everything between the two
 * devices, so plain traffic is acceptable ONLY to the phone itself (its own backend) and to Tailscale addresses
 * (100.64.0.0/10, fd7a:115c:a1e0::/48, *.ts.net). Android's network-security-config cannot name an address range, so the rule lives here
 * in code. Same rule as desktop/src/shared/cleartext-hosts.ts (the page checks before it dials; this guards saving a computer,
 * download links and the WebView's own requests). Pure Kotlin, no android.* — unit tested (CleartextPolicyTest).
 *
 * This copy is deliberately a little stricter than the page's: it does no address normalisation, so odd spellings such as
 * "0x64.0x40.1.1" are refused rather than interpreted.
 */
object CleartextPolicy {
    private val IPV4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")
    private val TS_NAME = Regex("^[a-z0-9-]+(\\.[a-z0-9-]+)*\\.ts\\.net$")
    private val HEX_GROUP = Regex("^[0-9a-f]{1,4}$")

    fun isAllowedHost(raw: String?): Boolean {
        var host = (raw ?: return false).trim().lowercase()
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length - 1)
        if (host.endsWith(".")) host = host.dropLast(1)
        if (host.isEmpty()) return false
        if (host == "localhost" || host == "::1") return true
        IPV4.matchEntire(host)?.let { m ->
            val o = m.groupValues.drop(1).map { it.toInt() }
            if (o.any { it > 255 }) return false
            return o[0] == 127 || (o[0] == 100 && o[1] in 64..127)
        }
        if (host.contains(':')) return isTailscaleV6(host)
        return TS_NAME.matches(host)
    }

    private fun isTailscaleV6(host: String): Boolean {
        if (!host.all { it in '0'..'9' || it in 'a'..'f' || it == ':' }) return false
        val halves = host.split("::")
        if (halves.size > 2) return false
        val left = if (halves[0].isEmpty()) emptyList() else halves[0].split(":")
        val right = if (halves.size == 2 && halves[1].isNotEmpty()) halves[1].split(":") else emptyList()
        val groups = if (halves.size == 2) {
            val fill = 8 - left.size - right.size
            if (fill < 0) return false
            left + List(fill) { "0" } + right
        } else left
        if (groups.size != 8 || groups.any { !HEX_GROUP.matches(it) }) return false
        return groups[0].toInt(16) == 0xfd7a && groups[1].toInt(16) == 0x115c && groups[2].toInt(16) == 0xa1e0
    }

    /** An address with this scheme and host: encrypted ones always pass; plain http/ws only to an allowed host. */
    fun isAllowed(scheme: String?, host: String?): Boolean = when (scheme?.lowercase()) {
        "https", "wss" -> true
        "http", "ws" -> isAllowedHost(host)
        else -> true // not a network scheme (data:, blob:, theme-asset:); other rules handle those
    }

    /** What the person sees when a computer is refused. Same words as the page's TAILSCALE_ONLY_MESSAGE. */
    const val MESSAGE =
        "YouCoded only connects to your computer over Tailscale, and this address isn’t one. Turn on Tailscale on both devices and add the computer again using its Tailscale address."
}
