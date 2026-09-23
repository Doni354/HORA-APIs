/* eslint-disable */
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");

// --- MOCKS ---
const mockVerifySubscription = jest.fn();
const mockAcknowledgeSubscription = jest.fn().mockResolvedValue(true);
const mockVerifyAppleTransaction = jest.fn();
const mockDecodeAppleJWS = jest.fn();
const mockGetNotificationAction = jest.fn();

// In-memory Firestore store
const mockUsers = {};
const mockUserSubscriptions = {}; // mockUserSubscriptions[email] = { [subId]: data }
const mockSubscriptionTokens = {}; // mockSubscriptionTokens[token] = data

jest.mock("../helper/playstore", () => ({
  verifySubscription: mockVerifySubscription,
  acknowledgeSubscription: mockAcknowledgeSubscription,
  BASE_MAX_STORAGE: 104857600,
  BASE_MAX_DEVICES: 1,
}));

jest.mock("../helper/applestore", () => ({
  verifyAppleTransaction: mockVerifyAppleTransaction,
  decodeAppleJWS: mockDecodeAppleJWS,
  getNotificationAction: mockGetNotificationAction,
  APPLE_BUNDLE_ID: "id.vorce.app",
}));

jest.mock("firebase-admin", () => ({
  auth: () => ({
    verifyIdToken: jest.fn(),
  }),
  firestore: {
    Timestamp: {
      now: () => ({ toMillis: () => Date.now(), toDate: () => new Date() }),
      fromDate: (date) => ({ toMillis: () => date.getTime(), toDate: () => date }),
      fromMillis: (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) }),
    },
    FieldValue: {
      increment: (val) => ({ _increment: val }),
      arrayUnion: (val) => val,
      arrayRemove: (val) => val,
    },
  },
}));

jest.mock("firebase-admin/firestore", () => ({
  Timestamp: {
    now: () => ({ toMillis: () => Date.now(), toDate: () => new Date() }),
    fromDate: (date) => ({ toMillis: () => date.getTime(), toDate: () => date }),
    fromMillis: (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) }),
  },
  FieldValue: {
    increment: (val) => ({ _increment: val }),
  },
}));

const mockDb = {
  collection: jest.fn((colName) => {
    if (colName === "users") {
      return {
        doc: jest.fn((email) => ({
          id: email,
          get: jest.fn(async () => ({
            exists: !!mockUsers[email],
            data: () => mockUsers[email],
          })),
          set: jest.fn(async (data, opts) => {
            if (opts && opts.merge) {
              mockUsers[email] = { ...(mockUsers[email] || {}), ...data };
            } else {
              mockUsers[email] = data;
            }
            return true;
          }),
          update: jest.fn(async (data) => {
            mockUsers[email] = { ...(mockUsers[email] || {}), ...data };
            return true;
          }),
          collection: jest.fn((subCol) => {
            if (subCol === "subscriptions") {
              const queryMock = {
                where: jest.fn(),
                limit: jest.fn(),
                orderBy: jest.fn(),
                get: jest.fn(async () => {
                  const subs = Object.values(mockUserSubscriptions[email] || {});
                  const active = subs.filter((s) => ["active", "grace_period"].includes(s.status));
                  return {
                    empty: active.length === 0,
                    docs: active.map((s) => ({ data: () => s })),
                    // forEach must iterate only the QUERY RESULT (active), matching real Firestore behavior
                    forEach: (cb) => active.forEach((s) => cb({ id: s.subscriptionId || "sub_1", data: () => s })),
                  };
                }),
              };
              queryMock.where.mockReturnValue(queryMock);
              queryMock.limit.mockReturnValue(queryMock);
              queryMock.orderBy.mockReturnValue(queryMock);

              return {
                where: queryMock.where,
                orderBy: queryMock.orderBy,
                limit: queryMock.limit,
                doc: jest.fn((subId) => ({
                  id: subId,
                  get: jest.fn(async () => {
                    const data = mockUserSubscriptions[email]?.[subId];
                    return {
                      exists: !!data,
                      data: () => data,
                    };
                  }),
                  set: jest.fn(async (data) => {
                    if (!mockUserSubscriptions[email]) mockUserSubscriptions[email] = {};
                    mockUserSubscriptions[email][subId] = { ...data, subscriptionId: subId };
                    return true;
                  }),
                  update: jest.fn(async (data) => {
                    if (mockUserSubscriptions[email]?.[subId]) {
                      mockUserSubscriptions[email][subId] = { ...mockUserSubscriptions[email][subId], ...data };
                    }
                    return true;
                  }),
                })),
              };
            }
          }),
        })),
      };
    }
    if (colName === "subscription_tokens") {
      return {
        doc: jest.fn((tokenKey) => ({
          get: jest.fn(async () => {
            const data = mockSubscriptionTokens[tokenKey];
            return {
              exists: !!data,
              data: () => data,
            };
          }),
          set: jest.fn(async (data) => {
            mockSubscriptionTokens[tokenKey] = data;
            return true;
          }),
        })),
        where: jest.fn((field, op, val) => ({
          where: jest.fn(() => ({
            limit: jest.fn(() => ({
              get: jest.fn(async () => {
                const found = Object.values(mockSubscriptionTokens).find(
                  (t) => t.originalTransactionId === val || t.transactionId === val
                );
                return {
                  empty: !found,
                  docs: found ? [{ data: () => found }] : [],
                };
              }),
            })),
          })),
        })),
      };
    }
    if (colName === "companies") {
      return {
        doc: jest.fn(() => ({
          get: jest.fn(async () => ({ exists: false })),
        })),
      };
    }
  }),
  batch: jest.fn(() => ({
    set: jest.fn((docRef, data) => docRef.set(data)),
    commit: jest.fn(async () => true),
  })),
};

