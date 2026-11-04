package com.accessctl.door

import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The door logic, online only: every card is decided by the server. The phone keeps no
 * card list and no offline log; if the server can't be reached the scan is refused.
 */
class Door(private val prefs: Prefs, private val listener: Listener) {

    interface Listener {
        fun onScanResult(r: ScanResult)
        fun onServerState(online: Boolean)
        fun onRemoteOpen()
    }

    /** online = the server decided (the kiosk page shows it); false = the server was unreachable. */
    data class ScanResult(
        val uid: String, val result: String, val name: String,
        val direction: String, val online: Boolean,
    )

    private val main = Handler(Looper.getMainLooper())
    // separate threads so a slow heartbeat never delays a card scan
    private val scanExec = Executors.newSingleThreadExecutor()
    private val syncExec = Executors.newSingleThreadExecutor()

    @Volatile var serverOk = false
        private set

    private fun api() = Api(prefs.server, prefs.key)

    fun scan(uid: String) = scanExec.execute {
        val r = api().scan(uid)
        if (r.ok) {
            val j = r.json()
            val result = j.optString("result", if (j.optBoolean("granted")) "granted" else "denied")
            setServerOk(true)
            post { listener.onScanResult(ScanResult(uid, result, j.optString("name", ""), j.optString("direction", ""), true)) }
        } else {
            Log.w(TAG, "scan: server error ${r.code} ${r.body.take(120)} — refused")
            setServerOk(false)
            post { listener.onScanResult(ScanResult(uid, "offline", "", "", false)) }
        }
    }

    /** Heartbeat: keeps the door "online" on the server and picks up "Open" from the panel. */
    fun sync() = syncExec.execute {
        val body = JSONObject()
            .put("fw", "android-" + BuildConfig.VERSION_NAME)
            .put("events", JSONArray())
        val r = api().sync(body)
        setServerOk(r.ok)
        if (r.ok && r.json().optBoolean("open")) post { listener.onRemoteOpen() }
    }

    /** Absolute URL of this door's live screen, or null (with the reason) if the server can't be reached. */
    fun kioskUrl(cb: (url: String?, error: String?, code: Int) -> Unit) = syncExec.execute {
        val r = api().kiosk()
        val j = r.json()
        val path = j.optString("url", "")
        if (r.ok && path.isNotEmpty()) {
            prefs.doorName = j.optString("name", "")
            post { cb(prefs.server + path, null, r.code) }
        } else {
            post { cb(null, j.optString("error", "").ifEmpty { r.body.take(160) }, r.code) }
        }
    }

    private fun setServerOk(ok: Boolean) {
        if (serverOk == ok) return
        serverOk = ok
        post { listener.onServerState(ok) }
    }

    private fun post(r: () -> Unit) { main.post(r) }

    fun shutdown() {
        scanExec.shutdown()
        syncExec.shutdown()
    }

    companion object { const val TAG = "Door" }
}
