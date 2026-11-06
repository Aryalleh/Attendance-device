package com.accessctl.door

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.Uri
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The phone *is* the door device: its NFC antenna reads the cards, it talks to the server
 * like the Wemos does, and its screen shows the door's live (kiosk) screen full time.
 */
class KioskActivity : Activity(), NfcAdapter.ReaderCallback, Door.Listener {

    private lateinit var prefs: Prefs
    private lateinit var door: Door
    private lateinit var web: WebView
    private lateinit var nativeScreen: View
    private lateinit var overlay: LinearLayout
    private lateinit var banner: TextView
    private lateinit var nativeStatus: TextView

    private val main = Handler(Looper.getMainLooper())
    private var nfc: NfcAdapter? = null
    private var tones: ToneGenerator? = null

    private var pageLoaded = false
    private var pageLoading = false
    private var serverOnline = false
    private var lastUid = ""
    private var lastScanMs = 0L
    private var cornerTaps = 0
    private var cornerFirstTapMs = 0L
    private var lockRequested = false
    private var loadedFor = ""     // server|key the live page was loaded with

    private val syncLoop = object : Runnable {
        override fun run() {
            door.sync()
            if (!pageLoaded && !pageLoading) loadKiosk()
            main.postDelayed(this, SYNC_INTERVAL_MS)
        }
    }
    private val hideOverlay = Runnable { overlay.visibility = View.GONE }

    // ------------------------------------------------------------------ lifecycle

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        prefs.kioskEnabled = true   // opened (again) by boot, Home or the launcher: back to kiosk mode
        setContentView(R.layout.activity_kiosk)
        web = findViewById(R.id.web)
        nativeScreen = findViewById(R.id.nativeScreen)
        overlay = findViewById(R.id.overlay)
        banner = findViewById(R.id.banner)
        nativeStatus = findViewById(R.id.nativeStatus)
        findViewById<TextView>(R.id.doorName).text = prefs.doorName

        door = Door(prefs, this)
        nfc = NfcAdapter.getDefaultAdapter(this)
        tones = try { ToneGenerator(AudioManager.STREAM_MUSIC, 90) } catch (_: Exception) { null }

