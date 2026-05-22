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

            // Build single watermark on watch page too
            if (watermark) {
                buildWatermark(watermark);
            }

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
    // SINGLE CLEAN WATERMARK
    // =============================================
    function buildWatermark(wm) {
        const wmText = `${wm.name}  |  ${wm.email}`;

        // One single moving watermark on outer layer
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

        // Add animation keyframes
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
    // ANTI PIRACY
    // =============================================

    // Block right click
    document.addEventListener('contextmenu', e => {
        e.preventDefault();
        return false;
    }, true);

    // Block keyboard shortcuts
    document.addEventListener('keydown', e => {
        // DevTools
        if (e.key === 'F12') { e.preventDefault(); return false; }
        if (e.ctrlKey && e.shiftKey && ['i','I','j','J','c','C'].includes(e.key)) { e.preventDefault(); return false; }
        if (e.metaKey && e.altKey && ['i','I','j','J'].includes(e.key)) { e.preventDefault(); return false; }
        if (e.ctrlKey && e.key === 'u') { e.preventDefault(); return false; }
        if (e.ctrlKey && e.key === 's') { e.preventDefault(); return false; }
        if (e.ctrlKey && e.key === 'p') { e.preventDefault(); return false; }

        // Fullscreen
        if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
    }, true);

    // Block drag
    document.addEventListener('dragstart', e => e.preventDefault(), true);

    // Block copy
    document.addEventListener('copy', e => { e.preventDefault(); }, true);

    // Block iframe embedding
    if (window.top !== window.self) {
        document.body.innerHTML = '<h1 style="color:red;text-align:center;padding:50px;">Not allowed</h1>';
    }

    // Cleanup
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
