package com.zcode.proxy

import android.content.Context
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.SecureRandom

/**
 * Stores the per-install credential seed (32-byte hex) used by Node side for
 * AES-256-GCM credential encryption. The seed itself is encrypted by Android
 * Keystore via EncryptedSharedPreferences so it survives app reinstalls (if
 * allowBackup=true) but is unreadable without the device.
 */
object CredentialStore {
    private const val PREFS_NAME = "zcode-proxy-secrets"
    private const val SEED_KEY = "credentialSeed"

    fun getOrCreateSeed(context: Context): String {
        val prefs = encryptedPrefs(context)
        val existing = prefs.getString(SEED_KEY, null)
        if (existing != null) return existing

        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        val seed = bytes.joinToString("") { "%02x".format(it) }
        prefs.edit().putString(SEED_KEY, seed).apply()
        return seed
    }

    private fun encryptedPrefs(context: Context) = EncryptedSharedPreferences.create(
        context,
        PREFS_NAME,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
}
