package dev.stack.app

import dev.stack.app.share.*

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings as AndroidSettings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import kotlin.concurrent.thread

/** Server address and token entry, a reachability check, and the Share outbox. */
class SettingsActivity : AppCompatActivity() {

    private lateinit var outbox: ShareOutbox
    private lateinit var outboxStatus: TextView
    private lateinit var outboxDropped: TextView
    private lateinit var status: TextView
    private lateinit var recentLinks: RecentLinks
    private lateinit var recentList: LinearLayout
    private lateinit var recentNotificationStatus: TextView
    private lateinit var enableNotifications: Button
    private lateinit var clearRecent: Button
    private var connectionBusy = false

    private fun connectionTask(work: () -> Unit) {
        if (connectionBusy) return
        connectionBusy = true
        val controls = listOf(R.id.save, R.id.test, R.id.disconnect, R.id.check_connection, R.id.forget, R.id.outbox_send, R.id.outbox_discard, R.id.server_url)
        controls.forEach { findViewById<View>(it).isEnabled = false }
        thread {
            try { work() }
            finally {
                runOnUiThread {
                    connectionBusy = false
                    controls.forEach { findViewById<View>(it).isEnabled = true }
                }
            }
        }
    }

    private val requestNotificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) RecentLinkNotifications.restore(applicationContext)
        refreshRecentLinks()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        ViewCompat.setAccessibilityHeading(findViewById(R.id.share_heading), true)

        val settings = Settings(this)
        outbox = ShareOutbox.at(this)
        recentLinks = RecentLinks.at(this)
        val serverField = findViewById<EditText>(R.id.server_url)
        val codeField = findViewById<TextView>(R.id.token)
        status = findViewById(R.id.status)
        outboxStatus = findViewById(R.id.outbox_status)
        outboxDropped = findViewById(R.id.outbox_dropped)
        recentList = findViewById(R.id.recent_links)
        recentNotificationStatus = findViewById(R.id.recent_notification_status)
        enableNotifications = findViewById(R.id.recent_enable_notifications)
        clearRecent = findViewById(R.id.recent_clear)

        serverField.setText(settings.serverUrl)
        codeField.text = settings.pairingCode
        status.text = settings.connectionState

        findViewById<Button>(R.id.save).setOnClickListener {
            val url = try {
                Settings.normalizeServerUrl(serverField.text.toString())
            } catch (_: Exception) {
                status.text = getString(R.string.bad_server_url)
                return@setOnClickListener
            }
            status.text = "Requesting pairing…"
            connectionTask {
                try {
                    val code = settings.pair(url)
                    runOnUiThread { codeField.text = code; status.text = "Approve this matching code in Stack System → Access, then check approval." }
                } catch (error: Exception) { runOnUiThread { status.text = error.message } }
            }
        }

        findViewById<Button>(R.id.test).setOnClickListener {
            status.text = getString(R.string.testing)
            connectionTask {
                try {
                    settings.completePairing()
                    ShareScheduler.flushNow(applicationContext)
                    runOnUiThread { codeField.text = ""; status.text = "Paired with Stack."; requestNotificationPermissionIfNeeded() }
                } catch (error: Exception) { runOnUiThread { status.text = error.message } }
            }
        }

        findViewById<Button>(R.id.disconnect).setOnClickListener {
            connectionTask { try { settings.disconnect(); runOnUiThread { codeField.text = ""; status.text = "Disconnected. Held shares are kept." } }
                catch (error: Exception) { runOnUiThread { status.text = "Disconnect not confirmed: ${error.message}. Revoke in System → Access if this server is unavailable." } } }
        }
        findViewById<Button>(R.id.check_connection).setOnClickListener {
            connectionTask { val state = settings.checkConnection(); runOnUiThread { status.text = state } }
        }
        findViewById<Button>(R.id.forget).setOnClickListener {
            androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle("Forget locally?")
                .setMessage("Server revocation will not be confirmed. Revoke the old credential in System → Access. Held shares remain bound to their original server.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Forget locally") { _, _ -> settings.forgetLocally(); codeField.text = ""; status.text = settings.connectionState }
                .show()
        }

        findViewById<Button>(R.id.outbox_send).setOnClickListener {
            val configuration = settings.configuration()
            if (configuration == null) {
                status.text = getString(R.string.not_configured)
                return@setOnClickListener
            }
            status.text = getString(R.string.outbox_sending)
            val client = ShareClient(configuration.serverUrl, "", tokenProvider = { settings.accessToken(configuration.destination) }, serverId = configuration.serverId)
            connectionTask {
                try {
                    // Forced: the user asked now, so the backoff does not apply.
                    val summary = outbox.flush({ client.share(it) }, force = true, destination = configuration.destination)
                    ShareScheduler.scheduleNext(applicationContext, outbox)
                    val message = if (summary.otherDestination > 0) {
                        getString(R.string.outbox_other_server, summary.otherDestination)
                    } else if (summary.attempted == 0 && summary.dropped.isEmpty()) {
                        getString(R.string.outbox_nothing_waiting)
                    } else {
                        getString(
                            R.string.outbox_flushed,
                            summary.delivered + summary.duplicate,
                            summary.attempted,
                            summary.pending,
                            summary.dropped.size,
                        )
                    }
                    runOnUiThread {
                        status.text = message
                        refreshOutbox()
                    }
                } catch (error: OutboxReadException) {
                    runOnUiThread { showOutboxProblem(error) }
                }
            }
        }

        findViewById<Button>(R.id.outbox_discard).setOnClickListener {
            try {
                val discarded = outbox.clear()
                ShareScheduler.scheduleNext(applicationContext, outbox)
                status.text = getString(R.string.outbox_cleared, discarded)
                refreshOutbox()
            } catch (error: OutboxReadException) {
                showOutboxProblem(error)
            }
        }

        enableNotifications.setOnClickListener {
            if (needsNotificationPermission()) {
                requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                startActivity(
                    Intent(AndroidSettings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(AndroidSettings.EXTRA_APP_PACKAGE, packageName),
                )
            }
        }

        clearRecent.setOnClickListener {
            val removed = RecentLinkNotifications.clear(applicationContext)
            status.text = resources.getQuantityString(
                R.plurals.recent_cleared,
                removed,
                removed,
            )
            refreshRecentLinks()
        }
    }

    override fun onResume() {
        super.onResume()
        RecentLinkNotifications.restore(applicationContext)
        refreshRecentLinks()
        refreshOutbox()
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (needsNotificationPermission()) {
            requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            RecentLinkNotifications.restore(applicationContext)
            refreshRecentLinks()
        }
    }

    private fun needsNotificationPermission(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) != PackageManager.PERMISSION_GRANTED

    private fun refreshRecentLinks() {
        val notificationsOn = RecentLinkNotifications.canNotify(this)
        recentNotificationStatus.text = getString(
            if (notificationsOn) {
                R.string.recent_notifications_on
            } else {
                R.string.recent_notifications_off
            },
        )
        enableNotifications.visibility = if (notificationsOn) View.GONE else View.VISIBLE

        val entries = recentLinks.entries()
        recentList.removeAllViews()
        if (entries.isEmpty()) {
            recentList.addView(TextView(this).apply { setText(R.string.recent_none) })
        } else {
            for (entry in entries) recentList.addView(recentRow(entry))
        }
        clearRecent.isEnabled = entries.isNotEmpty()
    }

    private fun recentRow(entry: RecentLink): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(0, dp(6), 0, dp(6))

            addView(
                Button(this@SettingsActivity).apply {
                    isAllCaps = false
                    gravity = android.view.Gravity.START or android.view.Gravity.CENTER_VERTICAL
                    text = if (entry.title == null) {
                        entry.url
                    } else {
                        "${entry.title}\n${entry.url}"
                    }
                    contentDescription = getString(R.string.recent_open_named, text)
                    setOnClickListener {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(entry.url)))
                    }
                },
                LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
            )
            addView(
                Button(this@SettingsActivity).apply {
                    setText(R.string.recent_remove)
                    contentDescription = getString(R.string.recent_remove_named, entry.title ?: entry.url)
                    setOnClickListener {
                        RecentLinkNotifications.remove(applicationContext, entry.id)
                        refreshRecentLinks()
                    }
                },
            )
        }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()

    private fun refreshOutbox() {
        val pending: Int
        val dropped: List<DroppedShare>
        try {
            pending = outbox.pending()
            dropped = outbox.dropped()
        } catch (error: OutboxReadException) {
            showOutboxProblem(error)
            return
        }
        findViewById<Button>(R.id.outbox_send).isEnabled = !connectionBusy
        findViewById<Button>(R.id.outbox_discard).isEnabled = !connectionBusy
        outboxStatus.text = if (pending == 0) {
            getString(R.string.outbox_none)
        } else {
            getString(R.string.outbox_pending, pending)
        }

        // Every abandoned share is named here even when notifications are
        // disabled. Silent loss is what the outbox exists to prevent.
        outboxDropped.text = if (dropped.isEmpty()) {
            ""
        } else {
            buildString {
                append(getString(R.string.outbox_dropped_heading))
                for (drop in dropped) {
                    append('\n')
                    append(
                        when (drop.reason) {
                            DropReason.EXPIRED ->
                                getString(R.string.outbox_dropped_expired, drop.describes)
                            DropReason.OVERFLOW ->
                                getString(R.string.outbox_dropped_overflow, drop.describes)
                            DropReason.REJECTED ->
                                getString(R.string.outbox_dropped_rejected, drop.describes)
                            DropReason.DISCARDED ->
                                getString(R.string.outbox_dropped_discarded, drop.describes)
                        },
                    )
                }
            }
        }
    }

    private fun showOutboxProblem(error: OutboxReadException) {
        ShareScheduler.pause(applicationContext)
        val message = getString(R.string.outbox_unreadable, error.fileName)
        status.text = message
        outboxStatus.text = message
        outboxDropped.text = ""
        findViewById<Button>(R.id.outbox_send).isEnabled = false
        findViewById<Button>(R.id.outbox_discard).isEnabled = false
    }
}
