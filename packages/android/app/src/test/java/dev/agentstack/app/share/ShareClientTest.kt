package dev.agentstack.app.share

import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

class ShareClientTest {
    private val client = ShareClient("http://127.0.0.1:8877", "synthetic-test-token")

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
