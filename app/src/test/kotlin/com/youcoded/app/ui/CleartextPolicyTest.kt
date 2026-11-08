package com.youcoded.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pins "plain connections only to the phone itself or Tailscale" (2026-10-30 audit A1). Same cases as desktop/tests/cleartext-hosts.test.ts. */
class CleartextPolicyTest {
    @Test fun `the phone itself and Tailscale are allowed`() {
        for (h in listOf("localhost", "127.0.0.1", "127.8.8.8", "[::1]", "100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1",
            "fd7a:115c:a1e0:ab12:4843:cd96:6200:1", "my-pc.tail1234.ts.net", "MY-PC.TS.NET.")) {
            assertTrue(h, CleartextPolicy.isAllowedHost(h))
        }
    }

    @Test fun `every other address is refused`() {
        for (h in listOf("192.168.1.20", "10.0.0.5", "172.16.0.1", "100.63.255.255", "100.128.0.1", "8.8.8.8", "example.com", "ts.net",
            "evil-ts.net", "a.ts.net.evil.com", "fd7a:115c:a1e1::1", "fe80::1", "999.1.1.1", "", "host name.ts.net", "0::1",
            "0x64.0x40.1.1", "3232235777", "100.64.1.2@192.168.1.2")) {
            assertFalse(h, CleartextPolicy.isAllowedHost(h))
        }
        assertFalse(CleartextPolicy.isAllowedHost(null))
    }

    @Test fun `encrypted addresses always pass and plain ones need an allowed host`() {
        assertTrue(CleartextPolicy.isAllowed("https", "example.com"))
        assertTrue(CleartextPolicy.isAllowed("wss", "example.com"))
        assertTrue(CleartextPolicy.isAllowed("theme-asset", "midnight"))
        assertTrue(CleartextPolicy.isAllowed("http", "100.64.0.9"))
        assertFalse(CleartextPolicy.isAllowed("http", "192.168.1.5"))
        assertFalse(CleartextPolicy.isAllowed("HTTP", "example.com"))
        assertFalse(CleartextPolicy.isAllowed("ws", null))
        assertEquals(true, CleartextPolicy.MESSAGE.contains("Tailscale"))
    }
}
