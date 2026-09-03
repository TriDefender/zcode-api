# Android APP UI 改版计划

> 状态：设计阶段（三选一待定）
> 预览尺寸：**1080 × 2400（20:9，主流直板机 FHD+，如 Pixel 8 / Redmi K70 / 一加 Ace 系列）**
> 预览文件：`Android-APP/design/previews/option-{a,b,c}-{light,dark}.svg`

---

## 1. 现状与问题（基于 `MainActivity.kt` 现有实现）

| # | 问题 | 现状 |
|---|------|------|
| 1 | 单列滚动三卡，无导航结构 | Settings&Login / Proxy Control / Logs 全部挤在一屏，日志区 `heightIn(max=600dp)` 被上方内容挤压 |
| 2 | 默认 Material 基线主题 | `MaterialTheme {}` 未传 `colorScheme`，是紫色基线 + 手写硬编码色（`0xFF16A34A` 等），无品牌感，亮暗模式表现不一致 |
| 3 | 状态表达弱 | `StatusPill` 一枚小胶囊承担 reachable/loggedIn 全部语义；代理运行状态只有一行小字 |
| 4 | 日志不友好 | 11sp 等宽字挤在小卡里，无过滤/复制/清屏 |
| 5 | 无 Edge-to-Edge、无动效 | 默认布局，无系统栏适配，无状态动效 |

## 2. 信息架构（三套方案共用，只换皮肤）

```
MainActivity
├── 主页 Tab（默认）────────────────────────────┐
│   顶部：应用名 + 状态胶囊 + 设置入口          │
│   ① 运行英雄卡：状态灯 + 运行中/已停止        │ ← 对应 status/startProxy/stopProxy
│      127.0.0.1:{port}（点击复制）+ 运行时长   │
│      大按钮：启动代理 / 停止代理              │
│   ② 账号卡：provider·plan、登录态；           │ ← 对应 startOAuth/logout
│      OAuth 登录/登出按钮就在此卡右侧           │    （未登录时整卡变登录 CTA）
│   ③ 接入配置卡：服务商 Z.AI/智谱 分段切换、    │ ← 对应 setConfig
│      套餐 coding-plan/start-plan 分段切换；    │
│      代理运行中锁定并显示提示                  │
│   ④ 实时日志预览（末 5 行 + 错误计数，         │ ← 对应 getLogs 轮询
│      点击进日志 Tab）                          │
├── 日志 Tab：全屏日志台（等宽、状态着色、       │
│   全部/成功/错误 过滤 chips、复制/清屏/自动滚动）│
└── 设置 Tab：端口、外观（跟随系统/亮/暗）、      │
    关于（版本/控制协议）——provider/plan 已上主页 │
```

现有 `ControlClient` 的 8 个命令（status/startOAuth/deliverOAuthCode/setConfig/startProxy/stopProxy/getLogs/logout）全部有落点，轮询架构（1.5s status + 增量 getLogs）保持不变，只重构展示层。

## 3. 自动深浅色：技术方案（已调研，Compose 原生支持）

