const path = require('path');
const multer = require('multer');
const Donation = require('../models/Donation');
const Notification = require('../models/Notification');
const s3 = require('../services/s3Upload');
const { logActivity } = require('../middleware/activityLog');

const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);
const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

function receiptFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();

  if (!allowedExtensions.has(ext) || !allowedMimeTypes.has(mime)) {
    return cb(new Error('Chỉ chấp nhận biên lai dạng JPG, PNG, WEBP hoặc PDF.'));
  }

  cb(null, true);
}

const uploadReceipt = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: receiptFileFilter,
});

function sanitizeFileBaseName(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  const base = path.basename(originalName || 'receipt', ext);

  return (
    base
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'receipt'
  );
}

function buildReceiptKey(userId, originalName) {
  const ext = path.extname(originalName || '').toLowerCase() || '.jpg';
  const safe = sanitizeFileBaseName(originalName);
  const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  return `donation-receipts/user-${userId}/${unique}-${safe}${ext}`;
}

function parseAmount(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const normalized = raw.replace(/,/g, '');
  const n = Number(normalized);

  if (!Number.isFinite(n)) return null;
  return n;
}

function trimOrNull(value, max = 2000) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function toDonationDTO(row) {
  if (!row) return null;
  const d = typeof row.toJSON === 'function' ? row.toJSON() : row;

  return {
    donation_id: d.donation_id,
    user_id: d.user_id,
    donor_name: d.donor_name,
    donor_email: d.donor_email,
    amount: Number(d.amount || 0),
    currency: d.currency,
    transfer_note: d.transfer_note,
    transaction_code: d.transaction_code,
    message: d.message,
    receipt_original_name: d.receipt_original_name,
    receipt_mime_type: d.receipt_mime_type,
    receipt_size: d.receipt_size,
    status: d.status,
    admin_note: d.admin_note,
    confirmed_by: d.confirmed_by,
    confirmed_at: d.confirmed_at,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

const createDonation = [
  uploadReceipt.single('receipt'),
  async (req, res) => {
    try {
      if (!s3.isS3Configured()) {
        return res.status(503).json({
          success: false,
          message: 'S3 chưa cấu hình. Không thể upload biên lai.',
        });
      }

      const amount = parseAmount(req.body.amount);
      if (!amount || amount <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Số tiền ủng hộ không hợp lệ.',
        });
      }

      if (!req.file || !req.file.buffer) {
        return res.status(400).json({
          success: false,
          message: 'Vui lòng upload biên lai chuyển khoản',
        });
      }

      const userId = req.user.id || req.user.user_id;
      const key = buildReceiptKey(userId, req.file.originalname);

      const uploaded = await s3.uploadDocumentBuffer({
        buffer: req.file.buffer,
        key,
        contentType: req.file.mimetype,
      });

      const donation = await Donation.create({
        user_id: userId,
        donor_name: req.user.full_name || req.user.name || null,
        donor_email: req.user.email || null,
        amount,
        currency: 'VND',
        transfer_note: trimOrNull(req.body.transfer_note, 255),
        transaction_code: trimOrNull(req.body.transaction_code, 255),
        message: trimOrNull(req.body.message, 2000),
        receipt_file_key: uploaded.key,
        receipt_original_name: req.file.originalname,
        receipt_mime_type: req.file.mimetype,
        receipt_size: req.file.size,
        status: 'PENDING',
      });

      await logActivity(
        userId,
        'DONATION_SUBMIT',
        `Submitted donation #${donation.donation_id} amount ${amount} VND`,
        req.ip
      );

      return res.status(201).json({
        success: true,
        message: 'Đã gửi biên lai ủng hộ. Vui lòng chờ admin xác nhận.',
        data: toDonationDTO(donation),
      });
    } catch (err) {
      console.error('[createDonation]', err);
      return res.status(500).json({
        success: false,
        message: err.message || 'Không gửi được thông tin donate.',
      });
    }
  },
];

async function listMyDonations(req, res) {
  try {
    const userId = req.user.id || req.user.user_id;

    const rows = await Donation.findAll({
      where: { user_id: userId },
      order: [['created_at', 'DESC']],
      limit: 100,
    });

    return res.json({
      success: true,
      data: rows.map(toDonationDTO),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Không tải được lịch sử donate.',
    });
  }
}

