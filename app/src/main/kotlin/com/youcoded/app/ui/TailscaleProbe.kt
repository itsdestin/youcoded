package com.youcoded.app.ui

import java.net.NetworkInterface

/**
 * Whether Tailscale is switched on on this phone, read from the phone's own network connections.
 *
 * WHY (Destin, 2026-11-10: the "Tailscale not connected" warning "still lets me click desktop to connect" and showed with
 * Tailscale on): the Connect to Desktop screen used to ask the backend, which looks for the `tailscale` program a computer
 * has. That program does not exist inside the Android app, so the answer was always "not connected". A phone with Tailscale
 * on has a VPN connection carrying a Tailscale address, and that can be read without any permission.
 *
 * The rule, deliberately narrow so a mobile carrier is not mistaken for Tailscale (carriers hand out the same 100.64.x.x
 * range on the mobile-data connection): Tailscale's own IPv6 range on any connection, or a 100.64.0.0/10 address on a VPN
 * connection (Android names those tun0, tun1, …). Pure Kotlin apart from [isOn]; unit tested (TailscaleProbeTest).
 */
object TailscaleProbe {
    /** One address the phone holds: the connection's name ("tun0", "wlan0", "rmnet1") and the address as text. */
    data class Held(val connection: String, val address: String)

    fun looksOn(held: List<Held>): Boolean = held.any { h ->
        // "fe80::1%wlan0" → "fe80::1": Java appends the connection name to some IPv6 addresses.
        val address = h.address.substringBefore('%').lowercase()
        if (address.contains(':')) address.startsWith("fd7a:115c:a1e0:")
        else h.connection.startsWith("tun") && isCarrierGradeRange(address)
    }

    private fun isCarrierGradeRange(v4: String): Boolean {
        val parts = v4.split('.').map { it.toIntOrNull() ?: return false }
        return parts.size == 4 && parts[0] == 100 && parts[1] in 64..127
    }

    /** null: the phone would not say (the screen then shows no warning rather than a guess). */
    fun isOn(): Boolean? = runCatching {
        val held = mutableListOf<Held>()
        for (nic in NetworkInterface.getNetworkInterfaces() ?: return null) {
            if (!nic.isUp) continue
            for (a in nic.inetAddresses) held += Held(nic.name, a.hostAddress ?: continue)
        }
        looksOn(held)
    }.getOrNull()
}
