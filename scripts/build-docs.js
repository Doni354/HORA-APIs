/**
 * build-docs.js
 * Script untuk build Docusaurus dan copy output ke public/doc/
 * Dijalankan via: npm run docs:build
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root      = path.resolve(__dirname, "..");
const buildDir  = path.join(root, "docs-site", "build");
const targetDir = path.join(root, "public", "doc");

// 1. Build Docusaurus
console.log("📦 Building Docusaurus...");
execSync("npm run build", { cwd: path.join(root, "docs-site"), stdio: "inherit" });

// 2. Hapus public/doc/ lama kalau ada
if (fs.existsSync(targetDir)) {
  console.log("🗑  Removing old public/doc/...");
  fs.rmSync(targetDir, { recursive: true, force: true });
}

// 3. Copy build → public/doc
console.log("📂 Copying build to public/doc/...");
fs.cpSync(buildDir, targetDir, { recursive: true });

console.log("✅ Done! Docs are ready in public/doc/");
console.log("   Run: firebase deploy --only hosting");
