require("dotenv").config();
const mysql = require("mysql2/promise");

async function main() {
  const uid = Number(process.argv[2] || 0);
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || process.env.DB_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT || process.env.DB_PORT || 3306),
    user: process.env.MYSQL_USER || process.env.DB_USER,
    password: process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || process.env.DB_NAME,
  });
  const [rows] = await conn.execute(
    `SELECT attempt_id, user_id, created_at, completed_at,
            DATE(COALESCE(completed_at, created_at)) AS d
     FROM quiz_attempts
     WHERE user_id = ?
     ORDER BY COALESCE(completed_at, created_at) DESC
     LIMIT 20`,
    [uid]
  );
  console.log(rows);
  await conn.end();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
