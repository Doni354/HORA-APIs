/* eslint-disable */
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");

// --- MOCKS ---
const mockVerifyIdToken = jest.fn();
const mockR2Send = jest.fn();
const mockGeneratePresignedPutUrl = jest.fn().mockResolvedValue("https://mock-r2-upload.com/user_storage/upload");

// In-memory Firestore store
const mockUsers = {};
const mockUserStorage = {}; // mockUserStorage[email] = [ { id, ...data } ]
const mockCompanies = {
  C_TEST_01: {
    namaPerusahaan: "PT Maju Mundur",
    createdBy: "owner@company.com",
    deviceLockEnabled: false,
    deviceBindings: {},
  },
};

jest.mock("firebase-admin", () => ({
  auth: () => ({
    verifyIdToken: mockVerifyIdToken,
  }),
  firestore: {
    Timestamp: {
      now: () => ({ toMillis: () => Date.now() }),
      fromMillis: (ms) => ({ toMillis: () => ms }),
    },
    FieldValue: {
      increment: (val) => ({ _increment: val }),
      arrayUnion: (val) => val,
      arrayRemove: (val) => val,
    },
  },
}));

jest.mock("../config/r2", () => ({
  r2: { send: mockR2Send },
}));

jest.mock("../helper/uploadFile", () => ({
  generatePresignedPutUrl: mockGeneratePresignedPutUrl,
  formatFileSize: jest.fn((bytes) => `${(bytes / (1024 * 1024)).toFixed(2)} MB`),
  deleteOldFileFromR2: jest.fn().mockResolvedValue(true),
}));

jest.mock("../helper/logCompanyActivity", () => ({
  logCompanyActivity: jest.fn().mockResolvedValue(true),
}));

jest.mock("../helper/emailHelper", () => ({
  send: jest.fn().mockResolvedValue(true),
}));

jest.mock("../helper/phoneValidator", () => ({
  checkPhoneUnique: jest.fn().mockResolvedValue({ isDuplicate: false }),
}));

const mockDb = {
  collection: jest.fn((colName) => {
    if (colName === "users") {
      return {
        doc: jest.fn((docId) => {
          return {
            id: docId,
            get: jest.fn(async () => {
              const data = mockUsers[docId];
              return {
                exists: !!data,
                data: () => data,
              };
            }),
            set: jest.fn(async (newData, options) => {
              if (options && options.merge) {
                mockUsers[docId] = { ...(mockUsers[docId] || {}), ...newData };
              } else {
                mockUsers[docId] = newData;
              }
              return true;
            }),
            update: jest.fn(async (updateData) => {
              mockUsers[docId] = { ...(mockUsers[docId] || {}), ...updateData };
              return true;
            }),
            collection: jest.fn((subCol) => {
              if (subCol === "storage") {
                return {
                  orderBy: jest.fn(() => ({
                    get: jest.fn(async () => {
                      const items = mockUserStorage[docId] || [];
                      return {
                        empty: items.length === 0,
                        forEach: (cb) => items.forEach((item) => cb({ id: item.id, data: () => item })),
                      };
                    }),
                  })),
                  doc: jest.fn((fileId) => {
                    const finalFileId = fileId || `file_${Date.now()}`;
                    return {
                      id: finalFileId,
                      set: jest.fn(async (fileData) => {
                        if (!mockUserStorage[docId]) mockUserStorage[docId] = [];
                        mockUserStorage[docId].push(fileData);
                        return true;
                      }),
                      get: jest.fn(async () => {
                        const items = mockUserStorage[docId] || [];
                        const found = items.find((f) => f.id === finalFileId);
                        return {
                          exists: !!found,
                          data: () => found,
                        };
                      }),
                    };
                  }),
                };
              }
            }),
          };
        }),
      };
    }
    if (colName === "companies") {
      return {
        doc: jest.fn((compCode) => ({
          id: compCode,
          get: jest.fn(async () => {
            const comp = mockCompanies[compCode];
            return {
              exists: !!comp,
              data: () => comp,
            };
          }),
          collection: jest.fn((subCol) => ({
            doc: jest.fn((docId) => ({
              set: jest.fn().mockResolvedValue(true),
            })),
            add: jest.fn().mockResolvedValue({ id: "log_123" }),
          })),
        })),
      };
    }
  }),
  runTransaction: jest.fn(async (callback) => {
    const transaction = {
      get: jest.fn(async (ref) => ref.get()),
      set: jest.fn(async (ref, data, opts) => ref.set(data, opts)),
      update: jest.fn(async (ref, data) => {
        // Handle FieldValue.increment
        for (const key of Object.keys(data)) {
          if (data[key] && data[key]._increment !== undefined) {
            const email = ref.id;
            if (mockUsers[email]) {
              mockUsers[email][key] = (mockUsers[email][key] || 0) + data[key]._increment;
            }
          }
        }
      }),
      delete: jest.fn(async (ref) => {}),
    };
    return callback(transaction);
  }),
};

