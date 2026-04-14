/* eslint-disable */
const { db } = require("../config/firebase");

/**
 * Cek apakah nomor telepon sudah dipakai user lain di collection 'users'.
 * 
 * @param {string} noTelp - Nomor telepon yang dicek
 * @param {string|null} excludeEmail - Email user yg sedang update (dikecualikan dari pengecekan)
 * @returns {Promise<{isDuplicate: boolean, owner: string|null}>}
 */
async function checkPhoneUnique(noTelp, excludeEmail = null) {
  if (!noTelp) return { isDuplicate: false, owner: null };

  const snapshot = await db
    .collection("users")
    .where("noTelp", "==", noTelp)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return { isDuplicate: false, owner: null };
  }

  // Cek apakah pemiliknya adalah user yang sedang update (self)
  const ownerEmail = snapshot.docs[0].id;
  if (excludeEmail && ownerEmail === excludeEmail) {
    return { isDuplicate: false, owner: null };
  }

  return { isDuplicate: true, owner: ownerEmail };
}

module.exports = { checkPhoneUnique };
