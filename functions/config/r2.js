/* eslint-disable */
const { S3Client } = require("@aws-sdk/client-s3");

const r2 = new S3Client({
  region: "auto",
  endpoint: "https://609723b5d7cc16b02d6454eebea06c5a.r2.cloudflarestorage.com",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

module.exports = { r2 };
