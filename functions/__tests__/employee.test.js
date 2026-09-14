/* eslint-disable */
const express = require("express");
const request = require("supertest");

// --- 1. MOCK MIDDLEWARE & SERVICES ---
let mockReqUser = {
  idCompany: "C_TEST_01",
  role: "admin",
  email: "admin@company.com",
  nama: "Admin Mock",
};

jest.mock("../middleware/token", () => ({
  verifyToken: (req, res, next) => {
    req.user = { ...mockReqUser };
    next();
  },
}));

jest.mock("../helper/logCompanyActivity", () => ({
  logCompanyActivity: jest.fn().mockResolvedValue(true),
}));

jest.mock("../helper/emailHelper", () => ({
  send: jest.fn().mockResolvedValue(true),
}));

// Mock Data In-Memory
const mockCompanies = {
  C_TEST_01: {
    namaPerusahaan: "PT Test Bersama",
    createdBy: "owner@company.com",
    ownerUid: "UID_OWNER",
    totalEmployees: 2,
  },
};

const mockEmployees = {
  "staff1@company.com": {
    userEmail: "staff1@company.com",
    role: "staff",
    jabatan: "Frontend Developer",
    status: "active",
    leaveBalance: 12,
    shiftQuota: 5,
    config: {},
  },
  "owner@company.com": {
    userEmail: "owner@company.com",
    role: "owner",
    jabatan: "Pemilik Perusahaan (Owner)",
    status: "active",
    leaveBalance: 12,
    shiftQuota: 0,
    config: {},
  },
};

const mockUsers = {
  "staff1@company.com": {
    username: "Staff Satu",
    photoURL: "https://example.com/staff1.jpg",
    noTelp: "08123456789",
    idCompany: "C_TEST_01",
    role: "staff",
    status: "active",
  },
  "owner@company.com": {
    username: "Owner Bos",
    photoURL: "https://example.com/owner.jpg",
    noTelp: "08987654321",
    idCompany: "C_TEST_01",
    role: "admin",
    uid: "UID_OWNER",
    status: "active",
  },
};

// Mock Firestore DB
jest.mock("../config/firebase", () => {
  const firestoreMock = {
    collection: jest.fn((colName) => {
      if (colName === "companies") {
        return {
          doc: jest.fn((compId) => ({
            get: jest.fn().mockResolvedValue({
              exists: !!mockCompanies[compId],
              data: () => mockCompanies[compId],
              id: compId,
            }),
            update: jest.fn().mockResolvedValue(true),
            collection: jest.fn((subCol) => {
              if (subCol === "employees") {
                return {
                  doc: jest.fn((empEmail) => ({
                    get: jest.fn().mockResolvedValue({
                      exists: !!mockEmployees[empEmail],
                      data: () => mockEmployees[empEmail],
                      id: empEmail,
                    }),
                    set: jest.fn().mockImplementation((data, opts) => {
                      mockEmployees[empEmail] = { ...(mockEmployees[empEmail] || {}), ...data };
                      return Promise.resolve(true);
                    }),
                  })),
                  get: jest.fn().mockResolvedValue({
                    empty: Object.keys(mockEmployees).length === 0,
                    size: Object.keys(mockEmployees).length,
                    forEach: (cb) => {
                      Object.entries(mockEmployees).forEach(([id, data]) => {
                        cb({ id, data: () => data });
                      });
                    },
                  }),
                };
              }
              if (subCol === "logs") {
                return {
                  add: jest.fn().mockResolvedValue({ id: "log_123" }),
                };
              }
              // absensi, leaves, reimbursements, tasks
              return {
                where: jest.fn().mockReturnThis(),
                orderBy: jest.fn().mockReturnThis(),
                limit: jest.fn().mockReturnThis(),
                get: jest.fn().mockResolvedValue({
                  empty: true,
                  docs: [],
                  forEach: jest.fn(),
                }),
              };
            }),
          })),
          get: jest.fn().mockResolvedValue({
            empty: false,
            size: 1,
            docs: [{ id: "C_TEST_01", data: () => mockCompanies["C_TEST_01"] }],
          }),
        };
      }
      if (colName === "users") {
        return {
          doc: jest.fn((uEmail) => ({
            get: jest.fn().mockResolvedValue({
              exists: !!mockUsers[uEmail],
              data: () => mockUsers[uEmail],
              id: uEmail,
            }),
            update: jest.fn().mockImplementation((data) => {
              if (mockUsers[uEmail]) {
                Object.assign(mockUsers[uEmail], data);
              }
              return Promise.resolve(true);
            }),
            set: jest.fn().mockResolvedValue(true),
          })),
          where: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          get: jest.fn().mockResolvedValue({
            empty: false,
            size: Object.keys(mockUsers).length,
            forEach: (cb) => {
              Object.entries(mockUsers).forEach(([id, data]) => {
                cb({ id, data: () => data });
              });
            },
          }),
        };
      }
      return {
        doc: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ exists: false }),
      };
    }),
    getAll: jest.fn((...refs) =>
      Promise.resolve(
        refs.map((ref) => {
          // Extract email from ref path if possible or fallback
          const id = "staff1@company.com";
          return {
            id: id,
            exists: !!mockUsers[id],
            data: () => mockUsers[id] || {},
          };
        })
      )
    ),
  };
  return { db: firestoreMock };
});

