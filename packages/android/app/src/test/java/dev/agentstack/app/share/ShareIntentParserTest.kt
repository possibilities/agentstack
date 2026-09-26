package dev.agentstack.app.share

import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.json.JSONObject
import org.junit.Test

/**
 * Covers the client half of the share contract: deciding whether an
 * ACTION_SEND payload travels as a locator or as text.
 *
 * URL recovery from prose is deliberately NOT tested here, because the app does
 * not do it — the server owns that (see extractFirstUrl in src/share.ts and its
 * coverage in test/share.test.ts). These cases pin the handoff instead.
 */
class ShareIntentParserTest {

    @Test
    fun `bare url from Chrome becomes a url payload with the page title`() {
        val payload = ShareIntentParser.parse(
            "https://example.com/article",
            "Example article",
        )
        assertEquals("https://example.com/article", payload?.url)
        assertEquals("Example article", payload?.title)
        assertNull(payload?.text)
    }

    @Test
    fun `prose containing a url travels as text for server side extraction`() {
        val payload = ShareIntentParser.parse(
            "great read https://example.com/deep-dive worth your time",
            null,
        )
        assertNull(payload?.url)
        assertEquals(
            "great read https://example.com/deep-dive worth your time",
            payload?.text,
        )
    }

    @Test
    fun `surrounding whitespace is trimmed before classification`() {
        val payload = ShareIntentParser.parse("  https://example.com/x  ", null)
        assertEquals("https://example.com/x", payload?.url)
    }

    @Test
    fun `a subject identical to the shared text is not sent as a title`() {
        val payload = ShareIntentParser.parse(
            "https://example.com/x",
            "https://example.com/x",
        )
        assertEquals("https://example.com/x", payload?.url)
        assertNull(payload?.title)
    }

    @Test
    fun `subject only shares still produce a payload`() {
        val payload = ShareIntentParser.parse(null, "A note with no body")
        assertEquals("A note with no body", payload?.text)
    }

    @Test
    fun `subject only share of a bare url becomes a url payload`() {
        val payload = ShareIntentParser.parse("", "https://example.com/only")
        assertEquals("https://example.com/only", payload?.url)
    }

    @Test
    fun `empty payloads are rejected rather than queued`() {
        assertNull(ShareIntentParser.parse(null, null))
        assertNull(ShareIntentParser.parse("   ", "  "))
    }

    @Test
    fun `non http schemes are not treated as locators`() {
        val payload = ShareIntentParser.parse("ftp://example.com/file", null)
        assertNull(payload?.url)
        assertEquals("ftp://example.com/file", payload?.text)
    }

    @Test
    fun `a scheme with no host is not treated as a locator`() {
        val payload = ShareIntentParser.parse("https://", null)
        assertNull(payload?.url)
        assertEquals("https://", payload?.text)
    }

    // Asserted by decoding rather than by matching the serialized text. Android
    // bundles an old AOSP org.json that escapes forward slashes as \/, while the
    // org.json artifact these JVM tests run against no longer does, so a string
    // match here tests which library the test happened to link, not the wire
    // contract. Both encodings decode to the same field values, and the field
    // values are what the server reads.
    @Test
    fun `json payload carries the contract version and client identity`() {
        val json = JSONObject(
            SharePayload(url = "https://example.com/x", title = "T").toJson(),
        )
        assertEquals(SharePayload.SHARE_VERSION, json.getInt("version"))
        assertEquals(SharePayload.SHARE_CLIENT, json.getString("client"))
        assertEquals("https://example.com/x", json.getString("url"))
        assertEquals("T", json.getString("title"))
        assertEquals(0, json.getJSONArray("tags").length())
    }
}
