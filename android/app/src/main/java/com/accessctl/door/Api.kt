package com.accessctl.door

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** The same device API the Wemos firmware uses (/api/v1/*), authenticated with X-Device-Key. */
class Api(private val base: String, private val key: String) {

    class Reply(val code: Int, val body: String) {
        val ok get() = code == 200
        fun json(): JSONObject = try { JSONObject(body) } catch (_: Exception) { JSONObject() }
    }

    private val https = base.startsWith("https://")

    /** Never throws: a network failure is returned as code -1 with the message as body. */
    fun call(method: String, path: String, body: JSONObject? = null, readTimeoutMs: Int = if (https) 5000 else 3000): Reply {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(base + path).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = if (https) 5000 else 3000
                readTimeout = readTimeoutMs
                useCaches = false
                setRequestProperty("X-Device-Key", key)
                setRequestProperty("Accept", "application/json")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
            }
            if (body != null) conn.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            Reply(code, text)
        } catch (e: IOException) {
            Reply(-1, e.message ?: e.javaClass.simpleName)
        } catch (e: Exception) {
            Reply(-1, e.message ?: e.javaClass.simpleName)
        } finally {
            conn?.disconnect()
        }
    }

    fun scan(uid: String) = call("POST", "/api/v1/scan", JSONObject().put("uid", uid))
    fun sync(body: JSONObject) = call("POST", "/api/v1/sync", body)
    fun cards() = call("GET", "/api/v1/cards", readTimeoutMs = 15000)
    fun kiosk() = call("GET", "/api/v1/kiosk")
}
