package dev.agentstack.app

import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import org.junit.Test

class SettingsOriginTest {
    @Test
    fun `only strict HTTPS origins are accepted`() {
        assertEquals("https://example.com", Settings.normalizeServerUrl(" https://example.com/ "))
        assertEquals("https://example.com", Settings.normalizeServerUrl("HTTPS://EXAMPLE.COM:443/"))
        for (origin in listOf("http://example.com", "https://example.com/path", "https://user@example.com", "https://example.com?q=1", "https://example.com#fragment")) {
            assertFailsWith<IllegalArgumentException> { Settings.normalizeServerUrl(origin) }
        }
    }
}
