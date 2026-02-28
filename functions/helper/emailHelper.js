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

      case "employee_approved":
        defaultSubject = `Selamat! Anda Diterima di ${companyName || "Perusahaan"}`;
        content = `
                    <h2 style="color: #059669; margin-top: 0;">Selamat Bergabung! 🎉</h2>
                    <p>Halo <b>${username}</b>,</p>
                    <p>Lamaran Anda untuk bergabung dengan <b>${companyName || "Perusahaan"}</b> telah <b style="color: #059669;">DISETUJUI</b>.</p>
                    <div style="background: #ecfdf5; border-left: 4px solid #059669; padding: 15px; margin: 20px 0; border-radius: 4px;">
                        <p style="margin: 0;">Status akun Anda sekarang: <b>Karyawan (Staff)</b></p>
                    </div>
                    <p>Silakan login kembali ke aplikasi untuk mulai bekerja.</p>
                `;
        break;

      case "employee_rejected":
        defaultSubject = "Update Status Lamaran";
        content = `
                    <h2 style="color: #111827; margin-top: 0;">Pemberitahuan Status Lamaran</h2>
                    <p>Halo <b>${username}</b>,</p>
                    <p>Mohon maaf, saat ini kami belum bisa menerima lamaran Anda.</p>
                    <div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 15px; margin: 20px 0; border-radius: 4px;">
                        <p style="margin: 0;">Status: <b style="color: #dc2626;">Ditolak</b></p>
                    </div>
                    <p>Tetap semangat dan jangan menyerah! 💪</p>
                `;
        break;

      case "employee_fired":
        defaultSubject = `Pemberitahuan Penghentian Kerja - ${companyName}`;
        content = `
                    <h2 style="color: #dc2626; margin-top: 0;">Pemberitahuan Penghentian Kerja</h2>
                    <p>Halo <b>${username}</b>,</p>
                    <p>Melalui email ini, kami menginformasikan bahwa akses kerja Anda di <b>${companyName}</b> telah <b style="color: #dc2626;">DICABUT</b>.</p>
                    <div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 15px; margin: 20px 0; border-radius: 4px;">
                        <p style="margin: 0 0 5px 0;"><strong>Alasan Pengeluaran:</strong></p>
                        <p style="margin: 0; font-style: italic;">"${reason || "Tidak ada alasan yang diberikan"}"</p>
                    </div>
                    <p>Jika Anda merasa ini adalah kesalahan, silakan hubungi manajemen perusahaan.</p>
                    <p>Terima kasih atas kontribusi Anda selama ini.</p>
                `;
        break;

      case "invite":
        defaultSubject = `Undangan Bergabung - ${companyName}`;
        content = `
                    <h2 style="color: #4f46e5; margin-top: 0;">Anda Diundang! ✉️</h2>
                    <p>Anda diundang oleh <b>${data.inviterName || "Admin"}</b> untuk bergabung ke <b>${companyName}</b>.</p>
                    <p>Untuk menerima undangan ini, silakan klik tombol di bawah, lalu:</p>
                    <ol style="line-height: 2;">
                        <li>Login menggunakan Akun Google (Email: ${data.targetEmail || "email Anda"})</li>
                        <li>Lengkapi data diri (No Telp & WA)</li>
                    </ol>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${link}" style="background-color: #4f46e5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Buka Undangan</a>
                    </div>
                    <p style="font-size: 13px; color: #9ca3af;">Link undangan berlaku selama 24 jam.</p>
                `;
        break;

      case "upgrade":
        defaultSubject = `Upgrade Paket Berhasil - ${companyName}`;
        content = `
                    <h2 style="color: #4f46e5; margin-top: 0;">Upgrade Berhasil! 🚀</h2>
                    <p>Halo Admin <b>${companyName}</b>,</p>
                    <p>Paket layanan Anda telah berhasil diperbarui oleh sistem kami.</p>
                    <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 25px 0;">
                        <ul style="margin: 0; padding-left: 20px; line-height: 2;">
                            <li><b>Max Storage:</b> ${data.maxStorageDisplay || "Tidak Berubah"}</li>
                            <li><b>Max Karyawan:</b> ${data.maxKaryawanDisplay || "Tidak Berubah"}</li>
                        </ul>
                    </div>
                    <p>Selamat menikmati layanan Vorce dengan kapasitas lebih besar.</p>
                `;
        break;

      case "report":
        defaultSubject = data.subject || `Laporan - ${companyName}`;
        content = `
                    <h2 style="color: #2c3e50; margin-top: 0;">📊 ${data.reportTitle || "Laporan"}</h2>
                    <p>Perusahaan: <strong>${companyName}</strong></p>
                    <p>Periode: <strong>${data.periode || "-"}</strong></p>
                    <p>Laporan Anda telah berhasil di-generate. Silakan klik tombol di bawah untuk mengunduh file Excel:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${link}" target="_blank" style="background-color: #059669; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">📥 Download Laporan Excel</a>
                    </div>
                    <p style="font-size: 13px; color: #9ca3af;">File akan diunduh dalam format .xlsx yang dapat dibuka dengan Microsoft Excel atau Google Sheets.</p>
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
