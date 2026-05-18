require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const db = require("../db");

(async () => {
  const p = db.getPool();
  const [users] = await p.execute(
    "SELECT user_id, email, role, name FROM users WHERE email LIKE ? LIMIT 10",
    ["%lecturer.demo%"]
  );
  console.log("users:", users);
  const [pub] = await p.execute(
    "SELECT quiz_id, title, created_by, is_published FROM quizzes WHERE is_published = 1 ORDER BY quiz_id DESC LIMIT 15"
  );
  console.log("published quizzes:", pub);
  for (const u of users) {
    const [owned] = await p.execute(
      "SELECT quiz_id, title, is_published FROM quizzes WHERE created_by = ? ORDER BY quiz_id DESC LIMIT 15",
      [u.user_id]
    );
    console.log(`owned by ${u.user_id} (${u.email}):`, owned);
  }
  const [orphan] = await p.execute(
    "SELECT quiz_id, title, created_by, is_published FROM quizzes WHERE is_published = 1 AND (created_by IS NULL OR created_by = 0) LIMIT 10"
  );
  console.log("published without created_by:", orphan);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
