// server/routes/videos.js
const express = require('express');
const crypto = require('crypto');
const Video = require('../models/Video');
const User = require('../models/User');
const Mentorship = require('../models/Mentorship');
const { auth } = require('../middleware/auth');
const router = express.Router();

// In-memory secure session store
const videoSessions = new Map();

// Cleanup expired sessions every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of videoSessions.entries()) {
        if (now > value.expires) videoSessions.delete(key);
    }
}, 5 * 60 * 1000);

// Encrypt video URL
function encryptUrl(url) {
    const secret = process.env.JWT_SECRET || 'secret';
    const key = crypto.scryptSync(secret, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(url, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

// Decrypt video URL
function decryptUrl(encryptedData) {
    try {
        const secret = process.env.JWT_SECRET || 'secret';
        const key = crypto.scryptSync(secret, 'salt', 32);
        const [ivHex, encrypted] = encryptedData.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return null;
    }
}

// Extract Google Drive File ID
function getFileId(url) {
    const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    const match2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (match2) return match2[1];
    return null;
}

// Get user's mentorships
router.get('/my-mentorships', auth, async (req, res) => {
    try {
        const mentorships = await Mentorship.find({
            _id: { $in: req.user.mentorships },
            isActive: true
        }).sort({ order: 1 });

        const mentorshipsWithCount = await Promise.all(
            mentorships.map(async (m) => {
                const videoCount = await Video.countDocuments({
                    mentorship: m._id,
                    isActive: true
                });
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
        const userMentorshipIds = req.user.mentorships.map(m =>
            m._id ? m._id.toString() : m.toString()
        );

        if (!userMentorshipIds.includes(req.params.mentorshipId) && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
            return res.status(403).json({ success: false, message: 'No access to this mentorship.' });
        }

        // Never send videoUrl to client
        const videos = await Video.find({
            mentorship: req.params.mentorshipId,
            isActive: true
        }).select('-videoUrl -cloudinaryId').sort({ order: 1, createdAt: -1 });

        res.json({ success: true, videos });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching videos.' });
    }
});

// Get video watch details - Returns session token NOT the URL
router.get('/watch/:id', auth, async (req, res) => {
    try {
        const video = await Video.findById(req.params.id).populate('mentorship');

        if (!video || !video.isActive) {
            return res.status(404).json({ success: false, message: 'Video not found.' });
        }

        // Check mentorship access
        const userMentorshipIds = req.user.mentorships.map(m =>
            m._id ? m._id.toString() : m.toString()
        );

        const videoMentorshipId = video.mentorship._id
            ? video.mentorship._id.toString()
            : video.mentorship.toString();

        if (!userMentorshipIds.includes(videoMentorshipId) &&
            req.user.role !== 'admin' &&
            req.user.role !== 'superadmin') {
            return res.status(403).json({ success: false, message: 'No access to this video.' });
        }

        video.viewCount += 1;
        await video.save();

        // Create secure session token (NOT the URL)
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const encryptedUrl = encryptUrl(video.videoUrl);

        // Store session with 2 hour expiry
        videoSessions.set(sessionToken, {
            videoId: video._id.toString(),
            userId: req.user._id.toString(),
            encryptedUrl: encryptedUrl,
            expires: Date.now() + (2 * 60 * 60 * 1000),
            userAgent: req.headers['user-agent']
        });

        // Return session token - NOT the video URL
        res.json({
            success: true,
            video: {
                id: video._id,
                title: video.title,
                description: video.description,
                mentorship: video.mentorship.name,
                viewCount: video.viewCount,
                createdAt: video.createdAt
                // ✅ videoUrl is NOT sent to client
            },
            sessionToken, // Only send this token
            watermark: {
                name: req.user.name,
                email: req.user.email,
                phone: req.user.phone || '',
                id: req.user._id.toString().slice(-6).toUpperCase()
            }
        });

    } catch (error) {
        console.error('Watch error:', error);
        res.status(500).json({ success: false, message: 'Error loading video.' });
    }
});

// Secure video frame endpoint - serves iframe page with hidden URL
router.get('/secure-frame/:sessionToken', async (req, res) => {
    try {
        const session = videoSessions.get(req.params.sessionToken);

        // Validate session
        if (!session) {
            return res.status(403).send(`
                <html><body style="background:#000;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;">
                    <div>
                        <h2>⛔ Session Expired</h2>
                        <p>Please refresh the page to continue watching.</p>
                    </div>
                </body></html>
            `);
        }

        if (Date.now() > session.expires) {
            videoSessions.delete(req.params.sessionToken);
            return res.status(403).send(`
                <html><body style="background:#000;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;">
                    <div>
                        <h2>⏰ Session Expired</h2>
                        <p>Please refresh the page.</p>
                    </div>
                </body></html>
            `);
        }

        // Verify user
        const user = await User.findById(session.userId);
        if (!user || user.isBlocked || !user.isActive) {
            videoSessions.delete(req.params.sessionToken);
            return res.status(403).send(`
                <html><body style="background:#000;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;">
                    <div>
                        <h2>🚫 Access Denied</h2>
                        <p>Your account has been blocked.</p>
                    </div>
                </body></html>
            `);
        }

        // Decrypt URL on server side
        const videoUrl = decryptUrl(session.encryptedUrl);
        if (!videoUrl) {
            return res.status(500).send('Error loading video.');
        }

        // Get Google Drive file ID and build embed URL
        const fileId = getFileId(videoUrl);
        const embedUrl = fileId
            ? `https://drive.google.com/file/d/${fileId}/preview`
            : videoUrl;

        // Serve an HTML page with the iframe
        // The actual Google Drive URL is injected SERVER-SIDE
        // Client never sees it
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");

        res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        html, body { width:100%; height:100%; background:#000; overflow:hidden; }
        iframe {
            width:100%;
            height:100%;
            border:none;
            display:block;
        }
        /* Block right click */
        body { -webkit-user-select:none; user-select:none; }
    </style>
</head>
<body oncontextmenu="return false;">
    <iframe
        src="${embedUrl}"
        allow="autoplay; encrypted-media"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-forms"
        allowfullscreen="false">
    </iframe>
    <script>
        // Disable right click
        document.addEventListener('contextmenu', e => e.preventDefault());
        // Disable keyboard shortcuts
        document.addEventListener('keydown', e => {
            if (e.ctrlKey || e.metaKey || e.key === 'F12') e.preventDefault();
        });
        // Prevent parent access
        Object.defineProperty(window, 'parent', { get: () => window });
        Object.defineProperty(window, 'top', { get: () => window });
    </script>
</body>
</html>
        `);

    } catch (error) {
        console.error('Secure frame error:', error);
        res.status(500).send('Error loading video.');
    }
});

// Refresh session (called every 30 minutes to keep alive)
router.post('/refresh-session', auth, async (req, res) => {
    try {
        const { sessionToken, videoId } = req.body;
        const session = videoSessions.get(sessionToken);

        if (!session || session.userId !== req.user._id.toString()) {
            return res.status(403).json({ success: false, message: 'Invalid session.' });
        }

        // Extend session by 2 hours
        session.expires = Date.now() + (2 * 60 * 60 * 1000);
        videoSessions.set(sessionToken, session);

        res.json({ success: true, message: 'Session refreshed.' });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

module.exports = router;
