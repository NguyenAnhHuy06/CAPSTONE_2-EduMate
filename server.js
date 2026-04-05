// server.js - Backend cho ứng dụng EduMate

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { uploadToS3 } = require("./services/s3Service");
const helmet = require("helmet"); // Thêm Helmet để tăng cường bảo mật HTTP headers

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

app.use(helmet()); // Sử dụng Helmet để bảo vệ ứng dụng khỏi một số lỗ hổng bảo mật phổ biến bằng cách thiết lập các HTTP headers phù hợp

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3001"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error("Not allowed by CORS"));
    }
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const allowedExtensions = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".docm",
  ".dotx",
  ".dotm",
]);

const allowedMimeTypes = new Set([
  "application/pdf", // PDF
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.ms-word.document.macroenabled.12", // .docm
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template", // .dotx
  "application/vnd.ms-word.template.macroenabled.12", // .dotm
]);

const storage = multer.diskStorage({
  destination: function (req, file, cd) {
    cd(null, uploadDir);
  },

  filename: function (req, file, cb) {
    const extension = path.extname(file.originalname).toLowerCase();

    const originalBaseName = path.basename(file.originalname, extension);

    const safeBaseName = originalBaseName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();

    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

    cb(null, `${uniqueSuffix} - ${safeBaseName || "document"}${extension}`);
  },
});

function fileFilter(req, file, cb) {
  const extension = path.extname(file.originalname).toLowerCase();

  const mimeType = (file.mimetype || "").toLowerCase();

  const isExtensionAllowed = allowedExtensions.has(extension);

  const isMimeAllowed = allowedMimeTypes.has(mimeType);

  if (!isExtensionAllowed || !isMimeAllowed) {
    return cb(new Error("Chỉ chấp nhận file PDF hoặc Word (.doc, .docx, .docm, .dotx, .dotm)"));
  } else {
    cb(null, true);
  }
}

const upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
  fileFilter: fileFilter,
});

const recentUploads = [];

function isEmpty(value) {
  return !value || !String(value).trim();
}

function normalizeTags(tagsText) {
  if (!tagsText) {
    return [];
  }

  return tagsText
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function deleteFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      console.warn("Không thể xóa file: ", e.message);
    }
  }
}

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Edumate backend is running.",
  });
});

app.post("/api/documents/upload", upload.single("documentFile"), async (req, res) => {
  try {
    const {
      title,
      category,
      subjectCode,
      subjectName,
      tags,
      description = "",
    } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Bạn chưa chọn file tài liệu.",
      });
    }

    if (isEmpty(title) || isEmpty(category) || isEmpty(subjectCode) || isEmpty(subjectName) || isEmpty(tags)) {
      deleteFileIfExists(req.file.path);

      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập đầy đủ các trường bắt buộc",
      });
    }

    if (title.length > 255) {
      return res.status(400).json({
        success: false,
        message: "Tiêu đề không được vượt quá 255 ký tự.",
      });
    }

    if (subjectCode.length > 50) {
      return res.status(400).json({
        success: false,
        message: "Mã môn học không được vượt quá 50 ký tự.",
      });
    }

    if (subjectName.length > 255) {
      return res.status(400).json({
        success: false,
        message: "Tên môn học không được vượt quá 255 ký tự.",
      });
    }

    // 👉 Upload lên S3
    const s3Url = await uploadToS3(req.file);

    const newDocument = {
      id: Date.now(),
      title: title.trim(),
      category: category.trim(),
      subjectCode: subjectCode.trim(),
      subjectName: subjectName.trim(),
      tags: normalizeTags(tags),
      description: description.trim(),
      originalFileName: req.file.originalname,
      storedFileName: req.file.filename,
      fileSize: req.file.size,
      fileType: req.file.mimetype,
      fileUrl: s3Url, // 👉 đổi sang S3
      downloads: 0,
      uploadedAt: new Date().toISOString(),
    };

    recentUploads.unshift(newDocument);

    if (recentUploads.length > 10) {
      recentUploads.pop();
    }

    return res.status(201).json({
      success: true,
      message: "Upload lên S3 thành công!",
      data: newDocument,
    });

  } catch (err) {
    if (req.file && req.file.path) {
      deleteFileIfExists(req.file.path);
    }

    console.error(err);

    return res.status(500).json({
      success: false,
      message: err.message || "Đã xảy ra lỗi trong quá trình upload tài liệu.",
    })
  }
});

app.get("/api/documents/recent", (req, res) => {
  res.status(200).json({
    success: true,
    total: recentUploads.length,
    data: recentUploads,
  });
});

app.use("/uploads", express.static(uploadDir));

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Không tìm thấy API bạn yêu cầu."
  });
});

app.use((err, req, res, next) => {
  if (req.file && req.file.path) {
    deleteFileIfExists(req.file.path);
  }

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: "Kích cỡ file vượt quá 10MB. Vui lòng chọn file nhỏ hơn (< 10MB)."
      });
    }

    return res.status(400).json({
      success: false,
      message: err.message || "Lỗi upload file."
    });
  }

  return res.status(400).json({
    success: false,
    message: err.message || "Lỗi upload file."
  });
});

app.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
});