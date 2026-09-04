package com.zcode.proxy

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.drawable.toBitmap
import com.zcode.proxy.ui.theme.Mono
import com.zcode.proxy.ui.theme.ThemeMode
import com.zcode.proxy.ui.theme.ThemePrefs
import com.zcode.proxy.ui.theme.ZcodeTheme
import com.zcode.proxy.ui.theme.dimColor
import com.zcode.proxy.ui.theme.isDarkTheme
import com.zcode.proxy.ui.theme.successColor
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        startService(Intent(this, ServerService::class.java))
        setContent {
            var themeMode by remember { mutableStateOf(ThemePrefs.load(this)) }
            ZcodeTheme(themeMode) {
                AppScreen(
                    themeMode = themeMode,
                    onThemeModeChange = { mode ->
                        themeMode = mode
                        ThemePrefs.save(this, mode)
                    },
                )
            }
        }
    }

    companion object {
        var controlClient: ControlClient? = null
    }
}

private const val POLL_INTERVAL_MS = 1500L
private const val MAX_LOG_LINES = 500
private const val SPARKLINE_MINUTES = 60

@Composable
private fun AppScreen(themeMode: ThemeMode, onThemeModeChange: (ThemeMode) -> Unit) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current

    var reachable by remember { mutableStateOf(false) }
    var loggedIn by remember { mutableStateOf(false) }
    var provider by remember { mutableStateOf("bigmodel") }
    var plan by remember { mutableStateOf("coding-plan") }
    var proxyPort by remember { mutableStateOf(0) }
    var proxyRunning by remember { mutableStateOf(false) }
    var logCursor by remember { mutableStateOf(0) }
    val logs = remember { mutableStateListOf<String>() }
    val minuteBuckets = remember { mutableStateListOf<Pair<Long, Int>>() }
    var toast by remember { mutableStateOf<String?>(null) }
    var tab by rememberSaveable { mutableStateOf(0) }

    // 运行时长：false→true 记起点；每秒刷新一次仅用于英雄卡 uptime
    var runningSince by remember { mutableStateOf<Long?>(null) }
    var nowMs by remember { mutableLongStateOf(0L) }
    LaunchedEffect(proxyRunning) {
        runningSince = if (proxyRunning) System.currentTimeMillis() else null
        nowMs = System.currentTimeMillis()
        if (proxyRunning) {
            while (isActive) {
                delay(1000)
                nowMs = System.currentTimeMillis()
            }
        }
    }

    // 轮询：status + 增量 getLogs（协议与旧版一致，1.5s）
    LaunchedEffect(Unit) {
        while (true) {
            val cc = MainActivity.controlClient
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
                        logs.addAll(newLines)
                        while (logs.size > MAX_LOG_LINES) logs.removeAt(0)
                        // 按分钟桶聚合请求数，供 sparkline 使用
                        val bucket = System.currentTimeMillis() / 60000L
                        if (minuteBuckets.isNotEmpty() && minuteBuckets.last().first == bucket) {
                            minuteBuckets[minuteBuckets.lastIndex] =
                                bucket to (minuteBuckets.last().second + newLines.size)
                        } else {
                            minuteBuckets.add(bucket to newLines.size)
                            while (minuteBuckets.size > SPARKLINE_MINUTES) minuteBuckets.removeAt(0)
                        }
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

    val errRegex = remember { Regex("\\b(4\\d\\d|5\\d\\d)\\b") }
    val errorCount = logs.count { errRegex.containsMatchIn(it) }
    val sparkData: List<Int> = remember(minuteBuckets.toList(), nowMs) {
        if (minuteBuckets.isEmpty()) {
            emptyList()
        } else {
            val firstMinute = minuteBuckets.first().first
            val currentMinute = nowMs / 60000L
            (firstMinute..currentMinute)
                .map { m -> minuteBuckets.firstOrNull { it.first == m }?.second ?: 0 }
                .takeLast(SPARKLINE_MINUTES)
        }
    }

    fun changeProvider(p: String) {
        scope.launch {
            val r = MainActivity.controlClient?.setConfig(provider = p)
            if (r != null && r.optBoolean("ok", false)) {
                provider = p
                toast = "服务商 → ${if (p == "zai") "Z.AI" else "智谱"}"
            } else {
                toast = "切换失败: ${r?.optString("error") ?: "Node 未响应"}"
            }
        }
    }

    fun changePlan(p: String) {
        scope.launch {
            val r = MainActivity.controlClient?.setConfig(plan = p)
            if (r != null && r.optBoolean("ok", false)) {
                plan = p
                toast = "套餐 → $p"
            } else {
                toast = "切换失败: ${r?.optString("error") ?: "Node 未响应"}"
            }
        }
    }

    fun startLogin() {
        scope.launch {
            val r = MainActivity.controlClient?.startOAuth(provider)
            if (r != null && r.optBoolean("ok", false)) {
                val url = r.optString("authorizeUrl")
                val customTabsIntent = androidx.browser.customtabs.CustomTabsIntent.Builder()
                    .setShowTitle(true)
                    .build()
                try {
                    customTabsIntent.launchUrl(context, android.net.Uri.parse(url))
                } catch (e: Exception) {
                    val fallback = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
                    fallback.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    try {
                        context.startActivity(fallback)
                    } catch (_: Exception) {
                    }
                }
            } else {
                toast = "登录失败: ${r?.optString("error") ?: "Node 未响应"}"
            }
        }
    }

    fun logout() {
        scope.launch {
            val r = MainActivity.controlClient?.logout()
            toast = if (r != null && r.optBoolean("ok", false)) "已登出" else "登出失败"
        }
    }

    fun startProxy() {
        scope.launch {
            val r = MainActivity.controlClient?.startProxy()
            toast = if (r != null && r.optBoolean("ok", false)) {
                "代理已启动 · 127.0.0.1:${r.optInt("port")}"
            } else {
                "启动失败: ${r?.optString("error") ?: "Node 未响应"}"
            }
        }
    }

    fun stopProxy() {
        scope.launch {
            val r = MainActivity.controlClient?.stopProxy()
            toast = if (r != null && r.optBoolean("ok", false)) "代理已停止" else "停止失败: ${r?.optString("error") ?: "Node 未响应"}"
        }
    }

    val cs = MaterialTheme.colorScheme

    Box(Modifier.fillMaxSize().background(cs.background)) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            when (tab) {
                0 -> {
                    // ── 主页 ──
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                        contentPadding = PaddingValues(top = 4.dp, start = 16.dp, end = 16.dp, bottom = 120.dp),
                    ) {
                        item {
                            TopBar(
                                subtitle = when {
                                    !reachable -> "本地反向代理 · Node 未响应"
                                    else -> "本地反向代理 · 已连接"
                                },
                                onSettings = { tab = 2 },
                            )
                        }
                        item {
                            HeroCard(
                                reachable = reachable,
                                loggedIn = loggedIn,
                                proxyRunning = proxyRunning,
                                proxyPort = proxyPort,
                                plan = plan,
                                uptimeText = runningSince?.let { formatDuration(nowMs - it) },
                                sparkData = sparkData,
                                clipboard = clipboard,
                                onCopied = { toast = "已复制 127.0.0.1:$proxyPort" },
                                onStart = ::startProxy,
                                onStop = ::stopProxy,
                            )
                        }
                        item {
                            AccountCard(
                                reachable = reachable,
                                loggedIn = loggedIn,
                                provider = provider,
                                onLogin = ::startLogin,
                                onLogout = ::logout,
                            )
                        }
                        item {
                            AccessConfigCard(
                                reachable = reachable,
                                proxyRunning = proxyRunning,
                                provider = provider,
                                plan = plan,
                                onProviderChange = ::changeProvider,
                                onPlanChange = ::changePlan,
                            )
                        }
                        item {
                            LogsPreviewCard(
                                logs = logs,
                                errorCount = errorCount,
                                errRegex = errRegex,
                                onOpenLogs = { tab = 1 },
                            )
                        }
                    }
                }
                1 -> LogsScreen(
                    logs = logs,
                    errRegex = errRegex,
                    onClear = { logs.clear() },
                )
                2 -> SettingsScreen(
                    themeMode = themeMode,
                    onThemeModeChange = onThemeModeChange,
                    provider = provider,
                    plan = plan,
                    proxyPort = proxyPort,
                    proxyRunning = proxyRunning,
                    reachable = reachable,
                    loggedIn = loggedIn,
                )
            }
        }

        // 底部导航
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
            HorizontalDivider(color = cs.outlineVariant, thickness = 1.dp)
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(cs.surfaceContainer)
                    .navigationBarsPadding()
                    .height(68.dp),
            ) {
                NavItem("主页", Icons.Filled.Home, tab == 0, Modifier.weight(1f)) { tab = 0 }
                NavItem("日志", Icons.Filled.Menu, tab == 1, Modifier.weight(1f)) { tab = 1 }
                NavItem("设置", Icons.Filled.Settings, tab == 2, Modifier.weight(1f)) { tab = 2 }
            }
        }

        // toast
        toast?.let { msg ->
            Surface(
                color = cs.inverseSurface,
                contentColor = cs.inverseOnSurface,
                shape = RoundedCornerShape(10.dp),
                shadowElevation = 4.dp,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 100.dp),
            ) {
                Text(msg, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp))
            }
        }
    }
}

