/* eslint-disable */

/**
 * GOOGLE PLAY DEVELOPER API HELPER
 * =================================
 * Module ini menangani semua interaksi dengan Google Play Developer API.
 *
 * Fungsi utama:
 * 1. verifySubscription()  — Cek status subscription dari purchaseToken
 * 2. acknowledgeSubscription() — Acknowledge purchase agar tidak auto-refund
 *
 * Authentication menggunakan Service Account JSON (GoogleApiKey.json)
 */

const { google } = require("googleapis");
const path = require("path");

// ──────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────

// Package name aplikasi Android kamu
// PENTING: Ganti ini dengan package name yang benar di Play Console
const PACKAGE_NAME = "com.vorce.app";

// Path ke Service Account JSON
const KEY_FILE_PATH = path.join(__dirname, "..", "GoogleApiKey.json");

// Subscription base limits (default tanpa subscription)
// Dipakai oleh recalculateLimits() untuk menghitung total limit
const BASE_MAX_STORAGE = 104857600; // 100 MB in bytes
const BASE_MAX_KARYAWAN = 3;

// ──────────────────────────────────────────────
// GOOGLE AUTH CLIENT (Singleton)
// ──────────────────────────────────────────────
// Pakai lazy initialization supaya auth client hanya dibuat sekali
let _authClient = null;

/**
 * Mendapatkan Google Auth client.
 * Menggunakan Service Account untuk autentikasi ke Google Play Developer API.
 *
 * Kenapa singleton? Karena auth client bisa di-reuse antar request.
 * Membuat auth client baru setiap request itu wasteful (baca file + handshake).
 */
async function getAuthClient() {
  if (!_authClient) {
    const auth = new google.auth.GoogleAuth({
      keyFile: KEY_FILE_PATH,
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
    _authClient = await auth.getClient();
  }
  return _authClient;
}

// ──────────────────────────────────────────────
// VERIFY SUBSCRIPTION
// ──────────────────────────────────────────────

/**
 * Verifikasi subscription menggunakan purchaseToken.
 *
 * Memanggil subscriptionsv2.get (API v2 yang lebih baru dan lengkap).
 * API v2 mengembalikan semua info yang dibutuhkan dalam satu call:
 * - subscriptionState
 * - expiryTime
 * - acknowledgementState
 * - lineItems (produk apa yang dibeli)
 *
 * @param {string} purchaseToken - Token dari Google Play purchase
 * @returns {Object} Response dari Google Play API
 * @throws {Error} Jika token invalid atau API call gagal
 */
async function verifySubscription(purchaseToken) {
  const authClient = await getAuthClient();
  const androidPublisher = google.androidpublisher({
    version: "v3",
    auth: authClient,
  });

  // subscriptionsv2.get — endpoint baru yang lebih baik dari subscriptions.get
  // Tidak perlu productId, cukup purchaseToken saja
  const response = await androidPublisher.purchases.subscriptionsv2.get({
    packageName: PACKAGE_NAME,
    token: purchaseToken,
  });

  return response.data;
}

// ──────────────────────────────────────────────
// ACKNOWLEDGE SUBSCRIPTION
// ──────────────────────────────────────────────

/**
 * Acknowledge subscription purchase ke Google Play.
 *
 * WAJIB dilakukan! Jika tidak di-acknowledge dalam 3 hari,
 * Google Play akan otomatis refund pembelian user.
 *
 * Kenapa ada subscriptionId dan basePlanId?
 * - subscriptionId = product ID subscription (contoh: "vorce_explorer")
 * - Ini dibutuhkan oleh API v1 acknowledge endpoint
 *
 * @param {string} purchaseToken - Token dari purchase
 * @param {string} subscriptionId - Product ID subscription
 */
async function acknowledgeSubscription(purchaseToken, subscriptionId) {
  const authClient = await getAuthClient();
  const androidPublisher = google.androidpublisher({
    version: "v3",
    auth: authClient,
  });

  // Acknowledge menggunakan API v1 (subscriptions.acknowledge)
  // karena v2 belum punya endpoint acknowledge tersendiri
  await androidPublisher.purchases.subscriptions.acknowledge({
    packageName: PACKAGE_NAME,
    subscriptionId: subscriptionId,
    token: purchaseToken,
  });
}

// ──────────────────────────────────────────────
// EXPORTS
// ──────────────────────────────────────────────

module.exports = {
  verifySubscription,
  acknowledgeSubscription,
  PACKAGE_NAME,
  BASE_MAX_STORAGE,
  BASE_MAX_KARYAWAN,
};
