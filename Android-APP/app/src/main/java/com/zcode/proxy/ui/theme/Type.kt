package com.zcode.proxy.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import com.zcode.proxy.R

/**
 * 数据声部（地址 / 数值 / 日志）专用等宽字体：JetBrains Mono（SIL OFL 1.1，
 * 许可证全文见 Android-APP/fonts-OFL.txt）。CJK 字形回落系统字体。
 */
val Mono = FontFamily(
    Font(R.font.jetbrainsmono_regular, FontWeight.Normal),
    Font(R.font.jetbrainsmono_medium, FontWeight.Medium),
    Font(R.font.jetbrainsmono_semibold, FontWeight.SemiBold),
    Font(R.font.jetbrainsmono_bold, FontWeight.Bold),
)

val AppTypography = Typography()
