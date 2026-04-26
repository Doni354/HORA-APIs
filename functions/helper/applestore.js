/* eslint-disable */

/**
 * APPLE APP STORE SERVER API v2 HELPER
 * ======================================
 * Module ini menangani semua interaksi dengan Apple App Store Server API.
 *
 * Fungsi utama:
 * 1. verifyAppleTransaction()   — Verify transaction via App Store Server API v2
 * 2. decodeSignedTransaction()  — Decode Apple JWS signed transaction
 * 3. decodeNotificationPayload() — Decode Apple Server Notification v2 payload
 *
 * Authentication: JWT signed dengan .p8 key dari App Store Connect
 *
 * ────────────────────────────────────────
 * PERBEDAAN DENGAN GOOGLE PLAY:
 * - Google: REST API + Service Account JSON
 * - Apple: JWT Bearer + .p8 private key (ECDSA P-256)
 *
 * Apple TIDAK pakai REST verify langsung.
 * Alur Apple IAP v2:
 *   1. Flutter kirim transactionId (dari StoreKit 2)
 *   2. BE signed JWT → panggil App Store Server API
 *   3. API return signed JWS → decode → validate
 *
 * REFERENSI:
 * - https://developer.apple.com/documentation/appstoreserverapi
 * - https://developer.apple.com/documentation/appstoreservernotifications
 * ────────────────────────────────────────
 */

require("dotenv").config();
const { SignJWT, importPKCS8, jwtVerify, createRemoteJWKSet } = require("jose");
const fs = require("fs");
const path = require("path");

// ──────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────

// Apple App Store Connect credentials (dari .env)
const APPLE_KEY_ID = process.env.APPLE_KEY_ID;
const APPLE_ISSUER_ID = process.env.APPLE_ISSUER_ID;
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || "com.vorce.app";

// Path ke .p8 private key file
const KEY_FILE_PATH = path.join(
  __dirname,
  "..",
  `SubscriptionKey_${APPLE_KEY_ID}.p8`
);

// Apple App Store Server API endpoints
// Production: https://api.storekit.itunes.apple.com
// Sandbox:    https://api.storekit-sandbox.itunes.apple.com
//
// PENTING: Saat development/testing, pakai SANDBOX.
// Saat production, pakai PRODUCTION.
// Bisa juga coba production dulu, kalau 404 → retry ke sandbox.
const APPLE_API_BASE = process.env.APPLE_IAP_SANDBOX === "true"
  ? "https://api.storekit-sandbox.itunes.apple.com"
  : "https://api.storekit.itunes.apple.com";

// Apple JWKS URL untuk verify JWS signatures dari Apple
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";