1. **跟随系统（默认行为）**：`MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkScheme else lightScheme)`。`isSystemInDarkTheme()` 读取系统 `UI_MODE_NIGHT_*`，用户在系统快捷开关切换深色模式时 **Activity 自动重建/recompose，无需任何手写监听**。
2. **品牌色板为主、Material You 动态取色为辅**：Android 12+ 上可提供开关「使用壁纸取色」，`dynamicLightColorScheme(context)` / `dynamicDarkColorScheme(context)`，低于 12 或开关关闭时回落到本方案的品牌色板（三套方案各自的 light/dark token，见预览）。
3. **系统栏适配**：`enableEdgeToEdge()` + `WindowCompat.getInsetsController(...).isAppearanceLightStatusBars = !darkTheme`，深色模式状态栏图标自动转白，内容绘制到状态栏/手势条后面。
4. **手动覆盖项**（设置页「外观」三选：跟随系统 / 亮色 / 暗色）：偏好存 DataStore；实现上自管一个 `ThemeMode` state（跟随系统时回退到 `isSystemInDarkTheme()`），不需要 `AppCompatDelegate`（纯 Compose 应用无 AppCompat 依赖）。
5. **资源层兜底**：涉及 XML 的启动屏/图标用 `values-night/` 同步适配（可选，非本次重点）。
6. **实证核验（2026-09-03，勿凭印象）**：`MaterialTheme {}` 无参调用**不会**自动跟随系统深色。已从 Google Maven 下载 BOM 2024.12.01 的 POM 与 material3-android 1.3.1 的 sources jar 核验：BOM 映射 material3 **1.3.1**；其 `MaterialTheme(colorScheme = MaterialTheme.colorScheme, ...)` 只继承父级主题，无父级时兜底 `LocalColorScheme = staticCompositionLocalOf { lightColorScheme() }`（`ColorScheme.kt:989`），`MaterialTheme.kt` 全文件 **0 处** `isSystemInDarkTheme`。**即当前线上 APK 在系统深色下也永远是亮色板**。跟随系统必须显式 `isSystemInDarkTheme()`（本设计做法）。
   - 同步链路：系统深色开关（快捷磁贴/省电/定时）→ `Configuration.uiMode` 变化 → Manifest 未声明 `configChanges` → **Activity 重建** → `isSystemInDarkTheme()`（= `LocalConfiguration.uiMode and UI_MODE_NIGHT_MASK == UI_MODE_NIGHT_YES`）取新值重组。
   - 附带修复：`Theme.ZcodeProxy` 目前写死 `android:Theme.Material.NoActionBar`（亮色窗口底），深色下启动瞬间白闪 → 补 `values-night/themes.xml`（框架的 `android:Theme.Material.NoActionBar` 即深色版）。状态栏图标对比：`enableEdgeToEdge()` 的 `SystemBarStyle.auto` 会随配置变化自动重应用（activity 1.9.3），并在 `ZcodeTheme` 内用 `SideEffect { isAppearanceLightStatusBars = !darkTheme }` 显式兜底。

> 本规则的其余部分（SVG 预览）即按每种风格各出一套亮色 token、一套暗色 token 渲染，成对对比。

## 4. 三套候选风格

### 方案 A —— Material You · 原生质感（Google 原生方向）
- **关键词**：Material 3 Expressive、色调分层表面（surfaceContainer 阶梯）、大圆角（26dp 卡片/全圆胶囊）、动态取色可选。
- **颜色**：靛紫主色 `#4C4FD8`（暗色反转为浅紫 `#C0C1FF`）；英雄卡用 primaryContainer 色调面。
- **动效**：M3 弹性容器变换、状态点呼吸、按钮涟漪。
- **适合**：想跟 Android 生态完全一致、实现成本最低、后续可白嫖壁纸取色。

### 方案 B —— 极光玻璃 · Aurora Glass（潮流深色优先）
- **关键词**：毛玻璃半透明卡片、极光渐变背景光斑、发光状态灯、悬浮玻璃 Dock 底栏、细 1px 高光描边。
- **颜色**：暗色玄绿黑底 `#060A09→#0D1210` + 松绿/胭脂/苍 光斑（真实极光：绿主调、玫红边缘）；亮色为月白→藕荷粉彩底 + 80% 白玻璃卡。
- **动效**：光斑缓慢漂移（`withInfiniteAnimation`）、状态灯辉光脉冲、卡片 blur-in。
- **适合**：想要「一眼惊艳」的演示效果；注意 Compose 用 `Modifier.blur()`/RenderEffect 做 UI 毛玻璃有性能预算，需在低端机上降级。

