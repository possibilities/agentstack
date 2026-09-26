package dev.agentstack.app.share

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * Normalized outcome of one share attempt.
 *
 * [Rejected] carries the HTTP status, not just the error code: whether a
 * rejection may be sent again unchanged is defined by the status in
 * share-ingest-v1, and the outbox needs it to decide.
 */
sealed class ShareResult {
    data class Queued(val jobId: Int) : ShareResult()
    data class Duplicate(val jobId: Int) : ShareResult()
    data class Indexed(val documentId: Int) : ShareResult()
    data class Rejected(val status: Int, val code: String, val message: String) : ShareResult()
    data class Unreachable(val message: String) : ShareResult()
}

/**
 * Minimal HTTP client for the share ingress.
 *
 * Uses HttpURLConnection so the app carries no third-party networking
 * dependency. Calls block, so callers must run this off the main thread.
 */
class ShareClient(
    private val serverUrl: String,
    private val token: String,
    private val timeoutMs: Int = 15_000,
) {

    fun share(payload: SharePayload): ShareResult {
        val body = payload.toJson().toByteArray(Charsets.UTF_8)
        val endpoint = "${serverUrl.trimEnd('/')}/v1/share"

        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Authorization", "Bearer $token")
            }
            connection.outputStream.use { it.write(body) }

            val status = connection.responseCode
            val raw = if (status in 200..299) {
                connection.inputStream.bufferedReader().use { it.readText() }
            } else {
                connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
            }
            interpret(status, raw)
        } catch (error: IOException) {
            ShareResult.Unreachable(
                error.message ?: "Could not reach AgentStack at $serverUrl",
            )
        } finally {
            connection?.disconnect()
        }
    }

    fun checkHealth(): ShareResult {
        var connection: HttpURLConnection? = null
        return try {
            val endpoint = "${serverUrl.trimEnd('/')}/v1/health"
            connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                setRequestProperty("Authorization", "Bearer $token")
            }
            when (val status = connection.responseCode) {
                in 200..299 -> ShareResult.Queued(0)
                401 -> ShareResult.Rejected(401, "unauthorized", "The share token was rejected.")
                else -> ShareResult.Rejected(status, "http_$status", "Server answered HTTP $status.")
            }
        } catch (error: IOException) {
            ShareResult.Unreachable(error.message ?: "Could not reach $serverUrl")
        } finally {
            connection?.disconnect()
        }
    }

    internal fun interpret(status: Int, raw: String): ShareResult {
        val json = try {
            if (raw.isBlank()) null else JSONObject(raw)
        } catch (_: Exception) {
            null
        }

        if (status in 200..299 && json != null && json.opt("ok") == true) {
            val data = json.optJSONObject("data")
            val jobId = data.positiveId("job_id")
            val documentId = data.positiveId("document_id")
            when (data?.optString("status")) {
                "queued" -> if (jobId != null) return ShareResult.Queued(jobId)
                "duplicate" -> if (jobId != null) return ShareResult.Duplicate(jobId)
                "already_indexed" -> if (documentId != null) return ShareResult.Indexed(documentId)
            }
        }

        if (status in 200..299) {
            return ShareResult.Unreachable("The server did not confirm admission. Held for a safe retry.")
        }

        val error = json?.optJSONObject("error")
        return ShareResult.Rejected(
            status,
            error?.optString("code") ?: "http_$status",
            error?.optString("message") ?: "AgentStack rejected the share (HTTP $status).",
        )
    }

    /** Receipts must carry an actual positive integer, never a coerced string or fraction. */
    private fun JSONObject?.positiveId(key: String): Int? {
        val value = when (val raw = this?.opt(key)) {
            is Int -> raw.toLong()
            is Long -> raw
            else -> return null
        }
        return value.takeIf { it in 1..Int.MAX_VALUE }?.toInt()
    }
}
