/* eslint-disable */

/**
 * SUBSCRIPTION SERVICE
 * ====================
 * Shared utilities untuk semua subscription logic.
 * Dipanggil oleh googlePlayService, appleSubscriptionService, dll.
 *
 * Exports:
 *   resolveBenefits(productId, basePlanId) → benefit object | null
 *   mapSubscriptionState(googleState)      → internal status string
 *   isActiveState(status)                  → boolean
 *   recalculateLimits(companyId)           → Promise<void>
 */

const { db } = require("../config/firebase");
const { PRODUCT_BENEFITS } = require("../config/products");
const {
  BASE_MAX_STORAGE,
  BASE_MAX_DEVICES,
} = require("../helper/playstore");

// ──────────────────────────────────────────────
// resolveBenefits
// ──────────────────────────────────────────────
/**
 * Resolve benefit dari productId + basePlanId.
 * @param {string} productId  - e.g. "vorce_basic"
 * @param {string} basePlanId - e.g. "monthly" | "yearly"
 * @returns {{ name, type, addedStorage, addedKaryawan, maxDevices, billingPeriod }} | null
 */
function resolveBenefits(productId, basePlanId) {
  const product = PRODUCT_BENEFITS[productId];
  if (!product) return null;

  const period = (basePlanId || "").toLowerCase().includes("year") ? "yearly" : "monthly";
  const benefits = product[period] || product.monthly;
  if (!benefits) return null;

  return {
    name: product.name,
    type: product.type,
    addedStorage: benefits.addedStorage,
    addedKaryawan: benefits.addedKaryawan,
    maxDevices: benefits.maxDevices || 0,
    billingPeriod: period,
  };
}

// ──────────────────────────────────────────────
// mapSubscriptionState
// ──────────────────────────────────────────────
/**
 * Konversi subscriptionState Google Play API v2 ke status internal.
 * @param {string} googleState
 * @returns {string}
 */
function mapSubscriptionState(googleState) {
  const stateMap = {
    SUBSCRIPTION_STATE_ACTIVE:                    "active",
    SUBSCRIPTION_STATE_CANCELED:                  "cancelled",
    SUBSCRIPTION_STATE_IN_GRACE_PERIOD:           "grace_period",
    SUBSCRIPTION_STATE_ON_HOLD:                   "on_hold",
    SUBSCRIPTION_STATE_PAUSED:                    "paused",
    SUBSCRIPTION_STATE_EXPIRED:                   "expired",
    SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "expired",
  };
  return stateMap[googleState] || "unknown";
}

// ──────────────────────────────────────────────
// isActiveState
// ──────────────────────────────────────────────
/**
 * Apakah status subscription dianggap masih aktif?
 * Grace period masih aktif — memberi waktu user memperbaiki payment.
 * @param {string} status
 * @returns {boolean}
 */
function isActiveState(status) {
  return ["active", "grace_period"].includes(status);
}

// ──────────────────────────────────────────────
// recalculateLimits
// ──────────────────────────────────────────────
/**
 * Hitung ulang maxStorage & max_devices berdasarkan semua subscription aktif.
 *
 * Formula:
 *   Ada tier  → maxStorage = tierStorage + addonStorage
 *   Tidak ada → maxStorage = BASE_MAX_STORAGE + addonStorage
 *
 * Fungsi ini IDEMPOTENT — aman dipanggil berulang kali.
 * @param {string} companyId
 */
async function recalculateLimits(companyId) {
  const activeSubs = await db
    .collection("companies")
    .doc(companyId)
    .collection("subscriptions")
    .where("status", "in", ["active", "grace_period"])
    .get();

  let tierStorage = 0;
  let hasTierPlan = false;
  let addonStorage = 0;
  let velinkedMaxDevices = 0;
  let hasVelinkedPlan = false;

  activeSubs.forEach((doc) => {
    const data = doc.data();
    if (data.productType === "tier") {
      if (!hasTierPlan || data.addedStorage > tierStorage) {
        tierStorage = data.addedStorage || 0;
      }
      hasTierPlan = true;
    } else if (data.productType === "velinked") {
      const devLimit = data.maxDevices || 0;
      if (!hasVelinkedPlan || devLimit > velinkedMaxDevices) {
        velinkedMaxDevices = devLimit;
      }
      hasVelinkedPlan = true;
    } else {
      addonStorage += data.addedStorage || 0;
    }
  });

  const finalStorage = hasTierPlan
    ? tierStorage + addonStorage
    : BASE_MAX_STORAGE + addonStorage;
  const finalMaxDevices = hasVelinkedPlan ? velinkedMaxDevices : BASE_MAX_DEVICES;

  await db.collection("companies").doc(companyId).update({
    maxStorage: finalStorage,
    max_devices: finalMaxDevices,
  });

  console.log(
    `[SubscriptionService] Recalculated limits for ${companyId}: ` +
      `maxStorage=${finalStorage} (tier=${hasTierPlan}), ` +
      `addonStorage=${addonStorage}, ` +
      `max_devices=${finalMaxDevices} (velinked=${hasVelinkedPlan})`
  );
}

module.exports = { resolveBenefits, mapSubscriptionState, isActiveState, recalculateLimits };
