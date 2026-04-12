/**
 * Reset password for one user by email.
 * Usage: node scripts/resetPassword.js <email> <new_password>
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const bcrypt = require("bcryptjs");
const db = require("../db");

async function main() {
  const email = String(process.argv[2] || "").trim().toLowerCase();
  const newPassword = String(process.argv[3] || "");

  if (!db.isConfigured()) {
    console.error("MySQL not configured.");
    process.exit(1);
  }
  if (!email || newPassword.length < 8) {
    console.error("Usage: node scripts/resetPassword.js <email> <new_password_min_8>");
    process.exit(1);
  }

  await db.initDb();
  const row = await db.findUserByEmail(email);
  if (!row) {
    console.error("No user with email:", email);
    process.exit(1);
  }

  const hash = await bcrypt.hash(newPassword, 10);
  await db.updateUserPassword(row.user_id, hash);
  console.log("Password updated for:", email, "(user_id:", row.user_id + ")");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
