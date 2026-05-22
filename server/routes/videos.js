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
    return [
        'sxs-lsnr.online',
        'www.sxs-lsnr.online',
        'localhost',
        '127.0.0.1'
    ];
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
        res.json({
            success: true,
            video: {
                id: video._id,
                title: video.title,
                description: video.description,
                mentorship: video.mentorship ? video.mentorship.name : '',
                viewCount: video.viewCount,
                createdAt: video.createdAt
                // ✅ NO videoUrl sent to client
            },
            sessionToken,
            watermark: {
                name: req.user.name,
                email: req.user.email,
                phone: req.user.phone || '',
                id: req.user._id.toString().slice(-6).toUpperCase()
            }
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

        // ── BLOCK DIRECT ACCESS - Must come from our website ──
        const referer = req.headers.referer || '';
        const allowedHosts = getAllowedHosts();
        const isFromOurSite = allowedHosts.some(host => referer.includes(host));

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
            -moz-user-select:none;
            -ms-user-select:none;
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

        /* ===== WATERMARKS INSIDE IFRAME ===== */
        .iwm-layer {
            position:absolute;
            top:0; left:0;
            width:100%; height:100%;
            pointer-events:none;
            z-index:10;
            overflow:hidden;
        }
        .iwm-text {
            position:absolute;
            white-space:nowrap;
            pointer-events:none;
            user-select:none;
            font-family:'Courier New',monospace;
            font-weight:800;
            letter-spacing:1px;
            text-shadow: 0 0 3px rgba(0,0,0,0.8), 0 0 6px rgba(0,0,0,0.5);
        }
        .iwm-1 {
            color:rgba(255,255,255,0.18);
            font-size:clamp(12px,2vw,20px);
            animation: iwmSlide1 25s linear infinite;
        }
        .iwm-2 {
            color:rgba(255,255,255,0.15);
            font-size:clamp(11px,1.6vw,18px);
            animation: iwmSlide2 32s linear infinite;
        }
        .iwm-3 {
            color:rgba(255,255,255,0.20);
            font-size:clamp(13px,2.2vw,22px);
            animation: iwmSlide3 20s linear infinite;
        }
        .iwm-4 {
            color:rgba(255,255,255,0.14);
            font-size:clamp(10px,1.4vw,16px);
            animation: iwmSlide4 28s linear infinite;
        }
        .iwm-5 {
            color:rgba(255,255,255,0.16);
            font-size:clamp(11px,1.8vw,19px);
            animation: iwmSlide5 35s linear infinite;
        }
        .iwm-6 {
            color:rgba(255,255,255,0.13);
            font-size:clamp(10px,1.5vw,17px);
            animation: iwmSlide6 22s linear infinite;
        }

        @keyframes iwmSlide1 {
            0% { top:10%; left:-50%; transform:rotate(-12deg); }
            50% { top:60%; left:110%; transform:rotate(-12deg); }
            100% { top:10%; left:-50%; transform:rotate(-12deg); }
        }
        @keyframes iwmSlide2 {
            0% { top:70%; left:120%; transform:rotate(8deg); }
            50% { top:20%; left:-60%; transform:rotate(8deg); }
            100% { top:70%; left:120%; transform:rotate(8deg); }
        }
        @keyframes iwmSlide3 {
            0% { top:40%; left:-40%; transform:rotate(-5deg); }
            33% { top:70%; left:40%; transform:rotate(3deg); }
            66% { top:25%; left:80%; transform:rotate(-8deg); }
            100% { top:40%; left:-40%; transform:rotate(-5deg); }
        }
        @keyframes iwmSlide4 {
            0% { top:80%; left:-30%; transform:rotate(15deg); }
            50% { top:10%; left:100%; transform:rotate(15deg); }
            100% { top:80%; left:-30%; transform:rotate(15deg); }
        }
        @keyframes iwmSlide5 {
            0% { top:50%; left:50%; transform:translate(-50%,-50%) rotate(0deg); }
            25% { top:15%; left:80%; }
            50% { top:75%; left:20%; transform:translate(-50%,-50%) rotate(10deg); }
            75% { top:30%; left:65%; }
            100% { top:50%; left:50%; transform:translate(-50%,-50%) rotate(0deg); }
        }
        @keyframes iwmSlide6 {
            0% { top:45%; left:110%; transform:rotate(-20deg); }
            50% { top:55%; left:-50%; transform:rotate(-20deg); }
            100% { top:45%; left:110%; transform:rotate(-20deg); }
        }

        .iwm-center {
            position:absolute;
            top:50%; left:50%;
            transform:translate(-50%,-50%);
            color:rgba(255,255,255,0.12);
            font-size:clamp(14px,2.5vw,28px);
            font-family:'Courier New',monospace;
            font-weight:800;
            pointer-events:none;
            user-select:none;
            z-index:11;
            white-space:nowrap;
            text-shadow: 0 0 5px rgba(0,0,0,0.7);
            animation: iwmPulse 8s ease-in-out infinite;
        }
        @keyframes iwmPulse {
            0%,100% { opacity:0.08; transform:translate(-50%,-50%) scale(1); }
            50% { opacity:0.16; transform:translate(-50%,-50%) scale(1.05); }
        }

        .iwm-corner {
            position:absolute;
            color:rgba(255,255,255,0.25);
            font-size:clamp(8px,1vw,12px);
            font-family:'Courier New',monospace;
            font-weight:700;
            pointer-events:none;
            user-select:none;
            z-index:12;
            background:rgba(0,0,0,0.5);
            padding:3px 8px;
            border-radius:4px;
            white-space:nowrap;
            text-shadow: 0 0 3px rgba(0,0,0,0.9);
        }
        .iwm-tl { top:8px; left:8px; }
        .iwm-tr { top:8px; right:8px; }
        .iwm-bl { bottom:8px; left:8px; }
        .iwm-br { bottom:8px; right:8px; }

        .iwm-grid {
            position:absolute;
            top:-50%; left:-50%;
            width:300%; height:300%;
            display:flex;
            flex-wrap:wrap;
            gap:55px 70px;
            transform:rotate(-25deg);
            pointer-events:none;
            z-index:9;
        }
        .iwm-grid-item {
            color:rgba(255,255,255,0.035);
            font-size:clamp(10px,1.2vw,13px);
            font-family:'Courier New',monospace;
            font-weight:700;
            white-space:nowrap;
            user-select:none;
            text-shadow: 0 0 2px rgba(0,0,0,0.5);
        }

        .iwm-random {
            position:absolute;
            color:rgba(255,255,255,0.14);
            font-size:clamp(10px,1.5vw,16px);
            font-family:'Courier New',monospace;
            font-weight:800;
            white-space:nowrap;
            pointer-events:none;
            user-select:none;
            z-index:13;
            text-shadow: 0 0 4px rgba(0,0,0,0.7);
            transition: all 3s ease;
        }

        /* Block Google Drive buttons */
        .gd-block-top {
            position:absolute;
            top:0; right:0;
            width:140px; height:55px;
            z-index:20;
            background:transparent;
        }
        .gd-block-bottom-right {
            position:absolute;
            bottom:0; right:0;
            width:70px; height:50px;
            z-index:20;
            background:transparent;
        }
        .gd-block-bottom-left {
            position:absolute;
            bottom:0; left:0;
            width:50px; height:50px;
            z-index:20;
            background:transparent;
        }

        /* Canvas watermark */
        .iwm-canvas {
            position:absolute;
            top:0; left:0;
            width:100%; height:100%;
            pointer-events:none;
            z-index:14;
        }
    </style>
</head>
<body oncontextmenu="return false" ondragstart="return false" onselectstart="return false">

    <!-- Video iframe -->
    <iframe class="video-frame" id="videoFrame"
        src="${embedUrl}"
        allow="autoplay; encrypted-media"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-forms"
        allowfullscreen="false"
        loading="lazy">
    </iframe>

    <!-- WATERMARK LAYERS INSIDE IFRAME PAGE -->
    <!-- Layer 1: 6 Moving watermarks -->
    <div class="iwm-layer">
        <div class="iwm-text iwm-1">${safeWmFull}</div>
        <div class="iwm-text iwm-2">${safeWmShort}</div>
        <div class="iwm-text iwm-3">${safeWmFull}</div>
        <div class="iwm-text iwm-4">${safeWmShort}</div>
        <div class="iwm-text iwm-5">${safeWmFull}</div>
        <div class="iwm-text iwm-6">${safeWmShort}</div>
    </div>

    <!-- Layer 2: Center pulsing -->
    <div class="iwm-center">${safeWmFull}</div>

    <!-- Layer 3: Corner stamps -->
    <div class="iwm-corner iwm-tl">${safeWmShort}</div>
    <div class="iwm-corner iwm-tr">ID: ${safeWmId}</div>
    <div class="iwm-corner iwm-bl">${safeWmEmail}</div>
    <div class="iwm-corner iwm-br" id="iwmTime"></div>

    <!-- Layer 4: Grid watermark -->
    <div class="iwm-grid" id="iwmGrid"></div>

    <!-- Layer 5: Canvas watermark (rendered by JS) -->
    <canvas class="iwm-canvas" id="iwmCanvas"></canvas>

    <!-- Block Google Drive buttons -->
    <div class="gd-block-top"></div>
    <div class="gd-block-bottom-right"></div>
    <div class="gd-block-bottom-left"></div>

    <script>
        // ── Timestamp update ──
        function updateTime() {
            var el = document.getElementById('iwmTime');
            if (el) el.textContent = new Date().toLocaleString();
        }
        updateTime();
        setInterval(updateTime, 1000);

        // ── Build grid watermark ──
        var grid = document.getElementById('iwmGrid');
        if (grid) {
            for (var i = 0; i < 80; i++) {
                var item = document.createElement('div');
                item.className = 'iwm-grid-item';
                item.textContent = i % 2 === 0 ? '${safeWmFull.replace(/'/g, "\\'")}' : '${safeWmShort.replace(/'/g, "\\'")}';
                grid.appendChild(item);
            }
        }

        // ── Canvas watermark ──
        function drawCanvas() {
            var canvas = document.getElementById('iwmCanvas');
            if (!canvas) return;
            canvas.width = window.innerWidth * 2;
            canvas.height = window.innerHeight * 2;
            var ctx = canvas.getContext('2d');

            // Visible layer
            ctx.font = 'bold 14px Courier New';
            ctx.fillStyle = 'rgba(255,255,255,0.05)';
            for (var y = 30; y < canvas.height; y += 75) {
                for (var x = 0; x < canvas.width; x += 380) {
                    ctx.save();
                    ctx.translate(x, y);
                    ctx.rotate(-0.35);
                    ctx.fillText('${safeWmShort.replace(/'/g, "\\'")}', 0, 0);
                    ctx.restore();
                }
            }

            // Forensic layer
            ctx.font = 'bold 9px Courier New';
            ctx.fillStyle = 'rgba(255,255,255,0.012)';
            for (var y2 = 50; y2 < canvas.height; y2 += 50) {
                for (var x2 = 60; x2 < canvas.width; x2 += 280) {
                    ctx.save();
                    ctx.translate(x2, y2);
                    ctx.rotate(0.2);
                    ctx.fillText('${safeWmEmail.replace(/'/g, "\\'")}|${safeWmId}|' + Date.now(), 0, 0);
                    ctx.restore();
                }
            }
        }
        drawCanvas();
        setInterval(drawCanvas, 30000);
        window.addEventListener('resize', drawCanvas);

        // ── Random watermarks ──
        function spawnRandom() {
            var existing = document.querySelectorAll('.iwm-random');
            if (existing.length > 8) existing[0].remove();
            var el = document.createElement('div');
            el.className = 'iwm-random';
            el.textContent = Math.random() > 0.5 ? '${safeWmShort.replace(/'/g, "\\'")}' : '${safeWmFull.replace(/'/g, "\\'")}';
            el.style.top = (Math.random() * 70 + 5) + '%';
            el.style.left = (Math.random() * 55 + 10) + '%';
            el.style.transform = 'rotate(' + (Math.random() * 30 - 15) + 'deg)';
            document.body.appendChild(el);
            setTimeout(function() {
                el.style.top = (Math.random() * 70 + 5) + '%';
                el.style.left = (Math.random() * 55 + 10) + '%';
            }, 200);
        }
        for (var r = 0; r < 4; r++) spawnRandom();
        setInterval(spawnRandom, 6000);

        // ── Security: Block all dangerous actions ──
        document.addEventListener('contextmenu', function(e) { e.preventDefault(); return false; });
        document.addEventListener('keydown', function(e) {
            if (e.ctrlKey || e.metaKey || e.key === 'F12' || e.key === 'PrintScreen') {
                e.preventDefault();
                return false;
            }
        });
        document.addEventListener('dragstart', function(e) { e.preventDefault(); });
        document.addEventListener('selectstart', function(e) { e.preventDefault(); });
        document.addEventListener('copy', function(e) { e.preventDefault(); });

        // ── Block parent frame access ──
        try {
            Object.defineProperty(window, 'parent', { get: function() { return window; } });
            Object.defineProperty(window, 'top', { get: function() { return window; } });
        } catch(e) {}

        // ── Block if opened directly (not in iframe) ──
        if (window === window.top) {
            document.body.innerHTML = '<div style="background:#0a0a1a;color:#ff4757;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;"><div><h1 style="font-size:4rem;">🚫</h1><h2>Direct Access Blocked</h2><p style="color:#888;margin-top:10px;">Videos can only be watched from the platform.</p><p style="color:#ff6b6b;margin-top:15px;font-size:0.85rem;">This attempt has been logged.</p></div></div>';
        }

        // ── Disable console ──
        try {
            var noop = function(){};
            ['log','debug','info','warn','error','table','trace','dir'].forEach(function(m) {
                console[m] = noop;
            });
        } catch(e) {}

        // ── Integrity check ──
        setInterval(function() {
            var layers = document.querySelectorAll('.iwm-layer, .iwm-center, .iwm-corner, .iwm-grid, .iwm-canvas');
            if (layers.length < 5) {
                document.body.innerHTML = '<div style="background:#0a0a1a;color:#ff4757;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;"><div><h1 style="font-size:4rem;">🚨</h1><h2>Tampering Detected</h2><p style="color:#888;margin-top:10px;">Watermark removal detected. Session terminated.</p></div></div>';
            }
        }, 3000);
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