@Composable
private fun TopBar(subtitle: String, onSettings: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val context = LocalContext.current
    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val appIcon = remember {
            runCatching {
                context.packageManager.getApplicationIcon(context.packageName).toBitmap(96, 96)
            }.getOrNull()
        }
        if (appIcon != null) {
            // 暗色模式下黑底图标需要垫一层提亮底 + 描边，避免糊进背景（方案 A 设计稿同款）
            val dark = isDarkTheme()
            val iconShape = RoundedCornerShape(10.dp)
            Image(
                bitmap = appIcon.asImageBitmap(),
                contentDescription = null,
                modifier = Modifier
                    .size(40.dp)
                    .clip(iconShape)
                    .then(
                        if (dark) Modifier
                            .background(cs.surfaceContainerHigh)
                            .border(1.dp, cs.outlineVariant, iconShape)
                        else Modifier,
                    ),
            )
        } else {
            Box(
                Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(cs.primary),
                contentAlignment = Alignment.Center,
            ) {
                Text("Z", color = cs.onPrimary, fontWeight = FontWeight.Bold, fontSize = 20.sp)
            }
        }
        Spacer(Modifier.width(12.dp))
        Column {
            Text("ZCode Proxy", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
            Text(subtitle, fontSize = 12.sp, color = cs.onSurfaceVariant)
        }
        Spacer(Modifier.weight(1f))
        IconButton(onClick = onSettings) {
            Icon(Icons.Filled.Settings, contentDescription = "设置", tint = cs.onSurfaceVariant)
        }
    }
}

