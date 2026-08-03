---
id: absensi
sidebar_position: 1
title: Absensi (Check-in/out)
---

# Route — `absensi.js`

## Tujuan

Mengelola data absensi karyawan per perusahaan. Check-in otomatis mendeteksi shift aktif via `shiftScheduleService`, menghitung keterlambatan, dan menyimpan lokasi GPS karyawan.

---

## Endpoints

| Method | Path | Auth | Role |
|---|---|---|---|
| `GET` | `/absensi/HomeA` | ✅ | Admin |
| `GET` | `/absensi/indie` | ✅ | Semua |
| `POST` | `/absensi/` | ❌ (legacy) | Karyawan |
| `POST` | `/absensi/checkout` | ✅ | Karyawan |

---

## POST `/` — Check-In

### Request Body

```json
{
  "IDKaryawan": "user@example.com",
  "NamaKaryawan": "Budi Santoso",
  "AlamatLatitude": -6.2088,
  "AlamatLongtitude": 106.8456,
  "AlamatLoc": "Jl. Sudirman No.1",
  "IDPerusahaan": "company-id",
  "NamaPerusahaan": "PT Vorce",
  "zone": "Asia/Jakarta",
  "idBerkasFoto": "foto-doc-id"
}
```

### Alur Check-In

```mermaid
sequenceDiagram
    participant F as Flutter
    participant BE as Route /absensi
    participant SH as shiftScheduleService
    participant DB as Firestore

    F->>BE: POST / { IDKaryawan, lat, lng, ... }
    BE->>SH: resolveUserShift(IDPerusahaan, IDKaryawan, now, zone)
    SH-->>BE: shift object | ShiftScheduleError

    alt Tidak ada shift aktif
        BE-->>F: 400 Tidak ada shift aktif
    end

    BE->>DB: Cek double check-in hari ini
    alt Sudah check-in
        BE-->>F: 409 Sudah check-in hari ini
    end

    BE->>BE: calculateLateness(shift, now, zone)
    BE->>DB: Simpan companies/{id}/absensi/{docId}
    BE-->>F: 200 + { shift, isLate, lateMinutes, fotoURL }
```

### Firestore — Record Absensi

```
companies/{companyId}/absensi/{autoId}
  ├── idKaryawan, namaKaryawan
  ├── alamatLatitude, alamatLongtitude, alamatLoc
  ├── idPerusahaan, namaPerusahaan
  ├── tanggal (Timestamp)
  ├── waktuCheckIn (string HH:mm)
  ├── shift (object: { id, name, startTime })
  ├── isLate (boolean)
  ├── lateMinutes (number)
  ├── status: "hadir" | "terlambat"
  ├── fotoURL (string, dari R2)
  └── createdAt (Timestamp)
```

---

## GET `/HomeA` — Absensi Per Perusahaan (Admin)

### Query Params
```
?IDPerusahaan=company-id&tglstart=2026-01-01&tglend=2026-01-31
```

Mengembalikan semua data absensi dalam rentang tanggal untuk seluruh karyawan. Admin menggunakan ini untuk rekap harian/bulanan.

---

## GET `/indie` — Absensi Individu

### Query Params
```
?idkaryawan=user@example.com&idPerusahaan=company-id&tglstart=2026-01-01
```

Riwayat absensi per karyawan. Bisa diakses oleh karyawan itu sendiri maupun admin.

---

## Decision Making

**Kenapa check-in tidak pakai `verifyToken`?**
Legacy endpoint — ada perangkat lama yang belum kirim Bearer token. Endpoint baru (`/checkout`) sudah wajib auth.

**Kenapa latitude/longitude disimpan, bukan divalidasi?**
Validasi lokasi (geofencing) dilakukan di sisi Flutter, bukan backend. Backend hanya menyimpan data — ini memungkinkan fleksibilitas konfigurasi radius per company di masa depan.
