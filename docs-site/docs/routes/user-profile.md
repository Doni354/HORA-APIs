---
id: user-profile-storage
title: User Profile & Storage
sidebar_label: User Storage (R2)
---

# User Profile & Storage API

## Tujuan Module

Module ini bertugas untuk memberikan *personal storage* bagi user layaknya *company storage*. Berkas pribadi user (yang di-*upload* oleh user untuk tujuan pribadi atau aplikasi) disimpan secara *default* dengan kapasitas hingga 100MB, yang kemudian kapasitas tersebut dapat diperbesar melalui sistem IAP (layaknya mekanisme Company). Akses *upload* dilakukan melalui skema R2 *Valet Key* (Presigned URL) untuk efisiensi transfer data.

## Tabel Endpoint

| Method | Path | Auth | Role Required | Deskripsi |
| --- | --- | --- | --- | --- |
| `GET` | `/api/user-storage` | Yes | Any | Mendapatkan daftar seluruh file (metadata) milik user terkait |
| `POST` | `/api/user-storage/valet-key` | Yes | Any | Membuat R2 pre-signed url untuk upload (berlaku 5 menit). Terdapat pengecekan sisa kuota user |
| `POST` | `/api/user-storage` | Yes | Any | Mengkonfirmasi upload selesai. Melakukan validasi eksistensi di R2 dan record transaksi kenaikan quota ke Firebase |
| `DELETE` | `/api/user-storage/:fileId` | Yes | Any | Mendelete file dari backend (Firestore) dan object storage (R2). Serta mengembalikan quota |

## Penjelasan Firestore

Module ini berinteraksi langsung dengan collection utama `users`.

1. Menyimpan metadata file upload di sub-koleksi: `users/{email}/storage/`.
2. Menyimpan ukuran pemakaian quota di field `usedStorage` pada dokumen induk: `users/{email}`.
3. Membaca ukuran batas default storage dari field `max_storage` (fallback pada runtime Node.js ke format 100MB jika undefined).

Bentuk penyimpanan dokumen:

```json
// Path: users/john.doe@gmail.com
{
  "email": "john.doe@gmail.com",
  "usedStorage": 1500000, 
  "max_storage": 104857600
}

// Path: users/john.doe@gmail.com/storage/{fileId}
{
  "id": "abc123xyz",
  "fileName": "document.pdf",
  "storagePath": "user_storage/johndoe/162817281_123.pdf",
  "downloadUrl": "https://cdn.vorce.id/user_storage/johndoe/162817281_123.pdf",
  "mimeType": "application/pdf",
  "size": "1.43 MB",
  "sizeBytes": 1500000,
  "createdAt": "2026-09-04T12:00:00Z"
}
```

## Flowchart dan Sequence Logic Upload

Berikut merupakan Sequence logic dengan skema Pre-Signed URL. Terdapat double-validation kuota (*pre-upload* dan *post-request*).

````mermaid
sequenceDiagram
    participant FE as Frontend Client
    participant H as HORA API (User Storage)
    participant FS as Firestore
    participant R2 as Cloudflare R2

    FE->>H: POST /user-storage/valet-key (fileName, size)
    H->>FS: GET users/{email}
    FS-->>H: Return { usedStorage, max_storage }
    Note right of H: Validasi: (usedStorage + size) > max_storage ?
    H->>R2: Generate Signed URL
    R2-->>H: URL String
    H-->>FE: Return Pre-Signed URL (expires 300s)

    FE->>R2: PUT File ke URL R2
    R2-->>FE: 200 OK (Upload Selesai)

    FE->>H: POST /user-storage (Confirm ObjectKey)
    H->>R2: HeadObjectCommand (Validasi file terkirim)
    R2-->>H: Metadata nyata ukuran \u0026 tipe (Source of Truth)
    
    H->>FS: Run Transaction (Firestore)
    FS-->>H: Lock users/{email}
    Note right of H: Re-validasi size dari R2 terhadap sisa kuota
    H->>FS: INSERT doc ke users/{email}/storage
    H->>FS: UPDATE usedStorage = usedStorage + sizeBytes
    FS-->>H: Transaction COMMIT
    H-->>FE: 201 Created (Upload Terkonfirmasi)
````

## Decision Making

- **R2 Valet Key (Presign) vs FormData Backend Storage**: Valet key memungkinkan *offloading* transmisi data agar tidak membebani memory *Cloud Run Node.js*. 
- **Firestore Transaction untuk `usedStorage`**: Karena user bisa saja melakukan upload dua file skala raksasa dalam mili-detik bersamaan, update quota harus di-*lock* dan aman dari potensi *race condition*. Transaction secara drastis menurunkan potensi *bypass* kuota.
- **`max_storage` Inject Runtime**: Dibanding melakukan batch export pada seluruh puluhan ribu database yang mahal operasionalnya, fallback string value Node.js diset ke otomatis 100MB jika value dokument tidak mendeteksi key ini. Jika user berlangganan/IAP, top up akan menghasilkan value baru yang akan meng-*override* fallback ini.
