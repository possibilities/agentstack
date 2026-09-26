package dev.agentstack.app.share

import org.json.JSONArray
import org.json.JSONObject

/**
 * The wire payload for POST /v1/share.
 *
 * Exactly one of [url] or [text] is populated. When the shared payload is a
 * bare URL the app sends it as [url]; anything else goes over as [text] and the
 * server extracts a locator from it. The server, not this app, is the
 * authoritative ingestion point.
 *
 * See docs/brain-share-contract.md.
 */
data class SharePayload(
    val url: String? = null,
    val text: String? = null,
    val title: String? = null,
) {
    fun toJson(): String {
        val json = JSONObject()
        json.put("version", SHARE_VERSION)
        json.put("client", SHARE_CLIENT)
        url?.let { json.put("url", it) }
        text?.let { json.put("text", it) }
        title?.let { json.put("title", it) }
        json.put("tags", JSONArray())
        return json.toString()
    }

    /**
     * The payload as the outbox stores it: what the user shared, and nothing
     * about the wire. Version, client, and tags are re-derived at send time, so
     * a held share picks up the current contract rather than the one in force
     * when it was taken.
     */
    fun toStorageJson(): JSONObject = JSONObject()
        .putOpt("url", url)
        .putOpt("text", text)
        .putOpt("title", title)

    companion object {
        const val SHARE_VERSION = 1
        const val SHARE_CLIENT = "android-share"

        fun fromStorage(json: JSONObject): SharePayload = SharePayload(
            url = json.optString("url").takeIf { it.isNotEmpty() },
            text = json.optString("text").takeIf { it.isNotEmpty() },
            title = json.optString("title").takeIf { it.isNotEmpty() },
        )
    }
}

/**
 * Turns an ACTION_SEND payload into a share request.
 *
 * Pure logic with no Android dependencies so it can be unit tested on the JVM.
 * Apps are inconsistent about what they put in the extras: Chrome sends a bare
 * URL in EXTRA_TEXT with the page title in EXTRA_SUBJECT, while many social and
 * reader apps send prose that merely contains a URL. Both must work.
 */
object ShareIntentParser {

    /** Matches how the server validates a locator: http(s) with a hostname. */
    private val BARE_URL = Regex("^https?://[^\\s]+$", RegexOption.IGNORE_CASE)

    /**
     * @return a payload, or null when there is nothing shareable.
     */
    fun parse(extraText: String?, extraSubject: String?): SharePayload? {
        val text = extraText?.trim().orEmpty()
        val subject = extraSubject?.trim().orEmpty()

        if (text.isEmpty()) {
            // Some apps share only a subject line. Treat it as the payload
            // rather than dropping the share entirely.
            if (subject.isEmpty()) return null
            return if (isBareUrl(subject)) {
                SharePayload(url = subject)
            } else {
                SharePayload(text = subject)
            }
        }

        // A title equal to the URL adds nothing, and a blank one is omitted so
        // the server's own extracted title wins.
        val title = subject.takeIf { it.isNotEmpty() && it != text }

        return if (isBareUrl(text)) {
            SharePayload(url = text, title = title)
        } else {
            SharePayload(text = text, title = title)
        }
    }

    private fun isBareUrl(candidate: String): Boolean {
        if (!BARE_URL.matches(candidate)) return false
        // Reject a scheme with no host, e.g. "https://".
        val afterScheme = candidate.substringAfter("://")
        val host = afterScheme.substringBefore('/').substringBefore('?')
        return host.isNotEmpty() && !host.contains('@')
    }
}
