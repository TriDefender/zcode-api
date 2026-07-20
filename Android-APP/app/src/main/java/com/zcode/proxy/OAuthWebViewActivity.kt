package com.zcode.proxy

import android.annotation.SuppressLint
import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class OAuthWebViewActivity : Activity() {
    private lateinit var webView: WebView
    private val scope = CoroutineScope(SupervisorJob() + kotlinx.coroutines.Dispatchers.Main)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val authorizeUrl = intent.getStringExtra(EXTRA_AUTHORIZE_URL) ?: run {
            Log.e(TAG, "Missing EXTRA_AUTHORIZE_URL; finishing.")
            finish()
            return
        }
        val provider = intent.getStringExtra(EXTRA_PROVIDER) ?: "bigmodel"
        val controlClient = MainActivity.controlClient

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            settings.setAllowFileAccess(false)
            settings.userAgentString = DESKTOP_UA
            webViewClient = OAuthWebClient(provider, controlClient) { success ->
                setResult(if (success) RESULT_OK else RESULT_CANCELED)
                finish()
            }
        }
        setContentView(webView)
        webView.loadUrl(authorizeUrl)
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private inner class OAuthWebClient(
        private val provider: String,
        private val controlClient: ControlClient?,
        private val onDone: (Boolean) -> Unit,
    ) : WebViewClient() {

        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
            val urlStr = request?.url?.toString() ?: return false
            val uri = Uri.parse(urlStr)
            val host = uri.host ?: return false
            if (host != "127.0.0.1" && host != "localhost") return false

            val code = uri.getQueryParameter("authCode")
                ?: uri.getQueryParameter("code")
                ?: return true.also { Log.w(TAG, "callback without code: $urlStr") }
            val state = uri.getQueryParameter("state") ?: ""

            view?.loadDataWithBaseURL(
                null,
                "<html><body><h2>Authorization received</h2><p>Returning to app…</p></body></html>",
                "text/html", "UTF-8", null,
            )

            scope.launch {
                val resp = controlClient?.deliverOAuthCode(provider, code, state)
                val ok = resp?.optBoolean("ok", false) == true
                onDone(ok)
            }
            return true
        }
    }

    companion object {
        private const val TAG = "OAuthWebViewActivity"
        const val EXTRA_AUTHORIZE_URL = "authorizeUrl"
        const val EXTRA_PROVIDER = "provider"
        private const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    }
}
