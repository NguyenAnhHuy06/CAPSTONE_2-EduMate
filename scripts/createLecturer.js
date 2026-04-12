/**
 * One-off: create a lecturer user in MySQL (bypasses OTP registration).
 * Usage:
 *   node scripts/createLecturer.js <email@dtu.edu.vn> <password_min_8_chars> [display name]
 * Env (optional): LECTURER_EMAIL, LECTURER_PASSWORD, LECTURER_NAME
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const bcrypt = require("bcryptjs");
const db = require("../db");

async function main() {
  const email =
    process.env.LECTURER_EMAIL ||
    (process.argv[2] && String(process.argv[2]).trim()) ||
    "";
  const password =
    process.env.LECTURER_PASSWORD ||
    (process.argv[3] && String(process.argv[3])) ||
    "";
  const fullName =
    process.env.LECTURER_NAME ||
    (process.argv[4] && String(process.argv[4]).trim()) ||
    "Lecturer";

  if (!db.isConfigured()) {
    console.error("MySQL is not configured (set DATABASE_URL or MYSQL_* in .env).");
    process.exit(1);
  }
  if (!email || !password || password.length < 8) {
    console.error(
      "Usage: node scripts/createLecturer.js <email@dtu.edu.vn> <password_8+_chars> [display name]"
    );
    process.exit(1);
  }

  await db.initDb();

  const existing = await db.findUserByEmail(email.toLowerCase());
  if (existing) {
    console.error("Email already registered:", email);
    process.exit(1);
  }

  const hashed = await bcrypt.hash(password, 10);
  const userId = await db.createUser({
    fullName,
    email: email.toLowerCase(),
    password: hashed,
    role: "LECTURER",
    userCode: null,
  });

  console.log("OK — lecturer created.");
  console.log("  user_id:", userId);
  console.log("  email:  ", email.toLowerCase());
  console.log("  name:   ", fullName);
  console.log("  role:   LECTURER");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
