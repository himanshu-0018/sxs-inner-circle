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
    if (!url) return null;
    const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    const match2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (match2) return match2[1];
    const match3 = url.match(/open\?id=([a-zA-Z0-9_-]+)/);
    if (match3) return match3[1];
    return null;
}

// Get allowed hosts for referer check
function getAllowedHosts() {
    const hosts = [
        'sxs-lsnr.online',
        'www.sxs-lsnr.online',
        'localhost',
        '127.0.0.1'
    ];

    // Also add Railway domain if exists
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
        hosts.push(process.env.RAILWAY_PUBLIC_DOMAIN);
    }

    return hosts;
}

// =============================================
// GET USER'S MENTORSHIPS
// =============================================
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

// =============================================
// GET VIDEOS FOR A MENTORSHIP
// =============================================
router.get('/mentorship/:mentorshipId', auth, async (req, res) => {
    try {
        const userMentorshipIds = req.user.mentorships.map(m =>
            m._id ? m._id.toString() : m.toString()
        );

        if (!userMentorshipIds.includes(req.params.mentorshipId) &&
            req.user.role !== 'admin' &&
            req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                message: 'No access to this mentorship.'
            });
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

// =============================================
// WATCH VIDEO - Returns session token NOT URL
// =============================================
router.get('/watch/:id', auth, async (req, res) => {
    try {
        const video = await Video.findById(req.params.id).populate('mentorship');

        if (!video || !video.isActive) {
            return res.status(404).json({
                success: false,
                message: 'Video not found.'
            });
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
            return res.status(403).json({
                success: false,
                message: 'You do not have access to this video.'
            });
        }

        // Increment view count
        video.viewCount += 1;
        await video.save();

        // Create secure encrypted session
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const encryptedUrl = encryptUrl(video.videoUrl);

        // Store session with 2 hour expiry
        videoSessions.set(sessionToken, {
            videoId: video._id.toString(),
            userId: req.user._id.toString(),
            encryptedUrl: encryptedUrl,
            expires: Date.now() + (2 * 60 * 60 * 1000),
            userAgent: req.headers['user-agent'],
            loaded: false,
            loadCount: 0
        });

        // Return session token - NEVER the video URL
// Check if watermarks are enabled
const watermarkEnabled = process.env.WATERMARK_ENABLED !== 'false';

res.json({
    success: true,
    video: {
        id: video._id,
        title: video.title,
        description: video.description,
        mentorship: video.mentorship ? video.mentorship.name : '',
        viewCount: video.viewCount,
        createdAt: video.createdAt
    },
    sessionToken,
    watermarkEnabled,
    watermark: watermarkEnabled ? {
        name: req.user.name,
        email: req.user.email,
        phone: req.user.phone || '',
        id: req.user._id.toString().slice(-6).toUpperCase()
    } : null
});

    } catch (error) {
        console.error('Watch error:', error);
        res.status(500).json({
            success: false,
            message: 'Error loading video.'
        });
    }
});

// =============================================
// SECURE FRAME - Serves video with watermarks
// ONLY works when embedded in our watch page
// =============================================
router.get('/secure-frame/:sessionToken', async (req, res) => {
    try {
        const session = videoSessions.get(req.params.sessionToken);

        // ── Validate session exists ──
        if (!session) {
            return res.status(403).send(`
                <html><body style="background:#0a0a1a;color:#ff4757;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;">
                    <div>
                        <h1 style="font-size:4rem;">⛔</h1>
                        <h2>Access Denied</h2>
                        <p style="color:#8888aa;margin-top:10px;">This link has expired or is invalid.</p>
                        <p style="color:#555;margin-top:15px;font-size:0.8rem;">Please go back to the platform and try again.</p>
                    </div>
                </body></html>
            `);
        }

        // ── Check expiry ──
        if (Date.now() > session.expires) {
            videoSessions.delete(req.params.sessionToken);
            return res.status(403).send(`
                <html><body style="background:#0a0a1a;color:#ffa502;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;">
                    <div>
                        <h1 style="font-size:4rem;">⏰</h1>
                        <h2>Session Expired</h2>
                        <p style="color:#8888aa;margin-top:10px;">Please go back and refresh the page.</p>
                    </div>
                </body></html>
            `);
        }

// BLOCK DIRECT ACCESS - Must come from our website
// But allow empty referer (some browsers don't send it)
const referer = req.headers.referer || '';
const origin = req.headers.origin || '';
const allowedHosts = getAllowedHosts();

// Allow if referer matches OR origin matches OR referer is empty (iframe load)
const isFromOurSite = referer === '' ||
    allowedHosts.some(host => referer.includes(host)) ||
    allowedHosts.some(host => origin.includes(host));

if (!isFromOurSite) {
            videoSessions.delete(req.params.sessionToken);
            console.log(`🚨 Direct access blocked: Session ${req.params.sessionToken.slice(0, 8)}... | Referer: ${referer || 'NONE'}`);
            return res.status(403).send(`
                <html><body style="background:#0a0a1a;color:#ff4757;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;">
                    <div>
                        <h1 style="font-size:4rem;">🚫</h1>
                        <h2>Direct Access Blocked</h2>
                        <p style="color:#8888aa;margin-top:10px;">Videos can only be watched from the platform.</p>
                        <p style="color:#ff6b6b;margin-top:15px;font-size:0.85rem;">This attempt has been logged.</p>
                    </div>
                </body></html>
            `);
        }

        // ── Check load count ──
        session.loadCount = (session.loadCount || 0) + 1;
        if (session.loadCount > 15) {
            videoSessions.delete(req.params.sessionToken);
            return res.status(403).send(`
                <html><body style="background:#0a0a1a;color:#ffa502;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;">
                    <div>
                        <h1 style="font-size:4rem;">⚠️</h1>
                        <h2>Too Many Requests</h2>
                        <p style="color:#8888aa;margin-top:10px;">Please refresh the watch page.</p>
                    </div>
                </body></html>
            `);
        }
        session.loaded = true;

        // ── Verify user is still active ──
        const user = await User.findById(session.userId);
        if (!user || user.isBlocked || !user.isActive) {
            videoSessions.delete(req.params.sessionToken);
            return res.status(403).send(`
                <html><body style="background:#0a0a1a;color:#ff4757;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;">
                    <div>
                        <h1 style="font-size:4rem;">🚫</h1>
                        <h2>Account Suspended</h2>
                        <p style="color:#8888aa;margin-top:10px;">Your account has been blocked. Contact admin.</p>
                    </div>
                </body></html>
            `);
        }

        // ── Decrypt URL server-side ──
        const videoUrl = decryptUrl(session.encryptedUrl);
        if (!videoUrl) {
            return res.status(500).send('Error loading video.');
        }

        // ── Build embed URL ──
        const fileId = getFileId(videoUrl);
        const embedUrl = fileId
            ? `https://drive.google.com/file/d/${fileId}/preview`
            : videoUrl;

        // ── Get watermark data ──
        // Check if watermarks are enabled via environment variable
const watermarkEnabled = process.env.WATERMARK_ENABLED !== 'false';
        const wmName = user.name || 'User';
        const wmEmail = user.email || '';
        const wmId = user._id.toString().slice(-6).toUpperCase();
        const wmFull = `${wmName}  •  ${wmEmail}  •  ID:${wmId}`;
        const wmShort = `${wmName}  |  ${wmEmail}`;

        // Escape for safe HTML injection
        const escapeHtml = (str) => {
            return str.replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        };

        const safeWmFull = escapeHtml(wmFull);
        const safeWmShort = escapeHtml(wmShort);
        const safeWmEmail = escapeHtml(wmEmail);
        const safeWmId = escapeHtml(wmId);

        // ── Security headers ──
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://sxs-lsnr.online https://www.sxs-lsnr.online");
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Referrer-Policy', 'no-referrer');

        // ── Serve protected HTML page ──
        res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        html, body {
            width:100%; height:100%;
            background:#000;
            overflow:hidden;
            -webkit-user-select:none;
            user-select:none;
            -webkit-touch-callout:none;
        }
        .video-frame {
            width:100%;
            height:100%;
            border:none;
            display:block;
            position:absolute;
            top:0; left:0;
            z-index:1;
        }
        .single-watermark {
            position:absolute;
            color:rgba(255,255,255,0.20);
            font-size:clamp(14px, 2.2vw, 22px);
            font-family:'Courier New', monospace;
            font-weight:800;
            white-space:nowrap;
            pointer-events:none;
            user-select:none;
            z-index:10;
            letter-spacing:1px;
            text-shadow:
                0 0 4px rgba(0,0,0,0.8),
                0 0 8px rgba(0,0,0,0.5);
            animation: singleMove 20s linear infinite;
        }
        @keyframes singleMove {
            0% { top:15%; left:-50%; }
            25% { top:45%; left:60%; }
            50% { top:75%; left:10%; }
            75% { top:30%; left:70%; }
            100% { top:15%; left:-50%; }
        }
        .gd-block-top {
            position:absolute;
            top:0; right:0;
            width:140px; height:55px;
            z-index:20;
            background:transparent;
        }
        .gd-block-bottom {
            position:absolute;
            bottom:0; right:0;
            width:70px; height:50px;
            z-index:20;
            background:transparent;
        }
    </style>
</head>
<body oncontextmenu="return false" ondragstart="return false" onselectstart="return false">
    <iframe class="video-frame"
        src="${embedUrl}"
        allow="autoplay; encrypted-media"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-forms"
        allowfullscreen="false">
    </iframe>

    <!-- Single clean watermark -->
    <div class="single-watermark">${safeWmShort}</div>

    <!-- Block Google Drive buttons -->
    <div class="gd-block-top"></div>
    <div class="gd-block-bottom"></div>

    <script>
        document.addEventListener('contextmenu', function(e) { e.preventDefault(); });
        document.addEventListener('keydown', function(e) {
            if (e.ctrlKey || e.metaKey || e.key === 'F12') { e.preventDefault(); return false; }
        });
        document.addEventListener('dragstart', function(e) { e.preventDefault(); });
        document.addEventListener('copy', function(e) { e.preventDefault(); });

        if (window === window.top) {
            document.body.innerHTML = '<div style="background:#0a0a1a;color:#ff4757;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;"><div><h1 style="font-size:4rem;">🚫</h1><h2>Direct Access Blocked</h2></div></div>';
        }
    </script>
</body>
</html>
        `);

    } catch (error) {
        console.error('Secure frame error:', error);
        res.status(500).send('Error loading video.');
    }
});

// =============================================
// REFRESH SESSION - Keep alive
// =============================================
router.post('/refresh-session', auth, async (req, res) => {
    try {
        const { sessionToken, videoId } = req.body;
        const session = videoSessions.get(sessionToken);

        if (!session || session.userId !== req.user._id.toString()) {
            return res.status(403).json({ success: false, message: 'Invalid session.' });
        }

        // Extend session by 2 hours
        session.expires = Date.now() + (2 * 60 * 60 * 1000);
        session.loadCount = 0; // Reset load count on refresh
        videoSessions.set(sessionToken, session);

        res.json({ success: true, message: 'Session refreshed.' });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

module.exports = router;