        setupWindow()
        setupWebView()
        findViewById<View>(R.id.adminCorner).setOnClickListener { onCornerTap() }
        overlay.setOnClickListener { overlay.visibility = View.GONE }
    }

    override fun onResume() {
        super.onResume()
        if (!prefs.configured) {
            startActivity(Intent(this, SettingsActivity::class.java))
            return
        }
        KioskMode.applyDeviceOwnerPolicies(this, prefs)
        if (prefs.lockTask && !KioskMode.inLockTask(this) && (!lockRequested || KioskMode.lockPermitted(this))) {
            // without device owner Android asks "pin this app?" — ask only once per launch
            lockRequested = true
            KioskMode.startLock(this)
        } else if (!prefs.lockTask && KioskMode.inLockTask(this)) {
            try { stopLockTask() } catch (_: Exception) {}
        }
        hideSystemBars()
        startReader()
        if (pageLoaded && loadedFor != prefs.server + "|" + prefs.key) pageLoaded = false   // settings changed
        if (!pageLoaded && !pageLoading) loadKiosk()
        main.removeCallbacks(syncLoop)
        main.post(syncLoop)
    }

    override fun onPause() {
        super.onPause()
        nfc?.let { try { it.disableReaderMode(this) } catch (_: Exception) {} }
        main.removeCallbacks(syncLoop)
    }

    override fun onDestroy() {
        door.shutdown()
        tones?.release()
        web.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    @Deprecated("Back does nothing on a kiosk")
    @SuppressLint("MissingSuperCall")
    override fun onBackPressed() { /* stay on the kiosk screen */ }

    // ------------------------------------------------------------------ window / kiosk

    private fun setupWindow() {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
    }

    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
        }
    }

    // ------------------------------------------------------------------ admin access

    private fun onCornerTap() {
        val now = SystemClock.elapsedRealtime()
        if (now - cornerFirstTapMs > 3000) { cornerFirstTapMs = now; cornerTaps = 0 }
        if (++cornerTaps >= 5) {
            cornerTaps = 0
            PinDialog.ask(this, prefs.pin) { startActivity(Intent(this, SettingsActivity::class.java)) }
        }
    }

    // ------------------------------------------------------------------ live screen

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false   // the page plays its chimes without a tap
            builtInZoomControls = false
            setSupportZoom(false)
        }
        web.isLongClickable = false
        web.setOnLongClickListener { true }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // stay on our server; never navigate the kiosk anywhere else
                val host = Uri.parse(prefs.server).host
                return request.url.host != host
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!pageLoading) return
                pageLoading = false
                pageLoaded = true
                web.visibility = View.VISIBLE
                nativeScreen.visibility = View.GONE
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame) pageFailed("HTTP ${response.statusCode}")
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) pageFailed(error.description?.toString() ?: "")
            }
        }
    }

    private fun loadKiosk() {
        pageLoading = true
        loadedFor = prefs.server + "|" + prefs.key
        nativeStatus.setText(R.string.connecting)
        door.kioskUrl { url, err, code ->
            if (url == null) {
                pageFailed(if (code == 401) getString(R.string.bad_key) else err ?: "")
                return@kioskUrl
            }
            findViewById<TextView>(R.id.doorName).text = prefs.doorName
            web.loadUrl(url)
        }
    }

    private fun pageFailed(why: String) {
        Log.w(TAG, "kiosk page not available: $why")
        pageLoading = false
        pageLoaded = false
        web.visibility = View.INVISIBLE
        nativeScreen.visibility = View.VISIBLE
        nativeStatus.text = if (why.isNotEmpty()) "${getString(R.string.offline)}\n$why" else getString(R.string.offline)
        // the sync loop retries every few seconds
    }

    // ------------------------------------------------------------------ NFC reader

    private fun startReader() {
        val a = nfc
        when {
            a == null -> showBanner(getString(R.string.no_nfc))
            !a.isEnabled -> showBanner(getString(R.string.nfc_off))
            else -> {
                updateBanner()
                val flags = NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or
                    NfcAdapter.FLAG_READER_NFC_F or NfcAdapter.FLAG_READER_NFC_V or
                    NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS
                val opts = Bundle().apply { putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250) }
                a.enableReaderMode(this, this, flags, opts)
            }
        }
    }

    /** Runs on an NFC binder thread. */
    override fun onTagDiscovered(tag: Tag) {
        val id = tag.id ?: return
        if (id.size < 4) return              // the server accepts 4..10 byte UIDs
        val uid = id.joinToString(":") { "%02X".format(it) }
        main.post {
            val now = SystemClock.elapsedRealtime()
            if (uid == lastUid && now - lastScanMs < SCAN_REPEAT_MS) return@post
            lastUid = uid
            lastScanMs = now
            beep(ToneGenerator.TONE_PROP_BEEP, 80)   // "card read", like the buzzer on the Wemos
            vibrate(40)
            door.scan(uid)
        }
    }

    // ------------------------------------------------------------------ Door.Listener

    override fun onScanResult(r: Door.ScanResult) {
        if (r.online && pageLoaded) {
            // the server logged it; the live page shows it with its own sound on the next poll — make that now
            web.evaluateJavascript("window.pollNow && window.pollNow()", null)
            if (r.result != "granted") vibrate(250)
            return
        }
        showResult(r)
    }

    override fun onServerState(online: Boolean) {
        serverOnline = online
        updateBanner()
        if (online && !pageLoaded && !pageLoading) loadKiosk()
    }

    override fun onRemoteOpen() {
        if (pageLoaded) web.evaluateJavascript("window.pollNow && window.pollNow()", null)
        else showResult(Door.ScanResult("", "manual", "", "", false))
    }

    // ------------------------------------------------------------------ feedback

    private fun showResult(r: Door.ScanResult) {
        val ok = r.result == "granted"
        val info = r.result == "manual"
        val unreachable = !ok && !info && !r.online
        val color = when { ok -> OK; info -> INFO; unreachable -> WARN; else -> BAD }
        val icon = findViewById<ImageView>(R.id.ovIcon)
        icon.setImageResource(when {
            info -> R.drawable.ic_result_door
            ok && r.direction == "out" -> R.drawable.ic_result_out
            ok -> R.drawable.ic_result_ok
            unreachable -> R.drawable.ic_result_wifi
            r.result == "disabled" -> R.drawable.ic_result_blocked
            r.result == "expired" -> R.drawable.ic_result_expired
            r.result == "denied" -> R.drawable.ic_result_door
            else -> R.drawable.ic_result_bad
        })
        icon.imageTintList = ColorStateList.valueOf(color)
        icon.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setStroke(dp(4), color)
            setColor(Color.argb(38, Color.red(color), Color.green(color), Color.blue(color)))
        }
        val title = findViewById<TextView>(R.id.ovTitle)
        title.setTextColor(color)
        title.text = getString(when {
            info -> R.string.remote_open
            ok && r.direction == "out" -> R.string.goodbye
            ok && r.direction == "in" -> R.string.welcome
            ok -> R.string.granted
            unreachable -> R.string.server_unreachable
            else -> R.string.denied
        })
        findViewById<TextView>(R.id.ovName).text = when {
            unreachable -> getString(R.string.card_not_checked)
            r.result == "unknown" -> getString(R.string.unknown_card)
            else -> r.name
        }
        val sub = when {
            info -> ""
            ok && r.direction == "in" -> getString(R.string.entry_logged)
            ok && r.direction == "out" -> getString(R.string.exit_logged)
            ok -> ""
            unreachable -> getString(R.string.try_again)
            r.result == "unknown" -> r.uid
            r.result == "disabled" -> getString(R.string.card_disabled)
            r.result == "expired" -> getString(R.string.card_expired)
            r.result == "not_member" -> getString(R.string.not_member)
            else -> getString(R.string.door_disabled)
        }
        findViewById<TextView>(R.id.ovSub).text = sub
        overlay.visibility = View.VISIBLE
        main.removeCallbacks(hideOverlay)
        main.postDelayed(hideOverlay, RESULT_HOLD_MS)

        if (ok || info) {
            beep(ToneGenerator.TONE_PROP_ACK, 300)
        } else {
            beep(ToneGenerator.TONE_SUP_ERROR, 600)
            vibrate(250)
        }
    }

    private fun updateBanner() {
        val a = nfc
        when {
            a == null -> showBanner(getString(R.string.no_nfc))
            !a.isEnabled -> showBanner(getString(R.string.nfc_off))
            !serverOnline && pageLoaded -> showBanner(getString(R.string.offline))
            else -> banner.visibility = View.GONE
        }
    }

    private fun showBanner(text: String) {
        banner.text = text
        banner.visibility = View.VISIBLE
    }

    private fun beep(tone: Int, ms: Int) {
        try { tones?.startTone(tone, ms) } catch (_: Exception) {}
    }

    private fun vibrate(ms: Long) {
        val v = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
        if (Build.VERSION.SDK_INT >= 26) {
            v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            v.vibrate(ms)
        }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        const val TAG = "Kiosk"
        const val SYNC_INTERVAL_MS = 5000L     // same heartbeat as the firmware
        const val SCAN_REPEAT_MS = 2000L       // ignore the same card held on the phone
        const val RESULT_HOLD_MS = 5000L
        // SecureEntry tokens, same as res/values/colors.xml and cloudflare/src/live.html
        val OK = Color.parseColor("#22C55E")
        val BAD = Color.parseColor("#EF4444")
        val INFO = Color.parseColor("#818CF8")
        val WARN = Color.parseColor("#F59E0B")
    }
}
