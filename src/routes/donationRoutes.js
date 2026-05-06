const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const rbac = require('../middleware/rbac');

const {
  createDonation,
  listMyDonations,
  listAdminDonations,
  getDonationReceipt,
  confirmDonation,
  rejectDonation,
} = require('../controllers/donationController');

router.post('/', auth, ...createDonation);

router.get('/my', auth, listMyDonations);

router.get('/admin', auth, rbac('ADMIN'), listAdminDonations);

router.get('/:id/receipt', auth, getDonationReceipt);

router.patch('/:id/confirm', auth, rbac('ADMIN'), confirmDonation);

router.patch('/:id/reject', auth, rbac('ADMIN'), rejectDonation);

module.exports = router;