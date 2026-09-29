package dev.stack.app.share

import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

class ShareClientTest {
    @Test
    fun `transport pins identity and refuses redirects`() {
        val server = java.net.ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))
        val headers = java.util.concurrent.CompletableFuture<String>()
        val worker = kotlin.concurrent.thread {
            server.accept().use { socket ->
                socket.soTimeout = 5000
                val reader = socket.getInputStream().bufferedReader()
                val lines = mutableListOf<String>()
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) break
                    lines += line
                }
                val length = lines.first { it.startsWith("Content-Length:", ignoreCase = true) }.substringAfter(':').trim().toInt()
                repeat(length) { reader.read() }
                headers.complete(lines.joinToString("\n"))
                socket.getOutputStream().write("HTTP/1.1 307 Temporary Redirect\r\nLocation: /other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
            }
        }
        try {
            val transport = ShareClient("http://127.0.0.1:${server.localPort}", "", timeoutMs = 5000, tokenProvider = { "scoped-token" }, serverId = "original-server")
            val result = transport.share(SharePayload(url = "https://example.com"))
            assertTrue(result is ShareResult.Rejected)
            assertEquals(307, result.status)
            val request = headers.get(5, java.util.concurrent.TimeUnit.SECONDS)
            assertTrue(request.contains("X-Stack-Server-ID: original-server", ignoreCase = true))
            assertTrue(request.contains("Authorization: Bearer scoped-token", ignoreCase = true))
        } finally { server.close(); worker.join(5000) }
    }

    private val client = ShareClient("http://127.0.0.1:8877", "synthetic-test-token")

    @Test
    fun `identity rejection holds content for its original server`() {
        val result = client.interpret(409, """{"ok":false,"error":{"code":"server_identity_mismatch"}}""")
        assertTrue(result is ShareResult.Unreachable)
        assertTrue(ShareOutbox.isRetryable(result))
    }

    @Test
    fun `valid receipts distinguish admitted duplicate and indexed`() {
        assertEquals(ShareResult.Queued(7), client.interpret(200, """{"ok":true,"data":{"status":"queued","job_id":7}}"""))
        assertEquals(ShareResult.Duplicate(7), client.interpret(200, """{"ok":true,"data":{"status":"duplicate","job_id":7}}"""))
        assertEquals(ShareResult.Indexed(9), client.interpret(200, """{"ok":true,"data":{"status":"already_indexed","document_id":9}}"""))
    }

    @Test
    fun `malformed success replies are ambiguous and held`() {
        for (body in listOf("not JSON", """{"ok":true}""", """{"ok":true,"data":{"status":"queued","job_id":0}}""")) {
            val result = client.interpret(200, body)
            assertTrue(result is ShareResult.Unreachable)
            assertTrue(ShareOutbox.isRetryable(result))
        }
    }

    @Test
    fun `server errors retain retry classification`() {
        for ((status, retry) in listOf(400 to false, 401 to true, 408 to true, 429 to true, 500 to true)) {
            val result = client.interpret(status, """{"ok":false,"error":{"code":"test_failure","message":"Synthetic failure"}}""")
            assertEquals(retry, ShareOutbox.isRetryable(result))
        }
    }

    @Test
    fun `receipt identities cannot coerce strings fractions booleans or overflowing integers`() {
        for (status in listOf("queued", "duplicate", "already_indexed")) {
            val key = if (status == "already_indexed") "document_id" else "job_id"
            for (value in listOf("\"7\"", "7.5", "7.0", "true", "null", "{}", "2147483648", "-1")) {
                val result = client.interpret(200, """{"ok":true,"data":{"status":"$status","$key":$value}}""")
                assertTrue(result is ShareResult.Unreachable)
                assertTrue(ShareOutbox.isRetryable(result))
            }
        }
    }
}
