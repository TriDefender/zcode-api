package com.zcode.proxy

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startService(Intent(this, ServerService::class.java))
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    AppScreen()
                }
            }
        }
    }

    @Composable
    private fun AppScreen() {
        val scope = rememberCoroutineScope()

        var reachable by remember { mutableStateOf(false) }
        var loggedIn by remember { mutableStateOf(false) }
        var provider by remember { mutableStateOf("bigmodel") }
        var plan by remember { mutableStateOf("coding-plan") }
        var proxyRunning by remember { mutableStateOf(false) }
        var proxyPort by remember { mutableStateOf(0) }
        var logCursor by remember { mutableStateOf(0) }
        val logs = remember { mutableStateOf<List<String>>(emptyList()) }
        var toast by remember { mutableStateOf<String?>(null) }

        LaunchedEffect(Unit) {
            while (true) {
                val cc = controlClient
                if (cc == null) {
                    reachable = false
                } else {
                    val resp = cc.status()
                    if (resp != null) {
                        reachable = true
                        loggedIn = resp.optBoolean("loggedIn", false)
                        provider = resp.optString("provider", provider)
                        plan = resp.optString("plan", plan)
                        proxyPort = resp.optInt("proxyPort", 0)
                        proxyRunning = proxyPort > 0
                    } else {
                        reachable = false
                    }
                    val logsResp = cc.getLogs(logCursor)
                    if (logsResp != null && logsResp.optBoolean("ok", false)) {
                        val next = logsResp.optInt("nextSince", logCursor)
                        val arr = logsResp.optJSONArray("lines")
                        if (arr != null && arr.length() > 0) {
                            val newLines = ArrayList<String>(arr.length())
                            for (i in 0 until arr.length()) newLines.add(arr.getString(i))
                            logs.value = (logs.value + newLines).takeLast(MAX_LOG_LINES)
                        }
                        logCursor = next
                    }
                }
                delay(POLL_INTERVAL_MS)
            }
        }

        LaunchedEffect(toast) {
            if (toast != null) {
                delay(2500)
                toast = null
            }
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("ZCode Proxy", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)

            SettingsLoginCard(
                reachable = reachable,
                loggedIn = loggedIn,
                provider = provider,
                plan = plan,
                proxyRunning = proxyRunning,
                onProviderChange = { newProvider ->
                    scope.launch {
                        val r = controlClient?.setConfig(provider = newProvider)
                        toast = if (r != null && r.optBoolean("ok", false)) "Provider → $newProvider"
                        else "setConfig failed: ${r?.optString("error") ?: "unreachable"}"
                        if (r != null && r.optBoolean("ok", false)) provider = newProvider
                    }
                },
                onPlanChange = { newPlan ->
                    scope.launch {
                        val r = controlClient?.setConfig(plan = newPlan)
                        toast = if (r != null && r.optBoolean("ok", false)) "Plan → $newPlan"
                        else "setConfig failed: ${r?.optString("error") ?: "unreachable"}"
                        if (r != null && r.optBoolean("ok", false)) plan = newPlan
                    }
                },
                onLogin = {
                    scope.launch {
                        val r = controlClient?.startOAuth(provider)
                        if (r != null && r.optBoolean("ok", false)) {
                            val url = r.optString("authorizeUrl")
                            val customTabsIntent = androidx.browser.customtabs.CustomTabsIntent.Builder()
                                .setShowTitle(true)
                                .build()
                            try {
                                customTabsIntent.launchUrl(this@MainActivity, android.net.Uri.parse(url))
                            } catch (e: Exception) {
                                val fallback = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
                                fallback.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                                try { startActivity(fallback) } catch (_: Exception) {}
                            }
                        } else {
                            toast = "startOAuth failed: ${r?.optString("error") ?: "unreachable"}"
                        }
                    }
                },
                onLogout = {
                    scope.launch {
                        val r = controlClient?.logout()
                        toast = if (r != null && r.optBoolean("ok", false)) "Logged out" else "Logout failed"
                    }
                },
            )

            ProxyControlCard(
                reachable = reachable,
                proxyRunning = proxyRunning,
                proxyPort = proxyPort,
                loggedIn = loggedIn,
                onStart = {
                    scope.launch {
                        val r = controlClient?.startProxy()
                        toast = if (r != null && r.optBoolean("ok", false)) {
                            "Proxy started on :${r.optInt("port")}"
                        } else {
                            "Start failed: ${r?.optString("error") ?: "unreachable"}"
                        }
                    }
                },
                onStop = {
                    scope.launch {
                        val r = controlClient?.stopProxy()
                        toast = if (r != null && r.optBoolean("ok", false)) "Proxy stopped"
                        else "Stop failed: ${r?.optString("error") ?: "unreachable"}"
                    }
                },
            )

            LogsCard(logs.value)

            toast?.let { msg ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0xFF1F2937), RoundedCornerShape(8.dp))
                        .padding(10.dp),
                ) {
                    Text(msg, color = Color.White, fontSize = 13.sp)
                }
            }
        }
    }

    @Composable
    private fun SettingsLoginCard(
        reachable: Boolean,
        loggedIn: Boolean,
        provider: String,
        plan: String,
        proxyRunning: Boolean,
        onProviderChange: (String) -> Unit,
        onPlanChange: (String) -> Unit,
        onLogin: () -> Unit,
        onLogout: () -> Unit,
    ) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Settings & Login", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                    Spacer(Modifier.weight(1f))
                    StatusPill(reachable = reachable, loggedIn = loggedIn)
                }

                SegmentedRow(
                    label = "Provider",
                    options = listOf("zai", "bigmodel"),
                    selected = provider,
                    onSelected = onProviderChange,
                    enabled = !proxyRunning,
                )

                SegmentedRow(
                    label = "Plan",
                    options = listOf("coding-plan", "start-plan"),
                    selected = plan,
                    onSelected = onPlanChange,
                    enabled = !proxyRunning,
                )

                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(
                        onClick = onLogin,
                        enabled = reachable && !loggedIn,
                        modifier = Modifier.weight(1f).semantics { testTag = "loginButton" },
                    ) { Text(if (loggedIn) "Logged In" else "OAuth Login") }
                    OutlinedButton(
                        onClick = onLogout,
                        enabled = reachable && loggedIn,
                        modifier = Modifier.weight(1f).semantics { testTag = "logoutButton" },
                    ) { Text("Logout") }
                }
            }
        }
    }

    @Composable
    private fun ProxyControlCard(
        reachable: Boolean,
        proxyRunning: Boolean,
        proxyPort: Int,
        loggedIn: Boolean,
        onStart: () -> Unit,
        onStop: () -> Unit,
    ) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Proxy Server", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                Text(
                    if (proxyRunning) "Running on 127.0.0.1:$proxyPort"
                    else if (!reachable) "Node unreachable"
                    else if (!loggedIn) "Not logged in — login first"
                    else "Stopped",
                    fontSize = 13.sp,
                    color = if (proxyRunning) Color(0xFF15803D) else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(
                        onClick = onStart,
                        enabled = reachable && !proxyRunning && loggedIn,
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF16A34A)),
                        modifier = Modifier.weight(1f).semantics { testTag = "startButton" },
                    ) { Text("Start Server") }
                    Button(
                        onClick = onStop,
                        enabled = reachable && proxyRunning,
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFDC2626)),
                        modifier = Modifier.weight(1f).semantics { testTag = "stopButton" },
                    ) { Text("Stop Server") }
                }
            }
        }
    }

    @Composable
    private fun LogsCard(lines: List<String>) {
        val listState = rememberLazyListState()
        LaunchedEffect(lines.size) {
            if (lines.isNotEmpty()) listState.animateScrollToItem(lines.lastIndex)
        }
        Card(
            modifier = Modifier.fillMaxWidth().heightIn(min = 180.dp, max = 600.dp),
            colors = CardDefaults.cardColors(containerColor = Color(0xFF111827)),
        ) {
            Column(modifier = Modifier.padding(8.dp)) {
                Text(
                    "Logs (${lines.size})",
                    color = Color(0xFF9CA3AF),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.padding(start = 4.dp, bottom = 4.dp),
                )
                HorizontalDivider(color = Color(0xFF374151))
                if (lines.isEmpty()) {
                    Text(
                        "No logs yet",
                        color = Color(0xFF6B7280),
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.padding(8.dp),
                    )
                } else {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxWidth().padding(4.dp),
                    ) {
                        items(lines.size) { idx ->
                            Text(
                                lines[idx],
                                color = Color(0xFFD1D5DB),
                                fontSize = 11.sp,
                                fontFamily = FontFamily.Monospace,
                                modifier = Modifier.padding(vertical = 1.dp),
                            )
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun SegmentedRow(
        label: String,
        options: List<String>,
        selected: String,
        onSelected: (String) -> Unit,
        enabled: Boolean,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(label, fontSize = 13.sp, modifier = Modifier.width(70.dp))
            options.forEach { opt ->
                val isSelected = opt == selected
                Button(
                    onClick = { onSelected(opt) },
                    enabled = enabled && !isSelected,
                    colors = if (isSelected) {
                        ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.primary,
                            contentColor = MaterialTheme.colorScheme.onPrimary,
                        )
                    } else {
                        ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.surface,
                            contentColor = MaterialTheme.colorScheme.onSurface,
                        )
                    },
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier
                        .padding(end = 8.dp)
                        .height(36.dp),
                ) {
                    Text(if (isSelected) "✓ $opt" else opt, fontSize = 12.sp)
                }
            }
        }
    }

    @Composable
    private fun StatusPill(reachable: Boolean, loggedIn: Boolean) {
        val (color, text) = when {
            !reachable -> Color(0xFFEF4444) to "unreachable"
            !loggedIn -> Color(0xFFF59E0B) to "logged out"
            else -> Color(0xFF22C55E) to "ready"
        }
        Box(
            modifier = Modifier
                .background(color, RoundedCornerShape(10.dp))
                .padding(horizontal = 10.dp, vertical = 3.dp),
        ) {
            Text(text, color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Medium)
        }
    }

    companion object {
        var controlClient: ControlClient? = null
        private const val POLL_INTERVAL_MS = 1500L
        private const val MAX_LOG_LINES = 500
    }
}