### 方案 C —— 终端控制台 · Terminal Console（开发者向，与桌面 TUI 同一品牌语言）
- **关键词**：等宽字体数据、tmux/vim 式顶部状态行 `● RUNNING │ 127.0.0.1:8080 │ ERR 0`、小圆角描边面板、LED 指示灯、`[ ■ STOP ]` 括号按钮、日志区是主角（占屏最大，行号+级别着色）；**日志终端面板在亮色模式下也保持深色**（同 VS Code 浅色主题嵌深色终端的习惯）。
- **颜色**：暗色 `#0B0D0F` 底 + 终端绿 `#3ECF8E` / 青 `#5CC8FF` / 琥珀 `#F5B657`；亮色纸白 `#FAFAF7` + 墨色文字。
- **动效**：日志打字机追加、LED 闪烁、光标闪烁。
- **适合**：工具属性强、与 PC 端 TUI（`src/tui/`）形成统一品牌；日志场景下信息密度最高。

### 三方案对比速览

| 维度 | A 原生质感 | B 极光玻璃 | C 终端控制台 |
|------|-----------|-----------|-------------|
| 第一印象 | 亲和、正经 | 惊艳、潮流 | 硬核、专业 |
| 实现成本 | ★ 最低（纯 M3 组件） | ★★★ blur/RenderEffect + 性能兜底 | ★★ 自绘组件为主 |
| 亮暗成色 | 两套等权重 | 暗色更出彩 | 两套等权重（日志区恒深色） |
| 品牌关联 | 中（Google 味） | 低（通用潮流） | 高（呼应桌面 TUI） |
| 信息密度 | 中 | 中低 | 高 |

## 5. 实施拆分（选定方案后）

1. `ui/theme/{Color,Type,Shape,Theme}.kt`：两套 `ColorScheme` token + `ZcodeTheme(mode)`（跟随系统/DataStore 覆盖）。
2. `ui/nav/`：`navigation-compose` 底部三 Tab；MainActivity 只留骨架 + 轮询 state 下发。
3. 组件：`StatusHeroCard` / `AccountCard` / `StatChipRow` / `LogConsole`（列表虚拟化沿用 LazyColumn）/ `BottomNavBar`；toast 换 SnackbarHost。
4. 逐卡替换现有 `AppScreen` 内实现，控制协议（`ControlClient`）零改动。
5. 验收：系统深色切换即时生效；日志页过滤/复制可用；`adb shell run-as com.zcode.proxy curl 127.0.0.1:<port>/status` 联调（见 anti-pattern #22）。

## 6. 预览文件清单

```
Android-APP/design/
├── UI-REDESIGN-PLAN.md                    ← 本文件
└── previews/
    ├── option-a-material-you-light.svg    (1080×2400)
    ├── option-a-material-you-dark.svg
    ├── option-b-aurora-glass-light.svg
    ├── option-b-aurora-glass-dark.svg
    ├── option-c-terminal-light.svg
    └── option-c-terminal-dark.svg
```

每张预览均为「主页 Tab」运行中状态，内容一致（运行英雄卡 / 账号卡 / 统计 / 日志预览 / 底部导航），便于横向对比皮肤。

## 7. 设计质量校准（v2，对照 Anthropic `frontend-design` skill）

按 anthropics/skills · frontend-design 的方法论做了一轮自我批判与修订：先钉死主题，再为每案写完整 token 系统（色/字/布局/签名元素），对照「AI 模板默认观」逐条排雷后更新了全部预览 SVG。

### 7.1 主题锚定（subject grounding）

- **主题**：跑在手机上的本地 AI 编码代理反向代理管道（ZCode Proxy）。**观众**：开发者本人。**这一屏唯一的工作**：3 秒确认「管道活着、健康」，并看清正在流动的流量。
- 主题世界的原料：端口与地址、请求流水（`#128 OAI glm-4.6 200 batch 1.0s`——直接沿用桌面端 compact 日志的原文 vernacular）、状态码语义色、终端。
- **数据的声音是等宽字体**：三案统一——地址/数值/百分比/日志一律 mono（JetBrains Mono，OFL 可随 APK 打包；CJK 回落系统字体）。这是最贴题的字体决策，不是风格装饰。

### 7.2 每案 token 系统

> **取色源：中国传统色**（霁蓝、靛青、月白、鸦青、漆黑、青莲、石青、胭脂、松绿、秋香、缃、藕荷、霜白、玄）——只取色相、不取纹样符号，按 WCAG 对明度做微调，应用方式保持现代。语义色三案统一：**2xx=松绿系、信息=青蓝系、错误/登出=胭脂、429/等待=秋香·缃**。

