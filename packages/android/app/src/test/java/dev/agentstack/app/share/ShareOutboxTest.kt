package dev.agentstack.app.share

import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.assertContentEquals
import kotlin.test.assertFailsWith
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Before
import org.junit.After
import org.junit.Test

/**
 * The delivery policy for shares the ingress has not accepted.
 *
 * [ShareOutbox] takes a File rather than a Context precisely so this runs on
 * the JVM: the policy is what has to be right, and it needs no device.
 */
class ShareOutboxTest {

    private lateinit var file: File
    private lateinit var outbox: ShareOutbox

    private val now = 1_760_000_000_000L
    private val unreachable = ShareResult.Unreachable("Could not reach the server.")
    private val rejected = ShareResult.Rejected(400, "bad_source", "not a usable locator")
    private val unauthorized = ShareResult.Rejected(401, "unauthorized", "token rejected")
    private val queued = ShareResult.Queued(7)
    private val duplicate = ShareResult.Duplicate(7)

    private fun link(name: String) = SharePayload(url = "https://example.com/$name")

    @Before
    fun setUp() {
        file = Files.createTempDirectory("outbox").resolve("share-outbox.json").toFile()
        outbox = ShareOutbox(file)
    }

    @After
    fun cleanUp() { file.parentFile?.deleteRecursively() }

    @Test
    fun `a held share survives a new instance reading the same file`() {
        outbox.enqueue(link("a"), now)
        val reopened = ShareOutbox(file)
        assertEquals(1, reopened.pending())
        assertEquals("https://example.com/a", reopened.entries().first().payload.url)
    }

    @Test
    fun `the first retry is one backoff step away`() {
        val entry = outbox.enqueue(link("a"), now)
        assertEquals(0, entry.attempts)
        assertEquals(now + ShareOutbox.backoffMs(1), entry.nextAttemptAt)
    }

    @Test
    fun `the oldest share is evicted rather than growing without bound`() {
        for (index in 0..ShareOutbox.MAX_ENTRIES) {
            outbox.enqueue(link("$index"), now + index)
        }
        val entries = outbox.entries()
        assertEquals(ShareOutbox.MAX_ENTRIES, entries.size)
        assertEquals("https://example.com/1", entries.first().payload.url)
        // The eviction is recorded, not silent.
        assertEquals(DropReason.OVERFLOW, outbox.dropped().first().reason)
    }

    @Test
    fun `an admitted share is removed`() {
        outbox.enqueue(link("a"), now)
        val summary = outbox.flush({ queued }, now, force = true)
        assertEquals(1, summary.attempted)
        assertEquals(1, summary.delivered)
        assertEquals(0, summary.pending)
        assertEquals(0, outbox.pending())
    }

    @Test
    fun `a duplicate counts as delivered because the job already exists`() {
        outbox.enqueue(link("a"), now)
        val summary = outbox.flush({ duplicate }, now, force = true)
        assertEquals(1, summary.duplicate)
        assertEquals(0, summary.delivered)
        assertEquals(0, outbox.pending())
    }

    @Test
    fun `the backoff is respected unless the round is forced`() {
        outbox.enqueue(link("a"), now)
        var calls = 0
        outbox.flush({ calls += 1; queued }, now + 1_000)
        assertEquals(0, calls)

        outbox.flush({ calls += 1; queued }, now + ShareOutbox.backoffMs(1) + 1)
        assertEquals(1, calls)
    }

    @Test
    fun `each retryable failure backs off further`() {
        outbox.enqueue(link("a"), now)
        outbox.flush({ unreachable }, now, force = true)
        var held = outbox.entries().first()
        assertEquals(1, held.attempts)
        assertEquals(now + ShareOutbox.backoffMs(1), held.nextAttemptAt)
        assertEquals("unreachable", held.lastCode)

        outbox.flush({ unreachable }, now + 1, force = true)
        held = outbox.entries().first()
        assertEquals(2, held.attempts)
        assertEquals(now + 1 + ShareOutbox.backoffMs(2), held.nextAttemptAt)
    }

    @Test
    fun `a payload the ingress will never accept is dropped and named`() {
        outbox.enqueue(link("a"), now)
        val summary = outbox.flush({ rejected }, now, force = true)
        assertEquals(1, summary.dropped.size)
        assertEquals(DropReason.REJECTED, summary.dropped.first().reason)
        assertEquals(0, outbox.pending())
        assertEquals("https://example.com/a", outbox.dropped().first().describes)
    }

