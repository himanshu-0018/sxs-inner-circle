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

    // =============================================
    // BAN USER - Report to Server & Lock Screen
    // =============================================
    async function banUser(reason) {
        if (alreadyBanned) return;
        alreadyBanned = true;

        try {
            await fetch(`${API}/auth/report-violation`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ reason })
            });
        } catch (e) {
            // Silent fail
        }

        // Lock the entire screen
        showBanScreen(reason);
    }

    function showBanScreen(reason) {
        // Stop video
        const frame = document.getElementById('videoFrame');
        if (frame) frame.src = '';

        // Clear all intervals
        if (sessionRefreshInterval) clearInterval(sessionRefreshInterval);

        // Replace entire body
        document.body.innerHTML = `
            <div style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:#0a0a1a;display:flex;align-items:center;justify-content:center;z-index:99999;">
                <div style="text-align:center;padding:40px;max-width:500px;">
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
                        Your identity (${user.name} - ${user.email}) has been logged.
                        Contact admin if you believe this is a mistake.
                    </p>
                </div>
            </div>
        `;

        // Clear localStorage
        localStorage.clear();
    }

    function addViolation(reason) {
        violationCount++;

        // First 2 violations = warning
        // 3rd violation = BAN
        if (violationCount >= 3) {
            banUser(reason);
        } else {
            showWarning(reason);
        }
    }

    function showWarning(reason) {
        // Add red watermarks as warning
        for (let i = 0; i < 8; i++) {
            const el = document.createElement('div');
            el.textContent = `⚠️ WARNING: ${user.name} - ${user.email} - ${reason}`;
            el.style.cssText = `
                position:absolute;
                top:${8 + i * 10}%;
                left:2%;
                color:rgba(255,0,0,0.45);
                font-size:clamp(14px,2.5vw,22px);
                z-index:100;
                pointer-events:none;
                white-space:nowrap;
                font-family:'Courier New',monospace;
                font-weight:bold;
                text-shadow:0 0 5px rgba(0,0,0,0.8);
            `;
            wrapper.appendChild(el);
        }

        // Show warning popup
        const popup = document.createElement('div');
        popup.style.cssText = `
            position:fixed;
            top:20px;
            left:50%;
            transform:translateX(-50%);
            background:rgba(255,71,87,0.95);
            color:#fff;
            padding:15px 30px;
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
            ⚠️ WARNING ${violationCount}/3: Suspicious activity detected!<br>
            <span style="font-size:0.78rem;opacity:0.8;">Your account will be permanently banned on next violation.</span>
        `;
        document.body.appendChild(popup);

        setTimeout(() => popup.remove(), 5000);
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

            // Build watermarks
            buildWatermarks(watermark);

            // Setup fullscreen
            setupFullscreen();

            // Refresh session every 30 minutes
            sessionRefreshInterval = setInterval(refreshSession, 30 * 60 * 1000);

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

        // LAYER 4: Corners
        document.getElementById('wmTL').textContent = wmShort;
        document.getElementById('wmTR').textContent = `ID: ${wm.id}`;
        document.getElementById('wmBL').textContent = wm.email;
        document.getElementById('wmBR').textContent = new Date().toLocaleString();
        setInterval(() => {
            const el = document.getElementById('wmBR');
            if (el) el.textContent = new Date().toLocaleString();
        }, 1000);

        // LAYER 5: Random
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
                ctx.fillText(forensicText, 0, 0); ctx.restore();
            }
        }

        wrapper.appendChild(canvas);
        setTimeout(() => createCanvas(mainText, forensicText), 30000);
    }

    // =============================================
    // ANTI PIRACY - DETECTION & AUTO BAN SYSTEM
    // =============================================

    // 1. Block right click
    document.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        addViolation('Right-click attempt detected');
        return false;
    }, true);

    // 2. Block dangerous keyboard shortcuts
    document.addEventListener('keydown', e => {
        // DevTools shortcuts
        if (e.key === 'F12') {
            e.preventDefault();
            e.stopPropagation();
            banUser('DevTools opened via F12 key');
            return false;
        }

        if (e.ctrlKey && e.shiftKey && ['i', 'I', 'j', 'J', 'c', 'C'].includes(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            banUser('DevTools opened via keyboard shortcut');
            return false;
        }

        // Source code / save shortcuts
        if (e.ctrlKey && e.key === 'u') {
            e.preventDefault();
            e.stopPropagation();
            banUser('View source attempt detected');
            return false;
        }

        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            e.stopPropagation();
            addViolation('Save page attempt');
            return false;
        }

        if (e.ctrlKey && e.key === 'p') {
            e.preventDefault();
            addViolation('Print attempt');
            return false;
        }

        // Mac DevTools
        if (e.metaKey && e.altKey && ['i', 'I', 'j', 'J', 'c', 'C'].includes(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            banUser('DevTools opened via Mac shortcut');
            return false;
        }

        // Mac screenshots
        if (e.metaKey && e.shiftKey && ['3', '4', '5'].includes(e.key)) {
            e.preventDefault();
            addViolation('Screenshot attempt');
            return false;
        }

        // PrintScreen
        if (e.key === 'PrintScreen') {
            e.preventDefault();
            navigator.clipboard?.writeText?.('');
            addViolation('Screenshot attempt');
            return false;
        }

        // Fullscreen toggle
        if (e.key === 'f' || e.key === 'F') {
            e.preventDefault();
            toggleFullscreen();
        }
    }, true);

    // 3. Block drag
    document.addEventListener('dragstart', e => { e.preventDefault(); }, true);

    // 4. DevTools detection via window size
    let devToolsDetected = false;
    setInterval(() => {
        const widthDiff = window.outerWidth - window.innerWidth > 160;
        const heightDiff = window.outerHeight - window.innerHeight > 160;

        if ((widthDiff || heightDiff) && !devToolsDetected) {
            devToolsDetected = true;
            banUser('Browser Developer Tools opened (window size anomaly detected)');
        }
    }, 1000);

    // 5. DevTools detection via debugger timing
    let debuggerChecks = 0;
    function checkDebugger() {
        const start = performance.now();
        // debugger statement only pauses when DevTools is open
        (function() { debugger; })();
        const duration = performance.now() - start;

        if (duration > 100) {
            debuggerChecks++;
            if (debuggerChecks >= 2) {
                banUser('Browser Developer Tools detected (debugger timing anomaly)');
            }
        }
    }
    // Run debugger check every 5 seconds
    setInterval(checkDebugger, 5000);

    // 6. DevTools detection via console.log override
    const devtoolsDetector = new Image();
    Object.defineProperty(devtoolsDetector, 'id', {
        get: function () {
            banUser('Browser DevTools console opened (object inspection detected)');
        }
    });
    setInterval(() => {
        console.log('%c', devtoolsDetector);
    }, 3000);

    // 7. Block screen recording
    if (navigator.mediaDevices?.getDisplayMedia) {
        navigator.mediaDevices.getDisplayMedia = function () {
            banUser('Screen recording attempt detected');
            return Promise.reject(new Error('Not allowed'));
        };
    }

    // 8. Watermark integrity check
    setInterval(() => {
        const layers = wrapper.querySelectorAll('.watermark-layer, .wm-center, .wm-corner');
        if (layers.length < 6) {
            banUser('Watermark tampering detected - elements removed from DOM');
        }
    }, 3000);

    // 9. MutationObserver - detect element removal
    const observer = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
            mutation.removedNodes.forEach(node => {
                if (node.classList && (
                    node.classList.contains('watermark-layer') ||
                    node.classList.contains('wm-center') ||
                    node.classList.contains('wm-corner') ||
                    node.classList.contains('wm-canvas') ||
                    node.classList.contains('iframe-shield') ||
                    node.classList.contains('iframe-bottom-shield') ||
                    node.classList.contains('iframe-top-shield')
                )) {
                    // Re-add removed element
                    wrapper.appendChild(node);
                    addViolation('DOM tampering - watermark element removed');
                }
            });
        });
    });
    observer.observe(wrapper, { childList: true, subtree: false });

    // 10. Block iframe embedding of this page
    if (window.top !== window.self) {
        document.body.innerHTML = '<h1 style="color:red;text-align:center;padding:50px;">Embedding not allowed</h1>';
    }

    // 11. Block accessing page source via fetch
    const origFetch = window.fetch;
    window.fetch = function (...args) {
        const url = (args[0]?.url || args[0] || '').toString();
        if (url.includes('secure-frame') && !url.includes(currentSessionToken)) {
            addViolation('Unauthorized API access attempt');
            return Promise.reject(new Error('Blocked'));
        }
        return origFetch.apply(this, args);
    };

    // 12. Detect page visibility changes (suspicious tab switching)
    let tabSwitchCount = 0;
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            tabSwitchCount++;
            if (tabSwitchCount > 15) {
                addViolation('Excessive tab switching detected (possible recording)');
            }
        }
    });

    // 13. Block copy/paste
    document.addEventListener('copy', e => {
        e.preventDefault();
        addViolation('Copy attempt');
        return false;
    }, true);

    // 14. Disable console methods (make debugging harder)
    const noop = () => {};
    ['log', 'debug', 'info', 'warn', 'error', 'table', 'trace', 'dir'].forEach(method => {
        // Keep a reference for our own use but disable for others
        window.console[method] = noop;
    });

    // Cleanup on page leave
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
