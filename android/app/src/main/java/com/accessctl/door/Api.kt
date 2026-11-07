package com.accessctl.door

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The same device API the Wemos firmware uses (the /api/v1 calls), authenticated with X-Device-Key.
 * Setup uses /api/v1/app/login without a key: the admin signs in and the server hands out the door's key.
 */
class Api(private val base: String, private val key: String = "") {

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
                if (key.isNotEmpty()) setRequestProperty("X-Device-Key", key)
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

    private fun creds(user: String, password: String) = JSONObject().put("username", user).put("password", password)
    /** The company's doors for this admin. */
    fun appDoors(user: String, password: String) = call("POST", "/api/v1/app/login", creds(user, password), 10000)
    /** Pair with door [id], or create a door named [newName] when id is null. Returns its key. */
    fun appPair(user: String, password: String, id: Int?, newName: String) =
        call("POST", "/api/v1/app/login", creds(user, password).put("door", id ?: "new").put("name", newName), 10000)
    /** Is this an admin of the door's company? (unlocks the settings) */
    fun appUnlock(user: String, password: String) = call("POST", "/api/v1/app/unlock", creds(user, password), 8000)
}
