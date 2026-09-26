package dev.agentstack.app.share

import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.Before
import org.junit.After
import org.junit.Test

class RecentLinksTest {
    private lateinit var file: java.io.File
    private lateinit var recent: RecentLinks

    @Before
    fun setup() {
        file = Files.createTempDirectory("recent-links").resolve("recent-links.json").toFile()
        recent = RecentLinks(file)
    }

    @After
    fun cleanUp() { file.parentFile?.deleteRecursively() }

    @Test
    fun `links persist newest first and can be removed individually`() {
        recent.add("https://example.com/a", "A", now = 1, id = "a")
        recent.add("https://example.com/b", null, now = 2, id = "b")

        assertEquals(listOf("b", "a"), RecentLinks(file).entries().map { it.id })
        assertEquals("A", recent.remove("a")?.title)
        assertEquals(listOf("b"), recent.entries().map { it.id })
        assertNull(recent.remove("absent"))
    }

    @Test
    fun `history is bounded and reports entries displaced by a new link`() {
        var evicted = emptyList<RecentLink>()
        for (index in 0..RecentLinks.MAX_ENTRIES) {
            evicted = recent.add(
                "https://example.com/$index",
                null,
                now = index.toLong(),
                id = index.toString(),
            ).evicted
        }

        assertEquals(RecentLinks.MAX_ENTRIES, recent.entries().size)
        assertEquals(listOf("0"), evicted.map { it.id })
        assertEquals("20", recent.entries().first().id)
    }

    @Test
    fun `clear returns every removed reminder`() {
        recent.add("https://example.com/a", null, id = "a")
        recent.add("https://example.com/b", null, id = "b")

        assertEquals(2, recent.clear().size)
        assertEquals(emptyList(), recent.entries())
    }
}
