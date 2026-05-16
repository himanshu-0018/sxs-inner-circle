// server/routes/admin.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Video = require('../models/Video');
const AccessKey = require('../models/AccessKey');
const Mentorship = require('../models/Mentorship');
const { adminAuth } = require('../middleware/auth');
const router = express.Router();

// ========== MENTORSHIP MANAGEMENT ==========
router.post('/mentorships', adminAuth, async (req, res) => {
    try {
        const { name, description, icon, color } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'Name required.' });

        const mentorship = new Mentorship({
            name, description: description || '', icon: icon || '🎓', color: color || '#6c5ce7'
        });
        await mentorship.save();
        res.json({ success: true, message: 'Mentorship created!', mentorship });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ success: false, message: 'Mentorship name already exists.' });
        }
        res.status(500).json({ success: false, message: 'Error creating mentorship.' });
    }
});

router.get('/mentorships', adminAuth, async (req, res) => {
    try {
        const mentorships = await Mentorship.find().sort({ order: 1, createdAt: -1 });
        const result = await Promise.all(mentorships.map(async (m) => {
            const videoCount = await Video.countDocuments({ mentorship: m._id });
            const studentCount = await User.countDocuments({ mentorships: m._id, role: 'student' });
            return { ...m.toObject(), videoCount, studentCount };
        }));
        res.json({ success: true, mentorships: result });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

router.put('/mentorships/:id', adminAuth, async (req, res) => {
    try {
        const { name, description, icon, color, isActive, order } = req.body;
        const mentorship = await Mentorship.findByIdAndUpdate(req.params.id, {
            name, description, icon, color, isActive, order
        }, { new: true });
        res.json({ success: true, message: 'Updated!', mentorship });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating.' });
    }
});

router.delete('/mentorships/:id', adminAuth, async (req, res) => {
    try {
        await Video.deleteMany({ mentorship: req.params.id });
        await Mentorship.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Mentorship and its videos deleted.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting.' });
    }
});

// ========== VIDEO MANAGEMENT ==========
router.post('/videos', adminAuth, async (req, res) => {
    try {
        const { title, description, mentorship, videoUrl, order } = req.body;
        if (!title || !mentorship || !videoUrl) {
            return res.status(400).json({ success: false, message: 'Title, mentorship and video URL required.' });
        }

        const video = new Video({
            title, description: description || '', mentorship, videoUrl, order: order || 0
        });
        await video.save();
        res.json({ success: true, message: 'Video added!', video });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error adding video.' });
    }
});

router.get('/videos', adminAuth, async (req, res) => {
    try {
        const videos = await Video.find().populate('mentorship', 'name icon').sort({ createdAt: -1 });
        res.json({ success: true, videos });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

router.put('/videos/:id', adminAuth, async (req, res) => {
    try {
        const video = await Video.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, message: 'Updated!', video });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

router.delete('/videos/:id', adminAuth, async (req, res) => {
    try {
        await Video.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Video deleted.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

router.patch('/videos/:id/toggle', adminAuth, async (req, res) => {
    try {
        const video = await Video.findById(req.params.id);
        video.isActive = !video.isActive;
        await video.save();
        res.json({ success: true, message: `Video ${video.isActive ? 'activated' : 'hidden'}.` });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

// ========== KEY MANAGEMENT ==========
router.post('/keys/generate', adminAuth, async (req, res) => {
    try {
        const { count = 1, expiresInDays = 30, note = '', mentorships = [] } = req.body;
        const keys = [];

        for (let i = 0; i < Math.min(count, 100); i++) {
            const key = `SXS-${uuidv4().split('-').slice(0, 3).join('-').toUpperCase()}`;
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + expiresInDays);

            const accessKey = new AccessKey({ key, expiresAt, note, mentorships });
            await accessKey.save();
            keys.push({ key, expiresAt });
        }

        res.json({ success: true, message: `${keys.length} key(s) generated.`, keys });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error generating keys.' });
    }
});

router.get('/keys', adminAuth, async (req, res) => {
    try {
        const keys = await AccessKey.find()
            .populate('usedBy', 'name email')
            .populate('mentorships', 'name icon')
            .sort({ createdAt: -1 });
        res.json({ success: true, keys });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

router.delete('/keys/:id', adminAuth, async (req, res) => {
    try {
        await AccessKey.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Key deleted.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

// ========== USER MANAGEMENT ==========
router.get('/users', adminAuth, async (req, res) => {
    try {
        const users = await User.find({ role: 'student' })
            .populate('mentorships', 'name icon')
            .select('-password')
            .sort({ createdAt: -1 });
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

router.patch('/users/:id/toggle', adminAuth, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        user.isActive = !user.isActive;
        if (user.isActive) {
            user.isBlocked = false;
            user.blockReason = '';
        }
        await user.save();
        res.json({ success: true, message: `User ${user.isActive ? 'activated' : 'deactivated'}.` });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

router.patch('/users/:id/unblock', adminAuth, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        user.isBlocked = false;
        user.blockReason = '';
        user.uniqueIPs = [];
        user.isActive = true;
        await user.save();
        res.json({ success: true, message: 'User unblocked and IP history cleared.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

router.patch('/users/:id/mentorships', adminAuth, async (req, res) => {
    try {
        const { mentorships } = req.body;
        const user = await User.findByIdAndUpdate(req.params.id, { mentorships }, { new: true }).populate('mentorships');
        res.json({ success: true, message: 'Mentorships updated.', user });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

router.delete('/users/:id', adminAuth, async (req, res) => {
    try {
        await User.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'User deleted.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

// ========== STATS ==========
router.get('/stats', adminAuth, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments({ role: 'student' });
        const activeUsers = await User.countDocuments({ role: 'student', isActive: true, isBlocked: false });
        const blockedUsers = await User.countDocuments({ role: 'student', isBlocked: true });
        const totalVideos = await Video.countDocuments();
        const totalMentorships = await Mentorship.countDocuments();
        const unusedKeys = await AccessKey.countDocuments({ isUsed: false });
        const usedKeys = await AccessKey.countDocuments({ isUsed: true });
        const totalViews = await Video.aggregate([{ $group: { _id: null, total: { $sum: '$viewCount' } } }]);

        res.json({
            success: true,
            stats: {
                totalUsers, activeUsers, blockedUsers,
                totalVideos, totalMentorships,
                unusedKeys, usedKeys,
                totalViews: totalViews[0]?.total || 0
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

module.exports = router;