# PANDUAN MENULIS DOKUMENTASI (DOCUSAURUS V3)
Gunakan panduan ini HANYA jika masuk ke Fase 4 (Fitur Baru) atau mendapatkan jawaban "Ya" setelah Fixing Bug.

### 1. Struktur Halaman Standar
Semua file MD/MDX dokumentasi harus mencakup:
- **Tujuan Module**: Apa yang di-handle oleh route/helper ini.
- **Tabel Endpoint**: Method, Path, Auth (Yes/No), Role.
- **Penjelasan Firestore**: Struktur JSON/Diagram struktur path di database.
- **Decision Making (Opsional)**: Catatan alasan logic tersebut dipilih.

### 2. Aturan Mutlak MermaidJS
- Semua diagram (sequence/flowchart) menggunakan sintaks ````mermaid`.
- **ANTI-ERROR**: Jika diagram memuat label dengan karakter khusus seperti `{ }`, `[ ]`, atau tanda kutip internal, **WAJIB dibungkus tanda kutip ganda**, contoh: `A["Menerima { data }"]`. Jangan gunakan HTML tags di dalam label.

### 3. Build Preview
- Setelah menulis, boleh jalankan `npm run docs:build` dalam folder `docs-site` HANYA untuk memastikan render Mermaid tidak error.
- Ingat, jangan Firebase Deploy sebelum diminta user.
