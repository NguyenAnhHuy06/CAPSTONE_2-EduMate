const express = require("express"); // Nạp Express để tạo server API.
const cors = require("cors"); // Cho phép frontend gọi API khác cổng.
const multer = require("multer"); // Thư viện xử lý upload file multipart/form-data.
const path = require("path"); // Hỗ trợ xử lý đường dẫn file/thư mục.
const fs = require("fs"); // Hỗ trợ kiểm tra, tạo, xóa file/thư mục.

const app = express(); // Tạo ứng dụng Express.
const PORT = 3000; // Cổng mà server sẽ chạy.
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB = 10 * 1024 * 1024 bytes.

app.use(cors()); // Cho phép truy cập API từ frontend chạy khác origin/port.
app.use(express.json()); // Cho phép đọc dữ liệu JSON gửi lên server.
app.use(express.urlencoded({ extended: true })); // Cho phép đọc dữ liệu form thường.

// Tạo đường dẫn thư mục lưu file upload.
const uploadDir = path.join(__dirname, "uploads");

// Nếu thư mục uploads chưa tồn tại thì tạo mới.
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Danh sách phần mở rộng file được phép.
const allowedExtensions = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".docm",
  ".dotx",
  ".dotm",
]);

// Danh sách MIME type được phép.
// MIME type là "kiểu nội dung" mà trình duyệt gửi kèm file lên server.
const allowedMimeTypes = new Set([
  "application/pdf", // PDF
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.ms-word.document.macroenabled.12", // .docm
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template", // .dotx
  "application/vnd.ms-word.template.macroenabled.12", // .dotm
  "application/octet-stream", // Một số máy/trình duyệt có thể gửi MIME chung kiểu này
]);

// Cấu hình cách Multer lưu file xuống ổ đĩa.
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Chỉ định nơi lưu file upload.
    cb(null, uploadDir);
  },

  filename: function (req, file, cb) {
    // Lấy phần đuôi file, ví dụ ".pdf", ".docx"
    const extension = path.extname(file.originalname).toLowerCase();

    // Lấy tên file gốc nhưng bỏ phần đuôi.
    const originalBaseName = path.basename(file.originalname, extension);

    // Chuẩn hóa tên file:
    // - bỏ dấu tiếng Việt
    // - thay ký tự đặc biệt bằng dấu gạch ngang
    // - chuyển về chữ thường
    const safeBaseName = originalBaseName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();

    // Tạo chuỗi duy nhất để tránh trùng tên file.
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

    // Tên file cuối cùng lưu trên server.
    cb(null, `${uniqueSuffix}-${safeBaseName || "document"}${extension}`);
  },
});

// Hàm kiểm tra file có đúng định dạng yêu cầu hay không.
function fileFilter(req, file, cb) {
  // Lấy phần mở rộng của file.
  const extension = path.extname(file.originalname).toLowerCase();

  // Lấy MIME type của file.
  const mimeType = (file.mimetype || "").toLowerCase();

  // Kiểm tra phần đuôi file có hợp lệ không.
  const isExtensionAllowed = allowedExtensions.has(extension);

  // Kiểm tra MIME type có hợp lệ không.
  const isMimeAllowed = allowedMimeTypes.has(mimeType);

  // Nếu sai định dạng thì báo lỗi.
  if (!isExtensionAllowed || !isMimeAllowed) {
    return cb(
      new Error(
        "Chỉ chấp nhận file PDF hoặc Word (.doc, .docx, .docm, .dotx, .dotm)."
      )
    );
  }

  // Nếu hợp lệ thì cho phép upload tiếp.
  cb(null, true);
}

// Tạo middleware upload của Multer.
const upload = multer({
  storage: storage, // Dùng cấu hình lưu file đã khai báo phía trên.
  limits: {
    fileSize: MAX_FILE_SIZE, // Giới hạn 10MB.
  },
  fileFilter: fileFilter, // Dùng hàm lọc định dạng file.
});

// Mảng tạm để lưu danh sách upload gần đây.
// Lưu ý: dữ liệu này chỉ nằm trong RAM, restart server sẽ mất.
const recentUploads = [];

// Hàm kiểm tra chuỗi rỗng/null/undefined.
function isEmpty(value) {
  return !value || !String(value).trim();
}

