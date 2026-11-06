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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
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
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
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
import com.zcode.proxy.ui.theme.warningColor
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale

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

/** coding 次数制窗口长度（时间进度条分母）；标签与窗口一一对应。 */
private const val FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000L
private const val WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000L
private const val LABEL_5H = "5 小时"
private const val LABEL_WEEK = "每周"

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
    var toast by remember { mutableStateOf<String?>(null) }
    var tab by rememberSaveable { mutableStateOf(0) }

    // 套餐用量（替换原「近 60 分钟请求」sparkline）：登录后拉一次 + 点按刷新，
    // 无轮询 —— billing/monitor 网关限频（与 TUI 手动刷新同策略）。
    var quotaUi by remember { mutableStateOf<QuotaUi?>(null) }
    var quotaStatus by remember { mutableStateOf("idle") } // idle | loading | ok | empty | error
    var quotaErrorMsg by remember { mutableStateOf("") }
    var quotaInFlight by remember { mutableStateOf(false) }

    // 更新检查（GitHub Releases）：每次启动自动查一次，设置页可手动触发
    val currentVersion = remember {
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull()
    }
    var updateInfo by remember { mutableStateOf<UpdateInfo?>(null) }
    var updateChecking by remember { mutableStateOf(false) }
    var updateCheckFailed by remember { mutableStateOf(false) }
    var showUpdateDialog by remember { mutableStateOf(false) }
    var skippedTag by remember { mutableStateOf(UpdatePrefs.loadSkipped(context)) }
    var autoCheckUpdate by remember { mutableStateOf(UpdatePrefs.loadAutoCheck(context)) }

    fun checkForUpdate(manual: Boolean) {
        scope.launch {
            updateChecking = true
            val info = UpdateChecker.fetchLatest()
            updateChecking = false
            if (info == null) {
                updateCheckFailed = true
                if (manual) toast = "检查更新失败，GitHub 暂不可达"
                return@launch
            }
            updateCheckFailed = false
            updateInfo = info
            val hasUpdate = UpdateChecker.isNewer(currentVersion, info.tag)
            if (manual) toast = if (hasUpdate) "发现新版本 ${info.tag}" else "已是最新版本"
            if (hasUpdate && (manual || info.tag != skippedTag)) showUpdateDialog = true
        }
    }

    // 每次启动自动检查一次（可在设置页关闭；手动检查不受开关影响）
    LaunchedEffect(Unit) { if (autoCheckUpdate) checkForUpdate(manual = false) }

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

    fun refreshQuota() {
        if (quotaInFlight) return
        quotaInFlight = true
        // 已有数据时保留旧值原地刷新（loading 占位仅用于首拉）
        if (quotaUi == null) quotaStatus = "loading"
        scope.launch {
            val r = MainActivity.controlClient?.quota()
            if (r != null && r.optBoolean("ok", false)) {
                val parsed = parseQuota(r, plan)
                quotaUi = parsed
                quotaStatus = if (parsed != null && parsed.rows.isNotEmpty()) "ok" else "empty"
            } else {
                quotaErrorMsg = r?.optString("error") ?: ""
                quotaStatus = "error"
            }
            quotaInFlight = false
        }
    }

    // 登录态/套餐切换时自动拉一次；登出清空（billing 调用需要凭据）
    LaunchedEffect(loggedIn, plan) {
        if (loggedIn) refreshQuota() else {
            quotaUi = null
            quotaStatus = "idle"
            quotaErrorMsg = ""
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
                openInBrowser(context, r.optString("authorizeUrl"))
                toast = "在浏览器完成授权后回到本应用即可；若浏览器提示无法打开 zcode:// 链接，可忽略"
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
                                quotaUi = quotaUi,
                                quotaStatus = quotaStatus,
                                quotaErrorMsg = quotaErrorMsg,
                                clipboard = clipboard,
                                onCopied = { toast = "已复制 127.0.0.1:$proxyPort" },
                                onStart = ::startProxy,
                                onStop = ::stopProxy,
                                onRefreshQuota = ::refreshQuota,
                            )
                        }
                        item {
                            AccountCard(
                                reachable = reachable,
                                loggedIn = loggedIn,
                                provider = provider,
                                proxyRunning = proxyRunning,
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
                    currentVersion = currentVersion,
                    updateInfo = updateInfo,
                    updateChecking = updateChecking,
                    updateCheckFailed = updateCheckFailed,
                    onCheckUpdate = { checkForUpdate(manual = true) },
                    autoCheckUpdate = autoCheckUpdate,
                    onAutoCheckUpdateChange = { enabled ->
                        autoCheckUpdate = enabled
                        UpdatePrefs.saveAutoCheck(context, enabled)
                    },
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

    // 新版本弹窗（启动自动检查 / 设置页手动检查共用）
    if (showUpdateDialog) {
        updateInfo?.let { info ->
            AlertDialog(
                onDismissRequest = { showUpdateDialog = false },
                title = { Text("发现新版本", fontWeight = FontWeight.SemiBold) },
                text = {
                    Column {
                        Text(
                            "最新 ${info.tag} · 当前 ${currentVersion ?: "未知"}",
                            fontFamily = Mono,
                            fontSize = 13.sp,
                            color = cs.onSurfaceVariant,
                        )
                        info.notes?.let { notes ->
                            Spacer(Modifier.height(10.dp))
                            Text(
                                notes.trim(),
                                fontSize = 12.sp,
                                lineHeight = 18.sp,
                                color = cs.onSurfaceVariant,
                                maxLines = 10,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        showUpdateDialog = false
                        openInBrowser(context, info.apkUrl ?: info.htmlUrl)
                    }) { Text("前往下载", fontWeight = FontWeight.Medium) }
                },
                dismissButton = {
                    Row {
                        TextButton(onClick = {
                            skippedTag = info.tag
                            UpdatePrefs.saveSkipped(context, info.tag)
                            showUpdateDialog = false
                        }) { Text("忽略此版本") }
                        TextButton(onClick = { showUpdateDialog = false }) { Text("以后再说") }
                    }
                },
            )
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
    quotaUi: QuotaUi?,
    quotaStatus: String,
    quotaErrorMsg: String,
    clipboard: ClipboardManager,
    onCopied: () -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onRefreshQuota: () -> Unit,
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
        QuotaBlock(
            loggedIn = loggedIn,
            quotaUi = quotaUi,
            status = quotaStatus,
            errorMsg = quotaErrorMsg,
            uptimeText = uptimeText,
            onRefresh = onRefreshQuota,
        )
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
    proxyRunning: Boolean,
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
                    when {
                        proxyRunning && loggedIn -> "已登录 · 代理运行中 · 登出已锁定"
                        proxyRunning -> "未登录 · 代理运行中"
                        loggedIn -> "已登录 · OAuth 授权"
                        else -> "未登录"
                    },
                    fontSize = 13.sp,
                    color = cs.onSurfaceVariant,
                )
            }
        }
        if (loggedIn) {
            OutlinedButton(
                onClick = onLogout,
                enabled = reachable && !proxyRunning,
                shape = RoundedCornerShape(50),
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = cs.error,
                    disabledContentColor = cs.error.copy(alpha = 0.38f),
                ),
                border = BorderStroke(1.5.dp, cs.error.copy(alpha = if (reachable && !proxyRunning) 0.55f else 0.25f)),
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
    currentVersion: String?,
    updateInfo: UpdateInfo?,
    updateChecking: Boolean,
    updateCheckFailed: Boolean,
    onCheckUpdate: () -> Unit,
    autoCheckUpdate: Boolean,
    onAutoCheckUpdateChange: (Boolean) -> Unit,
) {
    val cs = MaterialTheme.colorScheme
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
            SettingRow("版本", currentVersion ?: "—")
            SettingRow("控制协议", "Node · 127.0.0.1 本地监听")
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) {
                    Text("自动检查更新", fontSize = 14.sp, color = cs.onSurfaceVariant)
                    Text("启动时查询 GitHub Releases", fontSize = 12.sp, color = dimColor())
                }
                Switch(checked = autoCheckUpdate, onCheckedChange = onAutoCheckUpdateChange)
            }
            val (updateText, updateColor) = when {
                updateChecking -> "检查中…" to dimColor()
                updateInfo != null ->
                    if (UpdateChecker.isNewer(currentVersion, updateInfo.tag)) {
                        "${updateInfo.tag} 可更新" to cs.primary
                    } else {
                        "已是最新（${updateInfo.tag}）" to successColor()
                    }
                updateCheckFailed -> "检查失败 · GitHub 不可达" to cs.error
                else -> "未检查" to dimColor()
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text("更新", fontSize = 14.sp, color = cs.onSurfaceVariant)
                Spacer(Modifier.width(12.dp))
                Text(updateText, fontSize = 13.sp, color = updateColor, modifier = Modifier.weight(1f))
                TextButton(onClick = onCheckUpdate, enabled = !updateChecking) {
                    Text(if (updateChecking) "检查中…" else "检查更新", fontSize = 13.sp)
                }
            }
            Spacer(Modifier.height(4.dp))
            Text("更新来自 GitHub Releases · TriDefender/zcode-api", fontSize = 12.sp, color = dimColor())
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

/**
 * 套餐用量行。`progress == null` 时只画轨道（无占比数据可画）。
 * `striped = true` 为 coding 次数制窗口的时间进度条（填充 = 距重置时间进度，斜纹）——
 * 仅在上游没给 percentage 时兜底；有 percentage 时用实心剩余占比条（与 credit 条同语义）。
 * 值恒以「剩」开头（上游 number 可能为脏值，绝不渲染 X/Y，见 pr56/#57 实弹）。
 */
private data class QuotaRowUi(
    val label: String,
    val value: String,
    val progress: Float?,
    val striped: Boolean,
    /** credit/剩余占比档位：0 充足 / 1 偏低(≤30%) / 2 将尽(≤10%)；时间进度条恒 0。 */
    val warnLevel: Int = 0,
    /** 行内重置提示（如「1h 54m 后重置」/「2026-12-31 到期」）；null 不显示。 */
    val resetText: String? = null,
)

private data class QuotaUi(
    /** coding 档位字符串（data.level，如 "max"）；credit 制无档位 → null。 */
    val level: String?,
    val rows: List<QuotaRowUi>,
    /** 快照 serverTime（epoch ms）—— 时间进度条以服务端时间为“现在”，免设备时钟偏差。 */
    val nowMs: Long,
)

@Composable
private fun QuotaBlock(
    loggedIn: Boolean,
    quotaUi: QuotaUi?,
    status: String,
    errorMsg: String,
    uptimeText: String?,
    onRefresh: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = loggedIn, onClick = onRefresh),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("套餐用量", fontSize = 11.sp, color = cs.onPrimaryContainer.copy(alpha = 0.65f))
            quotaUi?.level?.let { level ->
                Spacer(Modifier.width(8.dp))
                Surface(shape = RoundedCornerShape(50), color = cs.primary.copy(alpha = 0.14f)) {
                    Text(
                        level,
                        fontFamily = Mono,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = cs.onPrimaryContainer,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                    )
                }
            }
            Spacer(Modifier.weight(1f))
            Text(
                uptimeText?.let { "UP $it" } ?: "UP —",
                fontFamily = Mono,
                fontSize = 11.sp,
                color = cs.onPrimaryContainer.copy(alpha = 0.65f),
            )
        }
        Spacer(Modifier.height(12.dp))
        val ui = quotaUi
        when {
            !loggedIn -> QuotaHint("登录后显示套餐用量")
            status == "loading" && ui == null -> QuotaPlaceholderRows()
            status == "error" -> Column {
                QuotaHint(if (errorMsg.isBlank()) "用量获取失败" else "用量获取失败 · $errorMsg")
                Spacer(Modifier.height(4.dp))
                Text(
                    "点按重试",
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    color = cs.primary,
                )
            }
            else -> {
                // quotaUi 是委托属性（by remember），不做智能转换 —— 显式取行列表兜底
                val rows = ui?.rows.orEmpty()
                if (rows.isEmpty()) {
                    QuotaHint("暂无用量数据 · 点按刷新")
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        rows.forEach { QuotaRow(it) }
                    }
                }
            }
        }
    }
}