| | A 原生质感 | B 极光玻璃 | C 终端控制台 |
|---|---|---|---|
| 色板（中国传统色） | Surface 霜白 `#F5F9FA` / Card 月白 `#E8F0F3` / 靛青 `#177CB0` / 绀青 `#123B4E` / 鸦青 `#1F2A30`（暗：漆黑 `#12181D`、鸦青黑 `#1C2429`、月白蓝 `#7EC3DF`、绀青 `#17475E`） | 玄绿 `#060A09→#0D1210` / 松绿 `#1E9E74` / 胭脂 `#C2475E` / 苍·天水碧 `#2E8F8A`（亮：月白 `#E9F3F5`→藕荷 `#F5E4ED`、松绿深 `#0E8A5F`） | 玄 `#0E1417` / 鸦青黑 `#131C21` / 松绿 `#2BC48A` / 石青 `#56B8DC` / 胭脂 `#E05561`（亮：霜白 `#F4F7F6`、松绿 `#147A56`、靛青 `#177CB0`、胭脂 `#A32E3C`） |
| 字体角色 | 界面=系统 sans；数据=JetBrains Mono | 界面=系统 sans；数据=JetBrains Mono；签名=Space Grotesk（wordmark/大数字，OFL） | 全等宽（mono 即身份）；CJK 回落 |
| 布局一句话 | 英雄卡=绀青色调面承载「状态+脉搏」，其余安静 | 光斑是背景主角，卡片是浮在极光上的玻璃 | 日志终端是主角（占屏最大），其余是它的仪表 |
| 签名元素（唯一大胆处） | **管道脉搏**：英雄卡内近 60 分钟请求 sparkline，末点呼吸 | **会呼吸的极光**：光斑随请求缓慢脉动 + 状态灯辉光 | **tail -f 主役**：状态行 + LED + 恒深色日志终端 |
| 一处主时刻（动效） | 状态灯呼吸 + sparkline 末点脉动，其余遵循 M3 默认 | 进场光斑漂移就位，此后仅状态灯辉光脉冲 | 日志打字机追加 + 光标闪烁（唯一动效） |

> SVG 预览以系统字体近似排版；实际实现按上表打包 OFL 字体。

### 7.3 对照「AI 默认观」的排雷记录

- 校准参考默认观 #2「近黑底 + 单一酸绿」正是 C 暗色的第一版风险 → **辩护**：终端语言由主题本身钉死（与桌面 TUI 同源）；**差异化**：绿/青/红是语义色（2xx/信息/错误），贯穿状态行、统计顶条、日志着色，不是装饰 accent；布局上日志主角化而非数字卡阵列；状态行/LED/括号按钮来自真实 TUI 词汇。
- 「大数字 + 小标签 + 渐变 accent」模板答案 → A 的统计三卡退居次要，英雄卡换成主题专属的「管道脉搏」sparkline；B 的渐变做减法（额度条、Dock 文字、头像光环改纯色，渐变只留 logo/主按钮/头像三处核心）。
- 装饰性编号 → C 底栏初版 `[1][2][3]` F 键编号在手机上无真实对应，已删除；日志 Tab 改为显示真实缓冲行数（128）。
- 假信息 → C 状态行右侧 `x86_64` 是上游伪装身份（anti-pattern #34），不应出现在自己的 UI 里，改为真实运行时 `NODE 26.4`。

### 7.4 文案（设计材料，非装饰）

- 动词直说、全流程同名：按钮「停止代理」→ toast「代理已停止」；「启动代理」→「代理已启动 · 127.0.0.1:8080」。
- 按用户心智命名：界面显示「服务商 / 套餐」，而非内部字段 provider/plan（代码层保留）。
- 空状态是指引不是气氛：日志空 → 「还没有请求 — 在编码工具里发一次对话试试」；未登录 → 「登录后即可启动代理」。
- 错误不道歉、不含糊：「Node 未响应 — 检查服务是否在运行」。
- 现 UI 为英文文案；实现时二选一：全中文（推荐，预览即中文）或提供英文对照表。

