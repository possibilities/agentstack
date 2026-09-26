package dev.agentstack.app.share

import dev.agentstack.app.R
import dev.agentstack.app.Settings
import dev.agentstack.app.SettingsActivity

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import android.app.Activity
import kotlin.concurrent.thread

/**
 * The share target. Runs with no UI of its own: it accepts the payload,
 * reports the outcome as a toast, and finishes immediately so sharing feels
 * instantaneous from the originating app.
 */
class ShareActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val app = applicationContext
        val settings = Settings(this)
        val configuration = settings.configuration()
        val outbox = ShareOutbox.at(this)

        val payload = payloadFrom(intent)
        if (payload == null) {
            toast(app, getString(R.string.nothing_to_share))
            finish()
            return
        }

        // Recent reminders are client state, independent of whether Admission
        // has happened or the outbox still holds this share.
        RecentLinkNotifications.remember(app, payload)

        // Never attempt a new share if its durable hold could not be recorded.
        val entry = try {
            outbox.enqueue(payload, destination = configuration?.serverUrl)
        } catch (error: OutboxReadException) {
            ShareScheduler.pause(app)
            toast(app, getString(R.string.outbox_share_not_held))
            startActivity(Intent(this, SettingsActivity::class.java))
            finish()
            return
        }

        // An unconfigured app cannot send, but the share is still worth
        // keeping: naming a server drains what was held meanwhile.
        if (configuration == null) {
            try {
                toast(app, getString(R.string.held_unconfigured, outbox.pending()))
            } catch (error: OutboxReadException) {
                reportOutboxProblem(app, error)
            }
            startActivity(Intent(this, SettingsActivity::class.java))
            finish()
            return
        }

        // Finish before the network call so the share sheet dismisses at once;
        // the outcome arrives as a toast from the background thread.
        val client = ShareClient(configuration.serverUrl, configuration.token)
        // Admission can outlive this Activity, but persistence must precede finish.
        try {
            ShareScheduler.scheduleNext(app, outbox)
        } catch (error: OutboxReadException) {
            reportOutboxProblem(app, error)
            startActivity(Intent(this, SettingsActivity::class.java))
            finish()
            return
        }
        toast(app, getString(R.string.sending))
        thread {
            val result = client.share(payload)
            try {
                when {
                    result is ShareResult.Queued || result is ShareResult.Duplicate || result is ShareResult.Indexed -> {
                        outbox.remove(entry.id)
                        // The server just answered, so anything held from an
                        // earlier outage can go now.
                        if (outbox.pending() > 0) ShareScheduler.flushNow(app)
                    }
                    ShareOutbox.isRetryable(result) -> {
                        outbox.defer(entry.id, result)
                        ShareScheduler.scheduleNext(app, outbox)
                    }
                    else -> outbox.reject(entry.id, result)
                }
                toast(app, describe(result, outbox))
            } catch (error: OutboxReadException) {
                // A local recording failure must not erase a known server receipt
                // or invent one when the request was ambiguous.
                val receipt = when (result) {
                    is ShareResult.Queued -> getString(R.string.queued, result.jobId)
                    is ShareResult.Duplicate -> getString(R.string.duplicate, result.jobId)
                    is ShareResult.Indexed -> getString(R.string.indexed, result.documentId)
                    else -> getString(R.string.outbox_delivery_unconfirmed)
                }
                reportOutboxProblem(app, error, receipt)
            }
        }
        finish()
    }

    private fun payloadFrom(intent: Intent?): SharePayload? {
        if (intent == null || intent.action != Intent.ACTION_SEND) return null
        return ShareIntentParser.parse(
            intent.getStringExtra(Intent.EXTRA_TEXT),
            intent.getStringExtra(Intent.EXTRA_SUBJECT),
        )
    }

    /**
     * A held share is reported as held, never as saved: nothing exists in
     * AgentStack until the ingress admits it.
     */
    private fun describe(result: ShareResult, outbox: ShareOutbox): String = when (result) {
        is ShareResult.Queued -> getString(R.string.queued, result.jobId)
        is ShareResult.Duplicate -> getString(R.string.duplicate, result.jobId)
        is ShareResult.Indexed -> getString(R.string.indexed, result.documentId)
        is ShareResult.Unreachable -> getString(R.string.held, outbox.pending())
        is ShareResult.Rejected ->
            if (ShareOutbox.isRetryable(result)) {
                getString(R.string.held_detail, result.message, outbox.pending())
            } else {
                getString(R.string.rejected, result.message)
            }
    }

    /**
     * Posted to the main looper against the application context rather than
     * through `runOnUiThread`: by the time a result arrives this Activity has
     * finished, and the toast must outlive it.
     */
    private fun toast(context: Context, message: String) {
        Handler(Looper.getMainLooper()).post {
            Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
        }
    }

    private fun reportOutboxProblem(context: Context, error: OutboxReadException, receipt: String? = null) {
        ShareScheduler.pause(context)
        val recovery = getString(R.string.outbox_unreadable, error.fileName)
        toast(context, listOfNotNull(receipt, recovery).joinToString(" "))
    }
}
