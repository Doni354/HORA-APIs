---
id: login
sidebar_position: 6
title: Login & Auth
---

# Route — `login.js`

## Tujuan

Menangani seluruh alur autentikasi Vorce. Mendukung dua metode login: **OTP via Email** dan **Google Sign-In** (Firebase Auth). JWT di-generate setelah verifikasi berhasil, berlaku 30 hari.

---

## Endpoints

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| `PUT` | `/login/sendlink` | ❌ | Request OTP ke email |
| `GET` | `/login/verifyOTP` | ❌ | Verifikasi OTP → return JWT |
| `POST` | `/login/login-google` | ❌ | Login via Google (Firebase ID Token) |
| `POST` | `/login/register` | ❌ | Registrasi akun baru (role: candidate) |
| `POST` | `/login/register-company` | ❌ | Registrasi + buat company sekaligus |

---

## Alur Login OTP

```mermaid
sequenceDiagram
    participant F as Flutter
    participant BE as Route /login
    participant DB as Firestore
    participant M as Email (SMTP)

    F->>BE: PUT /sendlink?email=user@example.com
    BE->>DB: Cek users/{email} — sudah ada?
    alt User tidak ditemukan
        BE-->>F: 404 Akun tidak ditemukan
    end
    BE->>BE: generateOTP() — 6 digit random
    BE->>DB: Update users/{email}.otp + otpExpires (now + 5 menit)
    BE->>M: Send email template "otp" { code: otp }
    BE-->>F: 200 Kode OTP telah dikirim

    F->>BE: GET /verifyOTP?email=...&otp=123456
    BE->>DB: Cek users/{email}.otp && otpExpires > now
    alt OTP salah / expired
        BE-->>F: 401 OTP tidak valid
    end
    BE->>BE: jwt.sign({ id:email, role, idCompany, status }, JWT_SECRET, 30d)
    BE-->>F: 200 { token, user: { email, role, idCompany, nama } }
```

---

## Alur Login Google

```mermaid
sequenceDiagram
    participant F as Flutter
    participant BE as Route /login
    participant FA as Firebase Auth
    participant DB as Firestore

    F->>BE: POST /login-google { idToken, deviceId, FcmToken }
    BE->>FA: admin.auth().verifyIdToken(idToken)
    FA-->>BE: decodedToken { email, uid, firebase.sign_in_provider }

    BE->>DB: Lookup users/{email}
    alt User tidak ada
        BE-->>F: 404 Akun tidak ditemukan, silakan register
    end

    BE->>BE: checkUserStatus(data)
    alt Status inactive/fired/rejected
        BE-->>F: 403 Akun tidak aktif
    end

    BE->>BE: checkDeviceSecurity(companyData, email, deviceId)
    alt Device berbeda + device lock aktif
        BE-->>F: 401 { forceLogout: true, message: "Sesi kadaluarsa" }
    end

    BE->>BE: handleEmailVerification(...)
    BE->>DB: Update fcmTokens, lastLoginAt, deviceInfo
    BE->>BE: jwt.sign({ id, role, idCompany, deviceId }, JWT_SECRET, 30d)
    BE-->>F: 200 { token, user }
```

---

## Device Security (Anti-Cheat)

Jika company mengaktifkan `deviceLockEnabled = true`:

```
users/{email} login dari device A
  → deviceBindings[safeEmail] = deviceA_id disimpan di companies/{id}

Jika users/{email} login dari device B (berbeda):
  → checkDeviceSecurity() detect mismatch
  → Return: { forceLogout: true }
  → Flutter menghapus token lokal dan redirect ke login
```

`safeEmail` = email dengan `.` diganti `_` (Firestore tidak boleh ada `.` di field key).

---

## JWT Payload

```json
{
  "id": "user@example.com",
  "role": "admin",
  "idCompany": "company-id",
  "status": "active",
  "deviceId": "device-uuid",
  "iat": 1700000000,
  "exp": 1702592000
}
```

**Expiry:** 30 hari. Tidak ada refresh token — user re-login jika expired.

---

## OTP Config

| Config | Default | Env Variable |
|---|---|---|
| Durasi OTP | 5 menit | `OTP_EXPIRE_SECONDS` |
| Format | 6 digit angka | - |

---

## Decision Making

**Kenapa OTP via email, bukan SMS?**
Lebih murah (tidak ada provider SMS berbayar) dan lebih aman dari SIM-swap attack.

**Kenapa JWT berlaku 30 hari tanpa refresh?**
Tradeoff antara UX (tidak sering login ulang) dan keamanan. Jika device hilang, admin bisa reset device binding untuk invalidate sesi.
