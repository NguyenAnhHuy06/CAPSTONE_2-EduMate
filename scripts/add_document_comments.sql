-- EduMate: discussion comments per document (run against your MySQL database)
-- Usage: mysql -u USER -p DATABASE < scripts/add_document_comments.sql

-- 1) Bảng lưu từng comment (không lưu JSON trong 1 cột documents — dễ query & index)
CREATE TABLE IF NOT EXISTS document_comments (
  comment_id INT AUTO_INCREMENT PRIMARY KEY,
  document_id INT NULL DEFAULT NULL,
  file_url VARCHAR(512) NULL DEFAULT NULL,
  user_id INT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_document_comments_doc (document_id),
  KEY idx_document_comments_file (file_url(191)),
  KEY idx_document_comments_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) Tùy chọn: cột đếm nhanh trên bảng documents (FE có thể không dùng nếu chỉ đọc COUNT từ document_comments)
-- Chạy từng lệnh; nếu báo "Duplicate column" thì bỏ qua.
-- ALTER TABLE documents ADD COLUMN comment_count INT NOT NULL DEFAULT 0;
