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
    isHLSReady,
    getHLSFilePath,
    getEncryptionKey,
    HLS_BASE
} = require('../hlsConverter');

const router = express.Router();

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

function encryptUrl(url) {
    const s = process.env.JWT_SECRET || 'secret';
    const k = crypto.scryptSync(s, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-256-cbc', k, iv);
    return iv.toString('hex') + ':' + c.update(url, 'utf8', 'hex') + c.final('hex');
}
function decryptUrl(d) {
    try {
        const s = process.env.JWT_SECRET || 'secret';
        const k = crypto.scryptSync(s, 'salt', 32);
        const [ivH, enc] = d.split(':');
        const dc = crypto.createDecipheriv('aes-256-cbc', k, Buffer.from(ivH, 'hex'));
        return dc.update(enc, 'hex', 'utf8') + dc.final('utf8');
    } catch (e) { return null; }
}
function getFileId(url) {
    if (!url) return null;
    const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
}
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || req.ip || 'unknown';
}
function getAllowedHosts() {
    const h = ['sxs-lsnr.online', 'www.sxs-lsnr.online', 'localhost', '127.0.0.1'];
    if (process.env.RAILWAY_PUBLIC_DOMAIN) h.push(process.env.RAILWAY_PUBLIC_DOMAIN);
    return h;
}
function errorPage(m) {
    return `<!DOCTYPE html><html><body style="background:#0a0a1a;color:#ff4757;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;margin:0;"><div><div style="font-size:4rem;">🚫</div><h2>${m}</h2></div></body></html>`;
}
function escHtml(s) {
    return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function fetchDriveStream(fileId, range) {
    return new Promise((resolve, reject) => {
        const tryF = (url, r = 0) => {
            if (r > 8) { reject(new Error('Redirects')); return; }
            const p = url.startsWith('https') ? https : http;
            const h = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*', 'Accept-Encoding': 'identity' };
            if (range) h['Range'] = range;
            const rq = p.get(url, { headers: h }, (rs) => {
                if ([301,302,303,307,308].includes(rs.statusCode) && rs.headers.location) {
                    rq.destroy(); rs.resume(); tryF(rs.headers.location, r+1); return;
                }
                resolve({ res: rs, status: rs.statusCode, headers: rs.headers });
            });
            rq.on('error', reject);
            rq.setTimeout(30000, () => { rq.destroy(); reject(new Error('Timeout')); });
        };
        tryF(`https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`);
    });
}

// =============================================
// ROUTES
// =============================================
router.get('/my-mentorships', auth, async (req, res) => {
    try {
        const ms = await Mentorship.find({ _id: { $in: req.user.mentorships }, isActive: true }).sort({ order: 1 });
        const r = await Promise.all(ms.map(async m => {
            const vc = await Video.countDocuments({ mentorship: m._id, isActive: true });
            return { ...m.toObject(), videoCount: vc };
        }));
        res.json({ success: true, mentorships: r });
    } catch (e) { res.status(500).json({ success: false, message: 'Error.' }); }
});

router.get('/mentorship/:mentorshipId', auth, async (req, res) => {
    try {
        const uids = req.user.mentorships.map(m => m._id ? m._id.toString() : m.toString());
        if (!uids.includes(req.params.mentorshipId) && req.user.role !== 'admin' && req.user.role !== 'superadmin')
            return res.status(403).json({ success: false, message: 'No access.' });
        const vs = await Video.find({ mentorship: req.params.mentorshipId, isActive: true })
            .select('-videoUrl -cloudinaryId').sort({ order: 1, createdAt: -1 });
        res.json({ success: true, videos: vs });
    } catch (e) { res.status(500).json({ success: false, message: 'Error.' }); }
});

router.get('/watch/:id', auth, async (req, res) => {
    try {
        const video = await Video.findById(req.params.id).populate('mentorship');
        if (!video || !video.isActive) return res.status(404).json({ success: false, message: 'Not found.' });

        const uids = req.user.mentorships.map(m => m._id ? m._id.toString() : m.toString());
        const vmId = video.mentorship._id ? video.mentorship._id.toString() : video.mentorship.toString();
        if (!uids.includes(vmId) && req.user.role !== 'admin' && req.user.role !== 'superadmin')
            return res.status(403).json({ success: false, message: 'No access.' });

        video.viewCount += 1;
        await video.save();

        const sessionToken = crypto.randomBytes(32).toString('hex');
        videoSessions.set(sessionToken, {
            videoId: video._id.toString(),
            userId: req.user._id.toString(),
            encryptedUrl: encryptUrl(video.videoUrl),
            hlsSessionId: video.hlsSessionId,
            hlsStatus: video.hlsStatus,
            clientIP: getClientIP(req),
            expires: Date.now() + (2 * 60 * 60 * 1000),
            loadCount: 0
        });

        res.json({
            success: true,
            video: {
                id: video._id, title: video.title, description: video.description,
                mentorship: video.mentorship?.name || '', viewCount: video.viewCount,
                createdAt: video.createdAt
            },
            sessionToken,
            watermark: {
                name: req.user.name, email: req.user.email,
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
// SECURE FRAME - Auto-selects HLS or Proxy
// =============================================
router.get('/secure-frame/:sessionToken', async (req, res) => {
    try {
        const session = videoSessions.get(req.params.sessionToken);
        if (!session) return res.status(403).send(errorPage('Session expired.'));
        if (Date.now() > session.expires) { videoSessions.delete(req.params.sessionToken); return res.status(403).send(errorPage('Expired.')); }

        const ref = req.headers.referer || '', orig = req.headers.origin || '';
        const hosts = getAllowedHosts();
        if (!(ref === '' || hosts.some(h => ref.includes(h)) || hosts.some(h => orig.includes(h))))
            return res.status(403).send(errorPage('Direct access blocked.'));

        session.loadCount = (session.loadCount || 0) + 1;
        if (session.loadCount > 20) return res.status(403).send(errorPage('Too many requests.'));

        const user = await User.findById(session.userId);
        if (!user || user.isBlocked || !user.isActive) return res.status(403).send(errorPage('Suspended.'));

        const wmShort = escHtml(`${user.name}  |  ${user.email}`);
        const clientIP = getClientIP(req);

        // Check if HLS is ready for this video
        const useHLS = session.hlsStatus === 'ready' &&
                       session.hlsSessionId &&
                       isHLSReady(session.hlsSessionId);

        let playerSrc;

        if (useHLS) {
            // Use encrypted HLS — no Google Drive URL at all!
            console.log(`🎬 Serving HLS for user: ${user.email}`);
            playerSrc = `/api/videos/hls/${session.hlsSessionId}/playlist.m3u8`;
        } else {
            // Fallback to direct proxy
            console.log(`📡 Serving proxy for user: ${user.email} (HLS status: ${session.hlsStatus})`);
            const videoUrl = decryptUrl(session.encryptedUrl);
            const fileId = getFileId(videoUrl);
            if (!fileId) return res.status(400).send(errorPage('Invalid.'));

            const proxyToken = crypto.randomBytes(32).toString('hex');
            proxyTokens.set(proxyToken, {
                fileId, userId: session.userId, clientIP,
                userAgent: req.headers['user-agent'] || '',
                expires: Date.now() + (4 * 60 * 60 * 1000),
                requestCount: 0
            });
            playerSrc = `/api/videos/proxy/${proxyToken}`;
        }

        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-store, no-cache, private');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy',
            `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self' https://sxs-lsnr.online https://www.sxs-lsnr.online`);
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');

        res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
${useHLS ? '<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"><\/script>' : ''}
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#000;overflow:hidden;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
#v{width:100%;height:100%;object-fit:contain;position:absolute;top:0;left:0;z-index:1}
#v::-webkit-media-controls{display:none!important}#v::-webkit-media-controls-enclosure{display:none!important}
#v::-webkit-media-controls-panel{display:none!important}#v::-internal-media-controls-download-button{display:none!important}
#v::-webkit-media-controls-download-button{display:none!important}#v::-webkit-media-controls-overflow-menu{display:none!important}
.wm{position:absolute;pointer-events:none;user-select:none;z-index:10;font-family:'Courier New',monospace;font-weight:800;white-space:nowrap;letter-spacing:2px;text-shadow:0 0 6px rgba(0,0,0,.9),2px 2px 4px rgba(0,0,0,.8)}
#wm1{color:rgba(255,255,255,.30);font-size:clamp(14px,2.5vw,24px);animation:wm1 15s linear infinite}
#wm2{color:rgba(255,255,255,.20);font-size:clamp(12px,2vw,20px);animation:wm2 18s linear infinite}
@keyframes wm1{0%{top:15%;left:-50%}25%{top:50%;left:65%}50%{top:75%;left:10%}75%{top:35%;left:75%}100%{top:15%;left:-50%}}
@keyframes wm2{0%{top:70%;left:110%}25%{top:25%;left:20%}50%{top:55%;left:75%}75%{top:15%;left:45%}100%{top:70%;left:110%}}
#ctrl{position:absolute;bottom:0;left:0;right:0;z-index:20;background:linear-gradient(transparent,rgba(0,0,0,.85));padding:20px 16px 12px;display:flex;align-items:center;gap:10px;opacity:0;transition:opacity .3s}
body:hover #ctrl,body.sc #ctrl{opacity:1}
#pw{flex:1;height:5px;background:rgba(255,255,255,.2);border-radius:5px;cursor:pointer;position:relative}
#pgb{height:100%;background:linear-gradient(90deg,#6c5ce7,#00cec9);border-radius:5px;width:0%;pointer-events:none;transition:width .1s}
#buf{position:absolute;top:0;left:0;height:100%;background:rgba(255,255,255,.1);border-radius:5px;pointer-events:none}
.cb{background:none;border:none;color:#fff;font-size:1.2rem;cursor:pointer;padding:4px 8px;border-radius:4px;flex-shrink:0}
.cb:hover{background:rgba(255,255,255,.15)}
#td{color:rgba(255,255,255,.8);font-size:.75rem;font-family:monospace;white-space:nowrap;flex-shrink:0}
#vs{width:55px;accent-color:#6c5ce7;flex-shrink:0}
#ld{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:30;text-align:center;color:#fff}
.spin{width:40px;height:40px;border:3px solid rgba(255,255,255,.1);border-top-color:#6c5ce7;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 10px}
@keyframes spin{to{transform:rotate(360deg)}}
@media(hover:none){#ctrl{opacity:1!important}#vs{display:none}}
</style></head>
<body oncontextmenu="return false" ondragstart="return false" onselectstart="return false">
<video id="v" playsinline webkit-playsinline preload="auto" controlsList="nodownload noplaybackrate" disablePictureInPicture disableRemotePlayback oncontextmenu="return false"></video>
<div class="wm" id="wm1">${wmShort}</div><div class="wm" id="wm2">${wmShort}</div>
<div id="ld"><div class="spin"></div><p style="font-size:.85rem;color:rgba(255,255,255,.6)">Loading...</p></div>
<div id="ctrl">
<button class="cb" id="pb" onclick="tp()">▶</button>
<div id="pw" onclick="sk(event)"><div id="buf"></div><div id="pgb"></div></div>
<span id="td">0:00 / 0:00</span>
<button class="cb" id="mb" onclick="tm()">🔊</button>
<input id="vs" type="range" min="0" max="1" step="0.05" value="1" oninput="document.getElementById('v').volume=this.value">
<button class="cb" onclick="tfs()">⛶</button>
</div>
<script>
var v=document.getElementById('v'),pb=document.getElementById('pb'),pgb=document.getElementById('pgb'),buf=document.getElementById('buf'),td=document.getElementById('td'),ld=document.getElementById('ld');
var SRC='${playerSrc}';
var IS_HLS=${useHLS};

if(IS_HLS&&typeof Hls!=='undefined'&&Hls.isSupported()){
    var hls=new Hls({enableWorker:true});
    hls.loadSource(SRC);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED,function(){ld.style.display='none';v.play().catch(function(){});});
    hls.on(Hls.Events.ERROR,function(ev,data){if(data.fatal)ld.innerHTML='<p style="color:#ff4757">Error loading. Refresh page.</p>';});
}else if(IS_HLS&&v.canPlayType('application/vnd.apple.mpegurl')){
    v.src=SRC;v.addEventListener('loadedmetadata',function(){ld.style.display='none';v.play().catch(function(){});});
}else{
    v.innerHTML='<source src="'+SRC+'" type="video/mp4">';v.load();
    v.addEventListener('canplay',function(){ld.style.display='none';v.play().catch(function(){});});
}

v.addEventListener('waiting',function(){ld.style.display='block';});
v.addEventListener('playing',function(){ld.style.display='none';});
function tp(){if(v.paused){v.play();pb.textContent='⏸';}else{v.pause();pb.textContent='▶';}}
function tm(){v.muted=!v.muted;document.getElementById('mb').textContent=v.muted?'🔇':'🔊';}
function tfs(){if(document.fullscreenElement||document.webkitFullscreenElement){(document.exitFullscreen||document.webkitExitFullscreen).call(document);}else{var el=document.documentElement;(el.requestFullscreen||el.webkitRequestFullscreen||el.msRequestFullscreen).call(el);}}
function sk(e){var r=document.getElementById('pw').getBoundingClientRect();var p=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));if(v.duration)v.currentTime=p*v.duration;}
function fmt(s){if(!s||isNaN(s))return'0:00';var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=Math.floor(s%60);if(h>0)return h+':'+(m<10?'0':'')+m+':'+(sc<10?'0':'')+sc;return m+':'+(sc<10?'0':'')+sc;}
v.addEventListener('timeupdate',function(){if(!v.duration)return;pgb.style.width=(v.currentTime/v.duration*100)+'%';td.textContent=fmt(v.currentTime)+' / '+fmt(v.duration);});
v.addEventListener('progress',function(){if(v.buffered.length>0&&v.duration){buf.style.width=(v.buffered.end(v.buffered.length-1)/v.duration*100)+'%';}});
v.addEventListener('ended',function(){pb.textContent='↩';});
v.addEventListener('pause',function(){pb.textContent='▶';});
v.addEventListener('play',function(){pb.textContent='⏸';});
v.addEventListener('error',function(){ld.innerHTML='<p style="color:#ff4757">Error loading video.<br>Please refresh.</p>';});
document.body.addEventListener('touchstart',function(){document.body.classList.toggle('sc');});
document.addEventListener('keydown',function(e){if(e.target.tagName==='INPUT')return;switch(e.key){case' ':case'k':e.preventDefault();tp();break;case'f':e.preventDefault();tfs();break;case'm':e.preventDefault();tm();break;case'ArrowLeft':e.preventDefault();v.currentTime=Math.max(0,(v.currentTime||0)-10);break;case'ArrowRight':e.preventDefault();v.currentTime=Math.min(v.duration||0,(v.currentTime||0)+10);break;case'ArrowUp':e.preventDefault();v.volume=Math.min(1,v.volume+.1);break;case'ArrowDown':e.preventDefault();v.volume=Math.max(0,v.volume-.1);break;}if(e.ctrlKey||e.metaKey||e.key==='F12'){e.preventDefault();return false;}});
document.addEventListener('contextmenu',function(e){e.preventDefault();});
document.addEventListener('dragstart',function(e){e.preventDefault();});
document.addEventListener('copy',function(e){e.preventDefault();});
v.addEventListener('contextmenu',function(e){e.preventDefault();return false;});
v.addEventListener('enterpictureinpicture',function(){document.exitPictureInPicture&&document.exitPictureInPicture();});
if(window===window.top){document.body.innerHTML='<div style="background:#0a0a1a;color:#ff4757;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;text-align:center;"><div><h1 style="font-size:4rem">🚫</h1><h2>Direct Access Blocked</h2></div></div>';}
</script></body></html>`);
    } catch (e) { console.error('Frame error:', e); res.status(500).send(errorPage('Error.')); }
});

// HLS ROUTES
router.get('/hls/:sessionId/playlist.m3u8', (req, res) => {
    const fp = getHLSFilePath(req.params.sessionId, 'playlist.m3u8');
    if (!fp) return res.status(404).send('Not found.');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(fp);
});

router.get('/hls/:sessionId/:segment', (req, res) => {
    if (!req.params.segment.match(/^seg\d+\.ts$/)) return res.status(400).send('Invalid.');
    const fp = getHLSFilePath(req.params.sessionId, req.params.segment);
    if (!fp) return res.status(404).send('Not found.');
    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(fp);
});

router.get('/hls-key/:sessionId', async (req, res) => {
    const key = getEncryptionKey(req.params.sessionId);
    if (!key) return res.status(403).send('Expired.');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.send(key);
});

// PROXY ROUTE
router.get('/proxy/:proxyToken', async (req, res) => {
    try {
        const s = proxyTokens.get(req.params.proxyToken);
        if (!s) return res.status(403).send('Denied.');
        if (Date.now() > s.expires) { proxyTokens.delete(req.params.proxyToken); return res.status(403).send('Expired.'); }
        const cip = getClientIP(req);
        if (s.clientIP !== 'unknown' && cip !== 'unknown' && s.clientIP !== cip) { proxyTokens.delete(req.params.proxyToken); return res.status(403).send('IP mismatch.'); }
        s.requestCount = (s.requestCount||0)+1;
        if (s.requestCount > 1000) { proxyTokens.delete(req.params.proxyToken); return res.status(429).send('Limit.'); }
        const u = await User.findById(s.userId).select('isBlocked isActive');
        if (!u || u.isBlocked || !u.isActive) return res.status(403).send('Suspended.');
        const { res: dr, status, headers } = await fetchDriveStream(s.fileId, req.headers.range);
        const oh = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store, private', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' };
        if (headers['content-length']) oh['Content-Length'] = headers['content-length'];
        if (headers['content-range']) oh['Content-Range'] = headers['content-range'];
        res.writeHead(status, oh);
        dr.pipe(res);
        dr.on('error', e => console.error('Err:', e.message));
        req.on('close', () => dr.destroy());
    } catch (e) { if (!res.headersSent) res.status(500).send('Error.'); }
});

router.post('/refresh-session', auth, async (req, res) => {
    try {
        const { sessionToken } = req.body;
        const s = videoSessions.get(sessionToken);
        if (!s || s.userId !== req.user._id.toString()) return res.status(403).json({ success: false });
        s.expires = Date.now() + (2*60*60*1000);
        s.loadCount = 0;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

module.exports = router;
