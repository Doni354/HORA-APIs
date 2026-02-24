/* eslint-disable */
const { db } = require("../config/firebase");

/**
 * EMAIL TEMPLATES ENGINE (MODULAR)
 * Digunakan untuk membungkus konten email ke dalam layout Master Vorce.
 */
class EmailTemplates {
  static getHeader() {
    // Gunakan URL absolut untuk gambar agar muncul di email client
    const logoUrl = "https://cdn.vorce.id/Assets/Vorce_LogoWithName.png";
    return `
            <div style="background-color: #f3f4f6; padding: 20px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
                <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                    <div style="background-color: #4f46e5; padding: 20px; text-align: center; padding-left: 70px;">
                        <img src="${logoUrl}" alt="Vorce Logo" style="height: 40px; width: auto; display: block; margin: 0 auto;" />
                    </div>
                    <div style="padding: 30px; color: #374151; line-height: 1.6;">
        `;
  }

  static getFooter() {
    return `
                    </div>
                    <div style="background-color: #f9fafb; padding: 20px; text-align: center; color: #6b7280; font-size: 12px; border-top: 1px solid #e5e7eb;">
                        <p style="margin: 0 0 5px 0;">&copy; ${new Date().getFullYear()} Vorce. All rights reserved.</p>
                        <p style="margin: 0;">Ini adalah email otomatis, mohon tidak membalas email ini.</p>
                    </div>
                </div>
            </div>
        `;
  }

  static generate(type, data) {
    let content = "";
    let defaultSubject = "Informasi dari Vorce";
    const { username, companyName, message, code, link, reason, deviceInfo } =
      data;

    switch (type) {
      case "otp":
        defaultSubject = "Kode Verifikasi Login - Vorce";
        content = `
                    <h2 style="color: #111827; margin-top: 0;">Halo,</h2>
                    <p>Gunakan kode OTP di bawah ini untuk melanjutkan proses login Anda. Kode ini bersifat rahasia.</p>
                    <div style="background: #f3f4f6; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0;">
                        <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #4f46e5;">${code}</span>
                    </div>
                    <p style="font-size: 14px; color: #6b7280;">Kode ini hanya berlaku selama 5 menit.</p>
                `;
        break;

      case "verification":
        defaultSubject = "Verifikasi Akun Anda - Vorce";
        content = `
                    <h2 style="color: #111827; margin-top: 0;">Selamat Datang, ${username}!</h2>
                    <p>Akun Anda telah disetujui. Silakan klik tombol di bawah ini untuk memverifikasi email Anda dan mengaktifkan akun sepenuhnya:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${link}" style="background-color: #4f46e5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Verifikasi Sekarang</a>
                    </div>
                    <p style="font-size: 13px; color: #9ca3af;">Link ini akan kadaluarsa dalam 1 jam.</p>
                `;
        break;

      case "reset_device":
        defaultSubject = data.isAdmin
          ? `Persetujuan Reset Perangkat: ${username}`
          : "Konfirmasi Reset Perangkat";
        content = `
                    <h2 style="color: #dc2626; margin-top: 0;">Permohonan Reset Perangkat</h2>
                    <p>Ada permintaan untuk mereset perangkat lama agar bisa login di perangkat baru.</p>
                    <div style="background: #fff5f5; border-left: 4px solid #dc2626; padding: 15px; margin: 20px 0;">
                        <p style="margin: 0;"><strong>User:</strong> ${username}</p>
                        <p style="margin: 5px 0;"><strong>Alasan:</strong> ${
                          reason || "-"
                        }</p>
                        <p style="margin: 5px 0;"><strong>Device:</strong> ${
                          deviceInfo || "Unknown"
                        }</p>
                    </div>
                    <p>Jika Anda menyetujui tindakan ini, klik tombol di bawah:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${link}" style="background-color: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Setujui & Reset Sekarang</a>
                    </div>
                `;
        break;

      case "billing":
        defaultSubject = `Tagihan Layanan Vorce - ${companyName}`;
        content = `
                    <h2 style="color: #4f46e5;">Halo Admin ${companyName},</h2>
                    <p>Berikut adalah informasi tagihan layanan Anda untuk bulan ini.</p>
                    <div style="background: #eff6ff; border-left: 4px solid #4f46e5; padding: 15px; margin: 20px 0;">
                        <p style="margin: 0; font-weight: bold; font-size: 18px;">${
                          message || "Rp 0"
                        }</p>
                    </div>
                    <p>Mohon segera melakukan pembayaran sebelum masa aktif habis.</p>
                `;
        break;

      default:
        content = `<h2>Halo ${username || "User"},</h2><p>${message}</p>`;
    }

    return {
      subject: defaultSubject,
      html: this.getHeader() + content + this.getFooter(),
    };
  }

  /**
   * Fungsi Helper untuk langsung kirim ke koleksi 'mail' di Firestore
   */
  static async send(to, type, data) {
    const emailData = this.generate(type, data);
    return await db.collection("mail").add({
      to: to,
      message: {
        subject: emailData.subject,
        html: emailData.html,
      },
    });
  }
}

module.exports = EmailTemplates;
