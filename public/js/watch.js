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
    // BAN USER
    // =============================================
    async function banUser(reason) {
        if (alreadyBanned) return;
        alreadyBanned = true;

        // Stop video
        const frame = document.getElementById('videoFrame');
        if (frame) frame.src = '';
        if (sessionRefreshInterval) clearInterval(sessionRefreshInterval);

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

        document.body.innerHTML = `
            <div style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:#0a0a1a;display:flex;align-items:center;justify-content:center;z-index:99999;padding:20px;">
                <div style="text-align:center;max-width:500px;">
                    <div style="font-size:5rem;margin-bottom:20px;">🚫</div>
                    <h1 style="color:#ff4757;font-size:1.8rem;margin-bottom:12px;">Account Suspended</h1>
                    <p style="color:#8888aa;line-height:1.7;margin-bottom:20px;">
                        Your account has been permanently suspended due to violation of our terms of service.
                    </p>
                    <div style="background:rgba(255,71,87,0.1);border:1px solid rgba(255,71,87,0.3);border-radius:10px;padding:16px;margin-bottom:20px;">
                        <p style="color:#ff6b6b;font-size:0.85rem;font-weight:600;">Reason: ${reason}</p>
                    </div>
                    <p style="color:#555;font-size:0.8rem;">
                        Your identity (${user.name || ''} - ${user.email || ''}) has been logged.
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
            // Show warning popup
            const popup = document.createElement('div');
            popup.style.cssText = `
                position:fixed;top:20px;left:50%;transform:translateX(-50%);
                background:rgba(255,71,87,0.97);color:#fff;padding:16px 28px;
                border-radius:12px;z-index:9999;font-family:-apple-system,sans-serif;
                font-size:0.9rem;font-weight:600;box-shadow:0 10px 30px rgba(0,0,0,0.5);
                text-align:center;max-width:90%;
            `;
            popup.innerHTML = `
                ⚠️ WARNING ${violationCount}/3: ${reason}<br>
                <span style="font-size:0.75rem;opacity:0.7;">Next violation = permanent ban</span>
            `;
            document.body.appendChild(popup);
            setTimeout(() => { if (popup.parentNode) popup.remove(); }, 5000);

            // Add extra watermark as punishment
            if (wrapper) {
                const el = document.createElement('div');
                el.textContent = `⚠️ ${user.name} | ${user.email}`;
                el.style.cssText = `
                    position:absolute;top:${Math.random()*70+10}%;left:${Math.random()*50+10}%;
                    color:rgba(255,0,0,0.35);font-size:clamp(14px,2.5vw,22px);z-index:100;
                    pointer-events:none;white-space:nowrap;font-family:'Courier New',monospace;
                    font-weight:bold;text-shadow:0 0 5px rgba(0,0,0,0.8);
                `;
                wrapper.appendChild(el);
            }
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
                document.body.innerHTML = `
                    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0a0a1a;">
                        <div style="text-align:center;padding:40px;">
                            <div style="font-size:5rem;">🚫</div>
                            <h1 style="color:#ff4757;margin:12px 0;">Account Blocked</h1>
                            <p style="color:#8888aa;">${data.message}</p>
                        </div>
                    </div>`;
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

            // Build single clean watermark
            if (watermark) buildWatermark(watermark);

            // Setup fullscreen
            setupFullscreen();

            // Setup all security
            setupSecurity();

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
    // SINGLE CLEAN WATERMARK
    // =============================================
    function buildWatermark(wm) {
        const wmText = `${wm.name}  |  ${wm.email}`;

        const el = document.createElement('div');
        el.className = 'outer-watermark';
        el.textContent = wmText;
        el.style.cssText = `
            position:absolute;
            color:rgba(255,255,255,0.20);
            font-size:clamp(14px, 2.2vw, 22px);
            font-family:'Courier New', monospace;
            font-weight:800;
            white-space:nowrap;
            pointer-events:none;
            user-select:none;
            z-index:15;
            letter-spacing:1px;
            text-shadow: 0 0 4px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.5);
            animation: outerWmMove 20s linear infinite;
        `;
        wrapper.appendChild(el);

        const style = document.createElement('style');
        style.textContent = `
            @keyframes outerWmMove {
                0% { top:20%; left:-50%; }
                25% { top:50%; left:65%; }
                50% { top:70%; left:15%; }
                75% { top:35%; left:75%; }
                100% { top:20%; left:-50%; }
            }
        `;
        document.head.appendChild(style);
    }

    // =============================================
    // SECURITY SYSTEM
    // =============================================
    function setupSecurity() {

        // ── 1. Block right click ──
        document.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            addViolation('Right-click attempt');
            return false;
        }, true);

        // ── 2. Block keyboard shortcuts ──
        document.addEventListener('keydown', e => {
            // F12 = instant ban
            if (e.key === 'F12') {
                e.preventDefault();
                e.stopPropagation();
                banUser('DevTools opened via F12');
                return false;
            }

            // Ctrl+Shift+I/J/C = instant ban
            if (e.ctrlKey && e.shiftKey && ['i','I','j','J','c','C','k','K'].includes(e.key)) {
                e.preventDefault();
                e.stopPropagation();
                banUser('DevTools opened via keyboard shortcut');
                return false;
            }

            // Mac: Cmd+Option+I/J/C = instant ban
            if (e.metaKey && e.altKey && ['i','I','j','J','c','C'].includes(e.key)) {
                e.preventDefault();
                e.stopPropagation();
                banUser('DevTools opened via Mac shortcut');
                return false;
            }

            // Ctrl+U = instant ban
            if (e.ctrlKey && e.key === 'u') {
                e.preventDefault();
                e.stopPropagation();
                banUser('View source attempt');
                return false;
            }

            // Ctrl+S = warning
            if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                addViolation('Save page attempt');
                return false;
            }

            // Ctrl+P = warning
            if (e.ctrlKey && e.key === 'p') {
                e.preventDefault();
                addViolation('Print attempt');
                return false;
            }

            // PrintScreen = warning
            if (e.key === 'PrintScreen') {
                e.preventDefault();
                navigator.clipboard?.writeText?.('');
                addViolation('Screenshot attempt');
                return false;
            }

            // Mac screenshot shortcuts = warning
            if (e.metaKey && e.shiftKey && ['3','4','5','6'].includes(e.key)) {
                e.preventDefault();
                addViolation('Screenshot attempt');
                return false;
            }

            // OBS recording shortcut
            if (e.ctrlKey && e.altKey && (e.key === 'r' || e.key === 'R')) {
                e.preventDefault();
                banUser('Screen recording shortcut detected (OBS)');
                return false;
            }

            // Windows Game Bar
            if (e.metaKey && e.altKey && (e.key === 'r' || e.key === 'R')) {
                e.preventDefault();
                banUser('Screen recording shortcut detected (Game Bar)');
                return false;
            }

            // Fullscreen
            if (e.key === 'f' || e.key === 'F') {
                e.preventDefault();
                toggleFullscreen();
            }
        }, true);

        // ── 3. Block drag ──
        document.addEventListener('dragstart', e => e.preventDefault(), true);

        // ── 4. Block copy ──
        document.addEventListener('copy', e => {
            e.preventDefault();
            addViolation('Copy attempt');
        }, true);

        // ── 5. DevTools detection via window size ──
        let devToolsDetected = false;
        setInterval(() => {
            const w = window.outerWidth - window.innerWidth > 160;
            const h = window.outerHeight - window.innerHeight > 160;
            if ((w || h) && !devToolsDetected) {
                devToolsDetected = true;
                banUser('Browser DevTools opened (window size anomaly)');
            }
        }, 1000);

        // ── 6. DevTools detection via debugger timing ──
        let dbgChecks = 0;
        setInterval(() => {
            const start = performance.now();
            (function () { debugger; })();
            if (performance.now() - start > 100) {
                dbgChecks++;
                if (dbgChecks >= 2) {
                    banUser('DevTools debugger detected');
                }
            }
        }, 5000);

        // ── 7. Console object detection ──
        const devImg = new Image();
        Object.defineProperty(devImg, 'id', {
            get: function () {
                banUser('DevTools console opened');
            }
        });
        setInterval(() => { console.log('%c', devImg); }, 3000);

        // ── 8. Block screen recording API ──
        if (navigator.mediaDevices?.getDisplayMedia) {
            navigator.mediaDevices.getDisplayMedia = async function () {
                await banUser('Screen recording attempt via browser API');
                return Promise.reject(new Error('Not allowed'));
            };
        }

        // ── 9. Block MediaRecorder ──
        if (window.MediaRecorder) {
            const OrigMediaRecorder = window.MediaRecorder;
            window.MediaRecorder = function (stream, options) {
                if (stream && stream.getVideoTracks) {
                    const tracks = stream.getVideoTracks();
                    tracks.forEach(track => {
                        const label = (track.label || '').toLowerCase();
                        if (label.includes('screen') || label.includes('display') ||
                            label.includes('monitor') || label.includes('window')) {
                            banUser('Screen recording detected via MediaRecorder');
                        }
                    });
                }
                return new OrigMediaRecorder(stream, options);
            };
            window.MediaRecorder.prototype = OrigMediaRecorder.prototype;
            window.MediaRecorder.isTypeSupported = OrigMediaRecorder.isTypeSupported;
        }

        // ── 10. Block Picture-in-Picture ──
        document.addEventListener('enterpictureinpicture', async (e) => {
            e.preventDefault();
            document.exitPictureInPicture?.().catch(() => {});
            await banUser('Picture-in-Picture attempt');
        });

        // ── 11. Block iframe embedding of this page ──
        if (window.top !== window.self) {
            document.body.innerHTML = '<h1 style="color:red;text-align:center;padding:50px;">Not allowed</h1>';
        }

        // ── 12. Watermark integrity check ──
        setInterval(() => {
            if (!wrapper) return;
            const wm = wrapper.querySelector('.outer-watermark');
            if (!wm) {
                // Someone removed the watermark!
                banUser('Watermark tampering - watermark element removed');
            }
        }, 3000);

        // ── 13. MutationObserver - auto restore watermark ──
        const observer = new MutationObserver((mutations) => {
            mutations.forEach(mutation => {
                mutation.removedNodes.forEach(node => {
                    if (node.classList && node.classList.contains('outer-watermark')) {
                        wrapper.appendChild(node);
                        addViolation('Watermark removal attempt');
                    }
                });
            });
        });
        if (wrapper) observer.observe(wrapper, { childList: true });

        // ── 14. Disable console ──
        const noop = () => {};
        try {
            ['log','debug','info','warn','error','table','trace','dir'].forEach(m => {
                window.console[m] = noop;
            });
        } catch (e) { }

        // ── 15. Tab switching monitor ──
        let tabSwitchCount = 0;
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                tabSwitchCount++;
                if (tabSwitchCount > 20) {
                    addViolation('Excessive tab switching - possible recording');
                    tabSwitchCount = 0;
                }
            }
        });
    }

    // =============================================
    // CLEANUP
    // =============================================
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