async function listAdminDonations(req, res) {
  try {
    const status = String(req.query.status || '').toUpperCase();
    const where = {};

    if (['PENDING', 'CONFIRMED', 'REJECTED'].includes(status)) {
      where.status = status;
    }

    const rows = await Donation.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: 200,
    });

    return res.json({
      success: true,
      data: rows.map(toDonationDTO),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Không tải được danh sách donate.',
    });
  }
}

async function getDonationReceipt(req, res) {
  try {
    const donation = await Donation.findByPk(req.params.id);
    if (!donation) {
      return res.status(404).json({
        success: false,
        message: 'Donation không tồn tại.',
      });
    }

    const userId = req.user.id || req.user.user_id;
    const role = String(req.user.role || '').toUpperCase();
    const isOwner = Number(donation.user_id) === Number(userId);
    const isAdmin = role === 'ADMIN';

    if (!isOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Bạn không có quyền xem biên lai này.',
      });
    }

    const url =
      (await s3.buildInlineSignedUrl(donation.receipt_file_key, 10 * 60)) ||
      (await s3.buildSignedUrl(donation.receipt_file_key, 10 * 60));

    return res.json({
      success: true,
      data: { url },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Không mở được biên lai.',
    });
  }
}

async function confirmDonation(req, res) {
  try {
    const donation = await Donation.findByPk(req.params.id);
    if (!donation) {
      return res.status(404).json({
        success: false,
        message: 'Donation không tồn tại.',
      });
    }

    donation.status = 'CONFIRMED';
    donation.admin_note = trimOrNull(req.body.admin_note, 2000);
    donation.confirmed_by = req.user.id || req.user.user_id;
    donation.confirmed_at = new Date();
    await donation.save();

    try {
    await Notification.create({
        user_id: donation.user_id,
        type: 'success',
        title: 'Donate confirmed',
        content: `Khoản ủng hộ ${Number(donation.amount || 0).toLocaleString('vi-VN')}đ của bạn đã được admin xác nhận.`,
    });
    } catch (notifyErr) {
    console.warn('[DonationNotification] Confirm notification failed:', notifyErr.message);
    }

    await logActivity(
    req.user.id || req.user.user_id,
    'DONATION_CONFIRM',
    `Confirmed donation #${donation.donation_id}`,
    req.ip
    );

    return res.json({
      success: true,
      message: 'Đã xác nhận khoản donate.',
      data: toDonationDTO(donation),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Không xác nhận được khoản donate.',
    });
  }
}

async function rejectDonation(req, res) {
  try {
    const donation = await Donation.findByPk(req.params.id);
    if (!donation) {
      return res.status(404).json({
        success: false,
        message: 'Donation không tồn tại.',
      });
    }

    donation.status = 'REJECTED';
    donation.admin_note = trimOrNull(req.body.admin_note, 2000);
    donation.confirmed_by = req.user.id || req.user.user_id;
    donation.confirmed_at = new Date();
    await donation.save();

    try {
    await Notification.create({
        user_id: donation.user_id,
        type: 'error',
        title: 'Donate rejected',
        content: `Khoản ủng hộ ${Number(donation.amount || 0).toLocaleString('vi-VN')}đ của bạn đã bị từ chối. Lý do: ${donation.admin_note || 'Biên lai chưa hợp lệ.'}`,
    });
    } catch (notifyErr) {
    console.warn('[DonationNotification] Reject notification failed:', notifyErr.message);
    }

    await logActivity(
    req.user.id || req.user.user_id,
    'DONATION_REJECT',
    `Rejected donation #${donation.donation_id}`,
    req.ip
    );

    return res.json({
      success: true,
      message: 'Đã từ chối khoản donate.',
      data: toDonationDTO(donation),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Không từ chối được khoản donate.',
    });
  }
}

module.exports = {
  createDonation,
  listMyDonations,
  listAdminDonations,
  getDonationReceipt,
  confirmDonation,
  rejectDonation,
};