@Composable
private fun HeroCard(
    reachable: Boolean,
    loggedIn: Boolean,
    proxyRunning: Boolean,
    proxyPort: Int,
    plan: String,
    uptimeText: String?,
    sparkData: List<Int>,
    clipboard: ClipboardManager,
    onCopied: () -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(cs.primaryContainer)
            .padding(20.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val (dotColor, stateText) = when {
                proxyRunning -> successColor() to "运行中"
                !reachable -> MaterialTheme.colorScheme.error to "Node 未响应"
                !loggedIn -> cs.onSurfaceVariant to "未登录"
                else -> cs.onSurfaceVariant to "已停止"
            }
            StatusDot(dotColor, pulse = proxyRunning)
            Spacer(Modifier.width(10.dp))
            Text(stateText, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = cs.onPrimaryContainer)
            Spacer(Modifier.weight(1f))
            Surface(shape = RoundedCornerShape(50), color = cs.primary.copy(alpha = 0.14f)) {
                Text(
                    plan,
                    fontFamily = Mono,
                    fontSize = 12.sp,
                    color = cs.onPrimaryContainer,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp),
                )
            }
        }
        Spacer(Modifier.height(16.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (proxyRunning) "127.0.0.1:$proxyPort" else "未启动",
                fontFamily = Mono,
                fontSize = 24.sp,
                fontWeight = FontWeight.SemiBold,
                color = cs.onPrimaryContainer,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (proxyRunning) {
                Surface(
                    shape = RoundedCornerShape(50),
                    color = Color.Transparent,
                    border = BorderStroke(1.5.dp, cs.primary.copy(alpha = 0.45f)),
                    onClick = {
                        clipboard.setText(AnnotatedString("http://127.0.0.1:$proxyPort"))
                        onCopied()
                    },
                ) {
                    Row(
                        Modifier.padding(horizontal = 14.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CopyGlyph(cs.onPrimaryContainer.copy(alpha = 0.85f))
                        Spacer(Modifier.width(6.dp))
                        Text("复制", fontSize = 13.sp, color = cs.onPrimaryContainer)
                    }
                }
            }
        }
        Spacer(Modifier.height(14.dp))
        Row(verticalAlignment = Alignment.Bottom) {
            Column(Modifier.weight(1f)) {
                Text("近 60 分钟请求", fontSize = 11.sp, color = cs.onPrimaryContainer.copy(alpha = 0.65f))
                Sparkline(
                    data = sparkData,
                    color = cs.primary,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Spacer(Modifier.width(12.dp))
            Text(
                uptimeText?.let { "UP $it" } ?: "UP —",
                fontFamily = Mono,
                fontSize = 12.sp,
                color = cs.onPrimaryContainer.copy(alpha = 0.65f),
            )
        }
        Spacer(Modifier.height(14.dp))
        Button(
            onClick = if (proxyRunning) onStop else onStart,
            enabled = if (proxyRunning) reachable else reachable && loggedIn,
            shape = RoundedCornerShape(50),
            colors = ButtonDefaults.buttonColors(
                containerColor = cs.primary,
                contentColor = cs.onPrimary,
                disabledContainerColor = cs.onSurfaceVariant.copy(alpha = 0.25f),
                disabledContentColor = cs.onSurfaceVariant,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
                .semantics { testTag = if (proxyRunning) "stopButton" else "startButton" },
        ) {
            if (proxyRunning) {
                Box(
                    Modifier
                        .size(14.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(cs.onPrimary),
                )
                Spacer(Modifier.width(10.dp))
                Text("停止代理", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            } else {
                Text("启动代理", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun AccountCard(
    reachable: Boolean,
    loggedIn: Boolean,
    provider: String,
    onLogin: () -> Unit,
    onLogout: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(cs.surfaceContainerLow)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(48.dp)
                .clip(CircleShape)
                .background(cs.primaryContainer),
            contentAlignment = Alignment.Center,
        ) {
            Text("Z", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = cs.onPrimaryContainer)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                if (provider == "zai") "Z.AI 账号" else "智谱账号",
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                color = cs.onSurface,
            )
            Spacer(Modifier.height(3.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(if (loggedIn) successColor() else cs.error),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    if (loggedIn) "已登录 · OAuth 授权" else "未登录",
                    fontSize = 13.sp,
                    color = cs.onSurfaceVariant,
                )
            }
        }
        if (loggedIn) {
            OutlinedButton(
                onClick = onLogout,
                enabled = reachable,
                shape = RoundedCornerShape(50),
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = cs.error,
                    disabledContentColor = cs.error.copy(alpha = 0.38f),
                ),
                border = BorderStroke(1.5.dp, cs.error.copy(alpha = if (reachable) 0.55f else 0.25f)),
                modifier = Modifier.semantics { testTag = "logoutButton" },
            ) {
                Text("登出", fontSize = 14.sp, fontWeight = FontWeight.Medium)
            }
        } else {
            Button(
                onClick = onLogin,
                enabled = reachable,
                shape = RoundedCornerShape(50),
                colors = ButtonDefaults.buttonColors(containerColor = cs.primary, contentColor = cs.onPrimary),
                modifier = Modifier.semantics { testTag = "loginButton" },
            ) {
                Text("登录", fontSize = 14.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

@Composable
private fun AccessConfigCard(
    reachable: Boolean,
    proxyRunning: Boolean,
    provider: String,
    plan: String,
    onProviderChange: (String) -> Unit,
    onPlanChange: (String) -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    val enabled = reachable && !proxyRunning
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(cs.surfaceContainerLow)
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("接入配置", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
            Spacer(Modifier.weight(1f))
            Text(
                when {
                    proxyRunning -> "运行中 · 切换已锁定"
                    !reachable -> "Node 未响应"
                    else -> "停止代理后可切换"
                },
                fontSize = 12.sp,
                color = dimColor(),
            )
        }
        HorizontalDivider(color = cs.outlineVariant, thickness = 1.dp, modifier = Modifier.padding(vertical = 12.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("服务商", fontSize = 13.sp, color = cs.onSurfaceVariant, modifier = Modifier.width(52.dp))
            SegChip("Z.AI", provider == "zai", enabled, modifier = Modifier.weight(1f), fill = true) { onProviderChange("zai") }
            Spacer(Modifier.width(8.dp))
            SegChip("智谱", provider == "bigmodel", enabled, modifier = Modifier.weight(1f), fill = true) { onProviderChange("bigmodel") }
        }
        Spacer(Modifier.height(14.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("套餐", fontSize = 13.sp, color = cs.onSurfaceVariant, modifier = Modifier.width(52.dp))
            SegChip("coding-plan", plan == "coding-plan", enabled, modifier = Modifier.weight(1f), fill = true, mono = true) { onPlanChange("coding-plan") }
            Spacer(Modifier.width(8.dp))
            SegChip("start-plan", plan == "start-plan", enabled, modifier = Modifier.weight(1f), fill = true, mono = true) { onPlanChange("start-plan") }
        }
    }
}

@Composable
private fun LogsPreviewCard(
    logs: List<String>,
    errorCount: Int,
    errRegex: Regex,
    onOpenLogs: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(cs.surfaceContainerLow)
            .clickable(onClick = onOpenLogs)
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("实时日志", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
            Spacer(Modifier.width(8.dp))
            Surface(shape = RoundedCornerShape(50), color = cs.secondaryContainer) {
                Text(
                    "${logs.size}",
                    fontFamily = Mono,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = cs.onSecondaryContainer,
                    modifier = Modifier.padding(horizontal = 9.dp, vertical = 3.dp),
                )
            }
            Spacer(Modifier.weight(1f))
            Text(
                "错误 $errorCount",
                fontFamily = Mono,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = if (errorCount == 0) successColor() else cs.error,
            )
            Spacer(Modifier.width(10.dp))
            Text("查看全部", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = cs.primary)
            Icon(
                Icons.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = cs.primary,
                modifier = Modifier.size(18.dp),
            )
        }
        HorizontalDivider(color = cs.outlineVariant, thickness = 1.dp, modifier = Modifier.padding(vertical = 10.dp))
        if (logs.isEmpty()) {
            Text(
                "还没有请求 — 在编码工具里发一次对话试试",
                fontSize = 12.sp,
                color = dimColor(),
                modifier = Modifier.padding(vertical = 10.dp),
            )
        } else {
            logs.takeLast(5).forEach { line ->
                Text(
                    line,
                    fontFamily = Mono,
                    fontSize = 11.sp,
                    lineHeight = 17.sp,
                    color = if (errRegex.containsMatchIn(line)) cs.error else cs.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(vertical = 2.dp),
                )
            }
        }
        Text(
            "点击卡片或右上角「查看全部」查看完整日志",
            fontSize = 12.sp,
            color = dimColor(),
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 10.dp),
        )
    }
}

@Composable
private fun LogsScreen(logs: MutableList<String>, errRegex: Regex, onClear: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val clipboard = LocalClipboardManager.current
    var filter by rememberSaveable { mutableStateOf(0) } // 0 全部 1 成功 2 错误
    val filtered = remember(logs.size, filter) {
        when (filter) {
            1 -> logs.filter { it.contains("\\b2\\d\\d\\b".toRegex()) }
            2 -> logs.filter { errRegex.containsMatchIn(it) }
            else -> logs.toList()
        }
    }
    val listState = rememberLazyListState()
    LaunchedEffect(filtered.size) {
        if (filtered.isNotEmpty()) listState.scrollToItem(filtered.lastIndex)
    }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("实时日志 (${filtered.size})", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
            Spacer(Modifier.weight(1f))
            TextButton(
                onClick = { clipboard.setText(AnnotatedString(filtered.joinToString("\n"))) },
                enabled = filtered.isNotEmpty(),
            ) { Text("复制", fontSize = 13.sp) }
            TextButton(onClick = onClear, enabled = logs.isNotEmpty()) { Text("清屏", fontSize = 13.sp) }
        }
        Row(Modifier.padding(horizontal = 16.dp)) {
            SegChip("全部", filter == 0, true) { filter = 0 }
            Spacer(Modifier.width(8.dp))
            SegChip("成功", filter == 1, true) { filter = 1 }
            Spacer(Modifier.width(8.dp))
            SegChip("错误", filter == 2, true) { filter = 2 }
        }
        HorizontalDivider(color = cs.outlineVariant, thickness = 1.dp, modifier = Modifier.padding(vertical = 8.dp))
        if (filtered.isEmpty()) {
            Text(
                "暂无日志",
                fontSize = 13.sp,
                color = dimColor(),
                modifier = Modifier.padding(16.dp),
            )
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
                contentPadding = PaddingValues(bottom = 110.dp, top = 4.dp),
            ) {
                items(filtered.size) { idx ->
                    val line = filtered[idx]
                    Text(
                        line,
                        fontFamily = Mono,
                        fontSize = 11.sp,
                        lineHeight = 17.sp,
                        color = if (errRegex.containsMatchIn(line)) cs.error else cs.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 1.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun SettingsScreen(
    themeMode: ThemeMode,
    onThemeModeChange: (ThemeMode) -> Unit,
    provider: String,
    plan: String,
    proxyPort: Int,
    proxyRunning: Boolean,
    reachable: Boolean,
    loggedIn: Boolean,
) {
    val cs = MaterialTheme.colorScheme
    val context = LocalContext.current
    val versionName = remember {
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "—"
    }
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(bottom = 120.dp),
    ) {
        Text("设置", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface, modifier = Modifier.padding(vertical = 10.dp))
        CardBlock(title = "外观") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("主题", fontSize = 13.sp, color = cs.onSurfaceVariant, modifier = Modifier.width(64.dp))
                SegChip("跟随系统", themeMode == ThemeMode.FOLLOW_SYSTEM, true) { onThemeModeChange(ThemeMode.FOLLOW_SYSTEM) }
                Spacer(Modifier.width(8.dp))
                SegChip("亮色", themeMode == ThemeMode.LIGHT, true) { onThemeModeChange(ThemeMode.LIGHT) }
                Spacer(Modifier.width(8.dp))
                SegChip("暗色", themeMode == ThemeMode.DARK, true) { onThemeModeChange(ThemeMode.DARK) }
            }
            Spacer(Modifier.height(6.dp))
            Text("跟随系统时，深色模式开关即时生效", fontSize = 12.sp, color = dimColor())
        }
        Spacer(Modifier.height(12.dp))
        CardBlock(title = "接入信息") {
            SettingRow("服务商", if (provider == "zai") "Z.AI" else "智谱")
            SettingRow("套餐", plan)
            SettingRow(
                "状态",
                when {
                    proxyRunning -> "127.0.0.1:$proxyPort · 运行中"
                    reachable -> "未启动"
                    else -> "Node 未响应"
                },
                valueColor = if (proxyRunning) successColor() else cs.onSurface,
            )
            SettingRow("登录", if (loggedIn) "已登录" else "未登录")
            Spacer(Modifier.height(4.dp))
            Text("切换服务商/套餐在主页「接入配置」卡", fontSize = 12.sp, color = dimColor())
        }
        Spacer(Modifier.height(12.dp))
        CardBlock(title = "关于") {
            SettingRow("应用", "ZCode Proxy")
            SettingRow("版本", versionName)
            SettingRow("控制协议", "Node · 127.0.0.1 本地监听")
            Spacer(Modifier.height(4.dp))
            Text("上游：Z.AI / 智谱开放平台（OAuth 登录）", fontSize = 12.sp, color = dimColor())
        }
    }
}

@Composable
private fun CardBlock(title: String, content: @Composable () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(cs.surfaceContainerLow)
            .padding(16.dp),
    ) {
        Text(title, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
        HorizontalDivider(color = cs.outlineVariant, thickness = 1.dp, modifier = Modifier.padding(vertical = 12.dp))
        content()
    }
}

@Composable
private fun SettingRow(label: String, value: String, valueColor: Color = MaterialTheme.colorScheme.onSurface) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(label, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.weight(1f))
        Text(value, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = valueColor)
    }
}

@Composable
private fun NavItem(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(
        modifier
            .fillMaxSize()
            .clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier
                .clip(RoundedCornerShape(50))
                .background(if (selected) cs.secondaryContainer else Color.Transparent)
                .padding(horizontal = 16.dp, vertical = 2.dp),
        ) {
            Icon(
                icon,
                contentDescription = label,
                tint = if (selected) cs.primary else cs.onSurfaceVariant,
                modifier = Modifier.size(22.dp),
            )
        }
        Text(
            label,
            fontSize = 11.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = if (selected) cs.primary else cs.onSurfaceVariant,
        )
    }
}

@Composable
private fun SegChip(
    text: String,
    selected: Boolean,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    fill: Boolean = false,
    mono: Boolean = false,
    onClick: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(50),
        color = if (selected) cs.primary else cs.background,
        border = if (selected) null else BorderStroke(1.dp, cs.outlineVariant),
        modifier = modifier
            .then(if (fill) Modifier.fillMaxWidth() else Modifier)
            .semantics { testTag = "seg_$text" },
    ) {
        Text(
            text,
            fontFamily = if (mono) Mono else null,
            fontSize = if (mono) 12.sp else 13.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = when {
                selected -> cs.onPrimary
                !enabled -> cs.onSurfaceVariant.copy(alpha = 0.5f)
                else -> cs.onSurfaceVariant
            },
            textAlign = if (fill) TextAlign.Center else null,
            maxLines = 1,
            modifier = Modifier
                .padding(horizontal = if (mono) 8.dp else 16.dp, vertical = 8.dp)
                .then(if (fill) Modifier.fillMaxWidth() else Modifier),
        )
    }
}

@Composable
private fun StatusDot(color: Color, pulse: Boolean) {
    if (pulse) {
        val alpha by rememberInfiniteTransition(label = "statusPulse").animateFloat(
            initialValue = 0.12f,
            targetValue = 0.4f,
            animationSpec = infiniteRepeatable(tween(1100, easing = LinearEasing), RepeatMode.Reverse),
            label = "statusPulseAlpha",
        )
        Box(contentAlignment = Alignment.Center) {
            Box(Modifier.size(24.dp).clip(CircleShape).background(color.copy(alpha = alpha)))
            Box(Modifier.size(12.dp).clip(CircleShape).background(color))
        }
    } else {
        Box(Modifier.size(12.dp).clip(CircleShape).background(color))
    }
}

@Composable
private fun Sparkline(data: List<Int>, color: Color, modifier: Modifier = Modifier) {
    // 签名动效：末点呼吸（与状态灯同一节奏），面积填充取 0.14f 弱化层次
    val pulseAlpha by rememberInfiniteTransition(label = "sparkPulse").animateFloat(
        initialValue = 0.12f,
        targetValue = 0.4f,
        animationSpec = infiniteRepeatable(tween(1100, easing = LinearEasing), RepeatMode.Reverse),
        label = "sparkPulseAlpha",
    )
    Canvas(modifier.height(36.dp)) {
        if (data.size < 2) {
            val y = size.height / 2
            drawLine(
                color = color.copy(alpha = 0.3f),
                start = Offset(0f, y),
                end = Offset(size.width, y),
                strokeWidth = 4f,
                cap = StrokeCap.Round,
            )
        } else {
            val maxV = (data.maxOrNull() ?: 1).coerceAtLeast(1)
            val step = size.width / (data.size - 1)
            val points = data.mapIndexed { i, v ->
                Offset(i * step, size.height * (1f - (v.toFloat() / maxV)).coerceIn(0.08f, 1f))
            }
            val line = Path().apply {
                moveTo(points.first().x, points.first().y)
                points.drop(1).forEach { lineTo(it.x, it.y) }
            }
            val area = Path().apply {
                addPath(line)
                lineTo(points.last().x, size.height)
                lineTo(points.first().x, size.height)
                close()
            }
            drawPath(area, color.copy(alpha = 0.14f))
            drawPath(line, color, style = Stroke(width = 4f, cap = StrokeCap.Round, join = StrokeJoin.Round))
            drawCircle(color.copy(alpha = pulseAlpha), radius = 11f, center = points.last())
            drawCircle(color, radius = 5.5f, center = points.last())
        }
    }
}

@Composable
private fun CopyGlyph(color: Color) {
    Box(Modifier.size(15.dp)) {
        Box(
            Modifier
                .align(Alignment.TopStart)
                .size(width = 10.dp, height = 12.dp)
                .border(1.5.dp, color, RoundedCornerShape(2.dp)),
        )
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .size(width = 10.dp, height = 12.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(color),
        )
    }
}

private fun formatDuration(ms: Long): String {
    val totalSeconds = ms / 1000
    val h = totalSeconds / 3600
    val m = (totalSeconds % 3600) / 60
    val s = totalSeconds % 60
    return "%02d:%02d:%02d".format(h, m, s)
}
