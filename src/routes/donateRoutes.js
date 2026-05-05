const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const rbac = require('../middleware/rbac');
const {
  getDonateInfo,
  updateDonateInfo,
} = require('../controllers/donateController');

router.get('/info', getDonateInfo);
router.put('/info', auth, rbac('ADMIN'), updateDonateInfo);

module.exports = router;