jest.mock("../config/firebase", () => ({
  admin: {
    auth: () => ({
      verifyIdToken: mockVerifyIdToken,
    }),
    firestore: {
      Timestamp: {
        now: () => ({ toMillis: () => Date.now() }),
        fromMillis: (ms) => ({ toMillis: () => ms }),
      },
      FieldValue: {
        increment: (val) => ({ _increment: val }),
        arrayUnion: (val) => val,
        arrayRemove: (val) => val,
      },
    },
  },
  db: mockDb,
}));

jest.mock("firebase-admin/firestore", () => ({
  Timestamp: {
    now: () => ({ toMillis: () => Date.now() }),
    fromMillis: (ms) => ({ toMillis: () => ms }),
  },
  FieldValue: {
    increment: (val) => ({ _increment: val }),
  },
}));

// Set test JWT secret
process.env.JWT_SECRET = "TEST_SECRET_KEY_FOR_JEST";

const profileRoutes = require("../routes/profile");
const loginRoutes = require("../routes/login");

const app = express();
app.use(express.json());
app.use("/api/profile", profileRoutes);
app.use("/api/user-storage", (req, res, next) => {
  req.url = "/user-storage" + (req.url === "/" ? "" : req.url);
  profileRoutes(req, res, next);
});
app.use("/api/login", loginRoutes);

