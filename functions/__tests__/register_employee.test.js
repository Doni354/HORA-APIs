/* eslint-disable */
const express = require("express");
const request = require("supertest");

// 1. Mock dependencies
const mockVerifyIdToken = jest.fn();
jest.mock("firebase-admin", () => ({
  auth: () => ({
    verifyIdToken: mockVerifyIdToken,
  }),
}));

const mockCheckPhoneUnique = jest.fn();
jest.mock("../helper/phoneValidator", () => ({
  checkPhoneUnique: (...args) => mockCheckPhoneUnique(...args),
}));

const mockLogCompanyActivity = jest.fn().mockResolvedValue(true);
jest.mock("../helper/logCompanyActivity", () => ({
  logCompanyActivity: (...args) => mockLogCompanyActivity(...args),
}));

const mockEmailSend = jest.fn().mockResolvedValue(true);
jest.mock("../helper/emailHelper", () => ({
  send: (...args) => mockEmailSend(...args),
}));

// In-Memory Database Stores
let mockUsers = {};
let mockCompanies = {};
let mockCompanyEmployees = {};
let mockUserStorage = {};

jest.mock("../config/firebase", () => ({
  db: {
    collection: jest.fn((colName) => {
      if (colName === "users") {
        return {
          doc: jest.fn((email) => ({
            get: jest.fn().mockImplementation(async () => ({
              exists: !!mockUsers[email],
              data: () => mockUsers[email],
              id: email,
            })),
            set: jest.fn().mockImplementation(async (data, opt) => {
              if (opt && opt.merge && mockUsers[email]) {
                mockUsers[email] = { ...mockUsers[email], ...data };
              } else {
                mockUsers[email] = { ...data };
              }
              return true;
            }),
            collection: jest.fn((subCol) => {
              if (subCol === "storage") {
                return {
                  doc: jest.fn((fileId) => ({
                    get: jest.fn().mockImplementation(async () => {
                      const userFiles = mockUserStorage[email] || {};
                      return {
                        exists: !!userFiles[fileId],
                        data: () => userFiles[fileId],
                        id: fileId,
                      };
                    }),
                  })),
                };
              }
              return { doc: jest.fn() };
            }),
          })),
        };
      }
      if (colName === "companies") {
        return {
          doc: jest.fn((compId) => ({
            get: jest.fn().mockImplementation(async () => ({
              exists: !!mockCompanies[compId],
              data: () => mockCompanies[compId],
              id: compId,
            })),
            collection: jest.fn((subCol) => {
              if (subCol === "employees") {
                return {
                  doc: jest.fn((empEmail) => ({
                    get: jest.fn().mockImplementation(async () => {
                      const compEmps = mockCompanyEmployees[compId] || {};
                      return {
                        exists: !!compEmps[empEmail],
                        data: () => compEmps[empEmail],
                        id: empEmail,
                      };
                    }),
                    set: jest.fn().mockImplementation(async (data, opt) => {
                      if (!mockCompanyEmployees[compId]) mockCompanyEmployees[compId] = {};
                      if (opt && opt.merge && mockCompanyEmployees[compId][empEmail]) {
                        mockCompanyEmployees[compId][empEmail] = {
                          ...mockCompanyEmployees[compId][empEmail],
                          ...data,
                        };
                      } else {
                        mockCompanyEmployees[compId][empEmail] = { ...data };
                      }
                      return true;
                    }),
                  })),
                };
              }
              return { doc: jest.fn() };
            }),
          })),
        };
      }
      return { doc: jest.fn() };
    }),
  },
  bucket: {},
}));

const loginRouter = require("../routes/login");

const app = express();
app.use(express.json());
app.use("/login", loginRouter);

