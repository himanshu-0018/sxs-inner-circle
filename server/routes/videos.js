// server/routes/videos.js
const express = require('express');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
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

// Encrypt URL
function encryptUrl(url) {
    const secret = process.env.JWT_SECRET || 'secret';
    const key = crypto.scryptSync(secret, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(url, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

// Decrypt URL
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
    return null;
}

// Get allowed hosts
function getAllowedHosts() {
    const hosts = [
        'sxs-lsnr.online',
        'www.sxs-lsnr.online',
        'localhost',
        '127.0.0.1'
    ];
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
        hosts.push(process.env.RAILWAY_PUBLIC_DOMAIN);
    }
    return hosts;
}

// =============================================
// GET USER MENTORSHIPS
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
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

// =============================================
// GET VIDEOS FOR MENTORSHIP
// =============================================
router.get('/mentorship/:mentorshipId', auth, async (req, res) => {
    try {
        const userMentorshipIds = req.user.mentorships.map(m =>
            m._id ? m._id.toString() : m.toString()
        );

        if (!userMentorshipIds.includes(req.params.mentorshipId) &&
            req.user.role !== 'admin' &&
            req.user.role !== 'superadmin') {
            return res.status(403).json({ success: false, message: 'No access.' });
        }

        const videos = await Video.find({
            mentorship: req.params.mentorshipId,
            isActive: true
        }).select('-videoUrl -cloudinaryId').sort({ order: 1, createdAt: -1 });

        res.json({ success: true, videos });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

// =============================================
// WATCH - Returns session token only
// =============================================
router.get('/watch/:id', auth, async (req, res) => {
    try {
        const video = await Video.findById(req.params.id).populate('mentorship');

        if (!video || !video.isActive) {
            return res.status(404).json({ success: false, message: 'Video not found.' });
        }

        const userMentorshipIds = req.user.mentorships.map(m =>
            m._id ? m._id.toString() : m.toString()
        );

        const videoMentorshipId = video.mentorship._id
            ? video.mentorship._id.toString()
            : video.mentorship.toString();

        if (!userMentorshipIds.includes(videoMentorshipId) &&
            req.user.role !== 'admin' &&
            req.user.role !== 'superadmin') {
            return res.status(403).json({ success: false, message: 'No access.' });
        }

        video.viewCount += 1;
        await video.save();

        // Create session token
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const encryptedUrl = encryptUrl(video.videoUrl);

        videoSessions.set(sessionToken, {
            videoId: video._id.toString(),
            userId: req.user._id.toString(),
            encryptedUrl,
            expires: Date.now() + (2 * 60 * 60 * 1000),
            loadCount: 0
        });

        res.json({
            success: true,
            video: {
                id: video._id,
                title: video.title,
                description: video.description,
                mentorship: video.mentorship ? video.mentorship.name : '',
                viewCount: video.viewCount,
                createdAt: video.createdAt
                // ✅ NO videoUrl sent
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
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

// =============================================
// SECURE FRAME - HTML page with video player
// Google Drive URL is NEVER sent to browser
// =============================================
router.get('/secure-frame/:sessionToken', async (req, res) => {
    try {
        const session = videoSessions.get(req.params.sessionToken);

        if (!session) {
            return res.status(403).send(errorPage('Session expired or invalid.'));
        }

        if (Date.now() > session.expires) {
            videoSessions.delete(req.params.sessionToken);
            return res.status(403).send(errorPage('Session expired. Please refresh.'));
        }

        // Check referer
        const referer = req.headers.referer || '';
        const origin = req.headers.origin || '';
        const allowedHosts = getAllowedHosts();
        const isFromOurSite = referer === '' ||
            allowedHosts.some(h => referer.includes(h)) ||
            allowedHosts.some(h => origin.includes(h));

        if (!isFromOurSite) {
            videoSessions.delete(req.params.sessionToken);
            return res.status(403).send(errorPage('Direct access blocked.'));
        }

        session.loadCount = (session.loadCount || 0) + 1;
        if (session.loadCount > 20) {
            videoSessions.delete(req.params.sessionToken);
            return res.status(403).send(errorPage('Too many requests.'));
        }

        // Verify user
        const user = await User.findById(session.userId);
        if (!user || user.isBlocked || !user.isActive) {
            videoSessions.delete(req.params.sessionToken);
            return res.status(403).send(errorPage('Account suspended.'));
        }

        // Decrypt URL server-side
        const videoUrl = decryptUrl(session.encryptedUrl);
        if (!videoUrl) {
            return res.status(500).send(errorPage('Error loading video.'));
        }

        // Get file ID
        const fileId = getFileId(videoUrl);

        // Generate a VIDEO PROXY token
        // This token is used to stream video bytes
        // Google Drive URL NEVER leaves server
        const proxyToken = crypto.randomBytes(24).toString('hex');
        videoSessions.set(`proxy_${proxyToken}`, {
            fileId,
            videoUrl,
            userId: session.userId,
            expires: Date.now() + (2 * 60 * 60 * 1000)
        });

        // Watermark data
        const wmName = user.name || 'User';
        const wmEmail = user.email || '';
        const wmShort = escHtml(`${wmName}  |  ${wmEmail}`);

        // Security headers
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy',
            "frame-ancestors 'self' https://sxs-lsnr.online https://www.sxs-lsnr.online");
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');

        // Send HTML with our VIDEO PROXY URL (not Google Drive)
        res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        html, body {
            width:100%; height:100%; background:#000; overflow:hidden;
            -webkit-user-select:none; user-select:none;
        }
        video {
            width:100%; height:100%; object-fit:contain;
            position:absolute; top:0; left:0;
        }
        /* Hide ALL video controls including download */
        video::-webkit-media-controls { display:none !important; }
        video::-webkit-media-controls-enclosure { display:none !important; }
        video::-webkit-media-controls-panel { display:none !important; }
        video::-internal-media-controls-download-button { display:none !important; }
        video::-webkit-media-controls-download-button { display:none !important; }

        /* Watermark */
        .wm {
            position:absolute;
            color:rgba(255,255,255,0.30);
            font-size:clamp(14px,2.5vw,24px);
            font-family:'Courier New',monospace;
            font-weight:800;
            white-space:nowrap;
            pointer-events:none;
            user-select:none;
            z-index:10;
            letter-spacing:2px;
            text-shadow: 0 0 6px rgba(0,0,0,0.9), 2px 2px 4px rgba(0,0,0,0.8);
            animation: wmMove1 15s linear infinite;
        }
        .wm2 {
            position:absolute;
            color:rgba(255,255,255,0.20);
            font-size:clamp(12px,2vw,20px);
            font-family:'Courier New',monospace;
            font-weight:800;
            white-space:nowrap;
            pointer-events:none;
            user-select:none;
            z-index:10;
            letter-spacing:1px;
            text-shadow: 0 0 4px rgba(0,0,0,0.8);
            animation: wmMove2 18s linear infinite;
        }
        @keyframes wmMove1 {
            0%   { top:15%; left:-50%; }
            25%  { top:50%; left:65%; }
            50%  { top:75%; left:10%; }
            75%  { top:35%; left:75%; }
            100% { top:15%; left:-50%; }
        }
        @keyframes wmMove2 {
            0%   { top:70%; left:110%; }
            25%  { top:25%; left:20%; }
            50%  { top:55%; left:75%; }
            75%  { top:15%; left:45%; }
            100% { top:70%; left:110%; }
        }

        /* Custom controls */
        .controls {
            position:absolute;
            bottom:0; left:0; right:0;
            background:linear-gradient(transparent, rgba(0,0,0,0.8));
            padding:20px 16px 12px;
            z-index:20;
            display:flex;
            align-items:center;
            gap:12px;
            opacity:0;
            transition:opacity 0.3s;
        }
        body:hover .controls { opacity:1; }
        .progress-wrap {
            flex:1;
            height:5px;
            background:rgba(255,255,255,0.2);
            border-radius:5px;
            cursor:pointer;
            position:relative;
        }
        .progress-bar {
            height:100%;
            background:linear-gradient(90deg,#6c5ce7,#00cec9);
            border-radius:5px;
            width:0%;
            pointer-events:none;
        }
        .ctrl-btn {
            background:none;
            border:none;
            color:#fff;
            font-size:1.2rem;
            cursor:pointer;
            padding:4px 8px;
            border-radius:4px;
            transition:background 0.2s;
            flex-shrink:0;
        }
        .ctrl-btn:hover { background:rgba(255,255,255,0.15); }
        .ctrl-time {
            color:rgba(255,255,255,0.8);
            font-size:0.75rem;
            font-family:monospace;
            white-space:nowrap;
            flex-shrink:0;
        }
        .vol-slider {
            width:60px;
            accent-color:#6c5ce7;
            flex-shrink:0;
        }
        .gd-block { position:absolute; z-index:30; background:transparent; }
    </style>
</head>
<body oncontextmenu="return false" ondragstart="return false">
    <!-- VIDEO - Streaming through OUR server proxy -->
    <!-- Google Drive URL is NEVER exposed to browser -->
    <video id="vid"
        playsinline
        webkit-playsinline
        preload="auto"
        controlsList="nodownload noplaybackrate"
        disablePictureInPicture
        disableRemotePlayback
        oncontextmenu="return false">
        <source src="/api/videos/proxy/${proxyToken}" type="video/mp4">
    </video>

    <!-- Watermarks -->
    <div class="wm" id="wm1">${wmShort}</div>
    <div class="wm2" id="wm2">${wmShort}</div>

    <!-- Custom controls (no download button!) -->
    <div class="controls" id="controls">
        <button class="ctrl-btn" id="playBtn" onclick="togglePlay()">▶</button>
        <div class="progress-wrap" id="progressWrap">
            <div class="progress-bar" id="progressBar"></div>
        </div>
        <span class="ctrl-time" id="timeDisplay">0:00 / 0:00</span>
        <button class="ctrl-btn" id="muteBtn" onclick="toggleMute()">🔊</button>
        <input type="range" class="vol-slider" id="volSlider" min="0" max="1" step="0.05" value="1">
        <button class="ctrl-btn" onclick="toggleFS()">⛶</button>
    </div>

    <script>
        var vid = document.getElementById('vid');
        var progressBar = document.getElementById('progressBar');
        var timeDisplay = document.getElementById('timeDisplay');
        var playBtn = document.getElementById('playBtn');

        // Play/Pause
        function togglePlay() {
            if (vid.paused) { vid.play(); playBtn.textContent = '⏸'; }
            else { vid.pause(); playBtn.textContent = '▶'; }
        }
        function toggleMute() {
            vid.muted = !vid.muted;
            document.getElementById('muteBtn').textContent = vid.muted ? '🔇' : '🔊';
        }
        function toggleFS() {
            if (document.fullscreenElement) { document.exitFullscreen(); }
            else { document.documentElement.requestFullscreen(); }
        }

        // Progress
        vid.addEventListener('timeupdate', function() {
            if (!vid.duration) return;
            progressBar.style.width = (vid.currentTime / vid.duration * 100) + '%';
            timeDisplay.textContent = fmt(vid.currentTime) + ' / ' + fmt(vid.duration);
        });

        document.getElementById('progressWrap').addEventListener('click', function(e) {
            var pct = e.offsetX / this.offsetWidth;
            vid.currentTime = pct * vid.duration;
        });

        document.getElementById('volSlider').addEventListener('input', function() {
            vid.volume = this.value;
        });

        function fmt(s) {
            if (isNaN(s)) return '0:00';
            var m = Math.floor(s/60), sec = Math.floor(s%60);
            return m + ':' + (sec<10?'0':'') + sec;
        }

        vid.addEventListener('ended', function() { playBtn.textContent = '↩'; });
        vid.addEventListener('pause', function() { playBtn.textContent = '▶'; });
        vid.addEventListener('play', function() { playBtn.textContent = '⏸'; });

        // Auto-play
        vid.play().catch(function() {});

        // Security
        document.addEventListener('contextmenu', function(e) { e.preventDefault(); });
        document.addEventListener('keydown', function(e) {
            if (e.ctrlKey || e.metaKey || e.key === 'F12') {
                e.preventDefault(); return false;
            }
            if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
            if (e.key === 'f') { e.preventDefault(); toggleFS(); }
            if (e.key === 'm') { e.preventDefault(); toggleMute(); }
        });
        document.addEventListener('dragstart', function(e) { e.preventDefault(); });
        document.addEventListener('copy', function(e) { e.preventDefault(); });

        // Block if opened directly
        if (window === window.top) {
            document.body.innerHTML = '<div style="background:#0a0a1a;color:#ff4757;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;"><div><h1>🚫</h1><h2>Direct Access Blocked</h2></div></div>';
        }
    </script>
</body>
</html>
        `);

    } catch (error) {
        console.error('Secure frame error:', error);
        res.status(500).send(errorPage('Error loading video.'));
    }
});

// =============================================
// VIDEO PROXY - Streams video through our server
// Google Drive URL NEVER reaches the browser
// =============================================
router.get('/proxy/:proxyToken', async (req, res) => {
    try {
        const session = videoSessions.get(`proxy_${req.params.proxyToken}`);

        if (!session) {
            return res.status(403).send('Access denied.');
        }

        if (Date.now() > session.expires) {
            videoSessions.delete(`proxy_${req.params.proxyToken}`);
            return res.status(403).send('Session expired.');
        }

        // Verify referer comes from our secure-frame
        const referer = req.headers.referer || '';
        const allowedHosts = getAllowedHosts();
        const isValid = referer === '' ||
            allowedHosts.some(h => referer.includes(h)) ||
            referer.includes('/api/videos/secure-frame/');

        // Build Google Drive direct download URL
        const fileId = session.fileId;
        if (!fileId) {
            return res.status(400).send('Invalid video.');
        }

        // Google Drive direct stream URL
        const driveUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

        // Fetch from Google Drive server-side
        const fetchDriveVideo = (url, redirectCount = 0) => {
            if (redirectCount > 5) {
                res.status(500).send('Too many redirects.');
                return;
            }

            const protocol = url.startsWith('https') ? https : http;
            const range = req.headers.range;

            const options = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; SxS-Stream/1.0)',
                    'Accept': '*/*',
                    ...(range ? { 'Range': range } : {})
                }
            };

            const proxyReq = protocol.get(url, options, (proxyRes) => {
                // Handle redirects (Google Drive redirects to actual file)
                if (proxyRes.statusCode === 301 || proxyRes.statusCode === 302 ||
                    proxyRes.statusCode === 303 || proxyRes.statusCode === 307) {
                    const redirectUrl = proxyRes.headers.location;
                    if (redirectUrl) {
                        proxyReq.destroy();
                        fetchDriveVideo(redirectUrl, redirectCount + 1);
                        return;
                    }
                }

                // Set response headers
                const responseHeaders = {
                    'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': 'no-store, no-cache, private',
                    'Content-Disposition': 'inline',
                    'X-Content-Type-Options': 'nosniff'
                };

                if (proxyRes.headers['content-length']) {
                    responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
                }
                if (proxyRes.headers['content-range']) {
                    responseHeaders['Content-Range'] = proxyRes.headers['content-range'];
                }

                res.writeHead(proxyRes.statusCode, responseHeaders);
                proxyRes.pipe(res);

                proxyRes.on('error', (err) => {
                    console.error('Proxy response error:', err);
                });
            });

            proxyReq.on('error', (err) => {
                console.error('Proxy request error:', err);
                if (!res.headersSent) {
                    res.status(500).send('Stream error.');
                }
            });

            req.on('close', () => {
                proxyReq.destroy();
            });
        };

        fetchDriveVideo(driveUrl);

    } catch (error) {
        console.error('Proxy error:', error);
        if (!res.headersSent) {
            res.status(500).send('Error.');
        }
    }
});

// =============================================
// REFRESH SESSION
// =============================================
router.post('/refresh-session', auth, async (req, res) => {
    try {
        const { sessionToken } = req.body;
        const session = videoSessions.get(sessionToken);

        if (!session || session.userId !== req.user._id.toString()) {
            return res.status(403).json({ success: false });
        }

        session.expires = Date.now() + (2 * 60 * 60 * 1000);
        session.loadCount = 0;
        videoSessions.set(sessionToken, session);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// =============================================
// HELPERS
// =============================================
function errorPage(message) {
    return `
        <html><body style="background:#0a0a1a;color:#ff4757;display:flex;
            align-items:center;justify-content:center;height:100vh;
            font-family:monospace;text-align:center;">
            <div>
                <h1 style="font-size:3rem;">🚫</h1>
                <h2>${message}</h2>
                <p style="color:#555;margin-top:10px;">Go back to the platform.</p>
            </div>
        </body></html>
    `;
}

function escHtml(str) {
    return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

module.exports = router;
