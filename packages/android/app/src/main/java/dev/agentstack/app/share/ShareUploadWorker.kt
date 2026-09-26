package dev.agentstack.app.share

import dev.agentstack.app.Settings
import dev.agentstack.app.R

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf

/**
 * One delivery round for the Share outbox.
 *
 * Runs on WorkManager's background thread, so the blocking [ShareClient] calls
 * are made where they belong. Network failures use the outbox's own backoff.
 * An unreadable outbox is a terminal local failure: preserve it for repair,
 * report the failure in WorkManager, and do not schedule a crash/retry loop.
 */
class ShareUploadWorker(
    context: Context,
    params: WorkerParameters,
) : Worker(context, params) {

    override fun doWork(): Result {
        val outbox = ShareOutbox.at(applicationContext)
        val settings = Settings(applicationContext)
        // Unconfigured is not undeliverable: held shares wait for a server to
        // be named, and saving one schedules this round again.
        val configuration = settings.configuration() ?: return Result.success()

        val client = ShareClient(configuration.serverUrl, configuration.token)
        try {
            outbox.flush({ payload -> client.share(payload) }, destination = configuration.serverUrl)
            ShareScheduler.scheduleNext(applicationContext, outbox)
        } catch (error: OutboxReadException) {
            return Result.failure(workDataOf(
                "agentstack.app.share.error" to "outbox_unreadable",
                "agentstack.app.share.recovery" to applicationContext.getString(R.string.outbox_unreadable, error.fileName),
            ))
        }
        return Result.success()
    }
}
