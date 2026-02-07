/* eslint-disable */
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

// Pastikan app sudah diinisialisasi
if (admin.apps.length === 0) {
  admin.initializeApp();
}

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

    // Data Author dari dokumen Message langsung (Tanpa Fetch DB User lagi)
    const authorId = message.authorId;
    const authorEmail = message.authorEmail;
    const type = message.type;

    // =====================================================
    // 1️⃣ Tentukan Title (Nama Pengirim) - MURNI DARI FE
    // =====================================================
    // KITA HAPUS LOGIC FETCH KE USERS DB UNTUK CARI NAMA
    // Jika FE lupa kirim authorName, kita kasih default aja biar gak error.
    const authorName = message.authorName || "Anggota Tim";

    // =====================================================
    // 2️⃣ Tentukan Body (Isi Pesan)
    // =====================================================
    // Logic ini sama persis spt request kamu, murni dari data 'message'
    let body = "";
    const truncate = (str, n) =>
      str && str.length > n ? str.substr(0, n - 1) + "..." : str;

    if (type === "text") {
      body = truncate(message.text, 100);
    } else if (type === "custom") {
      if (message.subtype === "recording" || message.subtype === "voice") {
        body = "🎤 Mengirim pesan suara";
      } else {
        body = "✨ Mengirim pesan baru";
      }
    } else if (type === "file") {
      const mime = message.mimeType || "";
      if (mime.startsWith("image/")) {
        body = "📷 Mengirim foto";
      } else if (mime.startsWith("video/")) {
        body = "🎥 Mengirim video";
      } else {
        const fileName = message.fileName || "dokumen";
        body = `📄 Mengirim file: ${truncate(fileName, 20)}`;
      }
    } else {
      body = "📩 Mengirim pesan";
    }

    // =====================================================
    // 3️⃣ Ambil token user & Petakan Token -> UserID
    // =====================================================
    // INI SATU-SATUNYA QUERY KE DB (Wajib untuk dapat token penerima)
    const usersSnap = await admin
      .firestore()
      .collection("users")
      .where("idCompany", "==", companyId)
      .get();

    const tokens = [];
    const tokenOwnerMap = {};

    usersSnap.forEach((doc) => {
      const userData = doc.data();
      const docId = doc.id; // Ini adalah EMAIL user

      // ---------------------------------------------------
      // 🛡️ FILTER PENGIRIM (Agar tidak dapat notif sendiri)
      // ---------------------------------------------------
      // Kita filter berdasarkan data yang dikirim FE (authorEmail / authorId)

      // Jika docId (email di db) sama dengan email pengirim
      if (authorEmail && docId === authorEmail) return;

      // Jika docId sama dengan authorId (jika authorId isinya email)
      if (docId === authorId) return;

      // Double check field di dalam user doc
      if (userData.uid === authorId) return;
      if (userData.email === authorEmail) return;

      // Ambil Token
      const userTokens = userData.fcmTokens;

      if (userTokens) {
        const userId = docId;

        if (Array.isArray(userTokens)) {
          userTokens.forEach((t) => {
            tokens.push(t);
            tokenOwnerMap[t] = userId;
          });
        } else if (typeof userTokens === "string") {
          tokens.push(userTokens);
          tokenOwnerMap[userTokens] = userId;
        }
      }
    });

    const uniqueTokens = [...new Set(tokens)];

    if (uniqueTokens.length === 0) {
      // Tidak perlu log error, mungkin memang company baru isi 1 orang
      return;
    }

    // =====================================================
    // 4️⃣ Payload FCM
    // =====================================================
    const payload = {
      notification: {
        title: authorName, // Menggunakan data langsung dari FE
        body: body,
      },
      data: {
        click_action: "FLUTTER_NOTIFICATION_CLICK",
        companyId: companyId,
        messageId: snap.id,
        type: type,
        authorId: authorId,
        route: "chat_screen",
      },
      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "chat_messages",
          tag: companyId, // Grouping notif per company
        },
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
            threadId: companyId, // Grouping notif di iOS
          },
        },
      },
    };

    // =====================================================
    // 5️⃣ Kirim ke FCM & Tangani Error
    // =====================================================
    try {
      const res = await admin.messaging().sendEachForMulticast({
        tokens: uniqueTokens,
        ...payload,
      });

      console.log(
        `✅ Notif sent: ${res.successCount} success, ${res.failureCount} failed.`
      );

      // =====================================================
      // 6️⃣ CLEANUP AUTOMATIC (Hapus Token Mati)
      // =====================================================
      if (res.failureCount > 0) {
        const cleanupPromises = [];

        res.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const error = resp.error;
            const badToken = uniqueTokens[idx];

            // Cek kode error spesifik token mati/invalid
            if (
              error.code === "messaging/invalid-registration-token" ||
              error.code === "messaging/registration-token-not-registered"
            ) {
              const ownerId = tokenOwnerMap[badToken];

              if (ownerId) {
                // Hapus token sampah tanpa menunggu (fire and forget) agar function cepat selesai
                const p = admin
                  .firestore()
                  .collection("users")
                  .doc(ownerId)
                  .update({
                    fcmTokens: FieldValue.arrayRemove(badToken),
                  })
                  .catch((err) =>
                    console.error(`Failed to remove token for ${ownerId}:`, err)
                  );

                cleanupPromises.push(p);
              }
            }
          }
        });

        if (cleanupPromises.length > 0) {
          await Promise.all(cleanupPromises);
        }
      }
    } catch (error) {
      console.error("❌ Error sending notification:", error);
    }
  }
);
