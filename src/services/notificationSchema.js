const { sequelize } = require("../config/db");

async function ensureNotificationActionPayloadColumn() {
  try {
    await sequelize.query(
      "ALTER TABLE notifications ADD COLUMN action_payload TEXT NULL DEFAULT NULL"
    );
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (!/duplicate column|already exists/i.test(msg)) {
      console.warn("[notifications] action_payload column:", msg);
    }
  }
}

async function ensureCitationsTable() {
  try {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS citations (
        citation_id INT AUTO_INCREMENT PRIMARY KEY,
        message_id INT NOT NULL,
        segment_id INT NOT NULL,
        excerpt TEXT NULL,
        KEY idx_citations_message (message_id),
        KEY idx_citations_segment (segment_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch (err) {
    console.warn("[citations] ensure table:", err.message);
  }
}

module.exports = {
  ensureNotificationActionPayloadColumn,
  ensureCitationsTable,
};
