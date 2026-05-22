// server/routes/videos.js
const express = require('express');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const Video = require('../models/Video');
const User = require('../models/User');
const Mentorship = require('../models/Mentorship');
const { auth } = require('../middleware/auth');
const {
    ffmpegAvailable,
    processToHLS,
    hlsSessions
} = require('../videoProcessor');

const router = express.Router();

// =============================================
// SESSION STORES
// =============================================
const videoSessions = new Map();
const proxyTokens = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of videoSessions.entries()) {
        if (now > v.expires) videoSessions.delete(k);
    }
    for (const [k, v] of proxyTokens.entries()) {
        if (now > v.expires) proxyTokens.delete(k);
    }
}, 5 * 60 * 1000);

// =============================================
// HELPERS
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
        req.headers['x-real-ip'] || req.ip || 'unknown';
}

function getAllowedHosts() {
    const hosts = ['sxs-lsnr.online', 'www.sxs-lsnr.online', 'localhost', '127.0.0.1'];
    if (process.env.RAILWAY_PUBLIC_DOMAIN) hosts.push(process.env.RAILWAY_PUBLIC_DOMAIN);
    return hosts;
}

function errorPage(msg) {
    return `<!DOCTYPE html><html><body style="background:#0a0a1a;color:#ff4757;
        display:flex;align-items:center;justify-content:center;height:100vh;
        font-family:monospace;text-align:center;margin:0;">
        <div><div style="font-size:4rem;">🚫</div>
        <h2>${msg}</h2><p style="color:#555;margin-top:10px;">Return to platform.</p>
        </div></body></html>`;
}

function escHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Direct proxy stream from Google Drive
function fetchDriveStream(fileId, range) {
    return new Promise((resolve, reject) => {
        const driveUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

        const tryFetch = (url, redirects = 0) => {
            if (redirects > 8) { reject(new Error('Too many redirects')); return; }

            const protocol = url.startsWith('https') ? https : http;
            const reqHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*',
                'Accept-Encoding': 'identity'
            };
            if (range) reqHeaders['Range'] = range;

            const req = protocol.get(url, { headers: reqHeaders }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    const loc = res.headers.location;
                    if (loc) { req.destroy(); res.resume(); tryFetch(loc, redirects + 1); return; }
                }
                resolve({ res, status: res.statusCode, headers: res.headers });
            });

            req.on('error', reject);
            req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
        };

        tryFetch(driveUrl);
    });
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
            const videoCount = await Video.countDocuments({ mentorship: m._id, isActive: true });
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
        const userIds = req.user.mentorships.map(m => m._id ? m._id.toString() : m.toString());

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
// WATCH - Generate session
// =============================================
router.get('/watch/:id', auth, async (req, res) => {
    try {
        const video = await Video.findById(req.params.id).populate('mentorship');
        if (!video || !video.isActive) {
            return res.status(404).json({ success: false, message: 'Not found.' });
        }

        const userIds = req.user.mentorships.map(m => m._id ? m._id.toString() : m.toString());
        const vmId = video.mentorship._id ? video.mentorship._id.toString() : video.mentorship.toString();

        if (!userIds.includes(vmId) &&
            req.user.role !== 'admin' && req.user.role !== 'superadmin') {
            return res.status(403).json({ success: false, message: 'No access.' });
        }

        video.viewCount += 1;
        await video.save();

        const sessionToken = crypto.randomBytes(32).toString('hex');
        videoSessions.set(sessionToken, {
            videoId: video._id.toString(),
            userId: req.user._id.toString(),
            encryptedUrl: encryptUrl(video.videoUrl),
            clientIP: getClientIP(req),
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
// SECURE FRAME - Player Page
// =============================================
router.get('/secure-frame/:sessionToken', async (req, res) => {
    try {
        const session = videoSessions.get(req.params.sessionToken);
        if (!session) return res.status(403).send(errorPage('Session expired.'));
        if (Date.now() > session.expires) {
            videoSessions.delete(req.params.sessionToken);
            return res.status(403).send(errorPage('Session expired.'));
        }

        const referer = req.headers.referer || '';
        const origin = req.headers.origin || '';
        const hosts = getAllowedHosts();
        const fromOurSite = referer === '' ||
            hosts.some(h => referer.includes(h)) ||
            hosts.some(h => origin.includes(h));

        if (!fromOurSite) {
            return res.status(403).send(errorPage('Direct access blocked.'));
        }

        session.loadCount = (session.loadCount || 0) + 1;
        if (session.loadCount > 20) {
            videoSessions.delete(req.params.sessionToken);
            return res.status(403).send(errorPage('Too many requests.'));
        }

        const user = await User.findById(session.userId);
        if (!user || user.isBlocked || !user.isActive) {
            return res.status(403).send(errorPage('Account suspended.'));
        }

        const videoUrl = decryptUrl(session.encryptedUrl);
        if (!videoUrl) return res.status(500).send(errorPage('Error.'));

        const fileId = getFileId(videoUrl);
        if (!fileId) return res.status(400).send(errorPage('Invalid video.'));

        const wmShort = escHtml(`${user.name}  |  ${user.email}`);

        let playerHtml = '';

        if (ffmpegAvailable) {
            // ── HLS Mode (FFmpeg available) ──
            // Process video to encrypted HLS segments
            console.log(`🎬 Processing HLS for user: ${user.email}`);
            const hlsSessionId = crypto.randomBytes(16).toString('hex');

            // Start HLS processing in background
            processToHLS(fileId, hlsSessionId).then(result => {
                if (result.success) {
                    hlsSessions.set(hlsSessionId, {
                        ...result,
                        userId: session.userId,
                        clientIP: getClientIP(req),
                        expires: Date.now() + (4 * 60 * 60 * 1000),
                        encKey: Buffer.from(result.encKey, 'hex')
                    });
                    console.log(`✅ HLS ready for session: ${hlsSessionId}`);
                }
            });

            // Show loading while processing
            playerHtml = getHLSPlayerHTML(hlsSessionId, wmShort);

        } else {
            // ── Direct Proxy Mode (No FFmpeg) ──
            const proxyToken = crypto.randomBytes(32).toString('hex');
            proxyTokens.set(proxyToken, {
                fileId,
                userId: session.userId,
                clientIP: getClientIP(req),
                userAgent: req.headers['user-agent'] || '',
                expires: Date.now() + (4 * 60 * 60 * 1000),
                requestCount: 0
            });

            playerHtml = getProxyPlayerHTML(proxyToken, wmShort);
        }

        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy',
            `default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; ` +
            `media-src 'self' blob:; connect-src 'self'; ` +
            `frame-ancestors 'self' https://sxs-lsnr.online https://www.sxs-lsnr.online`);
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Referrer-Policy', 'no-referrer');

        res.send(playerHtml);

    } catch (e) {
        console.error('Secure frame error:', e);
        res.status(500).send(errorPage('Error loading.'));
    }
});

// =============================================
// HLS PLAYLIST - Serve encrypted M3U8
// =============================================
router.get('/hls/:sessionId/playlist.m3u8', async (req, res) => {
    const session = hlsSessions.get(req.params.sessionId);
    if (!session) return res.status(403).send('Expired.');

    // IP check
    const clientIP = getClientIP(req);
    if (session.clientIP !== clientIP) {
        return res.status(403).send('IP mismatch.');
    }

    const playlistFile = session.playlistFile;

    if (!fs.existsSync(playlistFile)) {
        return res.status(202).send('#EXTM3U\n#Processing...\n');
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(playlistFile);
});

// =============================================
// HLS SEGMENTS - Serve encrypted .ts chunks
// =============================================
router.get('/hls/:sessionId/:segment', async (req, res) => {
    const session = hlsSessions.get(req.params.sessionId);
    if (!session) return res.status(403).send('Expired.');

    const clientIP = getClientIP(req);
    if (session.clientIP !== clientIP) {
        return res.status(403).send('IP mismatch.');
    }

    // Only allow .ts segment files
    const segment = req.params.segment;
    if (!segment.match(/^seg\d+\.ts$/)) {
        return res.status(400).send('Invalid.');
    }

    const segFile = path.join(session.outputDir, segment);
    if (!fs.existsSync(segFile)) {
        return res.status(404).send('Segment not found.');
    }

    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(segFile);
});

// =============================================
// HLS ENCRYPTION KEY - Serve decryption key
// =============================================
router.get('/hls-key/:sessionId', async (req, res) => {
    const session = hlsSessions.get(req.params.sessionId);
    if (!session) return res.status(403).send('Key expired.');

    // Strict IP check for key delivery
    const clientIP = getClientIP(req);
    if (session.clientIP !== clientIP) {
        console.log(`🚨 Key IP mismatch: ${session.clientIP} vs ${clientIP}`);
        return res.status(403).send('IP verification failed.');
    }

    // Verify user still active
    const user = await User.findById(session.userId).select('isBlocked isActive');
    if (!user || user.isBlocked || !user.isActive) {
        return res.status(403).send('Account suspended.');
    }

    // Send encryption key (binary)
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store, private');
    res.send(session.encKey);
});

// =============================================
// HLS STATUS - Check if processing complete
// =============================================
router.get('/hls-status/:sessionId', async (req, res) => {
    const session = hlsSessions.get(req.params.sessionId);
    if (!session) {
        return res.json({ ready: false, processing: false });
    }
    const ready = session.playlistFile && fs.existsSync(session.playlistFile);
    res.json({ ready, processing: !ready });
});

// =============================================
// DIRECT PROXY - Fallback when no FFmpeg
// =============================================
router.get('/proxy/:proxyToken', async (req, res) => {
    try {
        const pToken = req.params.proxyToken;
        const session = proxyTokens.get(pToken);

        if (!session) return res.status(403).send('Access denied.');
        if (Date.now() > session.expires) {
            proxyTokens.delete(pToken);
            return res.status(403).send('Session expired.');
        }

        const clientIP = getClientIP(req);
        if (session.clientIP !== 'unknown' && clientIP !== 'unknown' &&
            session.clientIP !== clientIP) {
            proxyTokens.delete(pToken);
            return res.status(403).send('IP mismatch.');
        }

        session.requestCount = (session.requestCount || 0) + 1;
        if (session.requestCount > 1000) {
            proxyTokens.delete(pToken);
            return res.status(429).send('Limit exceeded.');
        }

        const user = await User.findById(session.userId).select('isBlocked isActive');
        if (!user || user.isBlocked || !user.isActive) {
            return res.status(403).send('Suspended.');
        }

        const range = req.headers.range;
        const { res: driveRes, status, headers } = await fetchDriveStream(session.fileId, range);

        const outHeaders = {
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store, private',
            'Content-Disposition': 'inline',
            'X-Content-Type-Options': 'nosniff'
        };

        if (headers['content-length']) outHeaders['Content-Length'] = headers['content-length'];
        if (headers['content-range']) outHeaders['Content-Range'] = headers['content-range'];

        res.writeHead(status, outHeaders);
        driveRes.pipe(res);

        driveRes.on('error', err => console.error('Stream err:', err.message));
        req.on('close', () => driveRes.destroy());

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
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// =============================================
// PLAYER HTML GENERATORS
// =============================================
function getHLSPlayerHTML(hlsSessionId, wmShort) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#000;overflow:hidden;
    -webkit-user-select:none;user-select:none}
#v{width:100%;height:100%;object-fit:contain;position:absolute;top:0;left:0;z-index:1}
#v::-webkit-media-controls{display:none!important}
#v::-webkit-media-controls-enclosure{display:none!important}
#v::-webkit-media-controls-panel{display:none!important}
#v::-internal-media-controls-download-button{display:none!important}
#v::-webkit-media-controls-download-button{display:none!important}
.wm{position:absolute;pointer-events:none;user-select:none;z-index:10;
    font-family:'Courier New',monospace;font-weight:800;white-space:nowrap;
    letter-spacing:2px;text-shadow:0 0 6px rgba(0,0,0,.9),2px 2px 4px rgba(0,0,0,.8)}
#wm1{color:rgba(255,255,255,.30);font-size:clamp(14px,2.5vw,24px);
    animation:wm1 15s linear infinite}
#wm2{color:rgba(255,255,255,.20);font-size:clamp(12px,2vw,20px);
    animation:wm2 18s linear infinite}
@keyframes wm1{0%{top:15%;left:-50%}25%{top:50%;left:65%}50%{top:75%;left:10%}75%{top:35%;left:75%}100%{top:15%;left:-50%}}
@keyframes wm2{0%{top:70%;left:110%}25%{top:25%;left:20%}50%{top:55%;left:75%}75%{top:15%;left:45%}100%{top:70%;left:110%}}
#ctrl{position:absolute;bottom:0;left:0;right:0;z-index:20;
    background:linear-gradient(transparent,rgba(0,0,0,.85));
    padding:20px 16px 12px;display:flex;align-items:center;gap:10px;
    opacity:0;transition:opacity .3s}
body:hover #ctrl{opacity:1}
#pw{flex:1;height:5px;background:rgba(255,255,255,.2);border-radius:5px;cursor:pointer}
#pgb{height:100%;background:linear-gradient(90deg,#6c5ce7,#00cec9);
    border-radius:5px;width:0%;pointer-events:none;transition:width .1s}
.cb{background:none;border:none;color:#fff;font-size:1.2rem;cursor:pointer;
    padding:4px 8px;border-radius:4px;flex-shrink:0}
.cb:hover{background:rgba(255,255,255,.15)}
#td{color:rgba(255,255,255,.8);font-size:.75rem;font-family:monospace;
    white-space:nowrap;flex-shrink:0}
#vs{width:55px;accent-color:#6c5ce7;flex-shrink:0}
#loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
    z-index:30;text-align:center;color:#fff}
.spin{width:40px;height:40px;border:3px solid rgba(255,255,255,.1);
    border-top-color:#6c5ce7;border-radius:50%;
    animation:spin .7s linear infinite;margin:0 auto 10px}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body oncontextmenu="return false" ondragstart="return false" onselectstart="return false">
<video id="v" playsinline webkit-playsinline
    controlsList="nodownload noplaybackrate"
    disablePictureInPicture disableRemotePlayback
    oncontextmenu="return false">
</video>
<div class="wm" id="wm1">${wmShort}</div>
<div class="wm" id="wm2">${wmShort}</div>
<div id="loading">
    <div class="spin"></div>
    <p style="font-size:.85rem;color:rgba(255,255,255,.6);">Processing video...</p>
    <p style="font-size:.75rem;color:rgba(255,255,255,.4);margin-top:5px;">This may take 1-2 minutes for first load</p>
</div>
<div id="ctrl">
    <button class="cb" id="pb" onclick="tp()">▶</button>
    <div id="pw" onclick="seek(event)"><div id="pgb"></div></div>
    <span id="td">0:00 / 0:00</span>
    <button class="cb" id="mb" onclick="tm()">🔊</button>
    <input id="vs" type="range" min="0" max="1" step="0.05" value="1"
        oninput="document.getElementById('v').volume=this.value">
    <button class="cb" onclick="tfs()">⛶</button>
</div>
<script>
var v=document.getElementById('v');
var pb=document.getElementById('pb');
var pgb=document.getElementById('pgb');
var td=document.getElementById('td');
var loading=document.getElementById('loading');
var HLS_SESSION='${hlsSessionId}';
var hls=null;
var checkInterval=null;

// Poll until HLS is ready
function checkHLSReady(){
    fetch('/api/videos/hls-status/'+HLS_SESSION)
    .then(function(r){return r.json();})
    .then(function(data){
        if(data.ready){
            clearInterval(checkInterval);
            loadHLS();
        }
    })
    .catch(function(){});
}

function loadHLS(){
    var playlistUrl='/api/videos/hls/'+HLS_SESSION+'/playlist.m3u8';

    if(Hls.isSupported()){
        hls=new Hls({
            enableWorker:true,
            xhrSetup:function(xhr){
                // Add same-origin credentials
                xhr.withCredentials=false;
            }
        });
        hls.loadSource(playlistUrl);
        hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED,function(){
            loading.style.display='none';
            v.play().catch(function(){});
        });
        hls.on(Hls.Events.ERROR,function(event,data){
            console.log('HLS Error:',data.type,data.details);
        });
    }else if(v.canPlayType('application/vnd.apple.mpegurl')){
        // Safari native HLS
        v.src=playlistUrl;
        v.addEventListener('loadedmetadata',function(){
            loading.style.display='none';
            v.play().catch(function(){});
        });
    }
}

// Start polling for HLS readiness
checkInterval=setInterval(checkHLSReady,2000);
checkHLSReady(); // Immediate first check

function tp(){if(v.paused){v.play();pb.textContent='⏸';}else{v.pause();pb.textContent='▶';}}
function tm(){v.muted=!v.muted;document.getElementById('mb').textContent=v.muted?'🔇':'🔊';}
function tfs(){
    if(document.fullscreenElement||document.webkitFullscreenElement){
        (document.exitFullscreen||document.webkitExitFullscreen).call(document);
    }else{
        var el=document.documentElement;
        (el.requestFullscreen||el.webkitRequestFullscreen||el.msRequestFullscreen).call(el);
    }
}
function seek(e){
    var r=document.getElementById('pw').getBoundingClientRect();
    var pct=(e.clientX-r.left)/r.width;
    if(v.duration)v.currentTime=Math.max(0,Math.min(1,pct))*v.duration;
}
function fmt(s){
    if(!s||isNaN(s))return'0:00';
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
v.addEventListener('waiting',function(){loading.style.display='block';});
v.addEventListener('playing',function(){loading.style.display='none';});

document.addEventListener('keydown',function(e){
    switch(e.key){
        case' ':case'k':e.preventDefault();tp();break;
        case'f':e.preventDefault();tfs();break;
        case'm':e.preventDefault();tm();break;
        case'ArrowLeft':e.preventDefault();v.currentTime=Math.max(0,(v.currentTime||0)-10);break;
        case'ArrowRight':e.preventDefault();v.currentTime=Math.min(v.duration||0,(v.currentTime||0)+10);break;
    }
    if(e.ctrlKey||e.metaKey||e.key==='F12'){e.preventDefault();return false;}
});
document.addEventListener('contextmenu',function(e){e.preventDefault();});
document.addEventListener('dragstart',function(e){e.preventDefault();});
document.addEventListener('copy',function(e){e.preventDefault();});
v.addEventListener('contextmenu',function(e){e.preventDefault();return false;});
v.addEventListener('enterpictureinpicture',function(){
    document.exitPictureInPicture&&document.exitPictureInPicture();
});
if(window===window.top){
    document.body.innerHTML='<div style="background:#0a0a1a;color:#ff4757;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;"><div><h1>🚫</h1><h2>Direct Access Blocked</h2></div></div>';
}
</script>
</body>
</html>`;
}

function getProxyPlayerHTML(proxyToken, wmShort) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#000;overflow:hidden;
    -webkit-user-select:none;user-select:none}
#v{width:100%;height:100%;object-fit:contain;position:absolute;top:0;left:0;z-index:1}
#v::-webkit-media-controls{display:none!important}
#v::-webkit-media-controls-enclosure{display:none!important}
#v::-internal-media-controls-download-button{display:none!important}
#v::-webkit-media-controls-download-button{display:none!important}
.wm{position:absolute;pointer-events:none;user-select:none;z-index:10;
    font-family:'Courier New',monospace;font-weight:800;white-space:nowrap;
    letter-spacing:2px;text-shadow:0 0 6px rgba(0,0,0,.9),2px 2px 4px rgba(0,0,0,.8)}
#wm1{color:rgba(255,255,255,.30);font-size:clamp(14px,2.5vw,24px);animation:wm1 15s linear infinite}
#wm2{color:rgba(255,255,255,.20);font-size:clamp(12px,2vw,20px);animation:wm2 18s linear infinite}
@keyframes wm1{0%{top:15%;left:-50%}25%{top:50%;left:65%}50%{top:75%;left:10%}75%{top:35%;left:75%}100%{top:15%;left:-50%}}
@keyframes wm2{0%{top:70%;left:110%}25%{top:25%;left:20%}50%{top:55%;left:75%}75%{top:15%;left:45%}100%{top:70%;left:110%}}
#ctrl{position:absolute;bottom:0;left:0;right:0;z-index:20;
    background:linear-gradient(transparent,rgba(0,0,0,.85));
    padding:20px 16px 12px;display:flex;align-items:center;gap:10px;
    opacity:0;transition:opacity .3s}
body:hover #ctrl{opacity:1}
#pw{flex:1;height:5px;background:rgba(255,255,255,.2);border-radius:5px;cursor:pointer}
#pgb{height:100%;background:linear-gradient(90deg,#6c5ce7,#00cec9);border-radius:5px;width:0%}
.cb{background:none;border:none;color:#fff;font-size:1.2rem;cursor:pointer;padding:4px 8px;border-radius:4px}
.cb:hover{background:rgba(255,255,255,.15)}
#td{color:rgba(255,255,255,.8);font-size:.75rem;font-family:monospace;white-space:nowrap}
#vs{width:55px;accent-color:#6c5ce7}
#loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:30;text-align:center;color:#fff}
.spin{width:40px;height:40px;border:3px solid rgba(255,255,255,.1);border-top-color:#6c5ce7;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 10px}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body oncontextmenu="return false" ondragstart="return false" onselectstart="return false">
<video id="v" playsinline webkit-playsinline
    controlsList="nodownload noplaybackrate"
    disablePictureInPicture disableRemotePlayback oncontextmenu="return false">
    <source src="/api/videos/proxy/${proxyToken}" type="video/mp4">
</video>
<div class="wm" id="wm1">${wmShort}</div>
<div class="wm" id="wm2">${wmShort}</div>
<div id="loading"><div class="spin"></div><p style="font-size:.85rem;color:rgba(255,255,255,.6)">Loading...</p></div>
<div id="ctrl">
    <button class="cb" id="pb" onclick="tp()">▶</button>
    <div id="pw" onclick="seek(event)"><div id="pgb"></div></div>
    <span id="td">0:00 / 0:00</span>
    <button class="cb" id="mb" onclick="tm()">🔊</button>
    <input id="vs" type="range" min="0" max="1" step="0.05" value="1" oninput="document.getElementById('v').volume=this.value">
    <button class="cb" onclick="tfs()">⛶</button>
</div>
<script>
var v=document.getElementById('v');
var pb=document.getElementById('pb');
var pgb=document.getElementById('pgb');
var td=document.getElementById('td');
var loading=document.getElementById('loading');
v.addEventListener('canplay',function(){loading.style.display='none';v.play().catch(function(){});});
v.addEventListener('waiting',function(){loading.style.display='block';});
v.addEventListener('playing',function(){loading.style.display='none';});
function tp(){if(v.paused){v.play();pb.textContent='⏸';}else{v.pause();pb.textContent='▶';}}
function tm(){v.muted=!v.muted;document.getElementById('mb').textContent=v.muted?'🔇':'🔊';}
function tfs(){
    if(document.fullscreenElement||document.webkitFullscreenElement){
        (document.exitFullscreen||document.webkitExitFullscreen).call(document);
    }else{var el=document.documentElement;(el.requestFullscreen||el.webkitRequestFullscreen||el.msRequestFullscreen).call(el);}
}
function seek(e){var r=document.getElementById('pw').getBoundingClientRect();v.currentTime=(e.clientX-r.left)/r.width*(v.duration||0);}
function fmt(s){if(!s||isNaN(s))return'0:00';var m=Math.floor(s/60),sc=Math.floor(s%60);return m+':'+(sc<10?'0':'')+sc;}
v.addEventListener('timeupdate',function(){if(!v.duration)return;pgb.style.width=(v.currentTime/v.duration*100)+'%';td.textContent=fmt(v.currentTime)+' / '+fmt(v.duration);});
v.addEventListener('ended',function(){pb.textContent='↩';});
v.addEventListener('pause',function(){pb.textContent='▶';});
v.addEventListener('play',function(){pb.textContent='⏸';});
document.addEventListener('keydown',function(e){
    switch(e.key){case' ':case'k':e.preventDefault();tp();break;case'f':e.preventDefault();tfs();break;case'm':e.preventDefault();tm();break;case'ArrowLeft':e.preventDefault();v.currentTime=Math.max(0,(v.currentTime||0)-10);break;case'ArrowRight':e.preventDefault();v.currentTime=Math.min(v.duration||0,(v.currentTime||0)+10);break;}
    if(e.ctrlKey||e.metaKey||e.key==='F12'){e.preventDefault();return false;}
});
document.addEventListener('contextmenu',function(e){e.preventDefault();});
document.addEventListener('dragstart',function(e){e.preventDefault();});
document.addEventListener('copy',function(e){e.preventDefault();});
v.addEventListener('contextmenu',function(e){e.preventDefault();return false;});
v.addEventListener('enterpictureinpicture',function(){document.exitPictureInPicture&&document.exitPictureInPicture();});
if(window===window.top){document.body.innerHTML='<div style="background:#0a0a1a;color:#ff4757;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;"><div><h1>🚫</h1><h2>Direct Access Blocked</h2></div></div>';}
</script>
</body>
</html>`;
}

module.exports = router;
