package dev.agentstack.app.share

import android.content.Context
import dev.agentstack.app.Settings
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.file.Files
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/** One share the ingress has not accepted yet. */
data class OutboxEntry(
    val id: String,
    val payload: SharePayload,
    val createdAt: Long,
    val attempts: Int = 0,
    val nextAttemptAt: Long,
    val lastCode: String? = null,
    val lastMessage: String? = null,
    val destination: String? = null,
)

/** Why a held share was given up on. Every drop is recorded, never silent. */
enum class DropReason { EXPIRED, OVERFLOW, REJECTED, DISCARDED }

/** No read or mutation may treat unreadable durable intent as an empty outbox. */
class OutboxReadException(val fileName: String, cause: Exception) : IOException(
    "Share outbox could not be read. Delivery is paused; preserve and repair $fileName before retrying.",
    cause,
)

/** A share that will not be delivered, kept so the app can say what was lost. */
data class DroppedShare(
    val describes: String,
    val reason: DropReason,
    val detail: String?,
    val at: Long,
)

/** What one delivery round did. */
data class FlushSummary(
    val attempted: Int = 0,
    val delivered: Int = 0,
    val duplicate: Int = 0,
    val dropped: List<DroppedShare> = emptyList(),
    val pending: Int = 0,
    val offline: Boolean = false,
    val otherDestination: Int = 0,
)

/**
 * Durable hold for shares the ingress has not accepted.
 *
 * A share the server never received is not a failed share: it is one that has
 * not been delivered yet. Entries outlive the share Activity, the process, and
 * a reboot, and are redelivered until the ingress admits them or classifies
 * them as unsendable.
 *
 * The outbox holds intent only. It is not a queue in the AgentStack sense: no
 * job exists until Admission creates one, so nothing here may be reported to
 * the user as saved. Redelivery needs no client idempotency key because the
 * ingress derives one from the intent, so a share delivered twice comes back as
 * `duplicate` naming the same job. See docs/brain-share-contract.md.
 *
 * Plain app-private storage rather than [Settings]'s encrypted preferences:
 * this holds what the user chose to publish to their own index, not a
 * credential. The token stays encrypted and is never written here.
 *
 * Takes a [File] rather than a Context so the delivery policy is unit testable
 * on the JVM.
 */
class ShareOutbox(private val file: File) {

    // Activities and WorkManager open separate instances for the same file.
    private val lock = FILE_LOCK

    fun pending(): Int = synchronized(lock) { read().first.size }

    fun entries(): List<OutboxEntry> = synchronized(lock) { read().first }

    fun dropped(): List<DroppedShare> = synchronized(lock) { read().second }

    /**
     * Holds one payload, evicting the oldest if the cap is reached: the newest
     * share is always kept, because it is the one the user just asked for.
     */
    fun enqueue(payload: SharePayload, now: Long = System.currentTimeMillis(), destination: String? = null): OutboxEntry {
        val entry = OutboxEntry(
            id = UUID.randomUUID().toString(),
            payload = payload,
            createdAt = now,
            nextAttemptAt = now + backoffMs(1),
            destination = destination,
        )
        synchronized(lock) {
            val (entries, dropped) = read()
            val grown = entries + entry
            val overflow = (grown.size - MAX_ENTRIES).coerceAtLeast(0)
            val evicted = grown.take(overflow).map {
                DroppedShare(describe(it.payload), DropReason.OVERFLOW, null, now)
            }
            write(grown.drop(overflow), evicted + dropped)
        }
        return entry
    }

    fun remove(id: String) = synchronized(lock) {
        val (entries, dropped) = read()
        write(entries.filterNot { it.id == id }, dropped)
    }

    fun reject(id: String, result: ShareResult) = synchronized(lock) {
        val (entries, dropped) = read()
        val entry = entries.find { it.id == id } ?: return@synchronized
        val rejection = DroppedShare(describe(entry.payload), DropReason.REJECTED,
            (result as? ShareResult.Rejected)?.message, System.currentTimeMillis())
        write(entries.filterNot { it.id == id }, listOf(rejection) + dropped)
    }

    /** Reschedules one entry after a retryable failure. */
    fun defer(id: String, result: ShareResult, now: Long = System.currentTimeMillis()) =
        synchronized(lock) {
            val (entries, dropped) = read()
            write(entries.map { if (it.id == id) it.deferred(now, result) else it }, dropped)
        }

    fun clear(): Int = synchronized(lock) {
        val (entries, dropped) = read()
        val held = entries.map { DroppedShare(describe(it.payload), DropReason.DISCARDED, null, System.currentTimeMillis()) }
        write(emptyList(), held + dropped)
        entries.size
    }

