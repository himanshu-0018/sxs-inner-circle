// server/routes/auth.js
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AccessKey = require('../models/AccessKey');
const { auth } = require('../middleware/auth');
const router = express.Router();

const getClientIP = (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.headers['x-real-ip'] ||
        req.connection?.remoteAddress ||
        req.ip || 'unknown';
};

// Register student
router.post('/register', async (req, res) => {
    try {
        const { name, email, phone, password, accessKey } = req.body;
        if (!name || !email || !password || !accessKey) {
            return res.status(400).json({
                success: false,
                message: 'All fields are required including Access Key.'
            });
        }

        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'Email already registered.'
            });
        }

        const keyRecord = await AccessKey.findOne({ key: accessKey.trim() }).populate('mentorships');
        if (!keyRecord) {
            return res.status(400).json({
                success: false,
                message: 'Invalid access key.'
            });
        }
        if (keyRecord.isUsed) {
            return res.status(400).json({
                success: false,
                message: 'Access key already used.'
            });
        }
        if (new Date() > keyRecord.expiresAt) {
            return res.status(400).json({
                success: false,
                message: 'Access key expired.'
            });
        }

        const user = new User({
            name: name.trim(),
            email: email.toLowerCase().trim(),
            phone: phone || '',
            password,
            accessKey: accessKey.trim(),
            mentorships: keyRecord.mentorships.map(m => m._id)
        });

        const ip = getClientIP(req);
        user.trackIP(ip, req.headers['user-agent']);
        await user.save();

        keyRecord.isUsed = true;
        keyRecord.usedBy = user._id;
        keyRecord.usedAt = new Date();
        await keyRecord.save();

        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });

        res.status(201).json({
            success: true,
            message: 'Registration successful!',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                mentorships: keyRecord.mentorships
            }
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password required.'
            });
        }

        const user = await User.findOne({ email: email.toLowerCase() }).populate('mentorships');
        if (!user) {
            return res.status(400).json({
                success: false,
                message: 'Invalid credentials.'
            });
        }

        // Check if blocked (only for students)
        if (user.isBlocked && user.role === 'student') {
            return res.status(403).json({
                success: false,
                message: `Account BLOCKED: ${user.blockReason}`,
                blocked: true
            });
        }

        if (!user.isActive) {
            return res.status(403).json({
                success: false,
                message: 'Account deactivated by admin.',
                blocked: true
            });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(400).json({
                success: false,
                message: 'Invalid credentials.'
            });
        }

        const ip = getClientIP(req);
        user.trackIP(ip, req.headers['user-agent']);
        await user.save();

        // Recheck block after IP tracking
        if (user.isBlocked && user.role === 'student') {
            return res.status(403).json({
                success: false,
                message: `Account BLOCKED: ${user.blockReason}`,
                blocked: true
            });
        }

        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });

        res.json({
            success: true,
            message: 'Login successful!',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                mentorships: user.mentorships
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Get current user profile
router.get('/me', auth, async (req, res) => {
    try {
        const user = await User.findById(req.userId).populate('mentorships');
        res.json({
            success: true,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                role: user.role,
                mentorships: user.mentorships,
                createdAt: user.createdAt
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching profile.' });
    }
});

// Change own password
router.post('/change-password', auth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Current and new password are required.'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'New password must be at least 6 characters.'
            });
        }

        const user = await User.findById(req.userId);

        // Verify current password
        const isMatch = await user.comparePassword(currentPassword);
        if (!isMatch) {
            return res.status(400).json({
                success: false,
                message: 'Current password is incorrect.'
            });
        }

        // Update password
        user.password = newPassword;
        await user.save();

        console.log(`🔑 Password changed: ${user.email}`);

        res.json({
            success: true,
            message: 'Password changed successfully!'
        });

    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error.'
        });
    }
});

// Report suspicious activity - auto ban student
router.post('/report-violation', auth, async (req, res) => {
    try {
        const { reason } = req.body;
        const user = await User.findById(req.userId);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        // Don't ban admins - only log
        if (user.role === 'admin' || user.role === 'superadmin') {
            console.log(`⚠️ Admin violation (NOT banned): ${user.email} | Reason: ${reason}`);
            return res.json({
                success: true,
                banned: false,
                message: 'Logged for admin.'
            });
        }

        // Ban the student immediately
        user.isBlocked = true;
        user.isActive = false;
        user.blockReason = `Auto-banned: ${reason} | Time: ${new Date().toISOString()} | IP: ${getClientIP(req)}`;
        await user.save();

        console.log(`🚨 USER BANNED: ${user.name} (${user.email}) | Reason: ${reason} | IP: ${getClientIP(req)}`);

        res.json({
            success: true,
            banned: true,
            message: 'Account has been suspended due to policy violation.'
        });

    } catch (error) {
        console.error('Report violation error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
