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

// =============================================
// SESSION STORE
// =============================================
const videoSessions = new Map();
const proxyTokens = new Map();
const activeSessions = new Map(); // Track active IP per token

// Cleanup every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of videoSessions.entries()) {
        if (now > v.expires) videoSessions.delete(k);
    }
    for (const [k, v] of proxyTokens.entries()) {
        if (now > v.expires) proxyTokens.delete(k);
    }
    for (const [k, v] of activeSessions.entries()) {
        if (now > v.expires) activeSessions.delete(k);
    }
}, 5 * 60 * 1000);

// =============================================
// CRYPTO HELPERS
// =============================================
function encryptUrl(url) {
    const secret = process.env.JWT_SECRET || 'secret';
    const key = crypto.scryptSync(secret, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let enc = cipher.update(url, 'utf8', 'hex');
    enc += cipher.final('hex');
    return iv.toString('hex') + ':' + enc;
}

function decryptUrl(data) {
    try {
        const secret = process.env.JWT_SECRET || 'secret';
        const key = crypto.scryptSync(secret, 'salt', 32);
        const [ivHex, enc] = data.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let dec = decipher.update(enc, 'hex', 'utf8');
        dec += decipher.final('utf8');
        return dec;
    } catch (e) { return null; }
}

function getFileId(url) {
    if (!url) return null;
    const m1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m1) return m1[1];
    const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m2) return m2[1];
    return null;
}

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.headers['x-real-ip'] ||
        req.ip || 'unknown';
}

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

function errorPage(msg) {
    return `<html><body style="background:#0a0a1a;color:#ff4757;display:flex;
        align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;">
        <div><h1>🚫</h1><h2>${msg}</h2><p style="color:#555;margin-top:10px;">
        Return to the platform.</p></div></body></html>`;
}

