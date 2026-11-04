package com.accessctl.door

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The door logic of the Wemos firmware (server mode), running on the phone:
 * ask the server about each card, fall back to the cached card list when it is
 * unreachable, queue those scans and upload them with the next heartbeat.
 */
class Door(context: Context, private val listener: Listener) {

    interface Listener {
        fun onScanResult(r: ScanResult)
        fun onServerState(online: Boolean, queued: Int)
        fun onRemoteOpen()
    }

    /** online = decided by the server (the kiosk page shows it); otherwise decided on the phone. */
    data class ScanResult(
        val uid: String, val result: String, val name: String,
        val direction: String, val online: Boolean,
    )

    private val prefs = Prefs(context)
    private val store = OfflineStore(context)
    private val main = Handler(Looper.getMainLooper())
    // separate threads so a slow heartbeat never delays a card scan
    private val scanExec = Executors.newSingleThreadExecutor()
    private val syncExec = Executors.newSingleThreadExecutor()

    @Volatile var serverOk = false
        private set

    private fun api() = Api(prefs.server, prefs.key)
    private fun nowTs() = System.currentTimeMillis() / 1000

    fun scan(uid: String) = scanExec.execute {
        val r = api().scan(uid)
        if (r.ok) {
            val j = r.json()
            val result = j.optString("result", if (j.optBoolean("granted")) "granted" else "denied")
            val dir = j.optString("direction", "")
            if (result == "granted") store.setInside(uid, dir == "in")
            setServerOk(true)
            post { listener.onScanResult(ScanResult(uid, result, j.optString("name", ""), dir, true)) }
            return@execute
        }
        Log.w(TAG, "scan: server error ${r.code} ${r.body.take(120)} — deciding offline")
        // 4xx = the server answered but refused us (e.g. wrong key): still record it offline
        setServerOk(false)

        var name = ""
        var dir = ""
        val result: String
        val card = store.find(uid)
        if (!prefs.offlineFallback) {
            result = "denied"
            name = card?.name ?: ""
        } else if (card == null) {
            result = "unknown"
        } else {
            name = card.name
            if (!card.enabled) {
                result = "denied"
            } else {
                result = "granted"
                dir = if (card.inside) "out" else "in"      // server mode offline = toggle, like the firmware
                store.setInside(uid, dir == "in")
            }
        }
        store.enqueue(OfflineStore.Queued(nowTs(), uid, result, dir))
        post {
            listener.onScanResult(ScanResult(uid, result, name, dir, false))
            listener.onServerState(false, store.queued().size)
        }
    }

    /** Heartbeat: marks the door online, uploads offline scans, refreshes the card cache. */
    fun sync() = syncExec.execute {
        val pending = store.queued()
        val events = JSONArray()
        for (q in pending) {
            events.put(JSONObject().put("ts", q.ts).put("uid", q.uid).put("result", q.result).put("direction", q.direction))
        }
        val body = JSONObject()
            .put("fw", "android-" + BuildConfig.VERSION_NAME)
            .put("cards_version", prefs.cardsVersion)
            .put("events", events)
        val r = api().sync(body)
        if (!r.ok) {
            setServerOk(false)
            return@execute
        }
        store.dropQueued(pending.size)
        val j = r.json()
        if (j.optBoolean("open")) post { listener.onRemoteOpen() }
        val ver = j.optString("cards_version", "")
        if (ver.isNotEmpty() && (ver != prefs.cardsVersion || store.cardCount() == 0)) {
            val c = api().cards()
            if (c.ok) {
                store.replaceCards(c.body)
                prefs.cardsVersion = ver
                Log.i(TAG, "card cache updated: ${store.cardCount()} cards (v$ver)")
            }
        }
        setServerOk(true)
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

    fun queuedCount() = store.queued().size

    private fun setServerOk(ok: Boolean) {
        val changed = serverOk != ok
        serverOk = ok
        if (changed || !ok) {
            val n = store.queued().size
            post { listener.onServerState(ok, n) }
        }
    }

    private fun post(r: () -> Unit) { main.post(r) }

    fun shutdown() {
        scanExec.shutdown()
        syncExec.shutdown()
    }

    companion object { const val TAG = "Door" }
}