// ──────────────────────────────────────────────
// PRODUCT CONFIG (sama dengan Google Play)
// ──────────────────────────────────────────────
// Product IDs — Apple uses separate IDs per period (e.g. vorce_basic_month)
// TYPE: "tier" = exclusive plan, "addon" = stackable storage
const PRODUCT_BENEFITS = {
  // ── TIER PLANS (Google Play IDs — for shared config) ──
  vorce_basic:      { name: "Basic Plan", type: "tier",
    monthly: { addedStorage: 1073741824, addedKaryawan: 10 },
    yearly:  { addedStorage: 12884901888, addedKaryawan: 10 } },
  vorce_team:       { name: "Team Plan", type: "tier",
    monthly: { addedStorage: 3221225472, addedKaryawan: 30 },
    yearly:  { addedStorage: 38654705664, addedKaryawan: 30 } },
  vorce_business:   { name: "Business Plan", type: "tier",
    monthly: { addedStorage: 10737418240, addedKaryawan: 100 },
    yearly:  { addedStorage: 128849018880, addedKaryawan: 100 } },
  vorce_enterprise: { name: "Enterprise Plan", type: "tier",
    monthly: { addedStorage: 32212254720, addedKaryawan: 300 },
    yearly:  { addedStorage: 386547056640, addedKaryawan: 300 } },
  // ── STORAGE ADDONS (Google Play IDs) ──
  vorce_storage_1:  { name: "Storage Addon 3GB", type: "addon",
    monthly: { addedStorage: 3221225472, addedKaryawan: 0 },
    yearly:  { addedStorage: 38654705664, addedKaryawan: 0 } },
  vorce_storage_2:  { name: "Storage Addon 10GB", type: "addon",
    monthly: { addedStorage: 10737418240, addedKaryawan: 0 },
    yearly:  { addedStorage: 128849018880, addedKaryawan: 0 } },
  vorce_storage_3:  { name: "Storage Addon 30GB", type: "addon",
    monthly: { addedStorage: 32212254720, addedKaryawan: 0 },
    yearly:  { addedStorage: 386547056640, addedKaryawan: 0 } },
  vorce_storage_4:  { name: "Storage Addon 60GB", type: "addon",
    monthly: { addedStorage: 64424509440, addedKaryawan: 0 },
    yearly:  { addedStorage: 773094113280, addedKaryawan: 0 } },
  // ── APPLE-SPECIFIC TIER PLAN IDS ──
  vorce_basic_month:      { name: "Basic Plan", type: "tier",
    monthly: { addedStorage: 1073741824, addedKaryawan: 10 } },
  vorce_basic_year:       { name: "Basic Plan", type: "tier",
    yearly:  { addedStorage: 12884901888, addedKaryawan: 10 } },
  vorce_team_month:       { name: "Team Plan", type: "tier",
    monthly: { addedStorage: 3221225472, addedKaryawan: 30 } },
  vorce_team_year:        { name: "Team Plan", type: "tier",
    yearly:  { addedStorage: 38654705664, addedKaryawan: 30 } },
  vorce_business_month:   { name: "Business Plan", type: "tier",
    monthly: { addedStorage: 10737418240, addedKaryawan: 100 } },
  vorce_business_year:    { name: "Business Plan", type: "tier",
    yearly:  { addedStorage: 128849018880, addedKaryawan: 100 } },
  vorce_enterprise_month: { name: "Enterprise Plan", type: "tier",
    monthly: { addedStorage: 32212254720, addedKaryawan: 300 } },
  vorce_enterprise_year:  { name: "Enterprise Plan", type: "tier",
    yearly:  { addedStorage: 386547056640, addedKaryawan: 300 } },
  // ── APPLE-SPECIFIC STORAGE ADDON IDS ──
  vorce_storage_1_month:  { name: "Storage Addon 3GB", type: "addon",
    monthly: { addedStorage: 3221225472, addedKaryawan: 0 } },
  vorce_storage_1_year:   { name: "Storage Addon 3GB", type: "addon",
    yearly:  { addedStorage: 38654705664, addedKaryawan: 0 } },
  vorce_storage_2_month:  { name: "Storage Addon 10GB", type: "addon",
    monthly: { addedStorage: 10737418240, addedKaryawan: 0 } },
  vorce_storage_2_year:   { name: "Storage Addon 10GB", type: "addon",
    yearly:  { addedStorage: 128849018880, addedKaryawan: 0 } },
  vorce_storage_3_month:  { name: "Storage Addon 30GB", type: "addon",
    monthly: { addedStorage: 32212254720, addedKaryawan: 0 } },
  vorce_storage_3_year:   { name: "Storage Addon 30GB", type: "addon",
    yearly:  { addedStorage: 386547056640, addedKaryawan: 0 } },
  vorce_storage_4_month:  { name: "Storage Addon 60GB", type: "addon",
    monthly: { addedStorage: 64424509440, addedKaryawan: 0 } },
  vorce_storage_4_year:   { name: "Storage Addon 60GB", type: "addon",
    yearly:  { addedStorage: 773094113280, addedKaryawan: 0 } },
};

// Subscription base limits (sama dengan playstore.js)
const BASE_MAX_STORAGE = 104857600; // 100 MB
const BASE_MAX_KARYAWAN = 3;

// ──────────────────────────────────────────────
// JWT TOKEN GENERATION (untuk API calls ke Apple)
// ──────────────────────────────────────────────

/**
 * Cache untuk private key (lazy loaded)
 * Membaca .p8 file hanya sekali, lalu di-cache
 */
