/* eslint-disable */
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

// Pastikan app sudah diinisialisasi
if (admin.apps.length === 0) {
  admin.initializeApp();
}

/**
 * Trigger saat ada pesan baru di koleksi messages perusahaan.
 * Mengirim notifikasi via FCM dengan logika:
 * 1. Jika ada 'PING!!!' + Mention: Hanya target mention yang dapat (Eksklusif & Urgent).
 * 2. Jika Mention biasa: Target dapat notif 'Menyebut anda', yang lain dapat notif biasa.
 * 3. Jika Pesan biasa: Semua anggota (selain pengirim) dapat notif.
 */
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
    const authorEmail = message.authorEmail;
    const type = message.type;
    const textContent = message.text || "";

    // =====================================================
    // 0️⃣ Inisialisasi & Cek Kondisi Spesial
    // =====================================================
    const isPing = textContent.includes("PING!!!");
    const authorName = message.authorName || "Anggota Tim";
    const truncate = (str, n) =>
      str && str.length > n ? str.substr(0, n - 1) + "..." : str;

    const isUserMentioned = (text, userName) => {
      if (!text || !userName) return false;
      const t = text.toLowerCase();
      const u = userName.toLowerCase();
      return t.includes(`@{${u}}`) || t.includes(`@${u}`);
    };

    let mentionedSomeoneElse = "";
    const mentionMatch = textContent.match(/@(?:\{([^}]+)\}|(\w+))/);
    if (type === "text" && mentionMatch) {
      mentionedSomeoneElse = (mentionMatch[1] || mentionMatch[2] || "").trim();
    }

    // =====================================================
    // 1️⃣ Filter Token Berdasarkan Target
    // =====================================================
    const usersSnap = await admin
      .firestore()
      .collection("users")
      .where("idCompany", "==", companyId)
      .get();

    const tokensMentioned = [];
    const tokensGeneral = [];
    const tokenOwnerMap = {};

    usersSnap.forEach((doc) => {
      const userData = doc.data();
      const docId = doc.id;

      if (authorEmail && docId === authorEmail) return;
      if (
        docId === authorId ||
        userData.uid === authorId ||
        userData.email === authorEmail
      )
        return;

      const userTokens = userData.fcmTokens;
      if (!userTokens) return;

      const userName = userData.name || userData.username;
      const isActuallyMentioned =
        type === "text" && isUserMentioned(textContent, userName);

      if (isPing && mentionedSomeoneElse && !isActuallyMentioned) {
        return;
      }

      const targetGroup = isActuallyMentioned ? tokensMentioned : tokensGeneral;

      const addTokens = (tokens) => {
        if (Array.isArray(tokens)) {
          tokens.forEach((t) => {
            targetGroup.push(t);
            tokenOwnerMap[t] = docId;
          });
        } else if (typeof tokens === "string") {
          targetGroup.push(tokens);
          tokenOwnerMap[tokens] = docId;
        }
      };

      addTokens(userTokens);
    });

    const uniqueTokensMentioned = [...new Set(tokensMentioned)];
    const uniqueTokensGeneral = [...new Set(tokensGeneral)];

    // =====================================================
    // 2️⃣ Konstruksi Payload (PURE DATA-ONLY)
    // =====================================================
    const promises = [];

    // --- BATCH 1: Notifikasi Khusus Mention ---
    if (uniqueTokensMentioned.length > 0) {
      const cleanText =
        textContent.replace(/@(?:\{[^}]+\}|[a-zA-Z0-9_]+)/, "").trim() ||
        "menyebut anda";
      const bodyMentioned = `Menyebut anda : ${truncate(cleanText, 100)}`;
      const androidChannelId = isPing ? "urgent_alert" : "chat_message";

      promises.push(
        admin.messaging().sendEachForMulticast({
          tokens: uniqueTokensMentioned,
          // HANYA menggunakan 'data'. Jangan masukkan objek 'notification' di root atau di 'android'.
          data: {
            title: authorName,
            body: bodyMentioned,
            click_action: "FLUTTER_NOTIFICATION_CLICK",
            companyId: companyId,
            messageId: snap.id,
            type: type,
            authorId: authorId,
            route: "chat",
            isPing: isPing ? "true" : "false",
            channelId: androidChannelId,
          },
          android: {
            priority: "high", // Tetap high agar paket data sampai secepat mungkin
            ttl: isPing ? 0 : 3600 * 1000,
            // [FIX] Objek 'notification' dihapus agar tidak muncul double
          },
          apns: {
            payload: {
              aps: {
                contentAvailable: true,
                mutableContent: true,
                // Di iOS, 'sound' di sini tidak memicu notifikasi sistem jika tidak ada objek alert,
                // tapi membantu FE mengenali jenis suara yang harus diputar.
                sound: isPing ? "critical.caf" : "default",
              },
            },
          },
        })
      );
    }

    // --- BATCH 2: Notifikasi General ---
    if (uniqueTokensGeneral.length > 0) {
      let bodyGeneral = "";

      if (type === "text") {
        bodyGeneral = mentionedSomeoneElse
          ? `Menyebut ${mentionedSomeoneElse} : ${truncate(textContent, 100)}`
          : truncate(textContent, 100);
      } else if (type === "custom") {
        const sub = message.subtype;
        bodyGeneral =
          sub === "recording" || sub === "voice"
            ? "🎤 Mengirim pesan suara"
            : "✨ Mengirim pesan baru";
      } else if (type === "file") {
        const mime = message.mimeType || "";
        if (mime.startsWith("image/")) bodyGeneral = "📷 Mengirim foto";
        else if (mime.startsWith("video/")) bodyGeneral = "🎥 Mengirim video";
        else
          bodyGeneral = `📄 File: ${truncate(
            message.fileName || "Dokumen",
            30
          )}`;
      } else {
        bodyGeneral = "📩 Pesan baru";
      }

      promises.push(
        admin.messaging().sendEachForMulticast({
          tokens: uniqueTokensGeneral,
          data: {
            title: authorName,
            body: bodyGeneral,
            click_action: "FLUTTER_NOTIFICATION_CLICK",
            companyId: companyId,
            messageId: snap.id,
            type: type,
            authorId: authorId,
            route: "chat",
            channelId: "chat_message",
          },
          android: {
            priority: "high",
            // [FIX] Objek 'notification' dihapus
          },
          apns: {
            payload: { aps: { contentAvailable: true, mutableContent: true } },
          },
        })
      );
    }

    // =====================================================
    // 3️⃣ Eksekusi & Cleanup
    // =====================================================
    if (promises.length === 0) return;

    try {
      const results = await Promise.all(promises);
      let allResponses = [];
      let allTokens = [];

      results.forEach((res, i) => {
        allResponses = allResponses.concat(res.responses);
        const sourceTokens =
          i === 0 && uniqueTokensMentioned.length > 0
            ? uniqueTokensMentioned
            : uniqueTokensGeneral;
        allTokens = allTokens.concat(sourceTokens);
      });

      const cleanupPromises = [];
      allResponses.forEach((resp, idx) => {
        if (!resp.success) {
          const err = resp.error;
          if (
            err.code === "messaging/invalid-registration-token" ||
            err.code === "messaging/registration-token-not-registered"
          ) {
            const tokenToRem = allTokens[idx];
            const userId = tokenOwnerMap[tokenToRem];
            if (userId) {
              cleanupPromises.push(
                admin
                  .firestore()
                  .collection("users")
                  .doc(userId)
                  .update({
                    fcmTokens: FieldValue.arrayRemove(tokenToRem),
                  })
                  .catch(() => {})
              );
            }
          }
        }
      });
      await Promise.all(cleanupPromises);
    } catch (e) {
      console.error("❌ FCM Master Error:", e);
    }
  }
);