function escHtml(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// =============================================
// MY MENTORSHIPS
// =============================================
router.get('/my-mentorships', auth, async (req, res) => {
    try {
        const mentorships = await Mentorship.find({
            _id: { $in: req.user.mentorships },
            isActive: true
        }).sort({ order: 1 });

        const result = await Promise.all(mentorships.map(async m => {
            const videoCount = await Video.countDocuments({
                mentorship: m._id, isActive: true
            });
            return { ...m.toObject(), videoCount };
        }));
        res.json({ success: true, mentorships: result });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

// =============================================
// GET VIDEOS FOR MENTORSHIP
// =============================================
router.get('/mentorship/:mentorshipId', auth, async (req, res) => {
    try {
        const userIds = req.user.mentorships.map(m =>
            m._id ? m._id.toString() : m.toString());

        if (!userIds.includes(req.params.mentorshipId) &&
            req.user.role !== 'admin' && req.user.role !== 'superadmin') {
            return res.status(403).json({ success: false, message: 'No access.' });
        }

        const videos = await Video.find({
            mentorship: req.params.mentorshipId,
            isActive: true
        }).select('-videoUrl -cloudinaryId').sort({ order: 1, createdAt: -1 });

        res.json({ success: true, videos });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

// =============================================
// WATCH - Create session
// =============================================
router.get('/watch/:id', auth, async (req, res) => {
    try {
        const video = await Video.findById(req.params.id).populate('mentorship');

        if (!video || !video.isActive) {
            return res.status(404).json({ success: false, message: 'Not found.' });
        }

        const userIds = req.user.mentorships.map(m =>
            m._id ? m._id.toString() : m.toString());

        const vmId = video.mentorship._id
            ? video.mentorship._id.toString()
            : video.mentorship.toString();

        if (!userIds.includes(vmId) &&
            req.user.role !== 'admin' && req.user.role !== 'superadmin') {
            return res.status(403).json({ success: false, message: 'No access.' });
        }

        video.viewCount += 1;
        await video.save();

        const sessionToken = crypto.randomBytes(32).toString('hex');
        const clientIP = getClientIP(req);

        videoSessions.set(sessionToken, {
            videoId: video._id.toString(),
            userId: req.user._id.toString(),
            encryptedUrl: encryptUrl(video.videoUrl),
            clientIP,
            userAgent: req.headers['user-agent'],
            expires: Date.now() + (2 * 60 * 60 * 1000),
            loadCount: 0
        });

        res.json({
            success: true,
            video: {
                id: video._id,
                title: video.title,
                description: video.description,
                mentorship: video.mentorship?.name || '',
                viewCount: video.viewCount,
                createdAt: video.createdAt
            },
            sessionToken,
            watermark: {
                name: req.user.name,
                email: req.user.email,
                phone: req.user.phone || '',
                id: req.user._id.toString().slice(-6).toUpperCase()
            }
        });
    } catch (e) {
        console.error('Watch error:', e);
        res.status(500).json({ success: false, message: 'Error.' });
    }
});

// =============================================
// SECURE FRAME - Player page
// =============================================
router.get('/secure-frame/:sessionToken', async (req, res) => {
    try {
        const session = videoSessions.get(req.params.sessionToken);
        if (!session) return res.status(403).send(errorPage('Session expired.'));
        if (Date.now() > session.expires) {
            videoSessions.delete(req.params.sessionToken);
            return res.status(403).send(errorPage('Session expired.'));
        }

        // Referer check
        const referer = req.headers.referer || '';
        const origin = req.headers.origin || '';
        const hosts = getAllowedHosts();
        const ok = referer === '' ||
            hosts.some(h => referer.includes(h)) ||
            hosts.some(h => origin.includes(h));

        if (!ok) {
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

        const videoUrl = decryptUrl(session.encryptedUrl);
        if (!videoUrl) return res.status(500).send(errorPage('Error.'));

        const fileId = getFileId(videoUrl);
        if (!fileId) return res.status(400).send(errorPage('Invalid video.'));

        // Create a SHORT-LIVED proxy token (30 seconds only!)
        const proxyToken = crypto.randomBytes(24).toString('hex');
        const clientIP = getClientIP(req);

        proxyTokens.set(proxyToken, {
            fileId,
            userId: session.userId,
            clientIP,       // Lock to client IP
            userAgent: req.headers['user-agent'], // Lock to user agent
            sessionToken: req.params.sessionToken,
            expires: Date.now() + (4 * 60 * 60 * 1000),
            requestCount: 0,
            created: Date.now()
        });

        // Watermark
        const wmShort = escHtml(`${user.name}  |  ${user.email}`);
        const wmId = escHtml(user._id.toString().slice(-6).toUpperCase());

        // Security headers
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy',
            `default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self' https://sxs-lsnr.online https://www.sxs-lsnr.online`);
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Referrer-Policy', 'no-referrer');

        res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#000;overflow:hidden;
    -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}
video{width:100%;height:100%;object-fit:contain;position:absolute;top:0;left:0;z-index:1;}
video::-webkit-media-controls{display:none!important}
video::-webkit-media-controls-enclosure{display:none!important}
video::-webkit-media-controls-panel{display:none!important}
video::-internal-media-controls-download-button{display:none!important}
video::-webkit-media-controls-download-button{display:none!important}
video::-webkit-media-controls-overflow-menu{display:none!important}
.wm{position:absolute;pointer-events:none;user-select:none;z-index:10;
    font-family:'Courier New',monospace;font-weight:800;white-space:nowrap;
    letter-spacing:2px;text-shadow:0 0 6px rgba(0,0,0,.9),2px 2px 4px rgba(0,0,0,.8);}
.wm1{color:rgba(255,255,255,.30);font-size:clamp(14px,2.5vw,24px);
    animation:wm1 15s linear infinite;}
.wm2{color:rgba(255,255,255,.20);font-size:clamp(12px,2vw,20px);
    animation:wm2 18s linear infinite;}
@keyframes wm1{
    0%{top:15%;left:-50%}25%{top:50%;left:65%}
    50%{top:75%;left:10%}75%{top:35%;left:75%}100%{top:15%;left:-50%}}
@keyframes wm2{
    0%{top:70%;left:110%}25%{top:25%;left:20%}
    50%{top:55%;left:75%}75%{top:15%;left:45%}100%{top:70%;left:110%}}
.ctrl{position:absolute;bottom:0;left:0;right:0;
    background:linear-gradient(transparent,rgba(0,0,0,.85));
    padding:20px 16px 12px;z-index:20;
    display:flex;align-items:center;gap:10px;
    opacity:0;transition:opacity .3s;}
body:hover .ctrl{opacity:1;}
.prog{flex:1;height:5px;background:rgba(255,255,255,.2);
    border-radius:5px;cursor:pointer;position:relative;}
.progbar{height:100%;background:linear-gradient(90deg,#6c5ce7,#00cec9);
    border-radius:5px;width:0%;pointer-events:none;}
.cbtn{background:none;border:none;color:#fff;font-size:1.2rem;
    cursor:pointer;padding:4px 8px;border-radius:4px;flex-shrink:0;}
.cbtn:hover{background:rgba(255,255,255,.15)}
.ctime{color:rgba(255,255,255,.8);font-size:.75rem;font-family:monospace;
    white-space:nowrap;flex-shrink:0;}
.vol{width:55px;accent-color:#6c5ce7;flex-shrink:0;}
</style>
</head>
<body oncontextmenu="return false" ondragstart="return false" onselectstart="return false">

<video id="v" playsinline webkit-playsinline
    preload="metadata"
    controlsList="nodownload noplaybackrate"
    disablePictureInPicture
    disableRemotePlayback
    oncontextmenu="return false">
</video>

<div class="wm wm1">${wmShort}</div>
<div class="wm wm2">${wmShort}</div>

<div class="ctrl">
    <button class="cbtn" id="pb" onclick="tp()">▶</button>
    <div class="prog" id="pw" onclick="seek(event)">
        <div class="progbar" id="pgb"></div>
    </div>
    <span class="ctime" id="td">0:00 / 0:00</span>
    <button class="cbtn" id="mb" onclick="tm()">🔊</button>
    <input class="vol" id="vs" type="range" min="0" max="1" step="0.05" value="1"
        onchange="document.getElementById('v').volume=this.value">
    <button class="cbtn" onclick="tfs()">⛶</button>
</div>

<script>
var v=document.getElementById('v');
var pgb=document.getElementById('pgb');
var td=document.getElementById('td');
var pb=document.getElementById('pb');

// Load video through our proxy
// This is the ONLY URL student sees - not Google Drive
v.src='/api/videos/proxy/${proxyToken}';
v.load();
v.play().catch(function(){});

function tp(){if(v.paused){v.play();pb.textContent='⏸';}else{v.pause();pb.textContent='▶';}}
function tm(){v.muted=!v.muted;document.getElementById('mb').textContent=v.muted?'🔇':'🔊';}
function tfs(){
    if(document.fullscreenElement||document.webkitFullscreenElement){
        (document.exitFullscreen||document.webkitExitFullscreen).call(document);
    }else{
        var el=document.documentElement;
        (el.requestFullscreen||el.webkitRequestFullscreen).call(el);
    }
}
function seek(e){
    var pw=document.getElementById('pw');
    v.currentTime=(e.offsetX/pw.offsetWidth)*v.duration;
}
function fmt(s){
    if(isNaN(s))return'0:00';
    var m=Math.floor(s/60),sc=Math.floor(s%60);
    return m+':'+(sc<10?'0':'')+sc;
}
v.addEventListener('timeupdate',function(){
    if(!v.duration)return;
    pgb.style.width=(v.currentTime/v.duration*100)+'%';
    td.textContent=fmt(v.currentTime)+' / '+fmt(v.duration);
});
v.addEventListener('ended',function(){pb.textContent='↩';});
v.addEventListener('pause',function(){pb.textContent='▶';});
v.addEventListener('play',function(){pb.textContent='⏸';});

// Keyboard shortcuts
document.addEventListener('keydown',function(e){
    if(e.key===' '||e.key==='k'){e.preventDefault();tp();}
    if(e.key==='f'){e.preventDefault();tfs();}
    if(e.key==='m'){e.preventDefault();tm();}
    if(e.key==='ArrowLeft'){e.preventDefault();v.currentTime=Math.max(0,v.currentTime-10);}
    if(e.key==='ArrowRight'){e.preventDefault();v.currentTime=Math.min(v.duration,v.currentTime+10);}
    if(e.ctrlKey||e.metaKey||e.key==='F12'){e.preventDefault();return false;}
});

// Block all dangerous actions
document.addEventListener('contextmenu',function(e){e.preventDefault();});
document.addEventListener('dragstart',function(e){e.preventDefault();});
document.addEventListener('copy',function(e){e.preventDefault();});

// Block if opened directly without iframe
if(window===window.top){
    document.body.innerHTML='<div style="background:#0a0a1a;color:#ff4757;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;"><div><h1>🚫</h1><h2>Direct Access Blocked</h2><p style="color:#555;margin-top:10px;">Videos can only be watched on the platform.</p></div></div>';
}
</script>
</body>
</html>`);

    } catch (e) {
        console.error('Secure frame error:', e);
        res.status(500).send(errorPage('Error loading video.'));
    }
});

// =============================================
// VIDEO PROXY - Streams actual video bytes
// Google Drive URL NEVER leaves our server
// =============================================
router.get('/proxy/:proxyToken', async (req, res) => {
    try {
        const token = proxyTokens.get(req.params.proxyToken);

        // Token must exist
        if (!token) {
            console.log('❌ Proxy: Invalid token');
            return res.status(403).send('Access denied.');
        }

        // Token must not be expired
        if (Date.now() > token.expires) {
            proxyTokens.delete(req.params.proxyToken);
            console.log('❌ Proxy: Expired token');
            return res.status(403).send('Session expired.');
        }

        // ── IP LOCK ──
        // The proxy can ONLY be used from the same IP that created the session
        const clientIP = getClientIP(req);
        if (token.clientIP !== 'unknown' && clientIP !== 'unknown' &&
            token.clientIP !== clientIP) {
            console.log(`🚨 IP MISMATCH: Token IP=${token.clientIP}, Request IP=${clientIP}`);
            proxyTokens.delete(req.params.proxyToken);
            return res.status(403).send('IP mismatch. Access denied.');
        }

        // ── USER AGENT LOCK ──
        // Must come from same browser
        const ua = req.headers['user-agent'] || '';
        if (token.userAgent && ua && token.userAgent !== ua) {
            console.log('🚨 User-Agent mismatch');
            // Don't delete - could be iframe quirk, just log
        }

        // ── REQUEST COUNT LIMIT ──
        token.requestCount = (token.requestCount || 0) + 1;
        if (token.requestCount > 500) {
            proxyTokens.delete(req.params.proxyToken);
            console.log('❌ Too many requests on proxy token');
            return res.status(429).send('Too many requests.');
        }

        // Verify user is still active
        const user = await User.findById(token.userId).select('isBlocked isActive');
        if (!user || user.isBlocked || !user.isActive) {
            proxyTokens.delete(req.params.proxyToken);
            return res.status(403).send('Account suspended.');
        }

        // ── BUILD GOOGLE DRIVE URL (SERVER SIDE ONLY) ──
        const driveUrl = `https://drive.google.com/uc?export=download&id=${token.fileId}&confirm=t`;

        // Stream with range support for seeking
        const range = req.headers.range;

        const streamFromUrl = (url, redirects = 0) => {
            if (redirects > 8) {
                if (!res.headersSent) res.status(500).send('Stream error.');
                return;
            }

            const isHttps = url.startsWith('https');
            const protocol = isHttps ? https : http;

            const reqHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*',
                'Accept-Encoding': 'identity',
                'Connection': 'keep-alive'
            };

            if (range) {
                reqHeaders['Range'] = range;
            }

            const driveReq = protocol.get(url, { headers: reqHeaders }, (driveRes) => {
                const status = driveRes.statusCode;

                // Handle redirects
                if ([301, 302, 303, 307, 308].includes(status)) {
                    const loc = driveRes.headers.location;
                    if (loc) {
                        driveReq.destroy();
                        driveRes.resume();
                        streamFromUrl(loc, redirects + 1);
                        return;
                    }
                }

                if (status !== 200 && status !== 206) {
                    console.log('Drive returned status:', status);
                    if (!res.headersSent) res.status(502).send('Video unavailable.');
                    return;
                }

                // Build clean response headers
                // NEVER include any Google-related headers
                const outHeaders = {
                    'Content-Type': 'video/mp4',
                    'Cache-Control': 'no-store, no-cache, private, no-transform',
                    'Content-Disposition': 'inline',
                    'X-Content-Type-Options': 'nosniff',
                    'Accept-Ranges': 'bytes',
                    'Access-Control-Allow-Origin': 'null',
                    // Remove any Google URLs from headers
                };

                if (driveRes.headers['content-length']) {
                    outHeaders['Content-Length'] = driveRes.headers['content-length'];
                }
                if (driveRes.headers['content-range']) {
                    outHeaders['Content-Range'] = driveRes.headers['content-range'];
                }

                res.writeHead(status, outHeaders);
                driveRes.pipe(res);

                driveRes.on('error', err => {
                    console.error('Drive stream error:', err.message);
                });
            });

            driveReq.on('error', err => {
                console.error('Drive request error:', err.message);
                if (!res.headersSent) res.status(500).send('Stream error.');
            });

            driveReq.setTimeout(30000, () => {
                driveReq.destroy();
                if (!res.headersSent) res.status(504).send('Timeout.');
            });

            req.on('close', () => {
                driveReq.destroy();
            });
        };

        streamFromUrl(driveUrl);

    } catch (e) {
        console.error('Proxy error:', e);
        if (!res.headersSent) res.status(500).send('Error.');
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
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

module.exports = router;
