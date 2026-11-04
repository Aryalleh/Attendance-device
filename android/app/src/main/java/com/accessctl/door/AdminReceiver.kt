package com.accessctl.door

import android.app.admin.DeviceAdminReceiver

/** Lets the app be made "device owner" for a full kiosk lock-down (see android/README.md). */
class AdminReceiver : DeviceAdminReceiver()