@Composable
private fun QuotaHint(text: String) {
    Text(
        text,
        fontSize = 11.sp,
        color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.5f),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun QuotaPlaceholderRows() {
    val cs = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        listOf(LABEL_5H, LABEL_WEEK).forEach { label ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    label,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = cs.onPrimaryContainer.copy(alpha = 0.5f),
                )
                Spacer(Modifier.width(10.dp))
                Box(
                    Modifier
                        .weight(1f)
                        .height(6.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(cs.onPrimaryContainer.copy(alpha = 0.08f)),
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    "…",
                    fontFamily = Mono,
                    fontSize = 12.sp,
                    color = cs.onPrimaryContainer.copy(alpha = 0.4f),
                )
            }
        }
    }
}

@Composable
private fun QuotaRow(row: QuotaRowUi) {
    val cs = MaterialTheme.colorScheme
    val barColor = if (row.striped) {
        cs.primary
    } else {
        when (row.warnLevel) {
            1 -> warningColor()
            2 -> cs.error
            else -> cs.primary
        }
    }
    val valueColor = if (row.striped) cs.onPrimaryContainer else barColor
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            row.label,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = cs.onPrimaryContainer,
            maxLines = 1,
        )
        Spacer(Modifier.width(10.dp))
        QuotaBar(
            progress = row.progress,
            striped = row.striped,
            color = barColor,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(10.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text(
                row.value,
                fontFamily = Mono,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = valueColor,
            )
            row.resetText?.let { reset ->
                Text(
                    reset,
                    fontFamily = Mono,
                    fontSize = 10.sp,
                    color = cs.onPrimaryContainer.copy(alpha = 0.55f),
                )
            }
        }
    }
}

