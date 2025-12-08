/* eslint-disable */
const express = require("express");
const { db } = require("../config/firebase");
const { verifyToken } = require("../middleware/token");
const { uploadFile } = require("../helper/uploadFile");
const router = express.Router();
const { Timestamp } = require("firebase-admin/firestore");
const { logCompanyActivity } = require("../helper/logCompanyActivity");

module.exports = router;
