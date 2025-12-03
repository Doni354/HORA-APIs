/* eslint-disable */
const admin = require("firebase-admin")

// Initialize Firebase Admin once, shared across all modules
if (!admin.apps.length) {
  admin.initializeApp({
    storageBucket: "hora-7394b.firebasestorage.app",
  })
}

const db = admin.firestore()
const bucket = admin.storage().bucket()

module.exports = { admin, db, bucket }