describe("POST /login/register-employee", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUsers = {};
    mockCompanies = {
      COMP_001: {
        namaPerusahaan: "PT Vorce Solusi Digital",
        createdBy: "admin@vorce.id",
      },
    };
    mockCompanyEmployees = {};
    mockUserStorage = {};

    mockCheckPhoneUnique.mockResolvedValue({ isDuplicate: false });
  });

  test("1. Berhasil mendaftar kandidat dengan url CV dan desc", async () => {
    mockVerifyIdToken.mockResolvedValue({
      email: "kandidat1@gmail.com",
      name: "Kandidat Satu",
      picture: "https://lh3.googleusercontent.com/pic1.jpg",
      uid: "UID_GOOGLE_1",
      firebase: { sign_in_provider: "google.com" },
    });

    const res = await request(app)
      .post("/login/register-employee")
      .send({
        idToken: "VALID_TOKEN_1",
        idCompany: "COMP_001",
        noTelp: "081234567890",
        noWa: "081234567890",
        url: "https://cdn.vorce.id/user_storage/UID_GOOGLE_1/cv_kandidat.pdf",
        desc: "Senior Mobile Engineer dengan pengalaman Flutter 3 tahun.",
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Pendaftaran berhasil dikirim");
    expect(res.body.user.cvUrl).toBe(
      "https://cdn.vorce.id/user_storage/UID_GOOGLE_1/cv_kandidat.pdf"
    );
    expect(res.body.user.applicantDesc).toBe(
      "Senior Mobile Engineer dengan pengalaman Flutter 3 tahun."
    );

    // Verifikasi data tersimpan di users/{email}
    const savedUser = mockUsers["kandidat1@gmail.com"];
    expect(savedUser).toBeDefined();
    expect(savedUser.role).toBe("candidate");
    expect(savedUser.status).toBe("pending_approval");
    expect(savedUser.cvUrl).toBe(
      "https://cdn.vorce.id/user_storage/UID_GOOGLE_1/cv_kandidat.pdf"
    );
    expect(savedUser.applicantDesc).toBe(
      "Senior Mobile Engineer dengan pengalaman Flutter 3 tahun."
    );

    // Verifikasi data tersimpan di subcollection companies/{idCompany}/employees/{email}
    const savedEmployee = mockCompanyEmployees["COMP_001"]["kandidat1@gmail.com"];
    expect(savedEmployee).toBeDefined();
    expect(savedEmployee.status).toBe("applicant");
    expect(savedEmployee.jabatan).toBe("Pelamar / Applicant");
    expect(savedEmployee.cvUrl).toBe(
      "https://cdn.vorce.id/user_storage/UID_GOOGLE_1/cv_kandidat.pdf"
    );
    expect(savedEmployee.applicantDesc).toBe(
      "Senior Mobile Engineer dengan pengalaman Flutter 3 tahun."
    );

    // Verifikasi logCompanyActivity
    expect(mockLogCompanyActivity).toHaveBeenCalledWith(
      "COMP_001",
      expect.objectContaining({
        action: "NEW_APPLICANT",
        actorEmail: "kandidat1@gmail.com",
      })
    );

    // Verifikasi Email notifikasi ke admin
    expect(mockEmailSend).toHaveBeenCalledWith(
      "admin@vorce.id",
      "new_applicant",
      expect.objectContaining({
        companyName: "PT Vorce Solusi Digital",
        applicantName: "Kandidat Satu",
        applicantEmail: "kandidat1@gmail.com",
      })
    );
  });

  test("2. Berhasil mendaftar dengan cvFileId dari Personal Storage dan bio", async () => {
    mockVerifyIdToken.mockResolvedValue({
      email: "kandidat2@gmail.com",
      name: "Kandidat Dua",
      picture: "",
      uid: "UID_GOOGLE_2",
      firebase: { sign_in_provider: "google.com" },
    });

    // Simpan file di personal storage mock
    mockUserStorage["kandidat2@gmail.com"] = {
      storage_file_999: {
        fileName: "resume_final.pdf",
        downloadUrl: "https://cdn.vorce.id/user_storage/UID_GOOGLE_2/resume_final.pdf",
      },
    };

    const res = await request(app)
      .post("/login/register-employee")
      .send({
        idToken: "VALID_TOKEN_2",
        idCompany: "COMP_001",
        noTelp: "089876543210",
        cvFileId: "storage_file_999",
        bio: "Backend Golang/Node.js Developer.",
      });

    expect(res.status).toBe(200);
    expect(res.body.user.cvUrl).toBe(
      "https://cdn.vorce.id/user_storage/UID_GOOGLE_2/resume_final.pdf"
    );
    expect(res.body.user.applicantDesc).toBe("Backend Golang/Node.js Developer.");

    const savedEmp = mockCompanyEmployees["COMP_001"]["kandidat2@gmail.com"];
    expect(savedEmp.cvUrl).toBe(
      "https://cdn.vorce.id/user_storage/UID_GOOGLE_2/resume_final.pdf"
    );
    expect(savedEmp.applicantDesc).toBe("Backend Golang/Node.js Developer.");
  });

  test("3. Menolak pendaftaran jika user sudah menjadi pegawai aktif", async () => {
    mockVerifyIdToken.mockResolvedValue({
      email: "active_staff@gmail.com",
      name: "Staff Aktif",
      uid: "UID_GOOGLE_3",
    });

    mockUsers["active_staff@gmail.com"] = {
      role: "staff",
      status: "active",
      idCompany: "COMP_001",
    };

    const res = await request(app)
      .post("/login/register-employee")
      .send({
        idToken: "VALID_TOKEN_3",
        idCompany: "COMP_001",
        noTelp: "081122334455",
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sudah terdaftar sebagai pegawai aktif/i);
  });

  test("4. Menolak pendaftaran ganda jika masih berstatus candidate", async () => {
    mockVerifyIdToken.mockResolvedValue({
      email: "candidate@gmail.com",
      name: "Calon Pegawai",
      uid: "UID_GOOGLE_4",
    });

    mockUsers["candidate@gmail.com"] = {
      role: "candidate",
      status: "pending_approval",
      idCompany: "COMP_001",
    };

    const res = await request(app)
      .post("/login/register-employee")
      .send({
        idToken: "VALID_TOKEN_4",
        idCompany: "COMP_001",
        noTelp: "081122334466",
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sedang menunggu konfirmasi Admin/i);
  });

  test("5. Menolak jika nomor telepon duplikat", async () => {
    mockCheckPhoneUnique.mockResolvedValue({ isDuplicate: true });

    const res = await request(app)
      .post("/login/register-employee")
      .send({
        idToken: "VALID_TOKEN",
        idCompany: "COMP_001",
        noTelp: "081234567890",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("PHONE_ALREADY_EXISTS");
  });
});