    fun clearDropped() = synchronized(lock) { write(read().first, emptyList()) }

    /** When the next attempt is due, or null when nothing is held. */
    fun earliestAttempt(destination: String? = null): Long? = synchronized(lock) {
        read().first.filter { it.destination == null || it.destination == destination }.minOfOrNull { it.nextAttemptAt }
    }

    /**
     * Attempts delivery of every due entry through [send].
     *
     * The first unreachable server ends the round: the rest are deferred
     * unattempted rather than each paying its own connection timeout against a
     * host that is plainly down.
     *
     * The network calls happen outside the lock — a round can take a minute,
     * and a share arriving meanwhile must not block on it. The commit re-reads
     * and merges, so an entry enqueued mid-round survives.
     */
    fun flush(
        send: (SharePayload) -> ShareResult,
        now: Long = System.currentTimeMillis(),
        force: Boolean = false,
        destination: String? = null,
    ): FlushSummary = synchronized(FLUSH_LOCK) {
        val snapshot = synchronized(lock) {
            val (entries, dropped) = read()
            val bound = entries.map { if (it.destination == null) it.copy(destination = destination) else it }
            if (bound != entries) write(bound, dropped)
            bound
        }
        if (snapshot.isEmpty()) return@synchronized FlushSummary()

        var attempted = 0
        var delivered = 0
        var duplicate = 0
        var offline = false
        var otherDestination = 0
        val kept = mutableListOf<OutboxEntry>()
        val dropped = mutableListOf<DroppedShare>()

        for (entry in snapshot) {
            if (now - entry.createdAt > MAX_AGE_MS) {
                dropped += DroppedShare(describe(entry.payload), DropReason.EXPIRED, entry.lastMessage, now)
                continue
            }
            if (entry.destination != destination) {
                otherDestination += 1
                kept += entry
                continue
            }
            if (offline || (!force && entry.nextAttemptAt > now)) {
                kept += if (offline) entry.deferred(now, null) else entry
                continue
            }

            attempted += 1
            when (val result = send(entry.payload)) {
                is ShareResult.Queued -> delivered += 1
                is ShareResult.Indexed -> delivered += 1
                is ShareResult.Duplicate -> duplicate += 1
                is ShareResult.Unreachable -> {
                    offline = true
                    kept += entry.deferred(now, result)
                }
                is ShareResult.Rejected ->
                    if (isRetryable(result)) {
                        kept += entry.deferred(now, result)
                    } else {
                        dropped += DroppedShare(
                            describe(entry.payload),
                            DropReason.REJECTED,
                            result.message,
                            now,
                        )
                    }
            }
        }

        val pending = synchronized(lock) {
            val (current, priorDrops) = read()
            val processed = snapshot.map { it.id }.toSet()
            val arrived = current.filterNot { processed.contains(it.id) }
            val present = current.map { it.id }.toSet()
            val remaining = kept.filter { present.contains(it.id) } + arrived
            write(remaining, dropped + priorDrops)
            remaining.size
        }

        FlushSummary(attempted, delivered, duplicate, dropped, pending, offline, otherDestination)
    }

    private fun OutboxEntry.deferred(now: Long, result: ShareResult?): OutboxEntry {
        val next = attempts + 1
        return copy(
            attempts = next,
            nextAttemptAt = now + backoffMs(next),
            lastCode = (result as? ShareResult.Rejected)?.code
                ?: (result as? ShareResult.Unreachable)?.let { "unreachable" }
                ?: lastCode,
            lastMessage = when (result) {
                is ShareResult.Rejected -> result.message
                is ShareResult.Unreachable -> result.message
                else -> lastMessage
            },
        )
    }

