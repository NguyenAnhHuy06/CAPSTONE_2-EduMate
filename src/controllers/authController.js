const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const validator = require('validator');
const User = require('../models/User');
const generateOtp = require('../utils/generateOtp');
const { sendOtpEmail } = require('../services/emailService');
const { logActivity } = require('../middleware/activityLog');

const register = async (req, res) => {
    try {
        console.log('[Register] Request body:', JSON.stringify(req.body));
        let { email, password, full_name, role, user_code } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password are required' });
        }

        email = validator.trim(email).toLowerCase();
        full_name = full_name ? validator.escape(validator.trim(full_name)) : '';

        if (!validator.isEmail(email)) {
            return res.status(400).json({ success: false, message: 'Invalid email format' });
        }

        /** Match legacy `/api/auth/register` in `index.js`: no privilege escalation via public signup. */
        if (role && String(role).toUpperCase() !== 'STUDENT') {
            return res.status(403).json({
                success: false,
                message: 'Public registration is only available for student accounts.',
            });
        }
        role = 'STUDENT';

        if (!email.endsWith('@dtu.edu.vn')) {
            return res.status(400).json({ success: false, message: 'Student email must end with @dtu.edu.vn' });
        }

        if (password.length < 8) {
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
        }

        const otp_code = generateOtp();
        const otp_expires_at = new Date(Date.now() + 5 * 60 * 1000);

        console.log('[Register] Finding user...');
        const existingUser = await User.findOne({ where: { email } });

        if (existingUser && existingUser.is_verified) {
            return res.status(400).json({
                success: false,
                message: 'This email is already registered. Please use another email or login.'
            });
        }

        console.log('[Register] Hashing password...');
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        if (existingUser && !existingUser.is_verified) {
            console.log('[Register] Updating unverified user...');
            existingUser.password_hash = password_hash;
            existingUser.full_name = full_name;
            existingUser.role = role || 'STUDENT';
            existingUser.user_code = user_code;
            existingUser.otp_code = otp_code;
            existingUser.otp_expires_at = otp_expires_at;
            await existingUser.save();
        } else {
            console.log('[Register] Creating new user...');
            await User.create({
                email,
                password_hash,
                full_name,
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

        return res.status(201).json({
            success: true,
            message: 'OTP sent! Please check your email.'
        });
    } catch (error) {
        console.error('[Register] ERROR:', error.message);
        console.error('[Register] Stack:', error.stack);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

const verifyOtp = async (req, res) => {
    try {
        const { email, otp_code } = req.body;

        const user = await User.findOne({ where: { email } });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (user.is_verified) {
            return res.status(400).json({ success: false, message: 'User already verified' });
        }

        if (user.otp_code !== otp_code || user.otp_expires_at < new Date()) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }

        user.is_verified = true;
        user.otp_code = null;
        user.otp_expires_at = null;
        await user.save();

        return res.status(200).json({
            success: true,
            message: 'OTP verified successfully. You can now login.',
            user: {
                user_id: user.user_id,
                id: user.user_id,
                email: user.email,
                full_name: user.full_name,
                name: user.full_name,
                role: user.role,
                user_code: user.user_code
            }
        });
    } catch (error) {
        console.error('[verifyOtp] ERROR:', error.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ where: { email } });
        if (!user) {
            return res.status(400).json({ success: false, message: 'Incorrect email or password' });
        }

        if (!user.is_verified) {
            return res.status(403).json({ success: false, message: 'Please verify your email first' });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Incorrect email or password' });
        }

        const payload = {
            id: user.user_id,
            role: user.role
        };

        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1d' });

        const responseUser = {
            user_id: user.user_id,
            id: user.user_id,
            email: user.email,
            full_name: user.full_name,
            name: user.full_name,
            role: user.role,
            user_code: user.user_code
        };

        res.status(200).json({
            success: true,
            message: 'Login successful',
            token,
            user: responseUser
        });

        logActivity(user.user_id, 'login', `User ${user.email} logged in`, req.ip);
    } catch (error) {
        console.error('[login] ERROR:', error.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

module.exports = { register, verifyOtp, login };