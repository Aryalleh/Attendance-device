package com.accessctl.door

import android.content.Context

/** Door settings (what the Wemos keeps in /settings.json). */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("door", Context.MODE_PRIVATE)

    var server: String
        get() = sp.getString("server", "") ?: ""
        set(v) = sp.edit().putString("server", normalizeServer(v)).apply()
    var key: String
        get() = sp.getString("key", "") ?: ""
        set(v) = sp.edit().putString("key", v.trim()).apply()
    var pin: String
        get() = sp.getString("pin", "") ?: ""
        set(v) = sp.edit().putString("pin", v.trim()).apply()
    var offlineFallback: Boolean
        get() = sp.getBoolean("offline_fallback", true)
        set(v) = sp.edit().putBoolean("offline_fallback", v).apply()
    var lockTask: Boolean
        get() = sp.getBoolean("lock_task", true)
        set(v) = sp.edit().putBoolean("lock_task", v).apply()
    var autoStart: Boolean
        get() = sp.getBoolean("auto_start", true)
        set(v) = sp.edit().putBoolean("auto_start", v).apply()
    /** Set by "Exit kiosk mode": the app then behaves like a normal app until saved again. */
    var kioskEnabled: Boolean
        get() = sp.getBoolean("kiosk_enabled", true)
        set(v) = sp.edit().putBoolean("kiosk_enabled", v).apply()
    var cardsVersion: String
        get() = sp.getString("cards_version", "") ?: ""
        set(v) = sp.edit().putString("cards_version", v).apply()
    var doorName: String
        get() = sp.getString("door_name", "") ?: ""
        set(v) = sp.edit().putString("door_name", v).apply()

    val configured get() = server.isNotEmpty() && key.isNotEmpty()

    companion object {
        fun normalizeServer(raw: String): String {
            var s = raw.trim().trimEnd('/')
            if (s.isNotEmpty() && !s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
            return s
        }
    }
}