jest.mock("../config/firebase", () => ({
  admin: {
    auth: () => ({ verifyIdToken: jest.fn() }),
  },
  db: mockDb,
}));

process.env.JWT_SECRET = "TEST_SECRET_KEY_FOR_JEST";

const subscriptionRoutes = require("../routes/subscription");
const { recalculateUserStorageLimits, BASE_USER_STORAGE } = require("../helper/subscriptionService");
const { handleAppleWebhook } = require("../helper/appleSubscriptionService");

const app = express();
app.use(express.json());
app.use("/api/subscription", subscriptionRoutes);

describe("Personal Storage IAP / Subscription Plans", () => {
  const testUserEmail = "user.personal@gmail.com";
  let userJwt;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const k in mockUsers) delete mockUsers[k];
    for (const k in mockUserSubscriptions) delete mockUserSubscriptions[k];
    for (const k in mockSubscriptionTokens) delete mockSubscriptionTokens[k];

    mockUsers[testUserEmail] = {
      alamatEmail: testUserEmail,
      username: "Personal User",
      role: "user",
      status: "active",
      idCompany: null, // User pribadi (tidak ada company)
      usedStorage: 0,
      max_storage: 104857600, // 100MB
    };

    userJwt = jwt.sign(
      { id: testUserEmail, email: testUserEmail, role: "user", idCompany: null },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
  });

  test("1. Google Play: Aktivasi vorce_personal_storage_1 (monthly: +10 GB)", async () => {
    mockVerifySubscription.mockResolvedValue({
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      lineItems: [
        {
          productId: "vorce_personal_storage_1",
          expiryTime: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          autoRenewingPlan: {},
          offerDetails: { basePlanId: "monthly" },
        },
      ],
      latestOrderId: "GPA.1234-5678-9012-34567",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    });

    const res = await request(app)
      .post("/api/subscription/verify")
      .set("Authorization", `Bearer ${userJwt}`)
      .send({
        purchaseToken: "gp_token_personal_10gb_monthly",
        productId: "vorce_personal_storage_1",
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/berhasil/i);
    expect(res.body.data.productId).toBe("vorce_personal_storage_1");
    expect(res.body.data.productType).toBe("personal_storage");
    expect(res.body.data.billingPeriod).toBe("monthly");
    expect(res.body.data.addedStorage).toBe(10737418240); // 10 GB

    // Verifikasi kuota max_storage user naik menjadi 100MB + 10GB
    const expectedStorage = BASE_USER_STORAGE + 10737418240;
    expect(mockUsers[testUserEmail].max_storage).toBe(expectedStorage);
  });

  test("2. Google Play: Aktivasi vorce_personal_storage_2 (yearly: +240 GB)", async () => {
    mockVerifySubscription.mockResolvedValue({
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      lineItems: [
        {
          productId: "vorce_personal_storage_2",
          expiryTime: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
          autoRenewingPlan: {},
          offerDetails: { basePlanId: "yearly" },
        },
      ],
      latestOrderId: "GPA.9999-8888-7777-66666",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    });

    const res = await request(app)
      .post("/api/subscription/verify")
      .set("Authorization", `Bearer ${userJwt}`)
      .send({
        purchaseToken: "gp_token_personal_240gb_yearly",
        productId: "vorce_personal_storage_2",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.productId).toBe("vorce_personal_storage_2");
    expect(res.body.data.billingPeriod).toBe("yearly");
    expect(res.body.data.addedStorage).toBe(257698037760); // 240 GB

    const expectedStorage = BASE_USER_STORAGE + 257698037760;
    expect(mockUsers[testUserEmail].max_storage).toBe(expectedStorage);
  });

  test("3. Apple: Aktivasi vorce_personal_storage_3_year (yearly: +360 GB)", async () => {
    mockVerifyAppleTransaction.mockResolvedValue({
      productId: "vorce_personal_storage_3_year",
      bundleId: "id.vorce.app",
      subscriptionPeriod: "P1Y",
      originalTransactionId: "orig_tx_apple_360gb",
      expiresDate: Date.now() + 365 * 24 * 3600 * 1000,
    });

    const res = await request(app)
      .post("/api/subscription/verify-apple")
      .set("Authorization", `Bearer ${userJwt}`)
      .send({
        transactionId: "tx_apple_360gb_123",
        productId: "vorce_personal_storage_3_year",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.productId).toBe("vorce_personal_storage_3_year");
    expect(res.body.data.productType).toBe("personal_storage");
    expect(res.body.data.billingPeriod).toBe("yearly");
    expect(res.body.data.addedStorage).toBe(386547056640); // 360 GB

    const expectedStorage = BASE_USER_STORAGE + 386547056640;
    expect(mockUsers[testUserEmail].max_storage).toBe(expectedStorage);
  });

  test("4. GET /api/subscription/personal-status mengembalikan status langganan personal user", async () => {
    // Tambahkan 1 langganan personal di mock
    mockUserSubscriptions[testUserEmail] = {
      sub_10gb: {
        subscriptionId: "sub_10gb",
        productId: "vorce_personal_storage_1",
        productType: "personal_storage",
        billingPeriod: "monthly",
        status: "active",
        autoRenewing: true,
        addedStorage: 10737418240,
        createdAt: { toDate: () => new Date() },
      },
    };

    const res = await request(app)
      .get("/api/subscription/personal-status")
      .set("Authorization", `Bearer ${userJwt}`);

    expect(res.status).toBe(200);
    expect(res.body.totalAddedStorage).toBe(10737418240);
    expect(res.body.baseLimits.maxStorage).toBe(104857600);
    expect(res.body.currentMaxStorage).toBe(104857600 + 10737418240);
    expect(res.body.subscriptions).toHaveLength(1);
  });

  test("5. Apple Webhook update: status expired me-reset kuota ke BASE_USER_STORAGE (100MB)", async () => {
    // Step A: Register token in mock
    mockSubscriptionTokens["apple_tx_test_expired"] = {
      userEmail: testUserEmail,
      subscriptionId: "sub_test_expire",
      productId: "vorce_personal_storage_1_month",
      originalTransactionId: "orig_tx_apple_expire",
      platform: "apple",
    };

    mockUserSubscriptions[testUserEmail] = {
      sub_test_expire: {
        subscriptionId: "sub_test_expire",
        productId: "vorce_personal_storage_1_month",
        productType: "personal_storage",
        status: "active",
        addedStorage: 10737418240,
      },
    };
    mockUsers[testUserEmail].max_storage = BASE_USER_STORAGE + 10737418240;

    // Step B: Apple Webhook mengirim event DID_FAIL_TO_RENEW / EXPIRED
    mockDecodeAppleJWS.mockImplementation(async (payload) => {
      if (payload === "mock_signed_payload") {
        return {
          notificationType: "EXPIRED",
          subtype: "VOLUNTARY",
          data: { signedTransactionInfo: "mock_signed_tx" },
        };
      }
      if (payload === "mock_signed_tx") {
        return {
          transactionId: "tx_expired_1",
          originalTransactionId: "orig_tx_apple_expire",
          productId: "vorce_personal_storage_1_month",
          expiresDate: Date.now() - 1000,
        };
      }
    });
    mockGetNotificationAction.mockReturnValue("expire");

    const webhookRes = await handleAppleWebhook("mock_signed_payload");
    expect(webhookRes.ok).toBe(true);

    // Status di dokumen user menjadi expired
    expect(mockUserSubscriptions[testUserEmail].sub_test_expire.status).toBe("expired");

    // Kuota user kembali normal ke base 100MB
    expect(mockUsers[testUserEmail].max_storage).toBe(BASE_USER_STORAGE);
  });
});