describe("Personal Storage & Registration Decoupling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const k in mockUsers) delete mockUsers[k];
    for (const k in mockUserStorage) delete mockUserStorage[k];
  });

  test("1. verifyToken menerima Firebase ID Token dan meng-auto-provision user personal baru", async () => {
    const candidateEmail = "pelamar.baru@gmail.com";
    mockVerifyIdToken.mockResolvedValue({
      email: candidateEmail,
      uid: "FIREBASE_UID_12345",
      name: "Pelamar Baru",
      picture: "https://lh3.googleusercontent.com/photo.jpg",
      firebase: { sign_in_provider: "google.com" },
    });

    // Panggil GET /api/user-storage menggunakan Bearer <firebaseIdToken>
    const res = await request(app)
      .get("/api/user-storage")
      .set("Authorization", "Bearer valid_firebase_id_token");

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Success");
    expect(res.body.maxStorage).toBe(104857600); // 100MB
    expect(res.body.usedStorage).toBe(0);
    expect(res.body.data).toEqual([]);

    // Pastikan user doc ter-auto-provision di Firestore
    const userDoc = mockUsers[candidateEmail];
    expect(userDoc).toBeDefined();
    expect(userDoc.alamatEmail).toBe(candidateEmail);
    expect(userDoc.role).toBe("user");
    expect(userDoc.status).toBe("active");
    expect(userDoc.idCompany).toBeNull();
    expect(userDoc.uid).toBe("FIREBASE_UID_12345");
    expect(userDoc.max_storage).toBe(104857600);
  });

  test("2. Berhasil membuat valet-key untuk personal storage user yang belum terdaftar di perusahaan", async () => {
    const candidateEmail = "calon.karyawan@gmail.com";
    mockVerifyIdToken.mockResolvedValue({
      email: candidateEmail,
      uid: "UID_CALON_KARYAWAN",
      name: "Calon Karyawan",
    });

    const res = await request(app)
      .post("/api/user-storage/valet-key")
      .set("Authorization", "Bearer mock_firebase_token")
      .send({
        fileName: "cv_calon.pdf",
        mimeType: "application/pdf",
        fileSize: 2 * 1024 * 1024, // 2MB
      });

    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toBeDefined();
    expect(res.body.objectKey).toMatch(/^user_storage\/UIDCALONKARYAWAN\//);
    expect(res.body.publicUrl).toMatch(/^https:\/\/cdn\.vorce\.id\/user_storage\/UIDCALONKARYAWAN\//);
  });

  test("3. Menolak valet-key jika ukuran file melebihi sisa kuota personal (100MB)", async () => {
    const candidateEmail = "calon.karyawan@gmail.com";
    mockVerifyIdToken.mockResolvedValue({
      email: candidateEmail,
      uid: "UID_CALON_KARYAWAN",
      name: "Calon Karyawan",
    });

    // Buat user dengan usedStorage 99MB
    mockUsers[candidateEmail] = {
      alamatEmail: candidateEmail,
      role: "user",
      status: "active",
      idCompany: null,
      usedStorage: 99 * 1024 * 1024,
      max_storage: 100 * 1024 * 1024,
    };

    const res = await request(app)
      .post("/api/user-storage/valet-key")
      .set("Authorization", "Bearer mock_firebase_token")
      .send({
        fileName: "portofolio_besar.zip",
        mimeType: "application/zip",
        fileSize: 5 * 1024 * 1024, // 5MB > sisa 1MB
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("QUOTA_EXCEEDED");
  });

  test("4. Berhasil konfirmasi upload metadata (POST /api/user-storage) & simpan ke subkoleksi storage", async () => {
    const candidateEmail = "calon.karyawan@gmail.com";
    mockVerifyIdToken.mockResolvedValue({
      email: candidateEmail,
      uid: "UID_CALON_KARYAWAN",
      name: "Calon Karyawan",
    });

    // Inisialisasi user
    mockUsers[candidateEmail] = {
      alamatEmail: candidateEmail,
      role: "user",
      status: "active",
      idCompany: null,
      usedStorage: 0,
      max_storage: 100 * 1024 * 1024,
      uid: "UID_CALON_KARYAWAN",
    };

    // Mock R2 HeadObjectCommand returning 1.5MB
    mockR2Send.mockResolvedValue({
      ContentLength: 1500000,
      ContentType: "application/pdf",
    });

    const objectKey = "user_storage/UIDCALONKARYAWAN/1726740000_uuid.pdf";

    const res = await request(app)
      .post("/api/user-storage")
      .set("Authorization", "Bearer mock_firebase_token")
      .send({
        objectKey: objectKey,
        originalName: "Curriculum_Vitae.pdf",
        mimeType: "application/pdf",
      });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Data file berhasil ditambahkan");
    expect(res.body.data.storagePath).toBe(objectKey);
    expect(res.body.data.downloadUrl).toBe(`https://cdn.vorce.id/${objectKey}`);
    expect(mockUsers[candidateEmail].usedStorage).toBe(1500000);
  });

  test("5. Tetap mendukung custom Vorce backend JWT untuk karyawan/admin aktif", async () => {
    const employeeEmail = "staff@company.com";
    mockUsers[employeeEmail] = {
      alamatEmail: employeeEmail,
      username: "Staff Active",
      role: "staff",
      status: "active",
      idCompany: "C_TEST_01",
      usedStorage: 500000,
      max_storage: 104857600,
    };

    const backendJwt = jwt.sign(
      {
        id: employeeEmail,
        role: "staff",
        idCompany: "C_TEST_01",
        status: "active",
      },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    const res = await request(app)
      .get("/api/profile/user-storage")
      .set("Authorization", `Bearer ${backendJwt}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Success");
    expect(res.body.usedStorage).toBe(500000);
  });

  test("6. Candidate dapat mendaftar perusahaan (POST /register-employee) setelah upload CV tanpa merusak personal storage", async () => {
    const candidateEmail = "budi.pelamar@gmail.com";
    mockVerifyIdToken.mockResolvedValue({
      email: candidateEmail,
      uid: "UID_BUDI_123",
      name: "Budi Santoso",
      picture: "https://lh3.google.com/budi.jpg",
      firebase: { sign_in_provider: "google.com" },
    });

    // Step A: Budi sudah upload CV di personal storage
    mockUsers[candidateEmail] = {
      uid: "UID_BUDI_123",
      username: "Budi Santoso",
      alamatEmail: candidateEmail,
      role: "user",
      status: "active",
      idCompany: null,
      usedStorage: 1500000,
      max_storage: 104857600,
    };

    const cvAttachmentUrl = "https://cdn.vorce.id/user_storage/UIDBUDI123/1726743900000_cv_budi.pdf";

    // Step B: Budi mendaftar ke perusahaan C_TEST_01 dengan attachmentUrl & description
    const res = await request(app)
      .post("/api/login/register-employee")
      .send({
        idToken: "valid_budi_token",
        idCompany: "C_TEST_01",
        noTelp: "081299998888",
        attachmentUrl: cvAttachmentUrl,
        description: "Saya melamar sebagai Flutter Developer.",
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Pendaftaran berhasil dikirim");
    expect(res.body.user.role).toBe("candidate");
    expect(res.body.user.attachmentUrl).toBe(cvAttachmentUrl);

    // Step C: Verifikasi bahwa usedStorage & max_storage personal budi tetap terjaga (tidak terhapus)
    const updatedUser = mockUsers[candidateEmail];
    expect(updatedUser.role).toBe("candidate");
    expect(updatedUser.idCompany).toBe("C_TEST_01");
    expect(updatedUser.usedStorage).toBe(1500000);
    expect(updatedUser.max_storage).toBe(104857600);
    expect(updatedUser.attachmentUrl).toBe(cvAttachmentUrl);
  });
});