### 7.5 质量底线（不宣告地做到）

- 触控目标 ≥ 48dp；状态色对比按 WCAG AA 校准（暗色上的绿/琥珀提亮为 `#6CD79E`/`#F2C063` 一档）；系统开启「减少动态效果」时关停光斑漂移/打字机，退化为直接呈现；深浅色随系统即时切换（见 §3）。
- 字体打包：JetBrains Mono + Space Grotesk（仅 B）均 OFL，`FontFamily(R.font...)` 随 APK；CJK 由系统字体承担。

### 7.6 预览 v2 变更摘要

- **A**：英雄卡加入 sparkline（签名元素），统计数字改 mono，删除与统计卡重复的「今日请求」文案。
- **B**：渐变做减法（-3 处），统计数字改 mono。
- **C**：删装饰编号底栏、状态行右侧改 `NODE 26.4`，其余保持纪律。
- **品牌**：六张预览左上角已替换为从 `ZCode.exe` 提取的真实应用图标（PE 资源 RT_ICON 256px PNG）；母版存于 `Android-APP/design/assets/zcode-app-icon.png`，可直接作为 Android 端 mipmap 资源源文件。暗色预览中图标垫了一圈微光描边以防黑底糊边；实现时对应 `Image` + `border`（暗色主题）。

### 7.7 v3 变更（传统色 + 功能落位）

- **配色**：全部色板以中国传统色为取色源——A 霁蓝/靛青/月白/鸦青/漆黑，B 松绿/胭脂/天水碧/藕荷/玄（v4 去 AI 紫），C 松绿/石青/胭脂/秋香/玄/霜白。只借色相、无任何国风纹样符号；语义色三案统一（2xx 松绿系、信息青蓝系、错误与登出=胭脂、429=秋香/缃）。
- **功能按钮落位**：**OAuth 登录/登出 → 主页账号卡右侧**（已登录显示「登出」胶囊，未登录时整卡变为「登录」CTA，代理未登录不可启动）；**provider（Z.AI/智谱）与 plan（coding-plan/start-plan）→ 主页新增「接入配置」卡**，两行分段选择，代理运行中锁定并显示「运行中 · 切换已锁定」提示（沿用现有 `enabled = !proxyRunning` 语义）；设置页只留端口/外观/关于。
- **统计数字卡取消**（skill 排雷的「大数字+小标签」模板位）：请求量并入 sparkline、错误数并入 A/B 日志头「错误 0」计数与 C 状态行 `ERR 0`，腾出的空间给了接入配置卡。

### 7.8 v4 变更（B 去除「AI 紫」）

用户反馈 B 的蓝紫渐变「AI 味太足」——这正是 §7.3 校准点名的默认观残留。修正方向：**极光回归物理本色**（真实极光 = 氧原子 557.7nm 绿线为主调 + 氮的红/粉边缘），不是换一个讨好的渐变：

- 暗色光斑：青莲 `#801DAE` → 松绿 `#1E9E74`，石青 → 胭脂亮 `#C2475E`，胭脂 → 苍·天水碧 `#2E8F8A`；底色从蓝黑改玄绿黑。
- 主按钮：青莲→石青渐变改纯绿系渐变（`#1FA97A→#12A98F`）+ 绿色辉光；顶线渐变改为**绿→玫红边缘**（`#2BC48A→#E05561`，极光签名）；头像同绿系渐变。
- 亮色光斑：青莲粉/石青粉 → 松绿粉 `#A9D4BE` / 天水碧 `#BFE0D4`，胭脂粉保留；主色改松绿深 `#0E8A5F`。
- 玻璃卡底色从蓝紫黑 `#10122A` 调为绿黑 `#0F1A17`；全部紫值经 grep 校验零残留。
- 保留不变：玻璃卡结构、悬浮 Dock、辉光状态灯、石青日志 tag（信息语义色）。