@Composable
private fun QuotaBar(progress: Float?, striped: Boolean, color: Color, modifier: Modifier = Modifier) {
    // 设计稿规格：轨道 primary@12%；coding 条纹 = 8dp 周期 / 4dp 条（45% 叠 15% 底）；
    // credit 实心条随余量缩短并按阈值变色。圆角 3dp 由 clip 统一处理。
    Canvas(modifier.height(6.dp).clip(RoundedCornerShape(3.dp))) {
        drawRect(color.copy(alpha = 0.12f))
        progress?.let { p ->
            val w = size.width * p.coerceIn(0f, 1f)
            if (w <= 0f) return@let
            if (striped) {
                drawRect(color.copy(alpha = 0.15f), size = Size(w, size.height))
                val period = 8.dp.toPx()
                val stripe = 4.dp.toPx()
                var x = 0f
                while (x < w) {
                    drawRect(
                        color.copy(alpha = 0.45f),
                        topLeft = Offset(x, 0f),
                        size = Size(minOf(stripe, w - x), size.height),
                    )
                    x += period
                }
            } else {
                drawRect(color, size = Size(w, size.height))
            }
        }
    }
}

/** epoch 秒/毫秒并存（上游两种都见过）：>1e12 视为毫秒。 */
private fun toEpochMs(v: Long): Long = if (v > 1_000_000_000_000L) v else v * 1000L

