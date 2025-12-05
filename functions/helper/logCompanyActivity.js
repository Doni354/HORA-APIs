/* eslint-disable */
// helpers/activityLogger.js
const { db } = require("../config/firebase"); // Sesuaikan path config firebase kamu
const { Timestamp } = require("firebase-admin/firestore");

/**
 * Mencatat Aktivitas Company
 * @param {string} idCompany - ID Company tempat kejadian
 * @param {object} logData - Data detail log
 * @param {string} logData.actorEmail - Email pelaku (Admin)
 * @param {string} logData.actorName - Nama pelaku
 * @param {string} logData.target - Target aksi (misal: email pegawai yg di-acc)
 * @param {string} logData.action - Jenis aksi (misal: "APPROVE_EMPLOYEE", "REJECT_EMPLOYEE")
 * @param {string} logData.description - Deskripsi human-readable untuk UI
 */
const logCompanyActivity = async (idCompany, logData) => {
  try {
    if (!idCompany) return;

    // Kita simpan di sub-collection: companies/{idCompany}/logs
    // Supaya terisolasi per perusahaan
    await db
      .collection("companies")
      .doc(idCompany)
      .collection("logs")
      .add({
        actorEmail: logData.actorEmail,
        actorName: logData.actorName,
        target: logData.target || "-",
        action: logData.action,
        description: logData.description,
        createdAt: Timestamp.now(),
      });

    // console.log(`[LOG] Activity recorded for company ${idCompany}: ${logData.action}`);
  } catch (error) {
    // Log error jangan sampai bikin crash fitur utama, cukup di console server aja
    console.error("[LOG ERROR] Gagal mencatat aktivitas:", error);
  }
};

module.exports = { logCompanyActivity };
