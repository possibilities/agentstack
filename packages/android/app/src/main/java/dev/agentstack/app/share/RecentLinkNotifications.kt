package dev.agentstack.app.share

import dev.agentstack.app.R

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** Owns the ongoing notification corresponding to each retained recent link. */
object RecentLinkNotifications {
    private const val CHANNEL_ID = "agentstack.app.share.recent-links.v1"
    private const val GROUP_KEY = "agentstack.app.share.recent-links"
    private const val ACTION_REMOVE = "dev.agentstack.app.share.REMOVE_RECENT_LINK"
    private const val EXTRA_ID = "dev.agentstack.app.share.RECENT_LINK_ID"

    fun remember(context: Context, payload: SharePayload): RecentLink? {
        val url = payload.url ?: return null
        val change = RecentLinks.at(context).add(url, payload.title)
        for (entry in change.evicted) cancel(context, entry.id)
        post(context, change.added, alert = true)
        return change.added
    }

    fun restore(context: Context) {
        createChannel(context)
        if (!canNotify(context)) return
        for (entry in RecentLinks.at(context).entries()) {
            post(context, entry, alert = false)
        }
    }

    fun remove(context: Context, id: String): Boolean {
        val removed = RecentLinks.at(context).remove(id)
        cancel(context, id)
        return removed != null
    }

    fun clear(context: Context): Int {
        val removed = RecentLinks.at(context).clear()
        for (entry in removed) cancel(context, entry.id)
        return removed.size
    }

    fun canNotify(context: Context): Boolean {
        val permissionGranted =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.POST_NOTIFICATIONS,
                ) == PackageManager.PERMISSION_GRANTED
        val manager = context.getSystemService(NotificationManager::class.java)
        val channelEnabled =
            manager.getNotificationChannel(CHANNEL_ID)?.importance != NotificationManager.IMPORTANCE_NONE
        return permissionGranted &&
            channelEnabled &&
            NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    @SuppressLint("MissingPermission")
    private fun post(context: Context, entry: RecentLink, alert: Boolean) {
        createChannel(context)
        if (!canNotify(context)) return

        val open = Intent(Intent.ACTION_VIEW, Uri.parse(entry.url))
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val openIntent = PendingIntent.getActivity(
            context,
            notificationId(entry.id),
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val remove = Intent(context, RecentLinkActionReceiver::class.java)
            .setAction(ACTION_REMOVE)
            .setData(Uri.parse("agentstack-share://recent/${entry.id}"))
            .putExtra(EXTRA_ID, entry.id)
        val removeIntent = PendingIntent.getBroadcast(
            context,
            notificationId(entry.id),
            remove,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val title = entry.title ?: Uri.parse(entry.url).host ?: context.getString(R.string.recent_link)
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_layers)
            .setContentTitle(title)
            .setContentText(entry.url)
            .setStyle(NotificationCompat.BigTextStyle().bigText(entry.url))
            .setContentIntent(openIntent)
            .setAutoCancel(false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setWhen(entry.createdAt)
            .setShowWhen(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setGroup(GROUP_KEY)
            .addAction(0, context.getString(R.string.recent_open), openIntent)
            .addAction(0, context.getString(R.string.recent_remove), removeIntent)
        if (!alert) builder.setSilent(true)

        NotificationManagerCompat.from(context).notify(notificationId(entry.id), builder.build())
    }

    private fun createChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.recent_notification_channel),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = context.getString(R.string.recent_notification_channel_description)
        }
        manager.createNotificationChannel(channel)
    }

    private fun cancel(context: Context, id: String) {
        NotificationManagerCompat.from(context).cancel(notificationId(id))
    }

    private fun notificationId(id: String): Int = id.hashCode()

    fun removeId(intent: Intent): String? =
        intent.takeIf { it.action == ACTION_REMOVE }?.getStringExtra(EXTRA_ID)
}

/** Explicit notification action; removing a reminder never mutates AgentStack. */
class RecentLinkActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        RecentLinkNotifications.removeId(intent)?.let { id ->
            RecentLinkNotifications.remove(context, id)
        }
    }
}

/** Ongoing notifications are reconstructed after a reboot or app update. */
class RecentLinkRestoreReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            RecentLinkNotifications.restore(context)
        }
    }
}
