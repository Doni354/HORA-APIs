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
    
    const authorId = message.authorId;
    const authorEmail = message.authorEmail; 
    const type = message.type;
    const textContent = message.text || ""; 

    // =====================================================
    // 0️⃣ Cek Kondisi "PING!!!" (Time Sensitive)
    // =====================================================
    const isPing = textContent.includes("PING!!!");

    // =====================================================
    // 1️⃣ Tentukan Title & Content
    // =====================================================
    const authorName = message.authorName || "Anggota Tim";
    const truncate = (str, n) => (str && str.length > n) ? str.substr(0, n - 1) + "..." : str;

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

    let displayContent = textContent;
    if (mentionedSomeoneElse) {
      displayContent = textContent.replace(/@(?:\{[^}]+\}|[a-zA-Z0-9_]+)/, "").trim();
      if (!displayContent) displayContent = "mencolek"; 
    }
    const truncatedContent = truncate(displayContent, 100);

    // =====================================================
    // 2️⃣ Ambil token
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
      if (docId === authorId) return;
      if (userData.uid === authorId) return;
      if (userData.email === authorEmail) return;

      const userTokens = userData.fcmTokens;
      if (!userTokens) return;

      let targetGroup = tokensGeneral; 

      if (type === "text") {
        const userName = userData.name || userData.username;
        if (isUserMentioned(textContent, userName)) {
          targetGroup = tokensMentioned;
        }
      }

      const userId = docId;
      
      if (Array.isArray(userTokens)) {
        userTokens.forEach(t => {
          targetGroup.push(t);
          tokenOwnerMap[t] = userId; 
        });
      } else if (typeof userTokens === "string") {
        targetGroup.push(userTokens);
        tokenOwnerMap[userTokens] = userId;
      }
    });

    const uniqueTokensMentioned = [...new Set(tokensMentioned)];
    const uniqueTokensGeneral = [...new Set(tokensGeneral)];

    // =====================================================
    // 3️⃣ Config Android & iOS (CRITICAL FIXES)
    // =====================================================
    
    // [ANDROID FIX]
    // 1. Bedakan Channel ID untuk PING agar user bisa setting bypass DND di channel ini secara khusus.
    // 2. Tambahkan clickAction agar background notification lancar.
    const androidChannelId = isPing ? "urgent_alert" : "chat_messages";
    
    const androidConfig = {
      priority: "high", // Wajib 'high' agar wake up screen saat background
      notification: { 
        sound: "default", 
        channelId: androidChannelId, 
        tag: companyId,
        clickAction: "FLUTTER_NOTIFICATION_CLICK", // [FIX] Penting untuk background handler
        visibility: "public", // [FIX] Agar muncul di lock screen
      },
    };

    const promises = [];

    // --- BATCH 1: Ke User yang Di-Mention (PING Logic) ---
    if (uniqueTokensMentioned.length > 0) {
      const bodyMentioned = `Menyebut anda : ${truncatedContent}`;
      const interruptionLevel = isPing ? "time-sensitive" : "active";

      const payloadMentioned = {
        notification: {
          title: authorName,
          body: bodyMentioned,
        },
        data: {
          click_action: "FLUTTER_NOTIFICATION_CLICK",
          companyId: companyId,
          messageId: snap.id,
          type: type,
          authorId: authorId,
          route: "chat_screen",
          isPing: isPing ? "true" : "false",
        },
        android: androidConfig, // Menggunakan config dinamis (channel urgent/normal)
        apns: {
          payload: {
            aps: {
              sound: "default",
              threadId: companyId,
              "interruption-level": interruptionLevel,
            },
          },
        },
      };

      promises.push(
        admin.messaging().sendEachForMulticast({
          tokens: uniqueTokensMentioned,
          ...payloadMentioned,
        })
      );
    }

    // --- BATCH 2: Ke User General (Normal) ---
    if (uniqueTokensGeneral.length > 0) {
      let bodyGeneral = "";
      if (type === "text") {
        if (mentionedSomeoneElse) {
          bodyGeneral = `Menyebut ${mentionedSomeoneElse} : ${truncatedContent}`;
        } else {
          bodyGeneral = truncate(textContent, 100);
        }
      } else if (type === "custom") {
        if (message.subtype === "recording" || message.subtype === "voice") {
          bodyGeneral = "🎤 Mengirim pesan suara";
        } else {
          bodyGeneral = "✨ Mengirim pesan baru";
        }
      } else if (type === "file") {
        const mime = message.mimeType || "";
        if (mime.startsWith("image/")) {
          bodyGeneral = "📷 Mengirim foto";
        } else if (mime.startsWith("video/")) {
          bodyGeneral = "🎥 Mengirim video";
        } else {
          const fileName = message.fileName || "dokumen";
          bodyGeneral = `📄 Mengirim file: ${truncate(fileName, 20)}`;
        }
      } else {
        bodyGeneral = "📩 Mengirim pesan";
      }

      // Config Android untuk General (Selalu Normal)
      const androidGeneralConfig = {
        priority: "high",
        notification: { 
          sound: "default", 
          channelId: "chat_messages", // Selalu chat biasa
          tag: companyId,
          clickAction: "FLUTTER_NOTIFICATION_CLICK",
          visibility: "public",
        },
      };

      const payloadGeneral = {
        notification: {
          title: authorName,
          body: bodyGeneral,
        },
        data: {
          click_action: "FLUTTER_NOTIFICATION_CLICK",
          companyId: companyId,
          messageId: snap.id,
          type: type,
          authorId: authorId,
          route: "chat_screen",
        },
        android: androidGeneralConfig,
        apns: {
          payload: {
            aps: {
              sound: "default",
              threadId: companyId,
              "interruption-level": "active", 
            },
          },
        },
      };

      promises.push(
        admin.messaging().sendEachForMulticast({
          tokens: uniqueTokensGeneral,
          ...payloadGeneral,
        })
      );
    }

    // =====================================================
    // 5️⃣ Eksekusi & Cleanup
    // =====================================================
    if (promises.length === 0) return;

    try {
      const results = await Promise.all(promises);
      
      let allResponses = [];
      let allTokens = [];

      if (uniqueTokensMentioned.length > 0 && results[0]) {
        allResponses = allResponses.concat(results[0].responses);
        allTokens = allTokens.concat(uniqueTokensMentioned);
      }

      const generalResultIndex = uniqueTokensMentioned.length > 0 ? 1 : 0;
      if (uniqueTokensGeneral.length > 0 && results[generalResultIndex]) {
        allResponses = allResponses.concat(results[generalResultIndex].responses);
        allTokens = allTokens.concat(uniqueTokensGeneral);
      }

      const cleanupPromises = [];
      
      allResponses.forEach((resp, idx) => {
        if (!resp.success) {
          const error = resp.error;
          const badToken = allTokens[idx];
          
          if (
            error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered'
          ) {
            const ownerId = tokenOwnerMap[badToken];
            if (ownerId) {
              const p = admin.firestore()
                .collection("users")
                .doc(ownerId)
                .update({
                  fcmTokens: FieldValue.arrayRemove(badToken)
                })
                .catch(err => console.error(`Failed cleanup ${ownerId}:`, err));
              cleanupPromises.push(p);
            }
          }
        }
      });

      if (cleanupPromises.length > 0) {
        await Promise.all(cleanupPromises);
        console.log(`✨ Cleaned ${cleanupPromises.length} invalid tokens.`);
      }

    } catch (error) {
      console.error("❌ Error sending notification:", error);
    }
  }
);