private fun optStringOrNull(o: JSONObject, key: String): String? {
    if (!o.has(key) || o.isNull(key)) return null
    return o.optString(key, "").trim().ifBlank { null }
}

private fun optNumberOrNull(o: JSONObject, key: String): Double? {
    if (!o.has(key) || o.isNull(key)) return null
    return o.optDouble(key).takeUnless { it.isNaN() }
}

private fun optEpochMsOrNull(o: JSONObject, key: String): Long? =
    optNumberOrNull(o, key)?.toLong()?.let(::toEpochMs)

/**
 * 组装用量块视图。平面按主屏套餐切换选择（coding-plan → monitor 窗口 / start-plan →
 * billing 积分桶），首选平面无行时回退另一平面；level 仅在 coding 行被采用时附带。
 */
private fun parseQuota(resp: JSONObject, plan: String): QuotaUi? {
    if (!resp.optBoolean("ok", false)) return null
    val quota = resp.optJSONObject("quota") ?: return null
    val nowMs = optNumberOrNull(quota, "serverTime")?.toLong()
        ?.let { if (it > 0) toEpochMs(it) else System.currentTimeMillis() }
        ?: System.currentTimeMillis()
    val coding = quota.optJSONObject("codingPlan")
    val balances = quota.optJSONArray("balances")
    val codingRowsList = codingRows(coding, nowMs)
    val creditRowsList = creditRows(balances, nowMs)
    val level = coding?.let { optStringOrNull(it, "level") }
    return if (plan == "coding-plan") {
        if (codingRowsList.isNotEmpty()) QuotaUi(level, codingRowsList, nowMs)
        else QuotaUi(null, creditRowsList, nowMs)
    } else {
        if (creditRowsList.isNotEmpty()) QuotaUi(null, creditRowsList, nowMs)
        else QuotaUi(level, codingRowsList, nowMs)
    }
}

/** monitor 平面 limits[] 归一后的最小行集（只留渲染要用的字段）。 */
private data class CodingLimitRow(
    val type: String,
    val unit: String?,
    val remaining: Double?,
    val resetMs: Long?,
    /** 上游 percentage = 已用占比（0–100）；缺位/越界为 null。实弹 2026-09-30：2/3/60。 */
    val percentage: Double?,
)

/** 窗口语义名兜底：无重置时间的行退回类型友好名，永不裸显 TIME_LIMIT。 */
private fun friendlyWindowType(type: String): String = when (type) {
    "TOKENS_LIMIT" -> "Token"
    "TIME_LIMIT" -> "周期"
    else -> type.take(10)
}