// Import App with Router
const app = express();
app.use(express.json());
const companyRoutes = require("../routes/company");
app.use("/api/company", companyRoutes);

describe("Vorce Phase 1: Employee Management Test Suite", () => {
  beforeEach(() => {
    mockReqUser = {
      idCompany: "C_TEST_01",
      role: "admin",
      email: "admin@company.com",
      nama: "Admin Mock",
    };
  });

  describe("1. GET /api/company/:companyId/employees (List)", () => {
    test("Authorized admin can retrieve employee list of own company", async () => {
      const res = await request(app)
        .get("/api/company/C_TEST_01/employees")
        .set("Authorization", "Bearer dummy-token");

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.employees)).toBe(true);
      expect(res.body.pagination).toBeDefined();
    });

    test("Rejects cross-tenant access when companyId does not match user idCompany", async () => {
      const res = await request(app)
        .get("/api/company/C_OTHER_CORP/employees")
        .set("Authorization", "Bearer dummy-token");

      expect(res.statusCode).toBe(403);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toMatch(/Akses dilarang/i);
    });

    test("Accessible via clean route /api/company/employees", async () => {
      const res = await request(app)
        .get("/api/company/employees")
        .set("Authorization", "Bearer dummy-token");

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("2. GET /api/company/:companyId/employees/:email (Detail)", () => {
    test("Retrieves existing employee detail with activity summary", async () => {
      const res = await request(app)
        .get("/api/company/C_TEST_01/employees/staff1@company.com")
        .set("Authorization", "Bearer dummy-token");

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.userEmail).toBe("staff1@company.com");
      expect(res.body.data.jabatan).toBe("Frontend Developer");
      expect(res.body.data.activitySummary).toBeDefined();
      expect(res.body.data.activitySummary.attendance).toBeDefined();
      expect(res.body.data.activitySummary.leaves).toBeDefined();
    });

    test("Returns 404 for non-existing employee", async () => {
      const res = await request(app)
        .get("/api/company/C_TEST_01/employees/ghost@company.com")
        .set("Authorization", "Bearer dummy-token");

      expect(res.statusCode).toBe(404);
      expect(res.body.ok).toBe(false);
    });
  });

  describe("3. PATCH /api/company/:companyId/employees/:email (Update HR)", () => {
    test("Admin can successfully update role, jabatan, leaveBalance, shiftQuota, gaji", async () => {
      const res = await request(app)
        .patch("/api/company/C_TEST_01/employees/staff1@company.com")
        .send({
          jabatan: "Lead Frontend Engineer",
          leaveBalance: 15,
          shiftQuota: 10,
          gaji: 8500000,
        })
        .set("Authorization", "Bearer dummy-token");

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.updatedFields.jabatan).toBe("Lead Frontend Engineer");
      expect(res.body.data.updatedFields.leaveBalance).toBe(15);
      expect(res.body.data.updatedFields.shiftQuota).toBe(10);
      expect(res.body.data.updatedFields.gaji).toBe(8500000);
    });

    test("Rejects update when non-admin tries to update", async () => {
      mockReqUser.role = "staff"; // change actor to staff

      const res = await request(app)
        .patch("/api/company/C_TEST_01/employees/staff1@company.com")
        .send({ leaveBalance: 20 })
        .set("Authorization", "Bearer dummy-token");

      expect(res.statusCode).toBe(403);
      expect(res.body.ok).toBe(false);
    });

    test("Rejects invalid negative leaveBalance", async () => {
      const res = await request(app)
        .patch("/api/company/C_TEST_01/employees/staff1@company.com")
        .send({ leaveBalance: -5 })
        .set("Authorization", "Bearer dummy-token");

      expect(res.statusCode).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toMatch(/leaveBalance/i);
    });

    test("Protects company owner from demotion", async () => {
      const res = await request(app)
        .patch("/api/company/C_TEST_01/employees/owner@company.com")
        .send({ role: "staff" })
        .set("Authorization", "Bearer dummy-token");

      expect(res.statusCode).toBe(403);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toMatch(/Pemilik Perusahaan/i);
    });
  });

  describe("4. POST /api/company/:companyId/employees/:email/deactivate (Non-Destructive)", () => {
    test("Successfully deactivates employee with resigned status", async () => {
      const res = await request(app)
        .post("/api/company/C_TEST_01/employees/staff1@company.com/deactivate")
        .send({
          status: "resigned",
          reason: "Melanjutkan studi S2",
        })
        .set("Authorization", "Bearer dummy-token");

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.status).toBe("resigned");
      expect(res.body.data.reason).toBe("Melanjutkan studi S2");
      expect(mockEmployees["staff1@company.com"].status).toBe("resigned");
    });

    test("Rejects invalid deactivation status (e.g. 'inactive')", async () => {
      const res = await request(app)
        .post("/api/company/C_TEST_01/employees/staff1@company.com/deactivate")
        .send({ status: "inactive" })
        .set("Authorization", "Bearer dummy-token");

      expect(res.statusCode).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toMatch(/resigned.*terminated/i);
    });

    test("Prevents deactivation of company owner", async () => {
      const res = await request(app)
        .post("/api/company/C_TEST_01/employees/owner@company.com/deactivate")
        .send({ status: "terminated", reason: "Pemecatan" })
        .set("Authorization", "Bearer dummy-token");

      expect(res.statusCode).toBe(403);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toMatch(/Pemilik Perusahaan/i);
    });
  });

  describe("5. GET /api/company/:companyId/applicants (Recruitment Flow)", () => {
    beforeEach(() => {
      mockEmployees["applicant1@test.com"] = {
        userEmail: "applicant1@test.com",
        role: "staff",
        jabatan: "Pelamar / Applicant",
        status: "applicant",
        cvUrl: "https://cdn.vorce.id/user_storage/abc/cv.pdf",
        applicantDesc: "Saya antusias melamar posisi ini",
        leaveBalance: 12,
        shiftQuota: 0,
        config: {},
      };
      mockUsers["applicant1@test.com"] = {
        username: "Calon Karyawan",
        role: "candidate",
        status: "pending_approval",
        idCompany: "C_TEST_01",
      };
    });

    test("Admin can retrieve list of applicants with CV and description", async () => {
      const res = await request(app)
        .get("/api/company/C_TEST_01/applicants")
        .set("Authorization", "Bearer dummy-token");

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.employees)).toBe(true);
      const applicant = res.body.employees.find((e) => e.userEmail === "applicant1@test.com");
      expect(applicant).toBeDefined();
      expect(applicant.status).toBe("applicant");
      expect(applicant.cvUrl).toBe("https://cdn.vorce.id/user_storage/abc/cv.pdf");
      expect(applicant.applicantDesc).toBe("Saya antusias melamar posisi ini");
    });

    test("Rejects non-admin from accessing applicant list", async () => {
      mockReqUser.role = "staff";

      const res = await request(app)
        .get("/api/company/C_TEST_01/applicants")
        .set("Authorization", "Bearer dummy-token");

      expect(res.statusCode).toBe(403);
      expect(res.body.ok).toBe(false);
    });
  });
});
