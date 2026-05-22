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
    let networkCheckInterval = null;
    let violationCount = 0;
    let alreadyBanned = false;
    let videoLoaded = false;

    // =============================================
    // RUN SECURITY CHECKS BEFORE ANYTHING LOADS
    // This runs BEFORE video loads
    // =============================================
    function runPreloadSecurityChecks() {

        // Check 1: DevTools already open before page loads?
        const w = window.outerWidth - window.innerWidth > 160;
        const h = window.outerHeight - window.innerHeight > 160;
        if (w || h) {
            // DevTools is ALREADY open - block page immediately
            showBlockScreen('DevTools was open when page loaded');
            return false;
        }

        // Check 2: Block if opened in iframe
        if (window.top !== window.self) {
            document.body.innerHTML = '<h1 style="color:red;text-align:center;padding:50px;">Not allowed</h1>';
            return false;
        }

        return true;
    }

    // =============================================
    // SHOW BLOCK SCREEN (No server call needed)
    // Works even without internet
    // =============================================
    function showBlockScreen(reason) {
        // Stop video immediately
        const frame = document.getElementById('videoFrame');
        if (frame) {
            frame.src = '';
            frame.style.display = 'none';
        }

        // Clear all intervals
        if (sessionRefreshInterval) clearInterval(sessionRefreshInterval);
        if (networkCheckInterval) clearInterval(networkCheckInterval);

        // Replace entire page content
        document.body.innerHTML = `
            <div style="position:fixed;top:0;left:0;width:100vw;height:100vh;
                background:#0a0a1a;display:flex;align-items:center;
                justify-content:center;z-index:99999;padding:20px;">
                <div style="text-align:center;max-width:500px;">
                    <div style="font-size:5rem;margin-bottom:20px;">🚫</div>
                    <h1 style="color:#ff4757;font-size:1.8rem;margin-bottom:12px;">
                        Session Terminated
                    </h1>
                    <p style="color:#8888aa;line-height:1.7;margin-bottom:20px;">
                        Suspicious activity detected. Your session has been terminated.
                    </p>
                    <div style="background:rgba(255,71,87,0.1);border:1px solid 
                        rgba(255,71,87,0.3);border-radius:10px;padding:16px;margin-bottom:20px;">
                        <p style="color:#ff6b6b;font-size:0.85rem;font-weight:600;">
                            Reason: ${reason}
                        </p>
                    </div>
                    <p style="color:#555;font-size:0.8rem;margin-bottom:20px;">
                        Your identity (${user.name || ''} - ${user.email || ''}) 
                        has been logged. Your account will be reviewed.
                    </p>
                    <button onclick="window.location.href='/login.html'"
                        style="background:linear-gradient(135deg,#6c5ce7,#00cec9);
                        color:#fff;border:none;padding:12px 30px;border-radius:10px;
                        font-size:1rem;cursor:pointer;font-weight:600;">
                        Go to Login
                    </button>
                </div>
            </div>
        `;

        // Clear stored session
        localStorage.removeItem('token');
        localStorage.removeItem('user');

        // Try to report to server (even if offline, queued when back online)
        reportViolationWithRetry(reason);
    }

    // =============================================
    // BAN USER - With retry if offline
    // =============================================
    async function banUser(reason) {
        if (alreadyBanned) return;
        alreadyBanned = true;

        // Show block screen IMMEDIATELY (no waiting for server)
        showBlockScreen(reason);
    }

    // Report violation with retry (works even if momentarily offline)
    async function reportViolationWithRetry(reason, attempts = 0) {
        if (attempts > 5) return;

        try {
            const savedToken = token;
            const res = await fetch(`${API}/auth/report-violation`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${savedToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ reason })
            });

            if (res.ok) {
                console.log('Violation reported successfully');
                return;
            }
        } catch (e) {
            // Network error - retry after delay
            setTimeout(() => {
                reportViolationWithRetry(reason, attempts + 1);
            }, 3000 * (attempts + 1)); // 3s, 6s, 9s, 12s, 15s
        }
    }

    function addViolation(reason) {
        violationCount++;
        if (violationCount >= 3) {
            banUser(reason);
        } else {
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
                <span style="font-size:0.75rem;opacity:0.7;">
                    Next violation = permanent ban
                </span>
            `;
            document.body.appendChild(popup);
            setTimeout(() => { if (popup.parentNode) popup.remove(); }, 5000);
        }
    }

    // =============================================
    // NETWORK MONITOR
    // Video STOPS if internet disconnects
    // =============================================
    function setupNetworkMonitor() {
        let offlineCount = 0;
        let wasOffline = false;

        networkCheckInterval = setInterval(async () => {
            try {
                // Ping our own server to check connectivity
                const res = await fetch(`${API}/auth/me`, {
                    headers: { 'Authorization': `Bearer ${token}` },
                    cache: 'no-store',
                    signal: AbortSignal.timeout(3000)
                });

                if (res.ok) {
                    offlineCount = 0;

                    if (wasOffline) {
                        wasOffline = false;
                        // Was offline, now back - recheck token validity
                        const data = await res.json();
                        if (!data.success || data.user?.isBlocked) {
                            banUser('Account blocked while offline');
                        }
                    }
                }
            } catch (e) {
                offlineCount++;

                if (offlineCount >= 2) {
                    // 2 consecutive failures = STOP VIDEO
                    wasOffline = true;
                    const frame = document.getElementById('videoFrame');
                    if (frame) {
                        frame.style.display = 'none';
                    }

                    // Show offline warning overlay
                    showOfflineOverlay();
                }
            }
        }, 5000); // Check every 5 seconds

        // Native browser events as backup
        window.addEventListener('offline', () => {
            const frame = document.getElementById('videoFrame');
            if (frame) frame.style.display = 'none';
            showOfflineOverlay();
        });

        window.addEventListener('online', async () => {
            // Back online - verify session before resuming
            try {
                const res = await fetch(`${API}/auth/me`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const data = await res.json();

                if (data.success && !data.user?.isBlocked) {
                    hideOfflineOverlay();
                    const frame = document.getElementById('videoFrame');
                    if (frame) frame.style.display = 'block';
                } else {
                    banUser('Session invalid after reconnect');
                }
            } catch (e) {
                // Still can't reach server
            }
        });
    }

    function showOfflineOverlay() {
        const existing = document.getElementById('offlineOverlay');
        if (existing) return;

        const overlay = document.createElement('div');
        overlay.id = 'offlineOverlay';
        overlay.style.cssText = `
            position:absolute;top:0;left:0;width:100%;height:100%;
            background:rgba(10,10,26,0.95);display:flex;align-items:center;
            justify-content:center;z-index:50;border-radius:14px;
        `;
        overlay.innerHTML = `
            <div style="text-align:center;padding:30px;">
                <div style="font-size:3rem;margin-bottom:15px;">📵</div>
                <h3 style="color:#ffa502;margin-bottom:8px;">
                    Connection Lost
                </h3>
                <p style="color:#8888aa;font-size:0.85rem;line-height:1.6;">
                    Video paused due to network interruption.<br>
                    Reconnect to continue watching.
                </p>
            </div>
        `;
        if (wrapper) wrapper.appendChild(overlay);
    }

    function hideOfflineOverlay() {
        const overlay = document.getElementById('offlineOverlay');
        if (overlay) overlay.remove();
    }

    // =============================================
    // LOAD VIDEO
    // =============================================
    async function loadVideo() {
        // Run security checks FIRST before loading anything
        if (!runPreloadSecurityChecks()) return;

        try {
            const res = await fetch(`${API}/videos/watch/${videoId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            const data = await res.json();

            if (data.blocked) {
                showBlockScreen(data.message);
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
                videoLoaded = true;
            });

            setTimeout(() => {
                const loading = document.getElementById('playerLoading');
                if (loading) loading.style.display = 'none';
            }, 5000);

            // Build watermark
            if (watermark) buildWatermark(watermark);

            // Setup fullscreen
            setupFullscreen();

            // Setup ALL security
            setupSecurity();

            // Setup network monitor
            setupNetworkMonitor();

            // Refresh session every 30 minutes
            sessionRefreshInterval = setInterval(refreshSession, 30 * 60 * 1000);

            // Verify session every 2 minutes
            setInterval(verifySession, 2 * 60 * 1000);

        } catch (err) {
            console.error('loadVideo error:', err);
            alert('Error loading video.');
            window.location.href = '/dashboard.html';
        }
    }

    // Verify session is still valid every 2 minutes
    async function verifySession() {
        try {
            const res = await fetch(`${API}/auth/me`, {
                headers: { 'Authorization': `Bearer ${token}` },
                cache: 'no-store'
            });
            const data = await res.json();

            if (!data.success) {
                banUser('Session expired or invalid');
                return;
            }

            if (data.user?.isBlocked) {
                banUser('Account blocked by admin');
                return;
            }

        } catch (e) {
            // Network error handled by network monitor
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
                body: JSON.stringify({
                    sessionToken: currentSessionToken,
                    videoId
                })
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

        const el1 = document.createElement('div');
        el1.className = 'outer-watermark';
        el1.textContent = wmText;
        el1.style.cssText = `
            position:absolute;
            color:rgba(255,255,255,0.35);
            font-size:clamp(16px, 2.8vw, 28px);
            font-family:'Courier New', monospace;
            font-weight:800;
            white-space:nowrap;
            pointer-events:none;
            user-select:none;
            z-index:15;
            letter-spacing:2px;
            text-shadow: 0 0 6px rgba(0,0,0,0.9), 2px 2px 4px rgba(0,0,0,0.8);
            animation: outerWmMove 15s linear infinite;
        `;
        wrapper.appendChild(el1);

        const el2 = document.createElement('div');
        el2.className = 'outer-watermark-2';
        el2.textContent = wmText;
        el2.style.cssText = `
            position:absolute;
            color:rgba(255,255,255,0.25);
            font-size:clamp(14px, 2.2vw, 22px);
            font-family:'Courier New', monospace;
            font-weight:800;
            white-space:nowrap;
            pointer-events:none;
            user-select:none;
            z-index:15;
            letter-spacing:1px;
            text-shadow: 0 0 4px rgba(0,0,0,0.8), 2px 2px 4px rgba(0,0,0,0.8);
            animation: outerWmMove2 18s linear infinite;
        `;
        wrapper.appendChild(el2);

        const style = document.createElement('style');
        style.textContent = `
            @keyframes outerWmMove {
                0%   { top:15%; left:-50%; }
                25%  { top:50%; left:65%; }
                50%  { top:75%; left:10%; }
                75%  { top:35%; left:75%; }
                100% { top:15%; left:-50%; }
            }
            @keyframes outerWmMove2 {
                0%   { top:70%; left:110%; }
                25%  { top:25%; left:20%; }
                50%  { top:55%; left:75%; }
                75%  { top:15%; left:45%; }
                100% { top:70%; left:110%; }
            }
        `;
        document.head.appendChild(style);
    }

    // =============================================
    // SECURITY SYSTEM
    // =============================================
    function setupSecurity() {

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
                e.stopPropagation();
                banUser('DevTools opened via F12');
                return false;
            }
            if (e.ctrlKey && e.shiftKey && ['i','I','j','J','c','C','k','K'].includes(e.key)) {
                e.preventDefault();
                e.stopPropagation();
                banUser('DevTools opened via keyboard shortcut');
                return false;
            }
            if (e.metaKey && e.altKey && ['i','I','j','J','c','C'].includes(e.key)) {
                e.preventDefault();
                e.stopPropagation();
                banUser('DevTools opened via Mac shortcut');
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
            if (e.ctrlKey && e.altKey && (e.key === 'r' || e.key === 'R')) {
                e.preventDefault();
                banUser('Screen recording shortcut (OBS)');
                return false;
            }
            if (e.metaKey && e.altKey && (e.key === 'r' || e.key === 'R')) {
                e.preventDefault();
                banUser('Screen recording shortcut (Game Bar)');
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

        // DevTools detection via window size - INSTANT BAN
        let devToolsDetected = false;
        setInterval(() => {
            const w = window.outerWidth - window.innerWidth > 160;
            const h = window.outerHeight - window.innerHeight > 160;
            if ((w || h) && !devToolsDetected) {
                devToolsDetected = true;
                banUser('Browser DevTools opened (detected via window size)');
            }
        }, 500); // Check every 500ms for faster detection

        // DevTools debugger timing detection
        let dbgChecks = 0;
        setInterval(() => {
            const start = performance.now();
            (function () { debugger; })();
            if (performance.now() - start > 100) {
                dbgChecks++;
                if (dbgChecks >= 2) {
                    banUser('DevTools debugger timing detected');
                }
            }
        }, 3000);

        // Console object detection
        const devImg = new Image();
        Object.defineProperty(devImg, 'id', {
            get: function () {
                banUser('DevTools console opened (object inspection)');
            }
        });
        setInterval(() => {
            console.log('%c', devImg);
        }, 2000);

        // Block screen recording API
        if (navigator.mediaDevices?.getDisplayMedia) {
            navigator.mediaDevices.getDisplayMedia = async function () {
                await banUser('Screen recording attempt via browser API');
                return Promise.reject(new Error('Not allowed'));
            };
        }

        // Block MediaRecorder
        if (window.MediaRecorder) {
            const OrigMR = window.MediaRecorder;
            window.MediaRecorder = function (stream, options) {
                if (stream?.getVideoTracks) {
                    stream.getVideoTracks().forEach(track => {
                        const label = (track.label || '').toLowerCase();
                        if (label.includes('screen') || label.includes('display') ||
                            label.includes('monitor') || label.includes('window')) {
                            banUser('Screen recording via MediaRecorder detected');
                        }
                    });
                }
                return new OrigMR(stream, options);
            };
            window.MediaRecorder.prototype = OrigMR.prototype;
            window.MediaRecorder.isTypeSupported = OrigMR.isTypeSupported;
        }

        // Block Picture-in-Picture
        document.addEventListener('enterpictureinpicture', async (e) => {
            e.preventDefault();
            document.exitPictureInPicture?.().catch(() => {});
            await banUser('Picture-in-Picture attempt detected');
        });

        // Watermark integrity check
        setInterval(() => {
            if (!wrapper || !videoLoaded) return;
            const wm = wrapper.querySelector('.outer-watermark');
            if (!wm) {
                banUser('Watermark removed - tampering detected');
            }
        }, 2000);

        // MutationObserver - auto restore + punish
        const observer = new MutationObserver((mutations) => {
            mutations.forEach(mutation => {
                mutation.removedNodes.forEach(node => {
                    if (node.classList &&
                        (node.classList.contains('outer-watermark') ||
                         node.classList.contains('outer-watermark-2'))) {
                        wrapper.appendChild(node);
                        addViolation('Watermark element removed from DOM');
                    }
                });
            });
        });
        if (wrapper) observer.observe(wrapper, { childList: true });

        // Disable console methods
        const noop = () => {};
        try {
            ['log','debug','info','warn','error','table','trace','dir'].forEach(m => {
                window.console[m] = noop;
            });
        } catch (e) { }

        // Tab switching monitor
        let tabSwitchCount = 0;
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                tabSwitchCount++;
                if (tabSwitchCount > 20) {
                    addViolation('Excessive tab switching detected');
                    tabSwitchCount = 0;
                }
            }
        });
    }

    // Cleanup
    window.addEventListener('beforeunload', () => {
        if (sessionRefreshInterval) clearInterval(sessionRefreshInterval);
        if (networkCheckInterval) clearInterval(networkCheckInterval);
    });

    window.logout = function () {
        localStorage.clear();
        window.location.href = '/login.html';
    };

    // START
    loadVideo();

})();
