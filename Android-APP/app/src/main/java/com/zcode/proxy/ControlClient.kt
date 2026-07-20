package com.zcode.proxy

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.Socket

class ControlClient(private val controlPort: Int) {

    suspend fun connect() = withContext(Dispatchers.IO) {
        try {
            request(JSONObject().put("cmd", "status"))
            Log.i(TAG, "Control listener reachable on port $controlPort")
        } catch (t: Throwable) {
            Log.w(TAG, "Control listener not yet reachable: ${t.message}")
        }
    }

    suspend fun status(): JSONObject? = withContext(Dispatchers.IO) {
        try {
            request(JSONObject().put("cmd", "status"))
        } catch (t: Throwable) {
            Log.w(TAG, "status failed: ${t.message}")
            null
        }
    }

    suspend fun startOAuth(provider: String): JSONObject? = withContext(Dispatchers.IO) {
        try {
            request(JSONObject().put("cmd", "startOAuth").put("provider", provider))
        } catch (t: Throwable) {
            Log.e(TAG, "startOAuth failed", t)
            null
        }
    }

    suspend fun deliverOAuthCode(provider: String, code: String, state: String): JSONObject? =
        withContext(Dispatchers.IO) {
            try {
                request(JSONObject()
                    .put("cmd", "deliverOAuthCode")
                    .put("provider", provider)
                    .put("code", code)
                    .put("state", state))
            } catch (t: Throwable) {
                Log.e(TAG, "deliverOAuthCode failed", t)
                null
            }
        }

    suspend fun logout(): JSONObject? = withContext(Dispatchers.IO) {
        try { request(JSONObject().put("cmd", "logout")) } catch (t: Throwable) { null }
    }

    suspend fun setConfig(provider: String? = null, plan: String? = null): JSONObject? =
        withContext(Dispatchers.IO) {
            try {
                val body = JSONObject().put("cmd", "setConfig")
                if (provider != null) body.put("provider", provider)
                if (plan != null) body.put("plan", plan)
                request(body)
            } catch (t: Throwable) {
                Log.e(TAG, "setConfig failed", t)
                null
            }
        }

    suspend fun startProxy(): JSONObject? = withContext(Dispatchers.IO) {
        try {
            request(JSONObject().put("cmd", "startProxy"))
        } catch (t: Throwable) {
            Log.e(TAG, "startProxy failed", t)
            null
        }
    }

    suspend fun stopProxy(): JSONObject? = withContext(Dispatchers.IO) {
        try {
            request(JSONObject().put("cmd", "stopProxy"))
        } catch (t: Throwable) {
            Log.e(TAG, "stopProxy failed", t)
            null
        }
    }

    suspend fun getLogs(since: Int): JSONObject? = withContext(Dispatchers.IO) {
        try {
            request(JSONObject().put("cmd", "getLogs").put("since", since))
        } catch (t: Throwable) {
            null
        }
    }

    fun close() {
    }

    private fun request(body: JSONObject): JSONObject {
        val sock = Socket(InetAddress.getByName("127.0.0.1"), controlPort)
        try {
            sock.soTimeout = CONTROL_TIMEOUT_MS
            val bodyBytes = body.toString().toByteArray(Charsets.UTF_8)
            val req = "POST /control HTTP/1.1\r\n" +
                "Host: 127.0.0.1\r\n" +
                "Content-Type: application/json\r\n" +
                "Content-Length: ${bodyBytes.size}\r\n" +
                "Connection: close\r\n\r\n"
            val out: OutputStream = sock.getOutputStream()
            out.write(req.toByteArray(Charsets.US_ASCII))
            out.write(bodyBytes)
            out.flush()

            val reader = BufferedReader(InputStreamReader(sock.getInputStream(), Charsets.UTF_8))
            var contentLength = -1
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                if (line.lowercase().startsWith("content-length:")) {
                    contentLength = line.substringAfter(":").trim().toIntOrNull() ?: -1
                }
            }
            val sb = StringBuilder()
            if (contentLength > 0) {
                val buf = CharArray(contentLength)
                var read = 0
                while (read < contentLength) {
                    val n = reader.read(buf, read, contentLength - read)
                    if (n < 0) break
                    read += n
                }
                sb.append(buf, 0, read)
            } else {
                while (true) {
                    val line = reader.readLine() ?: break
                    sb.append(line)
                }
            }
            return JSONObject(sb.toString())
        } finally {
            sock.close()
        }
    }

    companion object {
        private const val TAG = "ControlClient"
        private const val CONTROL_TIMEOUT_MS = 10_000
    }
}
