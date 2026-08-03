---
id: emailHelper
sidebar_position: 4
title: Email Helper (SMTP)
---

# Helper — `emailHelper.js`

## Tujuan

Wrapper untuk pengiriman email transaksional via **Nodemailer + Hostinger SMTP**. Menggantikan Firebase "Trigger Email" extension yang sudah deprecated.

## Exports

| Export | Signature | Keterangan |
|---|---|---|
| `sendEmail(options)` | async → void | Kirim email via SMTP |
| `sendWelcomeEmail(email, name)` | async → void | Email sambutan saat registrasi |
| `sendPasswordResetEmail(email, resetLink)` | async → void | Email reset password |
| `sendInvitationEmail(email, companyName, inviteLink)` | async → void | Email undangan karyawan |

## Konfigurasi SMTP

```
Host:    smtp.hostinger.com
Port:    465 (SSL)
From:    cs@vorce.id
Sender:  "Vorce Customer Service"
```

Semua kredensial dari environment variables: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`.

## Digunakan Oleh

- `routes/login.js` — welcome email saat register, reset password
- `routes/karyawan.js` / `routes/profile.js` — undangan karyawan

## Perbedaan dari Sistem Lama

| Aspek | Lama (Firebase Extension) | Sekarang (Nodemailer) |
|---|---|---|
| Cara kirim | Tulis doc ke koleksi `mail` | Panggil function langsung |
| Latensi | Async (extension polling) | Langsung (sync SMTP) |
| Kustomisasi | Terbatas | Penuh (HTML template, CC, BCC) |
| Biaya | Gratis (tapi deprecated) | SMTP Hostinger plan |

## Decision Making

**Kenapa tidak pakai Firebase Email Extension?**  
Extension sudah deprecated dan akan dihapus. Nodemailer lebih fleksibel, bisa customize template HTML, set Reply-To, dan tidak bergantung pada extension pihak ketiga.
