const DonateSetting = require('../models/DonateSetting');

async function getDonateInfo(req, res) {
  try {
    let row = await DonateSetting.findOne({ order: [['id', 'ASC']] });

    if (!row) {
      row = await DonateSetting.create({
        account_name: '',
        bank_name: '',
        account_number: '',
        qr_image_url: '',
        transfer_note: '',
        message:
          'Mỗi khoản ủng hộ sẽ giúp EduMate duy trì server, chi trả chi phí API, lưu trữ tài liệu và tiếp tục phát triển thêm tính năng mới.',
        is_enabled: true,
      });
    }

    return res.json({
      success: true,
      data: row,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Không tải được thông tin donate.',
    });
  }
}

async function updateDonateInfo(req, res) {
  try {
    let row = await DonateSetting.findOne({ order: [['id', 'ASC']] });

    if (!row) {
      row = await DonateSetting.create({});
    }

    const {
      account_name,
      bank_name,
      account_number,
      qr_image_url,
      transfer_note,
      message,
      is_enabled,
    } = req.body || {};

    await row.update({
      account_name: account_name ?? row.account_name,
      bank_name: bank_name ?? row.bank_name,
      account_number: account_number ?? row.account_number,
      qr_image_url: qr_image_url ?? row.qr_image_url,
      transfer_note: transfer_note ?? row.transfer_note,
      message: message ?? row.message,
      is_enabled:
        typeof is_enabled === 'boolean' ? is_enabled : row.is_enabled,
    });

    return res.json({
      success: true,
      message: 'Donate info updated successfully.',
      data: row,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Không cập nhật được thông tin donate.',
    });
  }
}

module.exports = {
  getDonateInfo,
  updateDonateInfo,
};