const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const validator = require('validator');
const User = require('../models/User');
const generateOtp = require('../utils/generateOtp');
const { sendOtpEmail, checkEmailExists } = require('../services/emailService');
const { logActivity } = require('../middleware/activityLog');

const register = async (req, res) => {
    try {
        console.log('[Register] Request body:', JSON.stringify(req.body));
        let { email, password, name, role, user_code } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required' });
        }

        // Sanitize inputs
        email = validator.trim(email).toLowerCase();
        name = name ? validator.escape(validator.trim(name)) : '';

        // Validate email format server-side
        if (!validator.isEmail(email)) {
            return res.status(400).json({ message: 'Invalid email format' });
        }
        
        if (role === 'LECTURER' || role === 'ADMIN') {
            if (!email.endsWith('@duytan.edu.vn')) {
                return res.status(400).json({ message: 'Lecturer email must end with @duytan.edu.vn' });
            }
        } else {
            if (!email.endsWith('@dtu.edu.vn')) {
                return res.status(400).json({ message: 'Student email must end with @dtu.edu.vn' });
            }
        }

        // MX validation removed: Since we strictly check email.endsWith('@dtu.edu.vn') 
        // we already know the domain exists. dns.resolveMx was causing false negatives.

        // Validate password length
        if (password.length < 8) {
            return res.status(400).json({ message: 'Password must be at least 8 characters' });
        }

        const otp_code = generateOtp();
        const otp_expires_at = new Date(Date.now() + 5 * 60 * 1000); // 5 mins

        console.log('[Register] Finding user...');
        const existingUser = await User.findOne({ where: { email } });

        if (existingUser && existingUser.is_verified) {
            return res.status(400).json({ message: 'This email is already registered. Please use another email or login.' });
        }

        console.log('[Register] Hashing password...');
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        if (existingUser && !existingUser.is_verified) {
            console.log('[Register] Updating unverified user...');
            existingUser.password = password_hash;
            existingUser.name = name;
            existingUser.role = role || 'STUDENT';
            existingUser.user_code = user_code;
            existingUser.otp_code = otp_code;
            existingUser.otp_expires_at = otp_expires_at;
            await existingUser.save();
        } else {
            console.log('[Register] Creating new user...');
            await User.create({
                email,
                password: password_hash,
                name,
                role: role || 'STUDENT',
                user_code,
                otp_code,
                otp_expires_at
            });
        }

        console.log(`[OTP] Code for ${email}: ${otp_code}`);

        try {
            await sendOtpEmail(email, otp_code);
            console.log('[Register] Email sent successfully');
        } catch (emailErr) {
            console.error('[Register] Email send failed:', emailErr.message);
        }

        res.status(201).json({ message: 'OTP sent! Please check your email (or console log).' });
    } catch (error) {
        console.error('[Register] ERROR:', error.message);
        console.error('[Register] Stack:', error.stack);
        res.status(500).json({ message: 'Server error' });
    }
};

const verifyOtp = async (req, res) => {
    try {
        const { email, otp_code } = req.body;

        const user = await User.findOne({ where: { email } });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.is_verified) {
            return res.status(400).json({ message: 'User already verified' });
        }

        if (user.otp_code !== otp_code || user.otp_expires_at < new Date()) {
            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }

        user.is_verified = true;
        user.otp_code = null;
        user.otp_expires_at = null;
        await user.save();

        res.status(200).json({ message: 'OTP verified successfully. You can now login.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
};

const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ where: { email } });
        if (!user) {
            return res.status(400).json({ message: 'Incorrect email or password' });
        }

        if (!user.is_verified) {
            return res.status(403).json({ message: 'Please verify your email first' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Incorrect email or password' });
        }

        const payload = {
            id: user.user_id,
            role: user.role
        };

        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1d' });

        res.status(200).json({ message: 'Login successful', token, user: { id: user.user_id, email: user.email, name: user.name, role: user.role, user_code: user.user_code } });

        // Log login activity
        logActivity(user.user_id, 'login', `User ${user.email} logged in`, req.ip);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
};

module.exports = { register, verifyOtp, login };