/**
 * coding 窗口行。窗口名按 type + horizon 判别（位次标签已废 —— 实弹 2026-10-12
 * 对拍官方面板"剩余额度"卡：三窗口按重置升序是 5 小时 TOKENS_LIMIT / MCP 工具
 * 调用 TIME_LIMIT / 每周 TOKENS_LIMIT，位次标签把工具调用行贴成"每周"、每周行
 * 贴成"月度"，整体错位一格）。工具调用是 MCP 余量、与 LLM 用量无关，先剔除不
 * 展示。已知边缘：每周窗口生命末期（≤6h）会被贴成 5 小时，跨重置自愈。逾期
 * （horizon < 0，时钟偏斜/服务端滚动滞后；实弹 2026-11-05 截图：重置边界上的
 * 5h 行被旧降级贴成"周期"）同样归入 5 小时档 —— 5h 窗口滚动频率是每周窗口的
 * 28 倍，逾期行几乎必是 5h 窗口（此时时间进度条纹退化为满格，语义正确）。条画剩余
 * 占比（percentage 缺位时 5 小时/每周退回时间进度条纹条）；值 = 剩 remaining 或 剩 P%。
 */
private fun codingRows(coding: JSONObject?, nowMs: Long): List<QuotaRowUi> {
    val limits = coding?.optJSONArray("limits") ?: return emptyList()
    val parsed = buildList {
        for (i in 0 until limits.length()) {
            val o = limits.optJSONObject(i) ?: continue
            val type = optStringOrNull(o, "type") ?: continue
            add(
                CodingLimitRow(
                    type,
                    optStringOrNull(o, "unit"),
                    optNumberOrNull(o, "remaining"),
                    optEpochMsOrNull(o, "nextResetTime"),
                    optNumberOrNull(o, "percentage")?.takeIf { it in 0.0..100.0 },
                ),
            )
        }
    }
    // TIME_LIMIT = MCP 工具调用窗口（官方面板"工具调用"卡），与 LLM 调用无关。
    val chosen = parsed
        .filter { it.type != "TIME_LIMIT" }
        .sortedWith(compareBy { it.resetMs ?: Long.MAX_VALUE })
        .take(3)
    if (chosen.isEmpty()) return emptyList()
    return chosen.map { l ->
        val horizon = l.resetMs?.let { it - nowMs }
        val label = when {
            horizon == null -> friendlyWindowType(l.type)
            horizon <= 6 * 3600_000L -> LABEL_5H
            horizon <= 8 * 86_400_000L -> LABEL_WEEK
            horizon <= 45 * 86_400_000L -> "月度"
            else -> "周期"
        }
        // percentage = 已用占比（实弹自洽信号；total/number 是脏值，不伪造 X/Y）
        val remainingFrac = l.percentage?.let { ((100f - it.toFloat()) / 100f).coerceIn(0f, 1f) }
        val progress = remainingFrac ?: when (label) {
            LABEL_5H -> l.resetMs?.let { (1f - (it - nowMs).toFloat() / FIVE_HOUR_WINDOW_MS).coerceIn(0f, 1f) }
            LABEL_WEEK -> l.resetMs?.let { (1f - (it - nowMs).toFloat() / WEEK_WINDOW_MS).coerceIn(0f, 1f) }
            else -> null
        }
        val warnLevel = when {
            remainingFrac == null -> 0
            remainingFrac <= 0.10f -> 2
            remainingFrac <= 0.30f -> 1
            else -> 0
        }
        val resetText = l.resetMs?.let { fmtResetCountdown(it, nowMs) }
        val value = when {
            l.remaining != null -> "剩 ${fmtCount(l.remaining.toLong())} ${l.unit ?: "次"}"
            remainingFrac != null -> "剩 ${(remainingFrac * 100).toInt()}%"
            else -> "—"
        }
        QuotaRowUi(
            label,
            value,
            progress,
            striped = remainingFrac == null,
            warnLevel = warnLevel,
            resetText = resetText,
        )
    }
}

/** billing 平面 balances[] 归一后的最小行集。 */
private data class CreditBucket(
    val showName: String,
    val remaining: Double,
    val total: Double,
    val expiresMs: Long?,
)

