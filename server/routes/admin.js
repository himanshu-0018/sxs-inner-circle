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

// ✅ Single clean POST /videos route (removed duplicate)
router.post('/videos', adminAuth, async (req, res) => {
    try {
        const { title, description, mentorship, videoUrl, order } = req.body;

        console.log('Adding video:', { title, mentorship, videoUrl });

        if (!title) return res.status(400).json({ success: false, message: 'Title required.' });
        if (!mentorship) return res.status(400).json({ success: false, message: 'Program required.' });
        if (!videoUrl) return res.status(400).json({ success: false, message: 'URL required.' });

        const video = new Video({
            title: title.trim(),
            description: description || '',
            mentorship,
            videoUrl: videoUrl.trim(),
            order: parseInt(order) || 0,
            hlsStatus: 'pending'
        });

        await video.save();
        console.log('✅ Video saved:', video._id);

        // Trigger HLS conversion in background
        const { convertToHLS, ffmpegAvailable } = require('../hlsConverter');
        if (ffmpegAvailable) {
            console.log('🎬 Starting background HLS conversion...');
            convertToHLS(video, Video); // Non-blocking
        }

        res.json({
            success: true,
            message: 'Video added! HLS conversion started in background.',
            video: { id: video._id, title: video.title }
        });

    } catch (error) {
        console.error('Add video error:', error);
        res.status(500).json({ success: false, message: 'Error: ' + error.message });
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
        if (!video) return res.status(404).json({ success: false, message: 'Video not found.' });
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
        const { count = 1, expiresInDays = 30, note = '' } = req.body;
        let { mentorships = [] } = req.body;

        if (!Array.isArray(mentorships)) mentorships = [];
        mentorships = mentorships.filter(m => m && m.trim() !== '');

        if (mentorships.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Please select at least one mentorship program for the key.'
            });
        }

        console.log(`🔑 Generating ${count} key(s) for mentorships:`, mentorships);

        const keys = [];
        for (let i = 0; i < Math.min(count, 100); i++) {
            const key = `SXS-${uuidv4().split('-').slice(0, 3).join('-').toUpperCase()}`;
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + expiresInDays);

            const accessKey = new AccessKey({ key, expiresAt, note, mentorships });
            await accessKey.save();
            keys.push({ key, expiresAt });
        }

        res.json({
            success: true,
            message: `${keys.length} key(s) generated for ${mentorships.length} program(s).`,
            keys
        });
    } catch (error) {
        console.error('Key generation error:', error);
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
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
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
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
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
        const user = await User.findByIdAndUpdate(
            req.params.id,
            { mentorships },
            { new: true }
        ).populate('mentorships');
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
        const totalViews = await Video.aggregate([
            { $group: { _id: null, total: { $sum: '$viewCount' } } }
        ]);

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

// ========== HLS CONVERSION ==========

// GET /api/admin/conversion-stats
router.get('/conversion-stats', adminAuth, async (req, res) => {
    try {
        const total = await Video.countDocuments({ isActive: true });
        const ready = await Video.countDocuments({ hlsStatus: 'ready', isActive: true });
        const pending = await Video.countDocuments({ hlsStatus: 'pending', isActive: true });
        const converting = await Video.countDocuments({
            hlsStatus: { $in: ['downloading', 'converting'] },
            isActive: true
        });
        const failed = await Video.countDocuments({ hlsStatus: 'failed', isActive: true });

        const videos = await Video.find({ isActive: true })
            .select('title hlsStatus hlsProgress hlsError hlsConvertedAt duration')
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            stats: {
                total,
                ready,
                pending,
                converting,
                failed,
                percentage: total > 0 ? Math.round((ready / total) * 100) : 0
            },
            videos
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error loading conversion stats.' });
    }
});

// ✅ POST /api/admin/convert-retry/:id  ← THE MISSING ROUTE
router.post('/convert-retry/:id', adminAuth, async (req, res) => {
    try {
        const { convertToHLS, ffmpegAvailable } = require('../hlsConverter');

        if (!ffmpegAvailable) {
            return res.status(400).json({
                success: false,
                message: 'FFmpeg not available on this server.'
            });
        }

        const video = await Video.findById(req.params.id);
        if (!video) {
            return res.status(404).json({
                success: false,
                message: 'Video not found.'
            });
        }

        // Only retry if failed or pending
        if (video.hlsStatus === 'converting' || video.hlsStatus === 'downloading') {
            return res.status(400).json({
                success: false,
                message: 'Video is already being converted. Please wait.'
            });
        }

        console.log(`🔄 Retrying conversion for: ${video.title}`);

        // Reset status
        video.hlsStatus = 'pending';
        video.hlsProgress = 0;
        video.hlsError = null;
        await video.save();

        // Start conversion in background (non-blocking)
        convertToHLS(video, Video).catch(err => {
            console.error('Retry conversion failed:', err);
        });

        res.json({
            success: true,
            message: `🔄 Conversion restarted for "${video.title}". Check status in a moment.`
        });

    } catch (error) {
        console.error('Retry conversion error:', error);
        res.status(500).json({ success: false, message: 'Error retrying conversion.' });
    }
});

// POST /api/admin/convert-all
router.post('/convert-all', adminAuth, async (req, res) => {
    try {
        const { autoConvertPending, ffmpegAvailable } = require('../hlsConverter');

        if (!ffmpegAvailable) {
            return res.status(400).json({
                success: false,
                message: 'FFmpeg not available on this server.'
            });
        }

        // Count what needs converting
        const pendingCount = await Video.countDocuments({
            isActive: true,
            hlsStatus: { $in: ['pending', 'failed'] }
        });

        if (pendingCount === 0) {
            return res.json({
                success: true,
                message: '✅ No pending videos to convert!'
            });
        }

        // Run in background - don't await
        autoConvertPending(Video).catch(err => {
            console.error('Convert all error:', err);
        });

        res.json({
            success: true,
            message: `🔄 Started converting ${pendingCount} video(s). This may take a while.`
        });

    } catch (error) {
        console.error('Convert all error:', error);
        res.status(500).json({ success: false, message: 'Error starting conversion.' });
    }
});

module.exports = router;
