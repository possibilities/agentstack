package dev.agentstack.app

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.net.URI
import java.net.HttpURLConnection
import java.net.URL
import java.io.IOException
import java.security.SecureRandom
import java.util.UUID
import android.util.Base64
import org.json.JSONObject
import org.json.JSONArray

data class ShareConfiguration(val serverUrl: String, val serverId: String) {
    val destination: String get() = "$serverUrl#agentstack=$serverId"
}

/**
 * Device-local configuration.
 *
 * The share token is a credential, so it is held in EncryptedSharedPreferences
 * rather than plain preferences. This AgentStack namespace starts empty.
 */
class Settings(context: Context) {

    private val prefs = run {
        val key = MasterKey.Builder(context, "agentstack.app.share.master.v1")
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "agentstack.app.connection.v1",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    val serverUrl: String
        get() = prefs.getString(KEY_SERVER, DEFAULT_SERVER_URL).orEmpty()

    val pairingCode: String
        get() = prefs.getString("pair.code", "").orEmpty()

    val connectionState: String
        get() = when {
            prefs.contains("refresh") -> prefs.getString("observation", "Paired; connection not yet checked").orEmpty()
            prefs.contains("pair.request") -> if (prefs.getLong("pair.expires", 0) <= System.currentTimeMillis()) "Pairing expired; pair again" else "Pairing pending; approve in System → Access"
            else -> prefs.getString("observation", "Disconnected; pair to connect").orEmpty()
        }

    val isConfigured: Boolean
        get() = configuration() != null

    fun configuration(): ShareConfiguration? = synchronized(LOCK) {
        val values = prefs.all
        val server = values[KEY_SERVER] as? String ?: return@synchronized null
        val token = values["refresh"] as? String ?: return@synchronized null
        val serverId = values["server.id"] as? String ?: return@synchronized null
        if (server.isBlank() || token.isBlank()) null else ShareConfiguration(server, serverId)
    }

    /** Calls below perform network I/O and run on a worker thread only. Persist
     * retry intent before sending, and serialize rotation across app workers. */
    fun pair(server: String): String = synchronized(LOCK) {
        check(prefs.getString("refresh", null) == null) { "Disconnect first, or explicitly Forget locally and revoke the old credential in System → Access." }
        val url = normalizeServerUrl(server)
        require(URI(url).scheme == "https") { "Pairing requires HTTPS" }
        if (serverUrl != url || prefs.getLong("pair.expires", 0) <= System.currentTimeMillis()) {
            val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            val secret = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
            check(prefs.edit().clear().putString(KEY_SERVER, url).putString("pair.request", UUID.randomUUID().toString())
                .putString("pair.secret", secret).putLong("pair.expires", System.currentTimeMillis() + 600_000).commit())
        }
        val result = request(url, "/v1/access/pair", JSONObject().put("requestId", prefs.getString("pair.request", ""))
            .put("redemptionSecret", prefs.getString("pair.secret", "")).put("label", "Android").put("kind", "android")
            .put("scopes", JSONArray(listOf("brain:share", "brain:status", "content:read"))))
        check(prefs.edit().putString("pair.id", result.getString("id")).putString("pair.code", result.getString("code"))
            .putString("server.id", result.getString("serverId")).putLong("pair.expires", result.getLong("expiresAt")).commit())
        result.getString("code")
    }

    fun completePairing() = synchronized(LOCK) {
        val result = request(serverUrl, "/v1/access/redeem", JSONObject().put("id", prefs.getString("pair.id", ""))
            .put("redemptionSecret", prefs.getString("pair.secret", "")))
        check(prefs.edit().putString("refresh", result.getString("refreshToken")).remove("pair.secret").remove("pair.code").remove("pair.id")
            .remove("pair.request").remove("pair.expires").commit())
    }

    fun accessToken(destination: String, audience: String = "brain"): String = synchronized(LOCK) {
        if (destination != configuration()?.destination) throw IOException("Held share belongs to another destination")
        val refresh = prefs.getString("refresh", null) ?: throw IOException("Pair with AgentStack first")
        val pendingAudience = prefs.getString("refresh.audience", null)
        if (pendingAudience == null && prefs.getLong("token.$audience.expires", 0) > System.currentTimeMillis() + 30_000)
            return@synchronized prefs.getString("token.$audience", "").orEmpty()
        val target = pendingAudience ?: audience
        val requestId = prefs.getString("refresh.request", null) ?: UUID.randomUUID().toString()
        check(prefs.edit().putString("refresh.request", requestId).putString("refresh.audience", target).commit())
        val result = request(serverUrl, "/v1/access/refresh", JSONObject().put("refreshToken", refresh).put("requestId", requestId).put("audience", target))
        check(prefs.edit().putString("refresh", result.getString("refreshToken")).putString("token.$target", result.getString("accessToken"))
            .putLong("token.$target.expires", result.getLong("expiresAt")).remove("refresh.request").remove("refresh.audience").commit())
        if (target == audience) result.getString("accessToken") else accessToken(destination, audience)
    }

    fun disconnect() = synchronized(LOCK) {
        val server = serverUrl
        configuration()?.let { request(server, "/v1/access/disconnect", JSONObject(), accessToken(it.destination)) }
        check(prefs.edit().clear().putString(KEY_SERVER, server).commit())
    }

    fun forgetLocally() = synchronized(LOCK) {
        check(prefs.edit().clear().putString(KEY_SERVER, serverUrl).putString("observation", "Forgotten locally; server revocation not confirmed").commit())
    }

    fun checkConnection(): String = synchronized(LOCK) {
        if (configuration() == null) return@synchronized connectionState
        try {
            val token = accessToken(configuration()?.destination ?: throw IOException("Pair first"))
            val data = readEndpoint(serverUrl, "/v1/access/me", token)
            val value = "Connected at ${java.util.Date()}; permissions: ${data.getJSONArray("scopes")}"
            check(prefs.edit().putString("observation", value).commit())
            value
        } catch (error: Exception) {
            val code = error.message.orEmpty()
            val state = when {
                code.contains("revoked") -> "Credential revoked"
                code.contains("expired") -> "Credential expired; pair again"
                code.contains("identity") -> "Server identity changed; held shares stay on the original destination"
                else -> "Paired but unavailable; check AgentStack and tailnet reachability"
            }
            val value = "$state: $code (checked ${java.util.Date()})"
            prefs.edit().putString("observation", value).commit()
            value
        }
    }

    private fun readEndpoint(server: String, path: String, token: String? = null): JSONObject {
        val connection = URL("$server$path").openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false; connection.connectTimeout = 15_000; connection.readTimeout = 15_000
            if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
            connection.setRequestProperty("X-AgentStack-Server-ID", prefs.getString("server.id", null) ?: throw IOException("Pair first"))
            val ok = connection.responseCode in 200..299
            val body = JSONObject((if (ok) connection.inputStream else connection.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty())
            if (!ok || !body.optBoolean("ok")) throw IOException(body.optJSONObject("error")?.optString("code") ?: "Unavailable")
            val data = body.getJSONObject("data")
            if (data.getString("serverId") != prefs.getString("server.id", null)) throw IOException("Server identity changed")
            return data
        } catch (error: Exception) { throw IOException(error.message ?: "Unavailable", error) }
        finally { connection.disconnect() }
    }

    private fun request(server: String, path: String, data: JSONObject, token: String? = null): JSONObject {
        val connection = URL("$server$path").openConnection() as HttpURLConnection
        try {
            connection.apply { requestMethod = "POST"; instanceFollowRedirects = false; connectTimeout = 15_000; readTimeout = 15_000; doOutput = true
                setRequestProperty("Content-Type", "application/json"); if (token != null) setRequestProperty("Authorization", "Bearer $token") }
            if (path != "/v1/access/pair") connection.setRequestProperty("X-AgentStack-Server-ID", prefs.getString("server.id", null) ?: throw IOException("Pair first"))
            connection.outputStream.use { it.write(data.toString().toByteArray(Charsets.UTF_8)) }
            val ok = connection.responseCode in 200..299
            val raw = (if (ok) connection.inputStream else connection.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            val envelope = JSONObject(raw)
            if (!ok || !envelope.optBoolean("ok")) throw IOException(envelope.optJSONObject("error")?.optString("code") ?: "Connection failed")
            val result = envelope.getJSONObject("data")
            if (path != "/v1/access/pair" && result.has("serverId") && result.getString("serverId") != prefs.getString("server.id", null)) throw IOException("Server identity changed")
            return result
        } catch (error: Exception) { throw IOException(error.message ?: "Connection failed", error) }
        finally { connection.disconnect() }
    }

    companion object {
        const val DEFAULT_SERVER_URL = ""
        private const val KEY_SERVER = "agentstack.app.share.server_url"
        private val LOCK = Any()

        fun normalizeServerUrl(value: String): String {
            val uri = URI(value.trim())
            require(uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrEmpty() && uri.port in -1..65535 &&
                uri.rawPath in listOf("", "/") && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) {
                "Use an HTTPS origin without credentials, a path, query, or fragment."
            }
            return URI("https", null, uri.host.lowercase(java.util.Locale.ROOT), if (uri.port == 443) -1 else uri.port, null, null, null).toASCIIString()
        }
    }
}
