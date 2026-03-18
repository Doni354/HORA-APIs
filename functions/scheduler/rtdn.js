/* eslint-disable */

/**
 * GOOGLE PLAY RTDN — PUB/SUB TRIGGER
 * =====================================
 * Fungsi ini otomatis di-trigger oleh Google Cloud Pub/Sub setiap kali
 * ada perubahan status subscription di Google Play.
 *
 * KENAPA PUB/SUB TRIGGER, BUKAN WEBHOOK?
 * ────────────────────────────────────────
 * 1. KEAMANAN: Pub/Sub trigger hanya bisa dipanggil oleh Google.
 *    Webhook endpoint bisa di-hit siapa saja (public URL).
 *
 * 2. SETUP SIMPEL: Cukup tulis kode + deploy. Tidak perlu setup
 *    Pub/Sub Subscription manual di GCP Console.
 *
 * 3. RETRY OTOMATIS: Jika function error/throw, Firebase otomatis
 *    retry dengan exponential backoff. Webhook harus return 200
 *    meskipun error (kalau tidak, Pub/Sub retry terus-menerus).
 *
 * 4. SCALING INDEPENDEN: Function ini scale terpisah dari API utama.
 *    Kalau banyak notifikasi masuk, tidak mengganggu performance
 *    Express app.
 *
 * ────────────────────────────────────────
 * CARA KERJANYA:
 * Google Play → kirim event ke Pub/Sub topic "play-rtdn"
 * → Firebase Functions otomatis detect message baru di topic
 * → Trigger function ini
 * → Function re-verify ke Google Play API
 * → Update Firestore
 *
 * ────────────────────────────────────────
 * NOTIFICATION TYPES (dari Google Play):
 *  1 = RECOVERED     (payment berhasil setelah gagal)
 *  2 = RENEWED       (auto-renew berhasil)
 *  3 = CANCELED      (user cancel, masih aktif sampai period habis)
 *  4 = PURCHASED     (pembelian baru — biasanya sudah di-handle /verify)
 *  5 = ON_HOLD       (payment gagal, akses dihentikan)
 *  6 = IN_GRACE_PERIOD (payment gagal, masih ada grace period)
 *  7 = RESTARTED     (re-activate setelah cancel)
 *  8 = PRICE_CHANGE_CONFIRMED
 *  9 = DEFERRED      (gratis/extended oleh developer)
 * 10 = PAUSED
 * 11 = PAUSE_SCHEDULE_CHANGED
 * 12 = REVOKED       (refund/dicabut)
 * 13 = EXPIRED       (benar-benar expired)
 * 20 = PENDING_PURCHASE_CANCELED
 */

const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { Timestamp } = require("firebase-admin/firestore");
const { db } = require("../config/firebase");
const {
  verifySubscription,
  BASE_MAX_STORAGE,
  BASE_MAX_KARYAWAN,
} = require("../helper/playstore");

// ──────────────────────────────────────────────
// HELPERS (sama dengan yang di subscription.js)
// ──────────────────────────────────────────────

function mapSubscriptionState(googleState) {
  const stateMap = {
    SUBSCRIPTION_STATE_ACTIVE: "active",
    SUBSCRIPTION_STATE_CANCELED: "cancelled",
    SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "grace_period",
    SUBSCRIPTION_STATE_ON_HOLD: "on_hold",
    SUBSCRIPTION_STATE_PAUSED: "paused",
    SUBSCRIPTION_STATE_EXPIRED: "expired",
    SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "expired",
  };
  return stateMap[googleState] || "unknown";
}

/**
 * Recalculate limits — sama persis dengan yang di subscription.js.
 * Formula: maxStorage/maxKaryawan = BASE + Σ(addon dari subscription aktif)
 */
async function recalculateLimits(companyId) {
  const activeSubs = await db
    .collection("companies")
    .doc(companyId)
    .collection("subscriptions")
    .where("status", "in", ["active", "grace_period"])
    .get();

  let totalAddedStorage = 0;
  let totalAddedKaryawan = 0;

  activeSubs.forEach((doc) => {
    const data = doc.data();
    totalAddedStorage += data.addedStorage || 0;
    totalAddedKaryawan += data.addedKaryawan || 0;
  });

  await db
    .collection("companies")
    .doc(companyId)
    .update({
      maxStorage: BASE_MAX_STORAGE + totalAddedStorage,
      maxKaryawan: BASE_MAX_KARYAWAN + totalAddedKaryawan,
    });

  console.log(
    `[RTDN] Recalculated limits for ${companyId}: ` +
      `maxStorage=${BASE_MAX_STORAGE + totalAddedStorage}, ` +
      `maxKaryawan=${BASE_MAX_KARYAWAN + totalAddedKaryawan}`
  );
}

// ──────────────────────────────────────────────
// PUB/SUB TRIGGER — RTDN HANDLER
// ──────────────────────────────────────────────

