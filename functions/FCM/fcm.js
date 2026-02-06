/* eslint-disable */
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

exports.onNewCompanyMessage = onDocumentCreated(
  {
    document: "companies/{companyId}/messages/{messageId}",
    region: "asia-southeast2",
  },
  async (event) => {
    console.log("🔥 FCM Trigger Fired");

    const snap = event.data;
    if (!snap) return;

    const message = snap.data();
    const { companyId } = event.params;

    const authorId = message.authorId;
    const type = message.type;

    // =====================================================
    // 1️⃣ Tentukan isi notif
    // =====================================================
    let body = "Pesan baru";

    if (type === "text") {
      body = message.text;
    } else if (type === "custom") {
      if (message.subtype === "recording") {
        body = "🎤 Voice message";
      } else {
        body = "📎 Pesan baru";
      }
    } else if (type === "file") {
      const mime = message.mimeType || "";
      if (mime.startsWith("image/")) {
        body = "🖼️ Gambar";
      } else {
        body = "📄 File";
      }
    }

    // =====================================================
    // 2️⃣ Ambil user dalam company
    // users/{email} -> idCompany
    // =====================================================
    const usersSnap = await admin
      .firestore()
      .collection("users")
      .where("idCompany", "==", companyId)
      .get();

    const tokens = [];

    usersSnap.forEach((doc) => {
      if (doc.id === authorId) return;

      const userData = doc.data();
      const userTokens = userData.fcmTokens || [];

      if (Array.isArray(userTokens)) {
        tokens.push(...userTokens);
      } else if (typeof userTokens === "string") {
        tokens.push(userTokens);
      }
    });

    if (tokens.length === 0) return;

    // =====================================================
    // 3️⃣ Payload FCM
    // =====================================================
    const payload = {
      notification: {
        title: "Pesan baru",
        body,
      },
      data: {
        companyId,
        messageId: snap.id,
        type,
        authorId,
      },
    };

    // =====================================================
    // 4️⃣ Kirim ke FCM
    // =====================================================
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      ...payload,
    });

    // =====================================================
    // 5️⃣ Cleanup token invalid
    // =====================================================
    const invalidTokens = [];
    res.responses.forEach((r, idx) => {
      if (!r.success) {
        invalidTokens.push(tokens[idx]);
      }
    });

    if (invalidTokens.length > 0) {
      console.log("Invalid FCM Tokens:", invalidTokens);
      // optional: hapus dari DB
    }
  },
  "messages/{messageId}",
  async (event) => {
    console.log("🔥 onNewCompanyMessage TRIGGERED");

    const data = event.data?.data();
    console.log("📨 Message data:", data);
  }
);
