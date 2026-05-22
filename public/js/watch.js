// public/js/watch.js
(function () {
    'use strict';

    const API = '/api';
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    if (!token) { window.location.href = '/login.html'; return; }

    const videoId = new URLSearchParams(window.location.search).get('id');
    if (!videoId) { window.location.href = '/dashboard.html'; return; }

    const wrapper = document.getElementById('playerWrapper');
    let currentSessionToken = null;
    let sessionRefreshInterval = null;
    let violationCount = 0;
    let alreadyBanned = false;
    let screenRecordingDetected = false;

    // =============================================
    // BAN USER
    // =============================================
    async function banUser(reason) {
        if (alreadyBanned) return;
        alreadyBanned = true;

        // Stop video immediately
        const frame = document.getElementById('videoFrame');
        if (frame) frame.src = '';

        try {
            await fetch(`${API}/auth/report-violation`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ reason })
            });
        } catch (e) { }

        showBanScreen(reason);
    }

    function showBanScreen(reason) {
        if (sessionRefreshInterval) clearInterval(sessionRefreshInterval);

        document.body.innerHTML = `
            <div style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:#0a0a1a;display:flex;align-items:center;justify-content:center;z-index:99999;padding:20px;">
                <div style="text-align:center;max-width:500px;">
                    <div style="font-size:5rem;margin-bottom:20px;">🚫</div>
                    <h1 style="color:#ff4757;font-size:1.8rem;margin-bottom:12px;">Account Suspended</h1>
                    <p style="color:#8888aa;line-height:1.7;margin-bottom:20px;">
                        Your account has been permanently suspended due to violation of our terms of service.
                    </p>
                    <div style="background:rgba(255,71,87,0.1);border:1px solid rgba(255,71,87,0.3);border-radius:10px;padding:16px;margin-bottom:20px;">
                        <p style="color:#ff6b6b;font-size:0.85rem;font-weight:600;">
                            Reason: ${reason}
                        </p>
                    </div>
                    <p style="color:#555;font-size:0.8rem;">
                        Your identity (${user.name || ''} - ${user.email || ''}) has been logged.
                        Contact admin if you believe this is a mistake.
                    </p>
                </div>
            </div>
        `;
        localStorage.clear();
    }

    function addViolation(reason) {
        violationCount++;
        if (violationCount >= 3) {
            banUser(reason);
        } else {
            showWarningPopup(reason, violationCount);
        }
    }

    function showWarningPopup(reason, count) {
        // Add red watermarks
        for (let i = 0; i < 8; i++) {
            const el = document.createElement('div');
            el.textContent = `⚠️ WARNING ${count}/3: ${user.name} - ${user.email}`;
            el.style.cssText = `
                position:absolute;
                top:${8 + i * 10}%;
                left:2%;
                color:rgba(255,0,0,0.45);
                font-size:clamp(13px,2vw,20px);
                z-index:100;
                pointer-events:none;
                white-space:nowrap;
                font-family:'Courier New',monospace;
                font-weight:bold;
                text-shadow:0 0 5px rgba(0,0,0,0.8);
            `;
            wrapper.appendChild(el);
        }

        const popup = document.createElement('div');
        popup.style.cssText = `
            position:fixed;
            top:20px;
            left:50%;
            transform:translateX(-50%);
            background:rgba(255,71,87,0.97);
            color:#fff;
            padding:16px 28px;
            border-radius:12px;
            z-index:9999;
            font-family:-apple-system,sans-serif;
            font-size:0.9rem;
            font-weight:600;
            box-shadow:0 10px 30px rgba(0,0,0,0.5);
            text-align:center;
            max-width:90%;
        `;
        popup.innerHTML = `
            ⚠️ WARNING ${count}/3: Suspicious activity detected!<br>
            <span style="font-size:0.78rem;opacity:0.9;">${reason}</span><br>
            <span style="font-size:0.75rem;opacity:0.7;">Your account will be permanently banned on next violation.</span>
        `;
        document.body.appendChild(popup);
        setTimeout(() => { if (popup.parentNode) popup.remove(); }, 6000);
    }

    // =============================================
    // SCREEN RECORDING DETECTION
    // =============================================
    async function setupScreenRecordingDetection() {

        // METHOD 1: Block getDisplayMedia (browser screen capture API)
        if (navigator.mediaDevices) {
            const origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia?.bind(navigator.mediaDevices);
            navigator.mediaDevices.getDisplayMedia = async function (constraints) {
                // They tried to screen record via browser
                await banUser('Screen recording attempt detected via browser API (getDisplayMedia)');
                return Promise.reject(new Error('Screen recording is not permitted on this platform.'));
            };
        }

        // Also block on window level
        if (window.navigator.mediaDevices) {
            Object.defineProperty(window.navigator.mediaDevices, 'getDisplayMedia', {
                value: async function () {
                    await banUser('Screen recording attempt via getDisplayMedia override');
                    return Promise.reject(new Error('Not allowed'));
                },
                writable: false,
                configurable: false
            });
        }

        // METHOD 2: Detect MediaRecorder usage
        const OrigMediaRecorder = window.MediaRecorder;
        if (OrigMediaRecorder) {
            window.MediaRecorder = function (stream, options) {
                // Check if the stream contains display/screen tracks
                if (stream && stream.getVideoTracks) {
                    const tracks = stream.getVideoTracks();
                    tracks.forEach(track => {
                        if (track.label && (
                            track.label.toLowerCase().includes('screen') ||
                            track.label.toLowerCase().includes('display') ||
                            track.label.toLowerCase().includes('monitor') ||
                            track.label.toLowerCase().includes('entire') ||
                            track.label.toLowerCase().includes('window')
                        )) {
                            banUser('Screen recording detected via MediaRecorder API');
                        }
                    });
                }
                return new OrigMediaRecorder(stream, options);
            };
            window.MediaRecorder.prototype = OrigMediaRecorder.prototype;
            window.MediaRecorder.isTypeSupported = OrigMediaRecorder.isTypeSupported;
        }

        // METHOD 3: Monitor getUserMedia for screen capture
        if (navigator.mediaDevices?.getUserMedia) {
            const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = async function (constraints) {
                if (constraints && (constraints.video?.displaySurface ||
                    constraints.video?.cursor ||
                    JSON.stringify(constraints).includes('screen'))) {
                    await banUser('Screen capture attempt detected via getUserMedia');
                    return Promise.reject(new Error('Not allowed'));
                }
                return origGetUserMedia(constraints);
            };
        }

        // METHOD 4: Detect Picture-in-Picture (often used to record)
        document.addEventListener('enterpictureinpicture', async (e) => {
            e.preventDefault();
            document.exitPictureInPicture?.().catch(() => { });
            await banUser('Picture-in-Picture recording attempt detected');
        });

        // METHOD 5: Page Visibility API
        // When recording software alt-tabs, visibility changes rapidly
        let hiddenCount = 0;
        let hiddenTimer = null;
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                hiddenCount++;
                // More than 20 rapid tab switches is suspicious
                if (hiddenCount > 20) {
                    addViolation('Excessive tab switching detected - possible screen recording software');
                }
            }
        });

        // METHOD 6: Detect screen sharing via WebRTC
        // Some screen recorders use WebRTC internally
        if (window.RTCPeerConnection) {
            const OrigRTC = window.RTCPeerConnection;
            window.RTCPeerConnection = function (...args) {
                const pc = new OrigRTC(...args);
                // Monitor for display media tracks added
                pc.addEventListener('track', (e) => {
                    if (e.track && e.track.kind === 'video') {
                        const settings = e.track.getSettings?.();
                        if (settings && settings.displaySurface) {
                            banUser('Screen sharing via WebRTC detected');
                        }
                    }
                });
                return pc;
            };
            window.RTCPeerConnection.prototype = OrigRTC.prototype;
        }

        // METHOD 7: Monitor for OBS/Recording software via performance
        // Recording software causes slight but detectable frame rate drops
        let frameDropCount = 0;
        let lastFrameTime = performance.now();
        function checkFrameRate() {
            const now = performance.now();
            const delta = now - lastFrameTime;
            lastFrameTime = now;

            // If frame time is unusually high (>200ms), might be recording
            if (delta > 200 && delta < 5000) {
                frameDropCount++;
                if (frameDropCount > 10) {
                    // Too many frame drops = possible recording
                    // Don't ban immediately as this could be slow internet
                    // Just add extra watermarks
                    addExtraWatermarks();
                    frameDropCount = 0;
                }
            }
            requestAnimationFrame(checkFrameRate);
        }
        requestAnimationFrame(checkFrameRate);

        // METHOD 8: Keyboard shortcuts used by recording software
        document.addEventListener('keydown', e => {
            const recordingShortcuts = [
                // OBS shortcuts
                e.ctrlKey && e.altKey && e.key === 'r',
                e.ctrlKey && e.altKey && e.key === 'R',
                // Bandicam
                e.key === 'F12' && !e.ctrlKey,
                // Camtasia
                e.ctrlKey && e.shiftKey && e.key === 'F9',
                // Windows Game Bar
                e.metaKey && e.altKey && e.key === 'r',
                e.metaKey && e.altKey && e.key === 'R',
                // Mac QuickTime / Screenshot
                e.metaKey && e.shiftKey && e.key === '5',
                e.metaKey && e.shiftKey && e.key === '6',
                // ShareX
                e.ctrlKey && e.shiftKey && e.key === 'F1',
                // Snagit
                e.ctrlKey && e.shiftKey && e.key === 'p',
                e.ctrlKey && e.shiftKey && e.key === 'P',
            ];

            if (recordingShortcuts.some(s => s)) {
                e.preventDefault();
                e.stopPropagation();
                banUser('Screen recording keyboard shortcut detected');
                return false;
            }
        }, true);
    }

    // Add extra visible watermarks when suspicious activity detected
    function addExtraWatermarks() {
        if (!wrapper) return;
        const el = document.createElement('div');
        el.textContent = `${user.name} | ${user.email} | ${new Date().toLocaleString()}`;
        el.style.cssText = `
            position:absolute;
            top:${Math.random() * 80 + 5}%;
            left:${Math.random() * 50 + 10}%;
            color:rgba(255,255,255,0.20);
            font-size:clamp(14px,2.2vw,22px);
            z-index:50;
            pointer-events:none;
            white-space:nowrap;
            font-family:'Courier New',monospace;
            font-weight:bold;
            text-shadow:0 0 5px rgba(0,0,0,0.8);
            transform:rotate(${Math.random() * 20 - 10}deg);
        `;
        wrapper.appendChild(el);

        // Remove after 10 seconds
        setTimeout(() => { if (el.parentNode) el.remove(); }, 10000);
    }

    // Make watermarks MORE visible when screen recording suspected
    function maxWatermarkMode() {
        if (!wrapper) return;

        // Add 20 bright watermarks
        for (let i = 0; i < 20; i++) {
            const el = document.createElement('div');
            el.textContent = `${user.name} • ${user.email} • SxS INNER CIRCLE`;
            el.style.cssText = `
                position:absolute;
                top:${Math.random() * 85 + 2}%;
                left:${Math.random() * 60 + 5}%;
                color:rgba(255,255,255,0.30);
                font-size:clamp(16px,2.5vw,26px);
                z-index:50;
                pointer-events:none;
                white-space:nowrap;
                font-family:'Courier New',monospace;
                font-weight:bold;
                text-shadow:0 0 8px rgba(0,0,0,0.9),2px 2px 4px rgba(0,0,0,0.8);
                transform:rotate(${Math.random() * 30 - 15}deg);
                animation: wmPulseExtra 3s ease-in-out infinite;
            `;
            wrapper.appendChild(el);
        }
    }

    // =============================================
    // LOAD VIDEO
    // =============================================
    async function loadVideo() {
        try {
            const res = await fetch(`${API}/videos/watch/${videoId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            const data = await res.json();

            if (data.blocked) {
                showBanScreen(data.message);
                return;
            }

            if (!data.success) {
                alert(data.message || 'Video not found');
                window.location.href = '/dashboard.html';
                return;
            }

            const { video, watermark, sessionToken } = data;
            currentSessionToken = sessionToken;

            // Set video info
            document.getElementById('videoTitle').textContent = video.title || 'Video';
            document.getElementById('videoDescription').textContent = video.description || '';
            document.getElementById('videoMentorship').textContent = `📂 ${video.mentorship || ''}`;
            document.getElementById('videoViews').textContent = `👁 ${video.viewCount || 0} views`;
            document.getElementById('videoDate').textContent = `📅 ${video.createdAt ? new Date(video.createdAt).toLocaleDateString() : ''}`;
            document.getElementById('wmPreview').textContent = `${watermark.name} • ${watermark.email}`;
            document.title = `${video.title || 'Watch'} - SxS Inner Circle`;

            // Load secure frame
            const frame = document.getElementById('videoFrame');
            frame.src = `${API}/videos/secure-frame/${sessionToken}`;
            frame.style.display = 'block';

            frame.addEventListener('load', () => {
                const loading = document.getElementById('playerLoading');
                if (loading) loading.style.display = 'none';
            });

            setTimeout(() => {
                const loading = document.getElementById('playerLoading');
                if (loading) loading.style.display = 'none';
            }, 5000);

// Build watermarks only if enabled
if (data.watermarkEnabled && watermark) {
    buildWatermarks(watermark);
}

            // Setup fullscreen
            setupFullscreen();

            // Setup screen recording detection
            await setupScreenRecordingDetection();

            // Refresh session every 30 minutes
            sessionRefreshInterval = setInterval(refreshSession, 30 * 60 * 1000);

            // Periodically boost watermarks every 5 minutes
            setInterval(() => {
                addExtraWatermarks();
            }, 5 * 60 * 1000);

        } catch (err) {
            console.error('loadVideo error:', err);
            alert('Error loading video.');
            window.location.href = '/dashboard.html';
        }
    }

    async function refreshSession() {
        try {
            await fetch(`${API}/videos/refresh-session`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ sessionToken: currentSessionToken, videoId })
            });
        } catch (e) { }
    }

    // =============================================
    // FULLSCREEN
    // =============================================
    function setupFullscreen() {
        const fsBtn = document.getElementById('fullscreenBtn');
        if (fsBtn) fsBtn.addEventListener('click', toggleFullscreen);
        document.addEventListener('fullscreenchange', updateFS);
        document.addEventListener('webkitfullscreenchange', updateFS);
    }

    function toggleFullscreen() {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            document.exitFullscreen?.() || document.webkitExitFullscreen?.();
        } else {
            wrapper.requestFullscreen?.() || wrapper.webkitRequestFullscreen?.();
        }
    }

    function updateFS() {
        const isFS = document.fullscreenElement || document.webkitFullscreenElement;
        const fsBtn = document.getElementById('fullscreenBtn');
        if (fsBtn) fsBtn.textContent = isFS ? '✕' : '⛶';
    }

    // =============================================
    // WATERMARK SYSTEM - 6 LAYERS
    // =============================================
    function buildWatermarks(wm) {
        const wmFull = `${wm.name}  •  ${wm.email}  •  ID:${wm.id}`;
        const wmShort = `${wm.name}  |  ${wm.email}`;
        const wmMini = `${wm.name}  #${wm.id}`;

        // LAYER 1: 6 Moving watermarks
        const layer1 = document.getElementById('wmLayer1');
        [
            { cls: 'wm-move-1', text: wmFull },
            { cls: 'wm-move-2', text: wmShort },
            { cls: 'wm-move-3', text: wmFull },
            { cls: 'wm-move-4', text: wmShort },
            { cls: 'wm-move-5', text: wmFull },
            { cls: 'wm-move-6', text: wmShort }
        ].forEach(item => {
            const el = document.createElement('div');
            el.className = `wm-text ${item.cls}`;
            el.textContent = item.text;
            layer1.appendChild(el);
        });

        // LAYER 2: Static grid
        const grid = document.getElementById('wmGrid');
        for (let i = 0; i < 80; i++) {
            const item = document.createElement('div');
            item.className = 'wm-grid-item';
            item.textContent = i % 3 === 0 ? wmFull : wmShort;
            grid.appendChild(item);
        }

        // LAYER 3: Center pulse
        document.getElementById('wmCenter').textContent = wmFull;

        // LAYER 4: Corners + live timestamp
        document.getElementById('wmTL').textContent = wmShort;
        document.getElementById('wmTR').textContent = `ID: ${wm.id}`;
        document.getElementById('wmBL').textContent = wm.email;
        document.getElementById('wmBR').textContent = new Date().toLocaleString();
        setInterval(() => {
            const el = document.getElementById('wmBR');
            if (el) el.textContent = new Date().toLocaleString();
        }, 1000);

        // LAYER 5: Random repositioning
        function spawnRandom() {
            const existing = wrapper.querySelectorAll('.wm-random');
            if (existing.length > 10) existing[0].remove();
            const el = document.createElement('div');
            el.className = 'wm-random';
            el.textContent = Math.random() > 0.5 ? wmShort : wmMini;
            el.style.top = `${Math.random() * 70 + 5}%`;
            el.style.left = `${Math.random() * 55 + 10}%`;
            el.style.transform = `rotate(${Math.random() * 30 - 15}deg)`;
            wrapper.appendChild(el);
            setTimeout(() => {
                el.style.top = `${Math.random() * 70 + 5}%`;
                el.style.left = `${Math.random() * 55 + 10}%`;
            }, 200);
        }
        for (let i = 0; i < 5; i++) spawnRandom();
        setInterval(spawnRandom, 5000);

        // LAYER 6: Canvas
        createCanvas(wmShort, `${wm.email}|${wm.id}`);
    }

    function createCanvas(mainText, forensicText) {
        const old = wrapper.querySelector('.wm-canvas');
        if (old) old.remove();

        const canvas = document.createElement('canvas');
        canvas.className = 'wm-canvas';
        canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:13;';
        const rect = wrapper.getBoundingClientRect();
        canvas.width = Math.max(rect.width * 2, 1920);
        canvas.height = Math.max(rect.height * 2, 1080);
        const ctx = canvas.getContext('2d');

        ctx.font = 'bold 16px Courier New';
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        for (let y = 30; y < canvas.height; y += 80) {
            for (let x = 0; x < canvas.width; x += 400) {
                ctx.save(); ctx.translate(x, y); ctx.rotate(-0.35);
                ctx.fillText(mainText, 0, 0); ctx.restore();
            }
        }

        ctx.font = 'bold 10px Courier New';
        ctx.fillStyle = 'rgba(255,255,255,0.015)';
        for (let y = 50; y < canvas.height; y += 55) {
            for (let x = 80; x < canvas.width; x += 300) {
                ctx.save(); ctx.translate(x, y); ctx.rotate(0.2);
                ctx.fillText(`${forensicText}|${Date.now()}`, 0, 0); ctx.restore();
            }
        }

        wrapper.appendChild(canvas);
        setTimeout(() => createCanvas(mainText, forensicText), 30000);
    }

    // =============================================
    // ANTI PIRACY - BLOCK + BAN
    // =============================================

    // Block right click
    document.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        addViolation('Right-click attempt');
        return false;
    }, true);

    // Block keyboard shortcuts
    document.addEventListener('keydown', e => {
        if (e.key === 'F12') {
            e.preventDefault();
            banUser('DevTools opened via F12');
            return false;
        }
        if (e.ctrlKey && e.shiftKey && ['i','I','j','J','c','C','k','K'].includes(e.key)) {
            e.preventDefault();
            banUser('DevTools opened via keyboard shortcut');
            return false;
        }
        if (e.ctrlKey && e.key === 'u') {
            e.preventDefault();
            banUser('View source attempt');
            return false;
        }
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            addViolation('Save page attempt');
            return false;
        }
        if (e.ctrlKey && e.key === 'p') {
            e.preventDefault();
            addViolation('Print attempt');
            return false;
        }
        if (e.metaKey && e.altKey && ['i','I','j','J'].includes(e.key)) {
            e.preventDefault();
            banUser('DevTools opened via Mac shortcut');
            return false;
        }
        if (e.key === 'PrintScreen') {
            e.preventDefault();
            navigator.clipboard?.writeText?.('');
            addViolation('Screenshot attempt');
            return false;
        }
        if (e.metaKey && e.shiftKey && ['3','4','5','6'].includes(e.key)) {
            e.preventDefault();
            addViolation('Screenshot attempt');
            return false;
        }
        if (e.key === 'f' || e.key === 'F') {
            e.preventDefault();
            toggleFullscreen();
        }
    }, true);

    // Block drag
    document.addEventListener('dragstart', e => e.preventDefault(), true);

    // Block copy
    document.addEventListener('copy', e => {
        e.preventDefault();
        addViolation('Copy attempt');
    }, true);

    // DevTools window size detection
    let devToolsDetected = false;
    setInterval(() => {
        const w = window.outerWidth - window.innerWidth > 160;
        const h = window.outerHeight - window.innerHeight > 160;
        if ((w || h) && !devToolsDetected) {
            devToolsDetected = true;
            banUser('Browser DevTools opened (window size detection)');
        }
    }, 1000);

    // DevTools debugger detection
    let dbgChecks = 0;
    setInterval(() => {
        const start = performance.now();
        (function () { debugger; })();
        if (performance.now() - start > 100) {
            dbgChecks++;
            if (dbgChecks >= 2) banUser('DevTools debugger detected');
        }
    }, 5000);

    // Console object detection
    const devImg = new Image();
    Object.defineProperty(devImg, 'id', {
        get: function () {
            banUser('DevTools console opened');
        }
    });
    setInterval(() => { console.log('%c', devImg); }, 3000);

    // Watermark integrity check
