// server/middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const auth = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '') || req.query.token;
        if (!token) {
            return res.status(401).json({ success: false, message: 'Access denied. No token.' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.userId).populate('mentorships');

        if (!user) {
            return res.status(401).json({ success: false, message: 'User not found.' });
        }

        if (user.isBlocked) {
            return res.status(403).json({
                success: false,
                message: `Account blocked: ${user.blockReason || 'Contact admin.'}`,
                blocked: true
            });
        }

        if (!user.isActive) {
            return res.status(403).json({
                success: false,
                message: 'Account deactivated. Contact admin.',
                blocked: true
            });
        }

        req.user = user;
        req.userId = user._id;
        next();
    } catch (error) {
        res.status(401).json({ success: false, message: 'Invalid token.' });
    }
};

const adminAuth = async (req, res, next) => {
    await auth(req, res, () => {
        if (req.user && req.user.role === 'admin') {
            next();
        } else {
            res.status(403).json({ success: false, message: 'Admin access required.' });
        }
    });
};

module.exports = { auth, adminAuth };