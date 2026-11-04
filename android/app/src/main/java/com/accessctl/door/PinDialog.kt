package com.accessctl.door

import android.app.Activity
import android.app.AlertDialog
import android.text.InputType
import android.widget.EditText
import android.widget.Toast

object PinDialog {
    /** Runs [onOk] if [pin] is empty or the user types it correctly. */
    fun ask(a: Activity, pin: String, onOk: () -> Unit) {
        if (pin.isEmpty()) { onOk(); return }
        val input = EditText(a).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            isSingleLine = true
        }
        AlertDialog.Builder(a)
            .setTitle(R.string.pin_title)
            .setView(input)
            .setPositiveButton(R.string.ok) { _, _ ->
                if (input.text.toString() == pin) onOk()
                else Toast.makeText(a, R.string.pin_wrong, Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }
}
