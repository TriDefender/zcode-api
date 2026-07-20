package com.zcode.proxy

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class ServerService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var nodeJob: Job? = null
    private var nodeRunner: NodeRunner? = null
    private var controlClient: ControlClient? = null

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
        startForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (nodeJob?.isActive != true) {
            nodeJob = scope.launch {
                try {
                    val runner = NodeRunner(applicationContext)
                    runner.ensureAssetsExtracted()
                    runner.start()
                    nodeRunner = runner
                    controlClient = ControlClient(runner.controlPort).also { it.connect() }
                    MainActivity.controlClient = controlClient
                } catch (t: Throwable) {
                    Log.e(TAG, "Node.js failed to start", t)
                }
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        nodeJob?.cancel()
        controlClient?.close()
        nodeRunner?.stop()
        scope.cancel()
        super.onDestroy()
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "ZCode Proxy Service",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Keeps the proxy server running in the background"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun startForeground() {
        val notif = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("ZCode Proxy")
            .setContentText("Running")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    companion object {
        private const val TAG = "ServerService"
        private const val CHANNEL_ID = "zcode-proxy-service"
        private const val NOTIF_ID = 1001
    }
}