    private fun read(): Pair<List<OutboxEntry>, List<DroppedShare>> {
        // notExists distinguishes a genuinely new store from an inaccessible path.
        if (Files.notExists(file.toPath())) return emptyList<OutboxEntry>() to emptyList()
        try {
            val text = Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(file.readBytes())).toString()
            val input = JSONTokener(text)
            val root = input.nextValue() as? JSONObject ?: error("Outbox root must be an object")
            require(input.nextClean() == '\u0000')
            val entries = root.getJSONArray("entries").toList { item ->
                val storedPayload = item.getJSONObject("payload")
                val payload = SharePayload(
                    url = storedPayload.optionalString("url"),
                    text = storedPayload.optionalString("text"),
                    title = storedPayload.optionalString("title"),
                )
                require((payload.url != null) xor (payload.text != null))
                require((payload.url ?: payload.text)!!.isNotBlank())
                val attempts = if (item.has("attempts")) item.nonnegativeLong("attempts") else 0L
                require(attempts <= Int.MAX_VALUE)
                val destination = item.optionalString("destination")
                require(destination == null || destination.isNotBlank())
                OutboxEntry(
                    id = item.requiredString("id"),
                    payload = payload,
                    createdAt = item.nonnegativeLong("created_at"),
                    attempts = attempts.toInt(),
                    nextAttemptAt = item.nonnegativeLong("next_attempt_at"),
                    lastCode = item.optionalString("last_code"),
                    lastMessage = item.optionalString("last_message"),
                    destination = destination,
                )
            }
            require(entries.map { it.id }.distinct().size == entries.size)
            val dropped = root.getJSONArray("dropped").toList { item ->
                DroppedShare(
                    describes = item.requiredString("describes"),
                    reason = DropReason.valueOf(item.requiredString("reason")),
                    detail = item.optionalString("detail"),
                    at = item.nonnegativeLong("at"),
                )
            }
            return entries to dropped
        } catch (error: Exception) {
            // Preserve the complete file, including malformed rows. Even clear()
            // must refuse: its caller cannot knowingly discard an unreadable list.
            throw OutboxReadException(file.name, error)
        }
    }

    private fun write(entries: List<OutboxEntry>, dropped: List<DroppedShare>) {
        val root = JSONObject()
        root.put(
            "entries",
            JSONArray().also { array ->
                for (entry in entries) {
                    array.put(
                        JSONObject()
                            .put("id", entry.id)
                            .put("payload", entry.payload.toStorageJson())
                            .put("created_at", entry.createdAt)
                            .put("attempts", entry.attempts)
                            .put("next_attempt_at", entry.nextAttemptAt)
                            .putOpt("last_code", entry.lastCode)
                            .putOpt("destination", entry.destination)
                            .putOpt("last_message", entry.lastMessage),
                    )
                }
            },
        )
        root.put(
            "dropped",
            JSONArray().also { array ->
                for (drop in dropped.take(MAX_DROPPED)) {
                    array.put(
                        JSONObject()
                            .put("describes", drop.describes)
                            .put("reason", drop.reason.name)
                            .putOpt("detail", drop.detail)
                            .put("at", drop.at),
                    )
                }
            },
        )
        writeAtomically(file, root.toString())
    }

    private fun <T> JSONArray.toList(build: (JSONObject) -> T): List<T> =
        (0 until length()).map { index -> build(getJSONObject(index)) }

    private fun JSONObject.optionalString(key: String): String? {
        if (!has(key) || isNull(key)) return null
        return get(key) as? String ?: error("Invalid outbox string field: $key")
    }

    private fun JSONObject.requiredString(key: String): String =
        optionalString(key)?.takeIf { it.isNotBlank() } ?: error("Missing outbox string field: $key")

    private fun JSONObject.nonnegativeLong(key: String): Long {
        val value = when (val raw = get(key)) {
            is Int -> raw.toLong()
            is Long -> raw
            else -> error("Invalid outbox integer field: $key")
        }
        require(value >= 0)
        return value
    }

    companion object {
        private val FILE_LOCK = Any()
        private val FLUSH_LOCK = Any()
        /** Beyond this the oldest held shares are dropped rather than grown without bound. */
        const val MAX_ENTRIES = 200

        /** A share nobody could deliver for a week is abandoned, with a record. */
        const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000

        /** How many abandoned shares are remembered so the app can name them. */
        const val MAX_DROPPED = 20

        private val BACKOFF_MS = longArrayOf(60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000)

        fun backoffMs(attempts: Int): Long =
            BACKOFF_MS[attempts.coerceIn(1, BACKOFF_MS.size) - 1]

        /**
         * Whether a failed share is worth sending again unchanged, per
         * share-ingest-v1: a connection failure or a server fault is safely
         * retryable, and a 4xx other than 401 means the payload itself is wrong
         * and never will be.
         *
         * 401 is retryable on purpose. A rejected token is a configuration
         * fault the user can repair, and discarding what they shared in the
         * meantime is the one outcome the outbox exists to prevent.
         */
        fun isRetryable(result: ShareResult): Boolean = when (result) {
            is ShareResult.Unreachable -> true
            is ShareResult.Rejected ->
                result.status >= 500 ||
                    result.status == 401 ||
                    result.status == 408 ||
                    result.status == 429
            else -> false
        }

        fun describe(payload: SharePayload): String =
            payload.url ?: payload.title ?: payload.text?.take(60) ?: "a share"

        fun at(context: Context): ShareOutbox =
            ShareOutbox(File(context.filesDir, "agentstack.app.share.outbox.v1.json"))
    }
}
