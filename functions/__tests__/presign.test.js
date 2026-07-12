const express = require("express");
const request = require("supertest");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// --- MOCKS ---
// Mock Middleware verifyToken
jest.mock("../middleware/token", () => ({
  verifyToken: (req, res, next) => {
    // Inject mock user
    req.user = {
      idCompany: "company_123",
      role: "admin",
      email: "admin@company.com",
      nama: "Admin Mock",
    };
    next();
  },
}));

// Mock Log Activity helper
jest.mock("../helper/logCompanyActivity", () => ({
  logCompanyActivity: jest.fn().mockResolvedValue(true),
}));

// Mock R2 config
const mockR2Send = jest.fn();
jest.mock("../config/r2", () => ({
  r2: { send: mockR2Send },
}));

// Mock @aws-sdk/s3-request-presigner
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn().mockResolvedValue("https://mock-presigned-url.com/upload"),
}));

// Mock Firestore
const mockDb = {
  collection: jest.fn(),
  batch: jest.fn(),
  runTransaction: jest.fn(),
};
jest.mock("../config/firebase", () => ({
  db: mockDb,
}));

// Mock FieldValue and Timestamp
jest.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    increment: jest.fn((val) => ({ _increment: val })),
  },
  Timestamp: {
    now: jest.fn(() => ({ toMillis: () => Date.now() })),
    fromMillis: jest.fn((ms) => ({ toMillis: () => ms })),
  },
}));

// Import Routes
const berkasRoutes = require("../routes/berkas");

// Setup Express App
const app = express();
app.use(express.json());
app.use("/api/berkas", berkasRoutes);

describe("Presigned URL Flow Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/berkas/presign", () => {
    it("harus sukses mengembalikan presigned URL jika input valid dan kuota cukup", async () => {
      // Setup mock Firestore company doc
      const mockDoc = {
        exists: true,
        data: () => ({
          maxStorage: 100 * 1024 * 1024, // 100MB
          usedStorage: 10 * 1024 * 1024, // 10MB
          totalEmployees: 2,
          maxKaryawan: 5,
        }),
      };
      
      const mockCollection = jest.fn().mockReturnValue({
        doc: jest.fn().mockImplementation((id) => {
          if (id === "company_123") { // Company doc
            return {
              get: jest.fn().mockResolvedValue(mockDoc),
            };
          }
          // _upload_pending doc
          return {
            set: jest.fn().mockResolvedValue(true),
          };
        }),
      });
      mockDb.collection.mockImplementation(mockCollection);

      const res = await request(app)
        .post("/api/berkas/presign")
        .send({
          fileName: "test_image.jpg",
          mimeType: "image/jpeg",
          fileSize: 1024 * 1024, // 1MB
        });

      expect(res.status).toBe(200);
      expect(res.body.uploadUrl).toBe("https://mock-presigned-url.com/upload");
      expect(res.body.objectKey).toMatch(/^company_files\/company_123\/.*\.jpg$/);
      expect(res.body.registryId).toBeDefined();
    });

    it("harus menolak jika mime type tidak diizinkan", async () => {
      const res = await request(app)
        .post("/api/berkas/presign")
        .send({
          fileName: "virus.exe",
          mimeType: "application/x-msdos-program",
          fileSize: 1024,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MIME_NOT_ALLOWED");
    });


  });

  describe("POST /api/berkas/confirm-upload", () => {
    it("harus sukses mengkonfirmasi upload dengan validasi R2 HeadObjectCommand", async () => {
      // 1. Mock _upload_pending get
      const mockRegistryDoc = {
        exists: true,
        data: () => ({
          uploadedBy: "admin@company.com",
          objectKey: "company_files/company_123/mock-uuid.jpg",
          category: "general"
        })
      };

      const mockCollection = (collName) => {
        if (collName === "_upload_pending") {
          return {
            doc: jest.fn().mockReturnValue({
              get: jest.fn().mockResolvedValue(mockRegistryDoc),
              delete: jest.fn().mockResolvedValue(true)
            })
          };
        }
        // Mock for db.collection("companies").doc(...)
        return {
          doc: jest.fn().mockReturnValue({
             // Subcollection for files
             collection: jest.fn().mockReturnValue({
                 doc: jest.fn().mockReturnValue({
                     id: "new_file_id_123"
                 })
             })
          })
        };
      };
      mockDb.collection.mockImplementation(mockCollection);

      // 2. Mock R2 HeadObjectCommand
      mockR2Send.mockResolvedValueOnce({
        ContentLength: 5 * 1024 * 1024, // 5MB
        ContentType: "image/jpeg"
      });

      // 3. Mock Firestore Transaction
      mockDb.runTransaction.mockImplementation(async (transactionCallback) => {
        const t = {
          get: jest.fn().mockResolvedValue({
            exists: true,
            data: () => ({ maxStorage: 100 * 1024 * 1024, usedStorage: 10 * 1024 * 1024 })
          }),
          set: jest.fn(),
          update: jest.fn()
        };
        await transactionCallback(t);
        // Assert that t.set and t.update were called
        expect(t.set).toHaveBeenCalled();
        expect(t.update).toHaveBeenCalled();
      });

      const res = await request(app)
        .post("/api/berkas/confirm-upload")
        .send({
          objectKey: "company_files/company_123/mock-uuid.jpg",
          registryId: "mock-uuid"
        });

      expect(res.status).toBe(201);
      expect(res.body.message).toMatch(/berhasil/i);
      expect(res.body.data.mimeType).toBe("image/jpeg");
      expect(res.body.data.sizeBytes).toBe(5 * 1024 * 1024);
      
      // Verify R2 HeadObject was called
      expect(mockR2Send).toHaveBeenCalledTimes(1); 
    });

    it("harus menolak jika objectKey tidak ditemukan di R2", async () => {
       const mockRegistryDoc = {
        exists: true,
        data: () => ({
          uploadedBy: "admin@company.com",
          objectKey: "company_files/company_123/mock-uuid.jpg",
        })
      };

      mockDb.collection.mockImplementation(() => ({
        doc: () => ({ get: jest.fn().mockResolvedValue(mockRegistryDoc) })
      }));

      // Mock R2 error
      mockR2Send.mockRejectedValueOnce(new Error("NoSuchKey"));

      const res = await request(app)
        .post("/api/berkas/confirm-upload")
        .send({
          objectKey: "company_files/company_123/mock-uuid.jpg",
          registryId: "mock-uuid"
        });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("FILE_NOT_IN_STORAGE");
    });
  });
});
