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
                    <div class="blocked-screen" style="display:flex;">
                        <div class="icon">🚫</div>
                        <h1>Account Blocked</h1>
                        <p>${data.message}</p>
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

            // Load secure frame - URL is NEVER exposed to client
            const frame = document.getElementById('videoFrame');

            // This URL serves an HTML page with the video
            // The actual Google Drive URL is injected SERVER-SIDE only
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

            // Build all watermark layers
            buildWatermarks(watermark);

            // Setup fullscreen
            setupFullscreen();

            // Refresh session every 30 minutes
            sessionRefreshInterval = setInterval(refreshSession, 30 * 60 * 1000);

        } catch (err) {
            console.error('loadVideo error:', err);
            alert('Error loading video: ' + err.message);
            window.location.href = '/dashboard.html';
        }
    }

    // Refresh session to keep it alive
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
        } catch (e) {
            // Silent fail
        }
    }

    // =============================================
    // FULLSCREEN - Wrapper goes fullscreen (watermarks stay)
    // =============================================
    function setupFullscreen() {
        const fsBtn = document.getElementById('fullscreenBtn');
        if (fsBtn) fsBtn.addEventListener('click', toggleFullscreen);

        document.addEventListener('fullscreenchange', updateFullscreenUI);
        document.addEventListener('webkitfullscreenchange', updateFullscreenUI);
    }

    function toggleFullscreen() {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            document.exitFullscreen?.() || document.webkitExitFullscreen?.();
        } else {
            wrapper.requestFullscreen?.() ||
                wrapper.webkitRequestFullscreen?.() ||
                wrapper.msRequestFullscreen?.();
        }
    }

    function updateFullscreenUI() {
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

        // LAYER 2: Static rotated grid
        const grid = document.getElementById('wmGrid');
        for (let i = 0; i < 80; i++) {
            const item = document.createElement('div');
            item.className = 'wm-grid-item';
            item.textContent = i % 3 === 0 ? wmFull : wmShort;
            grid.appendChild(item);
        }

        // LAYER 3: Center pulsing
        document.getElementById('wmCenter').textContent = wmFull;

        // LAYER 4: Corner stamps with live timestamp
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

        // LAYER 6: Canvas pixel watermark
        createCanvasWatermark(wmShort, `${wm.email}|${wm.id}`);
    }

    function createCanvasWatermark(mainText, forensicText) {
        const existing = wrapper.querySelector('.wm-canvas');
        if (existing) existing.remove();

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
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(-0.35);
                ctx.fillText(mainText, 0, 0);
                ctx.restore();
            }
        }

        ctx.font = 'bold 10px Courier New';
        ctx.fillStyle = 'rgba(255,255,255,0.015)';
        for (let y = 50; y < canvas.height; y += 55) {
            for (let x = 80; x < canvas.width; x += 300) {
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(0.2);
                ctx.fillText(forensicText, 0, 0);
                ctx.restore();
            }
        }

        wrapper.appendChild(canvas);

        setTimeout(() => createCanvasWatermark(mainText, forensicText), 30000);
    }

    // =============================================
    // ANTI PIRACY
    // =============================================
    document.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        return false;
    }, true);

    document.addEventListener('keydown', e => {
        const blocked = [
            e.ctrlKey && e.key === 's',
            e.ctrlKey && e.key === 'u',
            e.ctrlKey && e.key === 'p',
            e.ctrlKey && e.shiftKey && ['i', 'I', 'j', 'J', 'c', 'C'].includes(e.key),
            e.key === 'F12',
            e.key === 'PrintScreen',
            e.metaKey && e.shiftKey && ['3', '4', '5'].includes(e.key)
        ];
        if (blocked.some(b => b)) {
            e.preventDefault();
            e.stopPropagation();
            return false;
        }
        if (e.key === 'f' || e.key === 'F') {
            e.preventDefault();
            toggleFullscreen();
        }
    }, true);

    document.addEventListener('dragstart', e => e.preventDefault(), true);

    // DevTools detection
    let devOpen = false;
    setInterval(() => {
        const w = window.outerWidth - window.innerWidth > 160;
        const h = window.outerHeight - window.innerHeight > 160;
        if ((w || h) && !devOpen) {
            devOpen = true;
            for (let i = 0; i < 10; i++) {
                const el = document.createElement('div');
                el.textContent = `⚠️ RECORDING DETECTED - ${user.name} - ${user.email}`;
                el.style.cssText = `position:absolute;top:${8 + i * 9}%;left:2%;color:rgba(255,0,0,0.4);font-size:clamp(14px,2.5vw,22px);z-index:100;pointer-events:none;white-space:nowrap;font-family:'Courier New',monospace;font-weight:bold;`;
                wrapper.appendChild(el);
            }
        } else if (!w && !h) {
            devOpen = false;
        }
    }, 1500);

    // Block screen recording
    if (navigator.mediaDevices?.getDisplayMedia) {
        navigator.mediaDevices.getDisplayMedia = function () {
            return Promise.reject(new Error('Not allowed'));
        };
    }

    // Watermark integrity check
    setInterval(() => {
        const layers = wrapper.querySelectorAll('.watermark-layer, .wm-center, .wm-corner');
        if (layers.length < 6) {
            document.body.innerHTML = `
                <div class="blocked-screen" style="display:flex;">
                    <div class="icon">🚨</div>
                    <h1 style="color:var(--danger);">Tampering Detected</h1>
                    <p>Session terminated.</p>
                </div>`;
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
                }
            });
        });
    });
    observer.observe(wrapper, { childList: true, subtree: false });

    // Block iframe embedding
    if (window.top !== window.self) {
        document.body.innerHTML = '<h1 style="color:red;text-align:center;padding:50px;">Embedding not allowed</h1>';
    }

    // Cleanup on leave
    window.addEventListener('beforeunload', () => {
        if (sessionRefreshInterval) clearInterval(sessionRefreshInterval);
    });

    window.logout = function () {
        localStorage.clear();
        window.location.href = '/login.html';
    };

    loadVideo();

})();
