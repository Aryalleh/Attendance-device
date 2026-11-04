package com.accessctl.door

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Opens the kiosk screen when the phone boots (or after the app is updated). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val prefs = Prefs(context)
        if (!prefs.autoStart || !prefs.configured || !prefs.kioskEnabled) return
        // Android 10+ only lets this start an activity if the app is device owner or the default
        // Home app; as Home the kiosk opens at boot anyway, so this is a best-effort extra.
        try {
            context.startActivity(Intent(context, KioskActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
        }
    }
}