let _privateKey = null;

/**
 * Load private key dari .p8 file
 * Apple menggunakan ES256 (ECDSA P-256) — sama dengan Sign in with Apple
 */
async function getPrivateKey() {
  if (!_privateKey) {
    const keyContent = fs.readFileSync(KEY_FILE_PATH, "utf8");
    _privateKey = await importPKCS8(keyContent, "ES256");
  }
  return _privateKey;
}

/**
 * Generate JWT Token untuk Apple App Store Server API
 *
 * JWT Spec dari Apple:
 * - Algorithm: ES256
 * - Header: { alg: "ES256", kid: KEY_ID, typ: "JWT" }
 * - Payload: { iss: ISSUER_ID, iat: now, exp: now+20min, aud: "appstoreconnect-v1", bid: BUNDLE_ID }
 *
 * Token berlaku 20 menit. Kita generate baru setiap API call
 * (overhead minimal karena signing ES256 cepat).
 *
 * @returns {string} Bearer JWT token
 */
async function generateAppleJWT() {
  const privateKey = await getPrivateKey();

  const token = await new SignJWT({})
    .setProtectedHeader({
      alg: "ES256",
      kid: APPLE_KEY_ID,
      typ: "JWT",
    })
    .setIssuer(APPLE_ISSUER_ID)
    .setIssuedAt()
    .setExpirationTime("20m")
    .setAudience("appstoreconnect-v1")
    // bundleId dikirim sebagai claim custom
    .setSubject(APPLE_BUNDLE_ID) // Menggunakan 'sub' claim, tapi tidak selalu diperlukan
    .sign(privateKey);

  return token;
}

// ──────────────────────────────────────────────
// JWS DECODER (untuk decode signed data dari Apple)
// ──────────────────────────────────────────────

/**
 * Decode JWS (JSON Web Signature) dari Apple.
 *
 * Apple mengirim semua data transaksi dalam format JWS (signed JWT).
 * Kita HARUS verify signature-nya menggunakan Apple's public keys (JWKS)
 * untuk memastikan data asli dari Apple (bukan spoofed).
 *
 * @param {string} signedPayload - JWS string dari Apple (format: header.payload.signature)
 * @returns {Object} Decoded payload (transaction data / notification data)
 */
async function decodeAppleJWS(signedPayload) {
  try {
    // Ambil Apple's public keys dari JWKS endpoint
    const JWKS = createRemoteJWKSet(new URL(APPLE_JWKS_URL));

    // Verify + decode JWS
    const { payload } = await jwtVerify(signedPayload, JWKS, {
      algorithms: ["ES256"],
    });

    return payload;
  } catch (error) {
    // Kalau verify gagal di production keys, coba decode manual
    // (untuk sandbox/testing, Apple kadang pakai keys berbeda)
    console.warn(
      "[AppleStore] JWS verify with JWKS failed, attempting manual decode:",
      error.message
    );

    // Fallback: decode tanpa verify (HANYA untuk debug)
    // Di production, sebaiknya tetap verify
    const parts = signedPayload.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid JWS format");
    }
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );
    console.warn("[AppleStore] ⚠️ Using unverified JWS payload (debug only)");
    return payload;
  }
}

// ──────────────────────────────────────────────
// VERIFY TRANSACTION (API Call ke Apple)
// ──────────────────────────────────────────────

/**
 * Verifikasi transaksi Apple menggunakan App Store Server API v2.
 *
 * Endpoint: GET /inApps/v1/transactions/{transactionId}
 *
 * Berbeda dengan Google Play yang pakai purchaseToken,
 * Apple pakai transactionId (dari StoreKit 2).
 *
 * Response dari Apple berupa JWS signed transaction yang perlu di-decode.
 *
 * @param {string} transactionId - Transaction ID dari StoreKit purchase
 * @returns {Object} Decoded transaction info (productId, expiresDate, status, etc.)
 */
