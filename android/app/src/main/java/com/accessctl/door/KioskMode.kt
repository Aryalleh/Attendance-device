package com.accessctl.door

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.provider.Settings
import android.util.Log

/** Locking the phone to the kiosk screen (Android "lock task" / screen pinning). */
object KioskMode {
    private const val TAG = "KioskMode"

    private fun dpm(c: Context) = c.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    private fun admin(c: Context) = ComponentName(c, AdminReceiver::class.java)

    fun isDeviceOwner(c: Context) = dpm(c).isDeviceOwnerApp(c.packageName)

    fun lockPermitted(c: Context) = dpm(c).isLockTaskPermitted(c.packageName)

    fun inLockTask(c: Context): Boolean {
        val am = c.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        return am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
    }

    /**
     * Device-owner mode (set once with adb, see android/README.md): the app becomes the permanent
     * Home app, lock-task starts without a prompt, and the lock screen / status bar are disabled.
     */
    fun applyDeviceOwnerPolicies(c: Context, prefs: Prefs) {
        if (!isDeviceOwner(c)) return
        val dpm = dpm(c)
        val admin = admin(c)
        try {
            dpm.setLockTaskPackages(admin, arrayOf(c.packageName))
            val home = IntentFilter(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME)
                addCategory(Intent.CATEGORY_DEFAULT)
            }
            dpm.addPersistentPreferredActivity(admin, home, ComponentName(c, KioskActivity::class.java))
            dpm.setKeyguardDisabled(admin, prefs.lockTask)
            dpm.setStatusBarDisabled(admin, prefs.lockTask)
            // keep the screen on while charging (AC | USB | wireless): the phone lives on a charger by the door
            dpm.setGlobalSetting(admin, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, "7")
        } catch (e: Exception) {
            Log.w(TAG, "device owner policies: $e")
        }
    }

    fun startLock(a: Activity) {
        try { a.startLockTask() } catch (e: Exception) { Log.w(TAG, "startLockTask: $e") }
    }

    /** Hand the phone back to the normal launcher (until the app is opened again). */
    fun leave(a: Activity) {
        try { if (inLockTask(a)) a.stopLockTask() } catch (e: Exception) { Log.w(TAG, "stopLockTask: $e") }
        if (!isDeviceOwner(a)) return
        val dpm = dpm(a)
        val admin = admin(a)
        try {
            dpm.clearPackagePersistentPreferredActivities(admin, a.packageName)
            dpm.setKeyguardDisabled(admin, false)
            dpm.setStatusBarDisabled(admin, false)
            dpm.setGlobalSetting(admin, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, "0")
        } catch (e: Exception) {
            Log.w(TAG, "leave: $e")
        }
    }

    /** Needed before the app can be uninstalled. */
    fun removeDeviceOwner(a: Activity) {
        leave(a)
        try {
            @Suppress("DEPRECATION")
            dpm(a).clearDeviceOwnerApp(a.packageName)
        } catch (e: Exception) {
            Log.w(TAG, "clearDeviceOwnerApp: $e")
        }
    }
}
