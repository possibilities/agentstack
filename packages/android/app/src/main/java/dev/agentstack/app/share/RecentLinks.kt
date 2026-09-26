package dev.agentstack.app.share

import android.content.Context
import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** One link retained locally so its reminder can be revisited or removed. */
data class RecentLink(
    val id: String,
    val url: String,
    val title: String?,
    val createdAt: Long,
)

/** The retained link and any older entries displaced by the bounded history. */
data class RecentLinkChange(
    val added: RecentLink,
    val evicted: List<RecentLink>,
)

/** App-private, bounded recent-link history. This is not the ingestion ledger. */
class RecentLinks(private val file: File) {

    fun entries(): List<RecentLink> = synchronized(FILE_LOCK) { read() }

    fun add(
        url: String,
        title: String?,
        now: Long = System.currentTimeMillis(),
        id: String = UUID.randomUUID().toString(),
    ): RecentLinkChange {
        require(isHttpUrl(url)) { "Recent links must use http(s)." }
        val entry = RecentLink(
            id = id,
            url = url,
            title = title?.trim()?.takeIf { it.isNotEmpty() },
            createdAt = now,
        )
        return synchronized(FILE_LOCK) {
            val grown = listOf(entry) + read().filterNot { it.id == id }
            val kept = grown.take(MAX_ENTRIES)
            val evicted = grown.drop(MAX_ENTRIES)
            write(kept)
            RecentLinkChange(entry, evicted)
        }
    }

    fun remove(id: String): RecentLink? = synchronized(FILE_LOCK) {
        val entries = read()
        val removed = entries.find { it.id == id } ?: return@synchronized null
        write(entries.filterNot { it.id == id })
        removed
    }

    fun clear(): List<RecentLink> = synchronized(FILE_LOCK) {
        val entries = read()
        write(emptyList())
        entries
    }

    private fun read(): List<RecentLink> {
        if (!file.exists()) return emptyList()
        val array = try {
            JSONObject(file.readText()).optJSONArray("entries")
        } catch (_: Exception) {
            return emptyList()
        } ?: return emptyList()

        return (0 until array.length()).mapNotNull { index ->
            try {
                val item = array.getJSONObject(index)
                val url = item.getString("url")
                if (!isHttpUrl(url)) return@mapNotNull null
                RecentLink(
                    id = item.getString("id"),
                    url = url,
                    title = item.optString("title").takeIf { it.isNotEmpty() },
                    createdAt = item.getLong("created_at"),
                )
            } catch (_: Exception) {
                null
            }
        }
    }

    private fun write(entries: List<RecentLink>) {
        val root = JSONObject().put(
            "entries",
            JSONArray().also { array ->
                for (entry in entries) {
                    array.put(
                        JSONObject()
                            .put("id", entry.id)
                            .put("url", entry.url)
                            .putOpt("title", entry.title)
                            .put("created_at", entry.createdAt),
                    )
                }
            },
        )
        writeAtomically(file, root.toString())
    }

    companion object {
        const val MAX_ENTRIES = 20

        private val FILE_LOCK = Any()

        private fun isHttpUrl(url: String): Boolean =
            url.startsWith("https://", ignoreCase = true) ||
                url.startsWith("http://", ignoreCase = true)

        fun at(context: Context): RecentLinks =
            RecentLinks(File(context.filesDir, "agentstack.app.share.recent-links.v1.json"))
    }
}
