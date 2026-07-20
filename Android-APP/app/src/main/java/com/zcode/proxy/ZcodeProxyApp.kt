package com.zcode.proxy

import android.app.Application
import android.util.Log

class ZcodeProxyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        lateinit var instance: ZcodeProxyApp
            private set
        private const val TAG = "ZcodeProxyApp"
    }
}