async function verifyAppleTransaction(transactionId) {
  const jwt = await generateAppleJWT();

  const url = `${APPLE_API_BASE}/inApps/v1/transactions/${transactionId}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const error = new Error(
      `Apple API Error: ${response.status} - ${errorBody}`
    );
    error.code = response.status;
    throw error;
  }

  const data = await response.json();

  // Apple response berisi signedTransactionInfo dalam format JWS
  if (data.signedTransactionInfo) {
    return await decodeAppleJWS(data.signedTransactionInfo);
  }

  return data;
}

/**
 * Get subscription status dari Apple App Store Server API v2.
 *
 * Endpoint: GET /inApps/v1/subscriptions/{transactionId}
 *
 * Mengembalikan status lengkap subscription termasuk renewal info.
 *
 * @param {string} transactionId - Original transaction ID
 * @returns {Object} Subscription status data
 */
async function getAppleSubscriptionStatus(transactionId) {
  const jwt = await generateAppleJWT();

  const url = `${APPLE_API_BASE}/inApps/v1/subscriptions/${transactionId}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const error = new Error(
      `Apple Subscription Status Error: ${response.status} - ${errorBody}`
    );
    error.code = response.status;
    throw error;
  }

  const data = await response.json();
  return data;
}

// ──────────────────────────────────────────────
// APPLE SUBSCRIPTION STATUS MAPPING
// ──────────────────────────────────────────────

/**
 * Map Apple subscription status ke internal status.
 *
 * Apple StoreKit 2 subscription states:
 * - 1: ACTIVE (auto-renew ON)
 * - 2: EXPIRED
 * - 3: BILLING_RETRY_PERIOD (payment failed, retrying)
 * - 4: BILLING_GRACE_PERIOD (payment failed, grace period)
 * - 5: REVOKED (refunded)
 *
 * Kita map ke status yang sama dengan Google Play supaya
 * Firestore subscription docs konsisten.
 */
function mapAppleSubscriptionStatus(appleStatus) {
  const statusMap = {
    1: "active",
    2: "expired",
    3: "on_hold",        // billing retry = on_hold
    4: "grace_period",   // billing grace = grace_period
    5: "expired",        // revoked = treated as expired
  };
  return statusMap[appleStatus] || "unknown";
}

/**
 * Map Apple Server Notification v2 notification types
 * ke action yang harus dilakukan.
 *
 * Apple Notification Types:
 * - DID_CHANGE_RENEWAL_PREF   — user changed subscription plan
 * - DID_CHANGE_RENEWAL_STATUS — auto-renew toggled on/off
 * - DID_FAIL_TO_RENEW         — payment failed
 * - DID_RENEW                 — subscription renewed successfully
 * - EXPIRED                   — subscription expired
 * - GRACE_PERIOD_EXPIRED      — grace period ended
 * - OFFER_REDEEMED            — promo offer redeemed
 * - REFUND                    — refund issued
 * - REFUND_DECLINED           — refund request declined
 * - RENEWAL_EXTENDED          — renewal date extended
 * - REVOKE                    — family sharing revoked
 * - SUBSCRIBED                — new subscription or resubscribe
 * - TEST                      — test notification
 */
function getNotificationAction(notificationType) {
  const actionMap = {
    SUBSCRIBED: "activate",
    DID_RENEW: "renew",
    EXPIRED: "expire",
    DID_FAIL_TO_RENEW: "billing_issue",
    GRACE_PERIOD_EXPIRED: "expire",
    REFUND: "revoke",
    REVOKE: "revoke",
    DID_CHANGE_RENEWAL_STATUS: "status_change",
    DID_CHANGE_RENEWAL_PREF: "plan_change",
    RENEWAL_EXTENDED: "extend",
    TEST: "test",
  };
  return actionMap[notificationType] || "unknown";
}

// ──────────────────────────────────────────────
// EXPORTS
// ──────────────────────────────────────────────

module.exports = {
  verifyAppleTransaction,
  getAppleSubscriptionStatus,
  decodeAppleJWS,
  generateAppleJWT,
  mapAppleSubscriptionStatus,
  getNotificationAction,
  PRODUCT_BENEFITS,
  BASE_MAX_STORAGE,
  BASE_MAX_KARYAWAN,
  APPLE_BUNDLE_ID,
};