// Hàm chuẩn hóa tags:
// Ví dụ: "notes, exam, lecture" -> ["notes", "exam", "lecture"]
function normalizeTags(tagsText) {
  return String(tagsText)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

// Hàm xóa file nếu file tồn tại.
// Dùng khi upload file xong nhưng các field text bị thiếu -> cần rollback file vừa lưu.
function deleteFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// Route test nhanh để kiểm tra server còn chạy không.
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Edumate backend is running.",
  });
});

/*
  Frontend cần gửi lên các field sau:
  - documentFile : file tài liệu
  - title        : tên tài liệu
  - category     : loại môn học
  - subjectCode  : mã môn
  - subjectName  : tên môn
  - tags         : tags, cách nhau bằng dấu phẩy
  - description  : mô tả (có thể để trống)
*/

// API upload tài liệu.
app.post("/api/documents/upload", upload.single("documentFile"), (req, res) => {
  // Lấy dữ liệu text từ form.
  const {
    title,
    category,
    subjectCode,
    subjectName,
    tags,
    description = "",
  } = req.body;

  // Kiểm tra có file được gửi lên hay không.
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "Bạn chưa chọn file tài liệu.",
    });
  }

  // Kiểm tra các trường bắt buộc.
  if (
    isEmpty(title) ||
    isEmpty(category) ||
    isEmpty(subjectCode) ||
    isEmpty(subjectName) ||
    isEmpty(tags)
  ) {
    // Nếu thiếu field text thì xóa file vừa upload để tránh file rác.
    deleteFileIfExists(req.file.path);

    return res.status(400).json({
      success: false,
      message: "Vui lòng nhập đầy đủ các trường bắt buộc.",
    });
  }

  // Tạo URL đầy đủ để frontend có thể dùng trực tiếp.
  const baseUrl = `${req.protocol}://${req.get("host")}`;

  // Tạo object tài liệu mới.
  const newDocument = {
    id: Date.now(), // ID đơn giản dựa trên thời gian.
    title: title.trim(), // Tên tài liệu.
    category: category.trim(), // Danh mục khóa học.
    subjectCode: subjectCode.trim(), // Mã môn học.
    subjectName: subjectName.trim(), // Tên môn học.
    tags: normalizeTags(tags), // Chuyển chuỗi tags thành mảng.
    description: description.trim(), // Mô tả, có thể rỗng.
    originalFileName: req.file.originalname, // Tên file gốc người dùng upload.
    storedFileName: req.file.filename, // Tên file đã đổi khi lưu trên server.
    fileSize: req.file.size, // Kích thước file tính bằng byte.
    fileType: req.file.mimetype, // MIME type file.
    fileUrl: `${baseUrl}/uploads/${req.file.filename}`, // Link truy cập file.
    downloads: 0, // Mặc định chưa ai tải.
    uploadedAt: new Date().toISOString(), // Thời gian upload.
  };

  // Thêm tài liệu mới vào đầu danh sách recent.
  recentUploads.unshift(newDocument);

  // Chỉ giữ tối đa 10 bản ghi gần nhất trong RAM.
  if (recentUploads.length > 10) {
    recentUploads.pop();
  }

  // Trả kết quả thành công cho frontend.
  return res.status(201).json({
    success: true,
    message: "Tải tài liệu lên thành công.",
    data: newDocument,
  });
});

// API lấy danh sách upload gần đây.
app.get("/api/documents/recent", (req, res) => {
  res.status(200).json({
    success: true,
    total: recentUploads.length,
    data: recentUploads,
  });
});

// Cho phép truy cập trực tiếp file trong thư mục uploads qua URL.
app.use("/uploads", express.static(uploadDir));

// Middleware xử lý route không tồn tại.
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Không tìm thấy API bạn yêu cầu.",
  });
});

// Middleware xử lý lỗi tập trung.
app.use((err, req, res, next) => {
  // Nếu có file đã được lưu trước khi lỗi xảy ra thì xóa đi.
  if (req.file && req.file.path) {
    deleteFileIfExists(req.file.path);
  }

  // Nếu lỗi đến từ Multer.
  if (err instanceof multer.MulterError) {
    // Lỗi vượt quá dung lượng cho phép.
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message:
          "File vượt quá 10MB. Vui lòng chọn file nhỏ hơn hoặc bằng 10MB.",
      });
    }

    // Các lỗi Multer khác.
    return res.status(400).json({
      success: false,
      message: err.message || "Lỗi upload file.",
    });
  }

  // Các lỗi tự tạo khác.
  return res.status(400).json({
    success: false,
    message: err.message || "Đã xảy ra lỗi ở server.",
  });
});

// Khởi động server.
app.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
});