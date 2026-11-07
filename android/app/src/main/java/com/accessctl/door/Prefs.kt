package com.accessctl.door

import android.content.Context
import android.util.Base64
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

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
    var doorName: String
        get() = sp.getString("door_name", "") ?: ""
        set(v) = sp.edit().putString("door_name", v).apply()

    /** The company admin who paired this phone, and a salted hash of their password (offline unlock). */
    var adminUser: String
        get() = sp.getString("admin_user", "") ?: ""
        private set(v) = sp.edit().putString("admin_user", v).apply()
    private var adminHash: String
        get() = sp.getString("admin_hash", "") ?: ""
        set(v) = sp.edit().putString("admin_hash", v).apply()
    var orgName: String
        get() = sp.getString("org_name", "") ?: ""
        set(v) = sp.edit().putString("org_name", v).apply()

    val configured get() = server.isNotEmpty() && key.isNotEmpty()
    /** Settings are behind an admin sign-in (phones set up before that used a numeric PIN). */
    val hasAdminLogin get() = adminUser.isNotEmpty() && adminHash.isNotEmpty()

    fun setAdmin(user: String, password: String) {
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        adminUser = user.trim()
        adminHash = b64(salt) + ":" + b64(pbkdf2(password, salt))
        pin = ""   // the PIN is replaced by the admin password
    }

    /** Offline check against the stored hash (the server is asked first when it can be reached). */
    fun checkAdminLocal(user: String, password: String): Boolean {
        val parts = adminHash.split(":")
        if (parts.size != 2 || !user.trim().equals(adminUser, ignoreCase = true)) return false
        val salt = Base64.decode(parts[0], Base64.NO_WRAP)
        return MessageDigest.isEqual(Base64.decode(parts[1], Base64.NO_WRAP), pbkdf2(password, salt))
    }

    private fun pbkdf2(password: String, salt: ByteArray): ByteArray =
        SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1")
            .generateSecret(PBEKeySpec(password.toCharArray(), salt, 20000, 256)).encoded

    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)

    companion object {
        const val DEFAULT_SERVER = "https://accessctl.m-cyber-warrior.workers.dev"

        fun normalizeServer(raw: String): String {
            var s = raw.trim().trimEnd('/')
            if (s.isNotEmpty() && !s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
            return s
        }
    }
}
