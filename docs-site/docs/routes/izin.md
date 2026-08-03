---
id: izin
sidebar_position: 2
title: Izin (Permit)
---

# Route — `izin.js`

## Tujuan

Mengelola pengajuan izin/sakit karyawan. Karyawan mengajukan izin dengan lampiran berkas; admin bisa mengubah status (approve/reject). Mendukung kuota izin per bulan per-company.

---

## Endpoints

| Method | Path | Auth | Role |
|---|---|---|---|
| `POST` | `/izin/` | ✅ | Karyawan |
| `GET` | `/izin/list` | ✅ | Admin (semua) / Karyawan (milik sendiri) |
| `PUT` | `/izin/:leaveId` | ✅ | Admin (ubah status) / Owner (edit data) |
| `DELETE` | `/izin/:leaveId` | ✅ | Admin / Owner |

---

## POST `/` — Ajukan Izin

Karyawan mengajukan izin. File lampiran (surat dokter dll) **harus sudah diupload** ke berkas collection terlebih dahulu, lalu kirim `fileId`-nya.

### Request Body

```json
{
  "tipeIzin": "sakit",
  "startDate": "2026-08-05",
  "endDate": "2026-08-06",
  "keterangan": "Demam tinggi",
  "fileId": "berkas-doc-id"
}
```

| tipeIzin | Keterangan |
|---|---|
| `sakit` | Izin sakit |
| `izin` | Izin keperluan pribadi |
| `cuti` | Cuti tahunan |

### Alur Pengajuan

```mermaid
sequenceDiagram
    participant F as Flutter Karyawan
    participant BE as Route /izin
    participant DB as Firestore

    F->>BE: POST / { tipeIzin, startDate, endDate, fileId }
    BE->>DB: Cek company.leaveQuota (jika ada)

    alt Kuota bulan ini sudah habis
        BE-->>F: 403 Batas kuota izin tercapai
    end

    BE->>DB: Lookup files/{fileId}
    alt File tidak ditemukan
        BE-->>F: 404 File tidak ditemukan
    end

    BE->>DB: Simpan companies/{id}/leaves/{autoId}
    note over BE,DB: status: "pending"
    BE->>DB: logCompanyActivity(REQUEST_LEAVE)
    BE-->>F: 201 Berhasil mengajukan izin
```

---

## PUT `/:leaveId` — Update Status atau Edit Data

Satu endpoint menangani **2 skenario berbeda** berdasarkan role:

```mermaid
flowchart TD
    A["PUT /:leaveId"] --> B{Ada field\n'status' di body?}
    B -->|Ya| C{Role = admin?}
    C -->|Tidak| D[403 Forbidden]
    C -->|Ya| E["Skenario A: Admin ubah status\nAPPROVED / REJECTED / PENDING"]
    B -->|Tidak| F{Adalah owner?}
    F -->|Tidak| G[403 Forbidden]
    F -->|Ya| H["Skenario B: Owner edit data\nReset status ke PENDING"]
    E & H --> I[Update Firestore + Log]
```

### Status Flow

```
pending → approved   (Admin setujui)
pending → rejected   (Admin tolak)
approved/rejected → pending  (Owner edit → otomatis reset)
```

---

## Firestore — Leave Document

```
companies/{companyId}/leaves/{leaveId}
  ├── idKaryawan, namaKaryawan
  ├── tipeIzin ("sakit" | "izin" | "cuti")
  ├── startDate, endDate (string YYYY-MM-DD)
  ├── keterangan
  ├── attachmentFileId, attachmentPath, attachmentName
  ├── status ("pending" | "approved" | "rejected")
  ├── history [ { status, by, at } ]   ← audit trail
  ├── createdAt (Timestamp)
  └── updatedAt (Timestamp)
```

---

## Decision Making

**Kenapa file harus diupload dulu, bukan bersamaan dengan form?**
Memisahkan concern upload file (async, bisa gagal) dari pembuatan record izin. Jika upload gagal, data izin tidak tersimpan setengah jadi.

**Kenapa ada `leaveQuota` per company?**
Beberapa perusahaan ingin membatasi izin karyawan per bulan (misal max 2x). Jika `leaveQuota` tidak diset di Firestore, pengecekan di-skip dan kuota tidak terbatas.

**Kenapa `history` array, bukan subcollection?**
Jumlah status change per leave document sangat sedikit (maks 3-5 kali). Array lebih efisien dari subcollection untuk kasus ini.