/**
 * onPlayRtdn
 *
 * Firebase Functions v2 Pub/Sub trigger.
 * Otomatis di-invoke ketika ada message baru di topic "play-rtdn".
 *
 * Perbedaan dengan webhook:
 * - Data notification sudah tersedia di event.data.message.json
 *   (sudah di-decode otomatis oleh Firebase, tidak perlu parse base64 manual)
 * - Kalau throw error, Firebase RETRY otomatis (dengan backoff)
 * - Tidak perlu return status code (bukan HTTP endpoint)
 */
const onPlayRtdn = onMessagePublished(
  {
    topic: "play-rtdn",
    region: "asia-southeast2",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (event) => {
    // ─── A. EXTRACT NOTIFICATION DATA ───
    // Firebase v2 sudah auto-decode base64 → JSON
    // event.data.message.json berisi notification object langsung
    const notification = event.data.message.json;

    if (!notification) {
      console.warn("[RTDN] Empty notification data");
      return;
    }

    console.log("[RTDN] Received:", JSON.stringify(notification));

    // ─── B. EXTRACT SUBSCRIPTION NOTIFICATION ───
    const subNotif = notification.subscriptionNotification;
    if (!subNotif) {
      // Bisa jadi test notification atau one-time product notification
      console.log("[RTDN] Not a subscription notification, ignoring.");
      return;
    }

    const { notificationType, purchaseToken, subscriptionId } = subNotif;

    if (!purchaseToken) {
      console.warn("[RTDN] Missing purchaseToken in notification");
      return;
    }

    console.log(
      `[RTDN] Type=${notificationType}, Product=${subscriptionId}, ` +
        `Token=${purchaseToken.substring(0, 20)}...`
    );

    // ─── C. CARI SUBSCRIPTION DI DATABASE ───
    // Lookup purchaseToken di registry untuk menemukan companyId
    const tokenDoc = await db
      .collection("subscription_tokens")
      .doc(purchaseToken)
      .get();

    if (!tokenDoc.exists) {
      // Token belum pernah diverifikasi oleh /verify endpoint.
      // Bisa terjadi jika:
      // 1. RTDN datang lebih cepat dari client verify (race condition)
      // 2. Purchase dari sumber lain yang belum di-track
      //
      // LOG dan skip — client tetap harus memanggil /verify untuk aktivasi pertama.
      console.warn(
        "[RTDN] Token not found in registry. Possibly not yet verified by client."
      );
      return;
    }

    const { companyId, subscriptionId: subDocId } = tokenDoc.data();

    // ─── D. RE-VERIFY KE GOOGLE PLAY ───
    // Jangan percaya notificationType saja — selalu re-verify ke Google Play
    // untuk mendapatkan status terbaru yang akurat.
    let subscriptionData;
    try {
      subscriptionData = await verifySubscription(purchaseToken);
    } catch (apiError) {
      console.error(
        "[RTDN] Failed to verify with Google Play:",
        apiError.message
      );
      // THROW error agar Firebase retry otomatis.
      // Ini keuntungan Pub/Sub trigger vs webhook — retry otomatis!
      throw apiError;
    }

    // ─── E. UPDATE STATUS DI FIRESTORE ───
    const googleState = subscriptionData.subscriptionState;
    const newStatus = mapSubscriptionState(googleState);
    const lineItem = subscriptionData.lineItems?.[0] || {};
    const expiryTime = lineItem.expiryTime
      ? new Date(lineItem.expiryTime)
      : null;
    const autoRenewing = lineItem.autoRenewingPlan ? true : false;

    // Build update object
    const updateData = {
      status: newStatus,
      autoRenewing: autoRenewing,
      lastRtdnAt: Timestamp.now(),
      lastRtdnType: notificationType,
    };

    if (expiryTime) {
      updateData.expiresAt = Timestamp.fromDate(expiryTime);
    }

    // Tambahkan timestamp spesifik berdasarkan event
    switch (notificationType) {
      case 2: // RENEWED
        updateData.lastRenewedAt = Timestamp.now();
        break;
      case 3: // CANCELED
        updateData.cancelledAt = Timestamp.now();
        break;
      case 13: // EXPIRED
      case 12: // REVOKED
        updateData.expiredAt = Timestamp.now();
        break;
    }

    // Update subscription document
    const subRef = db
      .collection("companies")
      .doc(companyId)
      .collection("subscriptions")
      .doc(subDocId);

    const subDoc = await subRef.get();
    if (!subDoc.exists) {
      console.warn(
        `[RTDN] Subscription doc ${subDocId} not found in company ${companyId}`
      );
      return;
    }

    await subRef.update(updateData);

    // ─── F. RECALCULATE LIMITS ───
    await recalculateLimits(companyId);

    console.log(
      `[RTDN] ✅ Updated ${subDocId} → status: ${newStatus} (type: ${notificationType})`
    );
  }
);

module.exports = { onPlayRtdn };
