---
id: scheduler
sidebar_position: 2
title: Scheduled Jobs
---

# Scheduled Jobs

File `scheduler/scheduler.js` berisi dua job otomatis yang berjalan tanpa interaksi user.

---

## 1. Account Cleanup (`scheduledAccountCleanup`)

**Schedule:** `0 19 * * *` (UTC) = setiap hari **jam 02:00 WIB**

### Tujuan
Menghapus permanen akun user yang sudah melewati **90 hari** sejak request deletion. User yang meminta delete akunnya diberi status `pending_deletion` dengan `deletionScheduledAt` = 90 hari dari sekarang.

### Alur

```mermaid
flowchart TD
    A["Trigger: 02:00 WIB setiap hari"] --> B["Query users\nstatus=pending_deletion\ndeletionScheduledAt <= now"]
    B --> C{Ada akun\nyang harus dihapus?}
    C -->|Tidak| D[Log: no action, selesai]
    C -->|Ya| E["Loop tiap akun"]
    E --> F["Log ke companies/{id}/logs"]
    F --> G["Hapus dari Firebase Auth\nadmin.auth().deleteUser(uid)"]
    G --> H["Hapus Firestore doc\nusers/{email}"]
    H --> I{Masih ada\nakun lain?}
    I -->|Ya| E
    I -->|Tidak| J["Log: success/fail count"]
```

### Error Handling
- Jika user tidak ditemukan di Firebase Auth (`auth/user-not-found`) → **skip**, lanjut hapus Firestore (mungkin sudah dihapus manual)
- Error lain per-user → log error, lanjut ke user berikutnya (tidak stop seluruh job)

---

## 2. Orphan Upload Cleanup (`cleanupOrphanUploads`)

**Schedule:** `0 * * * *` = **setiap jam**

### Tujuan
Menghapus file R2 yang "orphaned" — file yang sudah ter-upload ke R2 tapi tidak pernah dikonfirmasi ke backend (user crash/network error antara upload ke R2 dan panggilan `/confirm-upload`).

### Mekanisme Upload Registry

```mermaid
sequenceDiagram
    participant F as Flutter
    participant BE as Backend
    participant R2 as Cloudflare R2
    participant DB as Firestore

    F->>BE: POST /berkas/presign
    BE->>DB: Tulis _upload_pending/{uuid}\nexpiresAt = now + 15 menit
    BE-->>F: presigned URL

    F->>R2: Upload file langsung
    F->>BE: POST /berkas/confirm-upload
    BE->>DB: Hapus _upload_pending/{uuid}
    BE->>DB: Simpan metadata berkas

    Note over F,DB: Jika crash setelah upload R2\ntapi sebelum confirm-upload...

    DB-->>BE: _upload_pending masih ada, expired
    BE->>R2: DeleteObjectCommand (cleanup)
    BE->>DB: Hapus _upload_pending doc
```

### Alur Job

```mermaid
flowchart LR
    A[Trigger tiap jam] --> B["Query _upload_pending\nexpiresAt <= now\nlimit 100"]
    B --> C{Ditemukan?}
    C -->|Tidak| D[Selesai]
    C -->|Ya| E["Delete dari R2\nbest-effort"]
    E --> F{R2 error?}
    F -->|NoSuchKey| G["Log: already gone\nlanjut"]
    F -->|Error lain| H["Log error\nlanjut"]
    G --> I["Delete _upload_pending doc"]
    H --> I
    I --> J{Masih ada\ndoc lain?}
    J -->|Ya| E
    J -->|Tidak| K["Log: summary count"]
```

### Design Decisions

**Kenapa limit 100 per-run?**  
Mencegah timeout (max 120s). Sisa doc di-cleanup di run berikutnya.

**Kenapa R2 delete best-effort (tidak throw error)?**  
Jika file tidak ada di R2 (upload benar-benar gagal sebelum sampai ke R2), registry tetap harus dihapus. `NoSuchKey` = normal, bukan error.

**Kenapa polling (cron), bukan event trigger dari R2?**  
R2 Event Notification butuh Cloudflare Worker/Queue — lebih kompleks. Polling per jam acceptable karena lifecycle orphan file tidak urgent.
