---
id: attendance
sidebar_position: 3
title: Absensi & Shift Schedule
---

# Absensi & Shift Schedule

## Tujuan

Sistem absensi Vorce memungkinkan karyawan check-in/check-out berdasarkan **shift schedule yang ditentukan admin**. Absensi divalidasi terhadap jadwal shift (bukan server time statis), sehingga fleksibel untuk berbagai pola kerja.

---

## Konsep Utama

```mermaid
graph LR
    A[Admin buat\nShift Schedule] --> B[(Firestore\nshiftSchedules)]
    C[Karyawan absen] --> D[Backend cari\nshift aktif]
    B --> D
    D --> E{Shift ditemukan?}
    E -->|Ya| F[Validasi waktu check-in]
    E -->|Tidak| G[❌ Tidak ada shift aktif]
    F --> H[Catat absensi]
```

---

## Data Model Shift Schedule

```
companies/{companyId}/shiftSchedules/{shiftId}
  ├── name          — "Shift Pagi"
  ├── startTime     — "08:00"
  ├── endTime       — "17:00"
  ├── days          — ["monday", "tuesday", "wednesday", "thursday", "friday"]
  ├── isActive      — true
  └── createdAt     — Timestamp
```

---

## Flow Absensi

```mermaid
sequenceDiagram
    participant F as Flutter Karyawan
    participant BE as Backend /absensi
    participant SH as shiftScheduleService
    participant DB as Firestore

    F->>BE: POST /absensi/check-in { lat, lng, foto? }
    BE->>SH: getActiveShift(companyId, currentTime)
    SH->>DB: Query shiftSchedules where isActive=true
    SH->>SH: Filter shift yang cocok dengan\nhari & jam sekarang

    alt Tidak ada shift aktif
        SH-->>BE: null
        BE-->>F: 400 Tidak ada shift aktif saat ini
    end

    BE->>DB: Cek apakah sudah absen hari ini
    alt Sudah absen
        BE-->>F: 409 Sudah melakukan check-in
    end

    BE->>DB: Simpan absensi
    note over BE,DB: attendance/{date}/records/{userId}
    note over BE,DB: status: "hadir" / "terlambat"
    note over BE,DB: checkInTime, shiftId, lat, lng

    BE-->>F: 200 Check-in berhasil
```

---

## Status Absensi

| Status | Kondisi |
|---|---|
| `hadir` | Check-in dalam toleransi waktu shift |
| `terlambat` | Check-in melewati waktu toleransi |
| `izin` | Ada pengajuan izin yang disetujui |
| `sakit` | Ada pengajuan sakit yang disetujui |
| `alpha` | Tidak ada absensi hingga akhir shift |

---

## Manual Override

Admin dapat menginput shift secara manual per-absensi (tidak terikat shift schedule). Ini berguna untuk karyawan dengan jadwal tidak reguler atau event khusus. Field `isManualShift: true` pada record absensi menandakan ini.

---

## shiftScheduleService

Logic untuk mencari shift aktif diextract ke `helper/shiftScheduleService.js`:

```js
// Contoh penggunaan
const shift = await getActiveShift(companyId, new Date());
if (!shift) return res.status(400).json({ message: "Tidak ada shift aktif" });
```

Service ini mengembalikan shift yang:
1. `isActive: true`
2. Hari ini termasuk dalam `shift.days`
3. Jam sekarang berada dalam window `startTime` – `endTime`
