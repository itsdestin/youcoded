package com.youcoded.app.ui

import com.youcoded.app.ui.TailscaleProbe.Held
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pins what counts as "Tailscale is on" for the Connect to Desktop screen (Destin, 2026-11-10). */
class TailscaleProbeTest {
    @Test fun `a VPN connection with a Tailscale address is on`() {
        // Destin's Flip with Tailscale on, as the phone reported it.
        assertTrue(TailscaleProbe.looksOn(listOf(Held("wlan0", "192.168.4.22"), Held("tun0", "100.94.136.23"))))
        assertTrue(TailscaleProbe.looksOn(listOf(Held("tun1", "100.64.0.1"))))
    }

    @Test fun `Tailscale's own IPv6 range counts on any connection`() {
        assertTrue(TailscaleProbe.looksOn(listOf(Held("tun0", "fd7a:115c:a1e0::9e01:8817%tun0"))))
        assertTrue(TailscaleProbe.looksOn(listOf(Held("anything", "FD7A:115C:A1E0:ab12::1"))))
    }

    @Test fun `no VPN is off`() {
        assertFalse(TailscaleProbe.looksOn(emptyList()))
        assertFalse(TailscaleProbe.looksOn(listOf(Held("wlan0", "192.168.4.22"), Held("lo", "127.0.0.1"), Held("wlan0", "fe80::1%wlan0"))))
    }

    @Test fun `a mobile carrier using the same range is not mistaken for Tailscale`() {
        assertFalse(TailscaleProbe.looksOn(listOf(Held("rmnet_data2", "100.72.14.9"))))
    }

    @Test fun `another VPN is not Tailscale`() {
        assertFalse(TailscaleProbe.looksOn(listOf(Held("tun0", "10.8.0.2"), Held("tun0", "fd00::2"))))
        assertFalse(TailscaleProbe.looksOn(listOf(Held("tun0", "100.63.255.255"), Held("tun0", "100.128.0.1"), Held("tun0", "not-an-address"))))
    }
}