/**
 * credit 积分桶行。目标结构（用户/官方面板钉死）：5 小时 + 每周双窗口、单一总量池。
 * 桶 → 窗口判别用过期时间升序：最近一桶 8h 内到期才按窗口标签展示，否则（体验套餐
 * 长期桶）回退 showName 标签 —— 桶数不足 2 或形状不符时诚实降级，不硬套窗口语义。
 */
private fun creditRows(balances: JSONArray?, nowMs: Long): List<QuotaRowUi> {
    val arr = balances ?: return emptyList()
    val list = buildList {
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            add(
                CreditBucket(
                    optStringOrNull(o, "showName") ?: "",
                    optNumberOrNull(o, "remainingUnits") ?: 0.0,
                    optNumberOrNull(o, "totalUnits") ?: 0.0,
                    optEpochMsOrNull(o, "expiresAt"),
                ),
            )
        }
    }.sortedWith(compareBy { it.expiresMs ?: Long.MAX_VALUE })
    if (list.isEmpty()) return emptyList()
    val nearestExpiry = list[0].expiresMs
    val windowed = list.size >= 2 &&
        nearestExpiry != null &&
        nearestExpiry <= nowMs + 8 * 60 * 60 * 1000L
    return list.take(2).mapIndexed { i, b ->
        val label = when {
            windowed -> if (i == 0) LABEL_5H else LABEL_WEEK
            list.size == 1 -> b.showName.ifBlank { "总额度" }.take(10)
            else -> b.showName.ifBlank { "额度" }.take(10)
        }
        val progress = if (b.total > 0) (b.remaining / b.total).toFloat().coerceIn(0f, 1f) else null
        val frac = if (b.total > 0) b.remaining / b.total else 1.0
        val warnLevel = when {
            b.total <= 0.0 -> 0
            frac <= 0.10 -> 2
            frac <= 0.30 -> 1
            else -> 0
        }
        // 窗口桶显示重置倒计时；长期桶（体验套餐）改为到期日期
        val resetText = b.expiresMs?.let { exp ->
            if (windowed || exp - nowMs <= 7 * 24 * 60 * 60 * 1000L) {
                fmtResetCountdown(exp, nowMs)
            } else {
                fmtExpiryDate(exp)
            }
        }
        QuotaRowUi(
            label,
            "${fmtCredit(b.remaining.toLong())} / ${fmtCredit(b.total.toLong())}",
            progress,
            striped = false,
            warnLevel = warnLevel,
            resetText = resetText,
        )
    }
}

/** `3,894` — 全精度千分位（次数制值的契约，与 TUI fmtUnits 同语义）。 */
private fun fmtCount(n: Long): String =
    DecimalFormat("#,###", DecimalFormatSymbols(Locale.US)).format(n)

/** 重置倒计时：`1h 54m 后重置` / `3d 06h 后重置` / 已过 → `即将重置`。 */
private fun fmtResetCountdown(resetMs: Long, nowMs: Long): String {
    val diff = resetMs - nowMs
    if (diff <= 0) return "即将重置"
    val minutes = diff / 60000L
    return when {
        minutes >= 1440 -> "%dd %02dh 后重置".format(minutes / 1440, (minutes % 1440) / 60)
        minutes >= 60 -> "%dh %02dm 后重置".format(minutes / 60, minutes % 60)
        else -> "${minutes}m 后重置"
    }
}

/** 长期桶到期提示：`2026-12-31 到期`。 */
private fun fmtExpiryDate(expMs: Long): String =
    java.text.SimpleDateFormat("yyyy-MM-dd", Locale.US).format(java.util.Date(expMs)) + " 到期"

/** credit 紧凑展示：≥1e8 亿 / ≥1e4 万（如 6.4万 / 10万），其余千分位。 */
private fun fmtCredit(n: Long): String = when {
    n >= 100_000_000L -> trimScale(n / 1e8) + "亿"
    n >= 10_000L -> trimScale(n / 1e4) + "万"
    else -> fmtCount(n)
}

private fun trimScale(v: Double): String {
    val s = String.format(Locale.US, "%.1f", v)
    return if (s.endsWith(".0")) s.dropLast(2) else s
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

/** Custom Tabs 打开 URL，无支持浏览器时回退系统 ACTION_VIEW；再失败静默（登录/更新下载共用）。 */
private fun openInBrowser(context: android.content.Context, url: String) {
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
}

private fun formatDuration(ms: Long): String {
    val totalSeconds = ms / 1000
    val h = totalSeconds / 3600
    val m = (totalSeconds % 3600) / 60
    val s = totalSeconds % 60
    return "%02d:%02d:%02d".format(h, m, s)
}
