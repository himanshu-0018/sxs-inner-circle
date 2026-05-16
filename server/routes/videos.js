// server/routes/videos.js
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Video = require('../models/Video');
const User = require('../models/User');
const Mentorship = require('../models/Mentorship');
const { auth } = require('../middleware/auth');
const router = express.Router();

// Store temporary secure tokens (expire in 30 seconds)
const secureTokens = new Map();

// Cleanup expired tokens every 60 seconds
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of secureTokens.entries()) {
        if (now > value.expires) secureTokens.delete(key);
    }
}, 60000);

// Get user's mentorships
router.get('/my-mentorships', auth, async (req, res) => {
    try {
        const mentorships = await Mentorship.find({
            _id: { $in: req.user.mentorships },
            isActive: true
        }).sort({ order: 1 });

        const mentorshipsWithCount = await Promise.all(
            mentorships.map(async (m) => {
                const videoCount = await Video.countDocuments({ mentorship: m._id, isActive: true });
                return { ...m.toObject(), videoCount };
            })
        );
        res.json({ success: true, mentorships: mentorshipsWithCount });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching mentorships.' });
    }
});

// Get videos for a mentorship
router.get('/mentorship/:mentorshipId', auth, async (req, res) => {
    try {
        const userMentorshipIds = req.user.mentorships.map(m => m._id.toString());
        if (!userMentorshipIds.includes(req.params.mentorshipId) && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'No access to this mentorship.' });
        }

        const videos = await Video.find({
            mentorship: req.params.mentorshipId,
            isActive: true
        }).select('-videoUrl -cloudinaryId').sort({ order: 1, createdAt: -1 });

        res.json({ success: true, videos });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching videos.' });
    }
});

// Get video details + generate secure one-time stream token
router.get('/watch/:id', auth, async (req, res) => {
    try {
        const video = await Video.findById(req.params.id).populate('mentorship');
        if (!video || !video.isActive) {
            return res.status(404).json({ success: false, message: 'Video not found.' });
        }

        const userMentorshipIds = req.user.mentorships.map(m => m._id.toString());
        if (!userMentorshipIds.includes(video.mentorship._id.toString()) && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'No access.' });
        }

        video.viewCount += 1;
        await video.save();

        // Generate a secure one-time token for streaming
        const streamToken = crypto.randomBytes(32).toString('hex');
        secureTokens.set(streamToken, {
            videoId: video._id.toString(),
            userId: req.user._id.toString(),
            videoUrl: video.videoUrl,
            expires: Date.now() + 30000, // 30 second expiry
            used: false
        });

        res.json({
            success: true,
            video: {
                id: video._id,
                title: video.title,
                description: video.description,
                mentorship: video.mentorship.name,
                viewCount: video.viewCount,
                createdAt: video.createdAt
            },
            streamToken,
            watermark: {
                name: req.user.name,
                email: req.user.email,
                phone: req.user.phone || '',
                id: req.user._id.toString().slice(-6).toUpperCase()
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error loading video.' });
    }
});

// Refresh stream token (called by player every 25 seconds)
router.post('/refresh-token', auth, async (req, res) => {
    try {
        const { videoId } = req.body;
        const video = await Video.findById(videoId);
        if (!video) return res.status(404).json({ success: false });

        const streamToken = crypto.randomBytes(32).toString('hex');
        secureTokens.set(streamToken, {
            videoId: video._id.toString(),
            userId: req.user._id.toString(),
            videoUrl: video.videoUrl,
            expires: Date.now() + 30000,
            used: false
        });

        res.json({ success: true, streamToken });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Secure video proxy stream - fetches video server-side so URL is never exposed
router.get('/secure-stream/:streamToken', async (req, res) => {
    try {
        const tokenData = secureTokens.get(req.params.streamToken);

        if (!tokenData) {
            return res.status(403).json({ success: false, message: 'Invalid or expired stream token.' });
        }

        if (Date.now() > tokenData.expires) {
            secureTokens.delete(req.params.streamToken);
            return res.status(403).json({ success: false, message: 'Stream token expired.' });
        }

        // Verify the user still exists and is not blocked
        const user = await User.findById(tokenData.userId);
        if (!user || user.isBlocked || !user.isActive) {
            secureTokens.delete(req.params.streamToken);
            return res.status(403).json({ success: false, message: 'Access denied.' });
        }

        const videoUrl = tokenData.videoUrl;

        // Check referer - must come from our own site
        const referer = req.headers.referer || '';
        const host = req.headers.host || '';
        if (referer && !referer.includes(host)) {
            return res.status(403).json({ success: false, message: 'Access denied.' });
        }

        // Proxy the video stream from the actual URL
        const https = videoUrl.startsWith('https') ? require('https') : require('http');

        const range = req.headers.range;
        const proxyHeaders = {
            'User-Agent': 'SxS-Inner-Circle-Server/2.0'
        };
        if (range) proxyHeaders['Range'] = range;

        const proxyReq = https.get(videoUrl, { headers: proxyHeaders }, (proxyRes) => {
            // Security headers - prevent download
            const responseHeaders = {
                'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
                'Accept-Ranges': 'bytes',
                'Content-Disposition': 'inline', // Force inline, never attachment
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
                'Pragma': 'no-cache',
                'Expires': '0',
                'X-Frame-Options': 'DENY',
                'X-Robots-Tag': 'noindex, nofollow',
                'Cross-Origin-Resource-Policy': 'same-origin',
                'Cross-Origin-Opener-Policy': 'same-origin',
            };

            if (proxyRes.headers['content-length']) {
                responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
            }
            if (proxyRes.headers['content-range']) {
                responseHeaders['Content-Range'] = proxyRes.headers['content-range'];
            }

            res.writeHead(proxyRes.statusCode, responseHeaders);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            console.error('Proxy stream error:', err);
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: 'Stream error.' });
            }
        });

        req.on('close', () => {
            proxyReq.destroy();
        });

    } catch (error) {
        console.error('Secure stream error:', error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Stream error.' });
        }
    }
});

module.exports = router;