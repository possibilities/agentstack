package dev.agentstack.app

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.net.URI

data class ShareConfiguration(val serverUrl: String, val token: String)

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
            "agentstack.app.share.settings.v1",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    val serverUrl: String
        get() = prefs.getString(KEY_SERVER, DEFAULT_SERVER_URL).orEmpty()

    val token: String
        get() = prefs.getString(KEY_TOKEN, "").orEmpty()

    val isConfigured: Boolean
        get() = configuration() != null

    fun configuration(): ShareConfiguration? = synchronized(LOCK) {
        val values = prefs.all
        val server = values[KEY_SERVER] as? String ?: return@synchronized null
        val token = values[KEY_TOKEN] as? String ?: return@synchronized null
        if (server.isBlank() || token.isBlank()) null else ShareConfiguration(server, token)
    }

    fun save(server: String, token: String): Boolean = synchronized(LOCK) {
        prefs.edit().putString(KEY_SERVER, normalizeServerUrl(server))
            .putString(KEY_TOKEN, token.trim()).commit()
    }

    companion object {
        const val DEFAULT_SERVER_URL = "http://127.0.0.1:8877"
        private const val KEY_SERVER = "agentstack.app.share.server_url"
        private const val KEY_TOKEN = "agentstack.app.share.token"
        private val LOCK = Any()

        fun normalizeServerUrl(value: String): String {
            val uri = URI(value.trim())
            require(uri.scheme in listOf("http", "https") && !uri.host.isNullOrEmpty() &&
                uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) {
                "Use an http(s) server URL without credentials, a query, or a fragment."
            }
            return uri.toASCIIString().trimEnd('/')
        }
    }
}
