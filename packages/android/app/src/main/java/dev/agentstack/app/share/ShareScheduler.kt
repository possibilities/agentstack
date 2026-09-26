package dev.agentstack.app.share

import dev.agentstack.app.Settings

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Wakes the app to drain the Share outbox.
 *
 * WorkManager rather than an alarm: it persists its own queue across process
 * death and reboot, so the retry survives everything the outbox itself does,
 * and its network constraint means a device with no connectivity is not woken
 * only to fail — the round runs when the network returns, which is usually the
 * moment the tailnet comes back.
 *
 * The schedule itself stays in [ShareOutbox]: WorkManager's own backoff would
 * be a second, competing opinion about when to try next.
 */
object ShareScheduler {

    private const val WORK_NAME = "agentstack.app.share.outbox.v1"

    /** Schedules a drain for when the earliest held share is due. */
    fun scheduleNext(context: Context, outbox: ShareOutbox) {
        val due = outbox.earliestAttempt(Settings(context).configuration()?.serverUrl)
        if (due == null) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
            return
        }
        schedule(context, (due - System.currentTimeMillis()).coerceAtLeast(0))
    }

    /** Drains as soon as the device has a network. */
    fun flushNow(context: Context) = schedule(context, 0)

    /** An unreadable outbox requires repair, not another automatic attempt. */
    fun pause(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
    }

    private fun schedule(context: Context, delayMs: Long) {
        val request = OneTimeWorkRequestBuilder<ShareUploadWorker>()
            .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .build()
        // REPLACE, so the most recently computed due time wins rather than an
        // older one that was scheduled before the last failure backed off.
        WorkManager.getInstance(context)
            .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, request)
    }
}
