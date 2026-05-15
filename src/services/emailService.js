const nodemailer = require('nodemailer');
const dns = require('dns').promises;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE) === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized:
      String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED) === 'true',
  },
  family: 4,
});

// Check if email domain has valid MX records
const checkEmailExists = async (email) => {
  try {
    const domain = email.split('@')[1];
    const mxRecords = await dns.resolveMx(domain);
    return mxRecords && mxRecords.length > 0;
  } catch (err) {
    console.error(`[Email Check] Domain not found for: ${email}`);
    return false;
  }
};

const sendOtpEmail = async (email, otpCode) => {
  const mailOptions = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'EduMate - Verify Your Account',
    html: `
      <h2>Welcome to EduMate!</h2>
      <p>Your OTP code is: <strong>${otpCode}</strong></p>
      <p>This code will expire in 5 minutes.</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`OTP sent to ${email}`);
  } catch (error) {
    console.error('Error sending email:', error);
    throw new Error('Could not send OTP email');
  }
};

module.exports = { sendOtpEmail, checkEmailExists };