    @Test
    fun `a rejected token is retried rather than discarded`() {
        outbox.enqueue(link("a"), now)
        val summary = outbox.flush({ unauthorized }, now, force = true)
        assertTrue(summary.dropped.isEmpty())
        assertEquals(1, outbox.pending())
        assertEquals("unauthorized", outbox.entries().first().lastCode)
    }

    @Test
    fun `the round stops at the first unreachable server`() {
        outbox.enqueue(link("a"), now)
        outbox.enqueue(link("b"), now)
        outbox.enqueue(link("c"), now)
        var calls = 0
        val summary = outbox.flush({ calls += 1; unreachable }, now, force = true)

        assertEquals(1, calls)
        assertTrue(summary.offline)
        assertEquals(3, summary.pending)
        // Every held share backs off, so the next round is one wake, not three.
        assertTrue(outbox.entries().all { it.attempts == 1 })
    }

    @Test
    fun `a share no server ever accepted is abandoned`() {
        outbox.enqueue(link("a"), now)
        var calls = 0
        val summary = outbox.flush(
            { calls += 1; queued },
            now + ShareOutbox.MAX_AGE_MS + 1,
            force = true,
        )
        assertEquals(0, calls)
        assertEquals(DropReason.EXPIRED, summary.dropped.first().reason)
        assertEquals(0, outbox.pending())
    }

    @Test
    fun `a share enqueued during a round survives the commit`() {
        outbox.enqueue(link("a"), now)
        val summary = outbox.flush(
            {
                outbox.enqueue(link("late"), now)
                queued
            },
            now,
            force = true,
        )
        assertEquals(1, summary.delivered)
        assertEquals(1, outbox.pending())
        assertEquals("https://example.com/late", outbox.entries().first().payload.url)
    }

    @Test
    fun `the earliest due attempt drives the next wake`() {
        assertNull(outbox.earliestAttempt())
        outbox.enqueue(link("a"), now + 5_000)
        outbox.enqueue(link("b"), now)
        assertEquals(now + ShareOutbox.backoffMs(1), outbox.earliestAttempt())
    }

    @Test
    fun `a truncated file is preserved and every mutation refuses it`() {
        outbox.enqueue(link("a"), now)
        file.writeText("{\"entries\": [{\"id\"")
        assertUnreadablePreserved()
    }

    @Test
    fun `a malformed row cannot be omitted while valid held intent is rewritten`() {
        outbox.enqueue(link("keep"), now)
        val original = file.readText()
        val corruptions = listOf<(JSONObject) -> Unit>(
            { it.getJSONArray("entries").put(JSONObject().put("id", "broken")) },
            { it.getJSONArray("entries").put("not an entry") },
            { it.getJSONArray("entries").getJSONObject(0).getJSONObject("payload").put("url", 12) },
            { it.getJSONArray("entries").getJSONObject(0).put("destination", "") },
            { it.getJSONArray("entries").getJSONObject(0).put("created_at", "1700000000000") },
            { it.getJSONArray("entries").put(it.getJSONArray("entries").getJSONObject(0)) },
            { it.put("dropped", JSONArray().put(JSONObject().put("reason", "UNKNOWN"))) },
            { it.remove("entries") },
            { it.put("dropped", "not an array") },
        )
        for (corrupt in corruptions) {
            val root = JSONObject(original)
            corrupt(root)
            file.writeText(root.toString())
            assertUnreadablePreserved()
        }
    }

    @Test
    fun `invalid UTF-8 bytes are preserved instead of being replaced on decode`() {
        file.writeBytes(byteArrayOf(0xc3.toByte(), 0x28))
        assertUnreadablePreserved()
    }

    @Test
    fun `unexpected trailing bytes cannot be discarded during a rewrite`() {
        outbox.enqueue(link("keep"), now)
        file.appendText(" unexpected trailing data")
        assertUnreadablePreserved()
    }

    @Test
    fun `repairing the preserved file restores normal operation without resetting intent`() {
        outbox.enqueue(link("keep"), now)
        val valid = file.readBytes()
        file.writeText("{\"entries\":[")
        assertUnreadablePreserved()
        file.writeBytes(valid) // Simulates explicit repair, not a production recovery write.
        val reopened = ShareOutbox(file)
        assertEquals("https://example.com/keep", reopened.entries().single().payload.url)
        reopened.enqueue(link("new"), now)
        assertEquals(2, reopened.pending())
        assertEquals(2, reopened.flush({ queued }, now, force = true).delivered)
    }