// Watermark integrity check (only if watermarks enabled)
setInterval(() => {
    // Skip check if watermarks are disabled
    if (!wrapper.querySelector('.watermark-layer')) return;

    const layers = wrapper.querySelectorAll('.watermark-layer, .wm-center, .wm-corner');
    if (layers.length < 6) {
        banUser('Watermark tampering - DOM elements removed');
    }
}, 3000);

    // MutationObserver
    const observer = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
            mutation.removedNodes.forEach(node => {
                if (node.classList && (
                    node.classList.contains('watermark-layer') ||
                    node.classList.contains('wm-center') ||
                    node.classList.contains('wm-corner') ||
                    node.classList.contains('wm-canvas')
                )) {
                    wrapper.appendChild(node);
                    addViolation('DOM tampering - watermark removed');
                }
            });
        });
    });
    observer.observe(wrapper, { childList: true, subtree: false });

    // Block iframe embedding
    if (window.top !== window.self) {
        document.body.innerHTML = '<h1 style="color:red;text-align:center;padding:50px;">Embedding not allowed</h1>';
    }

    // Disable console
    const noop = () => {};
    try {
        ['log','debug','info','warn','error','table','trace','dir'].forEach(m => {
            window.console[m] = noop;
        });
    } catch (e) { }

    // Cleanup on leave
    window.addEventListener('beforeunload', () => {
        if (sessionRefreshInterval) clearInterval(sessionRefreshInterval);
    });

    window.logout = function () {
        localStorage.clear();
        window.location.href = '/login.html';
    };

    // START
    loadVideo();

})();
