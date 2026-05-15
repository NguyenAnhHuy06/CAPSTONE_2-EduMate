/**
 * Tạo tài khoản ADMIN trong MySQL (bỏ qua OTP).
 *
 * Usage:
 *   node scripts/createAdmin.js <email> <password_8+_chars> [display name]
 *
 * Hoặc env:
 *   ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const bcrypt = require("bcryptjs");
const db = require("../db");

async function main() {
  const email =
    process.env.ADMIN_EMAIL ||
    (process.argv[2] && String(process.argv[2]).trim()) ||
    "";
  const password =
    process.env.ADMIN_PASSWORD ||
    (process.argv[3] && String(process.argv[3])) ||
    "";
  const fullName =
    process.env.ADMIN_NAME ||
    (process.argv[4] && String(process.argv[4]).trim()) ||
    "Administrator";

  if (!db.isConfigured()) {
    console.error("MySQL chưa cấu hình (đặt DATABASE_URL hoặc MYSQL_* trong .env).");
    process.exit(1);
  }
  if (!email || !password || password.length < 8) {
    console.error(
      "Cách dùng: node scripts/createAdmin.js <email> <mật_khẩu_8_ký_tự+> [tên hiển thị]"
    );
    process.exit(1);
  }

  await db.initDb();

  const em = email.toLowerCase();
  const existing = await db.findUserByEmail(em);
  if (existing) {
    console.error("Email đã tồn tại:", em);
    process.exit(1);
  }

  const hashed = await bcrypt.hash(password, 10);
  const userId = await db.createUser({
    fullName,
    email: em,
    password: hashed,
    role: "ADMIN",
    userCode: null,
  });

  await db.markUserEmailVerified(userId);

  console.log("OK — tài khoản ADMIN đã tạo.");
  console.log("  user_id:", userId);
  console.log("  email:  ", em);
  console.log("  name:   ", fullName);
  console.log("  role:   ADMIN (đã đánh dấu email verified để đăng nhập được)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
