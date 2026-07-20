package com.zcode.proxy

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.net.ServerSocket
import java.util.concurrent.ConcurrentLinkedDeque

class NodeRunner(private val context: Context) {

    val controlPort: Int = allocateOrReusePort()
    val callbackPort: Int = controlPort + 1
    private var process: Process? = null

    private val logLines: ConcurrentLinkedDeque<String> = ConcurrentLinkedDeque()

    suspend fun ensureAssetsExtracted() = withContext(Dispatchers.IO) {
        val targetDir = File(context.filesDir, "server_bundle")
        val assetManager = context.assets
        val filesToExtract = listOf(
            "server_bundle/server.cjs",
            "server_bundle/config.example.yaml",
            "server_bundle/webui.txt",
            "server_bundle/zcode_system.json",
            "server_bundle/AliyunCaptcha.js.txt",
        )
        targetDir.mkdirs()
        for (assetPath in filesToExtract) {
            val outFile = File(context.filesDir, assetPath)
            outFile.parentFile?.mkdirs()
            assetManager.open(assetPath).use { input ->
                FileOutputStream(outFile).use { output -> input.copyTo(output) }
            }
            Log.i(TAG, "extracted $assetPath (${outFile.length()} bytes)")
        }
    }

    suspend fun start() = withContext(Dispatchers.IO) {
        val nativeDir = context.applicationInfo.nativeLibraryDir
        val libnode = File(nativeDir, "libnode.so")
        require(libnode.exists()) {
            "libnode.so not found in $nativeDir. Did downloadNodeBinary run?"
        }

        val serverBundle = File(context.filesDir, "server_bundle").apply { mkdirs() }
        val serverCjs = File(serverBundle, "server.cjs")
        require(serverCjs.exists()) {
            "server.cjs not found in ${serverBundle.absolutePath}. Did copyServerBundle run?"
        }

        val config = File(context.filesDir, "config.yaml")
        if (!config.exists()) {
            config.writeText(DEFAULT_CONFIG)
        }

        val credentialSeed = CredentialStore.getOrCreateSeed(context)

        val pb = ProcessBuilder(
            libnode.absolutePath,
            "--no-warnings",
            serverCjs.absolutePath,
            "android",
        ).apply {
            redirectErrorStream(true)
            directory(context.filesDir)
            environment()["HOME"] = context.filesDir.absolutePath
            environment()["LD_LIBRARY_PATH"] = nativeDir
            environment()["NODE_PATH"] = File(serverBundle, "node_modules").absolutePath
            environment()["ZCODE_CONTROL_PORT"] = controlPort.toString()
            environment()["ZCODE_OAUTH_CALLBACK_PORT"] = callbackPort.toString()
            environment()["ZCODE_PROXY_CREDENTIAL_SECRET"] = credentialSeed
            environment()["ZCODE_IDENTITY_PLATFORM"] = "linux"
            environment()["ZCODE_IDENTITY_ARCH"] = "x64"
            environment()["ZCODE_IDENTITY_RELEASE"] = "6.8.0"
            environment()["ZCODE_PROXY_CONFIG"] = config.absolutePath
            environment()["ZCODE_LOG_FORMAT"] = "compact"
        }

        val p = pb.start()
        process = p
        Log.i(TAG, "Node.js started (controlPort=$controlPort)")

        Thread({
            BufferedReader(InputStreamReader(p.inputStream, Charsets.UTF_8)).use { reader ->
                while (true) {
                    val line = reader.readLine() ?: break
                    appendLog(line)
                }
            }
            val exit = try { p.exitValue() } catch (_: IllegalThreadStateException) { -1 }
            Log.i(TAG, "Node stdout stream closed (exit=$exit)")
        }, "node-stdout").start()
    }

    fun snapshotLogs(): List<String> = logLines.toList()

    fun stop() {
        process?.destroy()
        process = null
    }

    private fun appendLog(line: String) {
        Log.i("Node", line)
        logLines.addLast(line)
        while (logLines.size > LOG_CAPACITY) {
            logLines.pollFirst()
        }
    }

    private fun allocateOrReusePort(): Int {
        val portFile = File(context.filesDir, "control-port")
        if (portFile.exists()) {
            val cached = portFile.readText().trim().toIntOrNull()
            if (cached != null && isPortFree(cached)) return cached
        }
        ServerSocket(0).use { s ->
            val port = s.localPort
            portFile.writeText(port.toString())
            return port
        }
    }

    private fun isPortFree(port: Int): Boolean = try {
        ServerSocket(port).use { it }
        true
    } catch (e: Exception) {
        false
    }

    companion object {
        private const val TAG = "NodeRunner"
        private const val LOG_CAPACITY = 500
        private val DEFAULT_CONFIG = """
            server:
              host: "127.0.0.1"
              port: 8080
            auth:
              mode: oauth
            provider: bigmodel
            plan: coding-plan
        """.trimIndent()
    }
}