    @Test
    fun `corruption during delivery is not overwritten by the round commit`() {
        outbox.enqueue(link("a"), now)
        val corrupt = "{\"entries\":[".toByteArray()
        var calls = 0
        assertFailsWith<OutboxReadException> {
            outbox.flush({
                calls++
                file.writeBytes(corrupt)
                queued
            }, now, force = true)
        }
        assertEquals(1, calls)
        assertContentEquals(corrupt, file.readBytes())
    }

    @Test
    fun `intentional discard is distinct from overflow after reopening`() {
        for (index in 0..ShareOutbox.MAX_ENTRIES) outbox.enqueue(link("$index"), now)
        val overflow = outbox.dropped().single()
        assertEquals(DropReason.OVERFLOW, overflow.reason)
        assertEquals(ShareOutbox.MAX_ENTRIES, outbox.clear())
        val reopened = ShareOutbox(file)
        assertEquals(0, reopened.pending())
        assertTrue(reopened.dropped().all { it.reason == DropReason.DISCARDED })
        assertTrue(reopened.dropped().none { it.describes == overflow.describes })
    }

    private fun assertUnreadablePreserved() {
        val bytes = file.readBytes()
        var sent = false
        val actions: List<() -> Any?> = listOf(
            { outbox.pending() }, { outbox.entries() }, { outbox.dropped() },
            { outbox.enqueue(link("new"), now) }, { outbox.clear() }, { outbox.clearDropped() },
            { outbox.remove("id") }, { outbox.reject("id", rejected) },
            { outbox.defer("id", unreachable, now) }, { outbox.earliestAttempt() },
            { outbox.flush({ sent = true; queued }, now, force = true) },
            { ShareOutbox(file).pending() },
        )
        for (action in actions) {
            val error = assertFailsWith<OutboxReadException> { action() }
            assertEquals(file.name, error.fileName)
            assertTrue(error.message!!.contains("preserve and repair"))
            assertContentEquals(bytes, file.readBytes())
        }
        assertEquals(false, sent)
    }

    @Test
    fun `held payloads round trip through storage`() {
        outbox.enqueue(SharePayload(text = "a note worth keeping", title = "Notes"), now)
        val restored = ShareOutbox(file).entries().first().payload
        assertEquals("a note worth keeping", restored.text)
        assertEquals("Notes", restored.title)
        assertNull(restored.url)
    }

    @Test
    fun `held shares cannot move to another destination`() {
        outbox.enqueue(link("private"), now, destination = "https://first.example")
        var calls = 0
        val wrong = outbox.flush({ calls++; queued }, now, force = true, destination = "https://second.example")
        assertEquals(0, calls)
        assertEquals(1, wrong.otherDestination)
        assertEquals(1, wrong.pending)
        outbox.flush({ calls++; queued }, now, force = true, destination = "https://first.example")
        assertEquals(1, calls)
        assertEquals(0, outbox.pending())
    }

    @Test
    fun `unconfigured shares bind before an ambiguous request`() {
        outbox.enqueue(link("a"), now)
        outbox.flush({
            assertEquals("https://first.example", ShareOutbox(file).entries().first().destination)
            unreachable
        }, now, force = true, destination = "https://first.example")
        var calls = 0
        outbox.flush({ calls++; queued }, now, force = true, destination = "https://second.example")
        assertEquals(0, calls)
    }

    @Test
    fun `discard during a retry cannot resurrect the entry`() {
        outbox.enqueue(link("old"), now)
        outbox.flush({
            ShareOutbox(file).clear()
            ShareOutbox(file).enqueue(link("new"), now)
            unreachable
        }, now, force = true)
        assertEquals(listOf("https://example.com/new"), outbox.entries().map { it.payload.url })
    }

    @Test
    fun `mixed partial failure preserves every outcome`() {
        for (name in listOf("admitted", "rejected", "held")) outbox.enqueue(link(name), now)
        val results = listOf(queued, rejected, unreachable).iterator()
        val summary = outbox.flush({ results.next() }, now, force = true)
        assertEquals(3, summary.attempted)
        assertEquals(1, summary.delivered)
        assertEquals(1, summary.dropped.size)
        assertEquals(1, summary.pending)
    }

    @Test
    fun `already indexed content is acknowledged and removed`() {
        outbox.enqueue(link("indexed"), now)
        val summary = outbox.flush({ ShareResult.Indexed(9) }, now, force = true)
        assertEquals(1, summary.delivered)
        assertEquals(0, outbox.pending())
    }
}
