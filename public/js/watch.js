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

    // =============================================
    // LOAD VIDEO
    // =============================================
async function loadVideo() {
    try {
        const res = await fetch(`${API}/videos/watch/${videoId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await res.json();

        console.log('Video API Response:', data); // Debug log

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

        // Safe destructuring with fallbacks
        const video = data.video || {};
        const watermark = data.watermark || {
            name: user.name || 'User',
            email: user.email || '',
            phone: '',
            id: 'XXXXXX'
        };

        // Set video info safely
        document.getElementById('videoTitle').textContent = video.title || 'Video';
        document.getElementById('videoDescription').textContent = video.description || '';
        document.getElementById('videoMentorship').textContent = `📂 ${video.mentorship || ''}`;
        document.getElementById('videoViews').textContent = `👁 ${video.viewCount || 0} views`;
        document.getElementById('videoDate').textContent = `📅 ${video.createdAt ? new Date(video.createdAt).toLocaleDateString() : ''}`;
        document.getElementById('wmPreview').textContent = `${watermark.name} • ${watermark.email}`;
        document.title = `${video.title || 'Watch'} - SxS Inner Circle`;

        // Convert Google Drive URL to embed URL
        const embedUrl = getEmbedUrl(video.videoUrl || '');
        console.log('Embed URL:', embedUrl); // Debug log

        if (!embedUrl) {
            alert('Video URL not found. Contact admin.');
            window.location.href = '/dashboard.html';
            return;
        }

        // Load iframe
        const frame = document.getElementById('videoFrame');
        frame.src = embedUrl;
        frame.style.display = 'block';

        // Hide loading after iframe loads
        frame.addEventListener('load', () => {
            const loading = document.getElementById('playerLoading');
            if (loading) loading.style.display = 'none';
        });

        // Fallback hide loading after 5 seconds
        setTimeout(() => {
            const loading = document.getElementById('playerLoading');
            if (loading) loading.style.display = 'none';
        }, 5000);

        // Build watermarks
        buildWatermarks(watermark);

    } catch (err) {
        console.error('loadVideo error:', err);
        alert('Error loading video: ' + err.message);
        window.location.href = '/dashboard.html';
    }
}

    // =============================================
    // CONVERT ANY GOOGLE DRIVE URL TO EMBED URL
    // =============================================
    function getEmbedUrl(url) {
        // Already an embed URL
        if (url.includes('/preview') || url.includes('embed')) {
            return url;
        }

        // Extract file ID from various Google Drive formats
        let fileId = null;

        // Format: /file/d/FILE_ID/view
        const match1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
        if (match1) fileId = match1[1];

        // Format: id=FILE_ID
        const match2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
        if (match2 && !fileId) fileId = match2[1];

        // Format: open?id=FILE_ID
        const match3 = url.match(/open\?id=([a-zA-Z0-9_-]+)/);
        if (match3 && !fileId) fileId = match3[1];

        if (fileId) {
            return `https://drive.google.com/file/d/${fileId}/preview`;
        }

        // If not Google Drive, return as is (direct MP4 etc)
        return url;
    }

    // =============================================
    // WATERMARK SYSTEM - 6 LAYERS
    // =============================================
    function buildWatermarks(wm) {
        const wmFull = `${wm.name} • ${wm.email} • ID:${wm.id}`;
        const wmShort = `${wm.name} | ${wm.email}`;
        const wmMini = `${wm.name} #${wm.id}`;

        // LAYER 1: 6 Moving watermarks
        const layer1 = document.getElementById('wmLayer1');
        ['wm-move-1', 'wm-move-2', 'wm-move-3', 'wm-move-4', 'wm-move-5', 'wm-move-6'].forEach((cls, i) => {
            const el = document.createElement('div');
            el.className = `wm-text ${cls}`;
            el.textContent = i % 2 === 0 ? wmFull : wmShort;
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
        document.getElementById('wmTR').textContent = `ID:${wm.id}`;
        document.getElementById('wmBL').textContent = wm.email;
        document.getElementById('wmBR').textContent = new Date().toLocaleString();
        setInterval(() => {
            document.getElementById('wmBR').textContent = new Date().toLocaleString();
        }, 1000);

        // LAYER 5: Random repositioning watermarks
        function spawnRandom() {
            const existing = wrapper.querySelectorAll('.wm-random');
            if (existing.length > 10) existing[0].remove();

            const el = document.createElement('div');
            el.className = 'wm-random';
            el.textContent = Math.random() > 0.5 ? wmShort : wmMini;
            el.style.top = `${Math.random() * 70 + 5}%`;
            el.style.left = `${Math.random() * 55 + 10}%`;
            el.style.transform = `rotate(${Math.random() * 30 - 15}deg)`;
            el.style.opacity = Math.random() * 0.07 + 0.04;
            el.style.fontSize = `${Math.random() * 6 + 9}px`;
            wrapper.appendChild(el);

            setTimeout(() => {
                el.style.top = `${Math.random() * 70 + 5}%`;
                el.style.left = `${Math.random() * 55 + 10}%`;
            }, 200);
        }
        for (let i = 0; i < 5; i++) spawnRandom();
        setInterval(spawnRandom, 5000);

        // LAYER 6: Canvas pixel watermark
        function createCanvas() {
            const canvas = document.createElement('canvas');
            canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:13;';
            canvas.width = 1920;
            canvas.height = 1080;
            const ctx = canvas.getContext('2d');

            ctx.font = 'bold 13px Courier New';
            ctx.fillStyle = 'rgba(255,255,255,0.035)';
            for (let y = 0; y < 1080; y += 65) {
                for (let x = 0; x < 1920; x += 320) {
                    ctx.save();
                    ctx.translate(x, y);
                    ctx.rotate(-0.4);
                    ctx.fillText(wmShort, 0, 0);
                    ctx.restore();
                }
            }

            // Invisible forensic layer
            ctx.font = 'bold 9px Courier New';
            ctx.fillStyle = 'rgba(255,255,255,0.008)';
            for (let y = 30; y < 1080; y += 45) {
                for (let x = 50; x < 1920; x += 250) {
                    ctx.save();
                    ctx.translate(x, y);
                    ctx.rotate(0.2);
                    ctx.fillText(`${wm.email}|${wm.id}`, 0, 0);
                    ctx.restore();
                }
            }

            wrapper.appendChild(canvas);

            // Refresh canvas every 30 seconds
            setTimeout(() => { canvas.remove(); createCanvas(); }, 30000);
        }
        createCanvas();
    }

    // =============================================
    // ANTI PIRACY
    // =============================================

    // Block right click
    document.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        return false;
    }, true);

    // Block keyboard shortcuts
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
    }, true);

    // Block drag
    document.addEventListener('dragstart', e => { e.preventDefault(); return false; }, true);

    // Detect DevTools
    let devOpen = false;
    setInterval(() => {
        const w = window.outerWidth - window.innerWidth > 160;
        const h = window.outerHeight - window.innerHeight > 160;
        if ((w || h) && !devOpen) {
            devOpen = true;
            for (let i = 0; i < 10; i++) {
                const el = document.createElement('div');
                el.textContent = `⚠️ RECORDING DETECTED - ${user.name} - ${user.email}`;
                el.style.cssText = `position:absolute;top:${8 + i * 9}%;left:2%;color:rgba(255,0,0,0.35);font-size:clamp(12px,2vw,20px);z-index:100;pointer-events:none;white-space:nowrap;font-family:monospace;font-weight:bold;`;
                wrapper.appendChild(el);
            }
        } else if (!w && !h) {
            devOpen = false;
        }
    }, 1500);

    // Block screen recording via browser
    if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
        const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getDisplayMedia = function () {
            for (let i = 0; i < 15; i++) {
                const el = document.createElement('div');
                el.textContent = `🚨 SCREEN RECORDING - ${user.name} - ${user.email}`;
                el.style.cssText = `position:absolute;top:${4 + i * 6}%;left:1%;color:rgba(255,0,0,0.45);font-size:22px;z-index:200;pointer-events:none;font-family:monospace;font-weight:bold;`;
                wrapper.appendChild(el);
            }
            return Promise.reject(new Error('Screen recording not allowed'));
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
                    <p>Watermark removal detected. Session terminated.</p>
                </div>`;
        }
    }, 3000);

    // Mutation observer - detect watermark removal
    const observer = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
            mutation.removedNodes.forEach(node => {
                if (node.classList && (
                    node.classList.contains('watermark-layer') ||
                    node.classList.contains('wm-center') ||
                    node.classList.contains('wm-corner')
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

    window.logout = function () {
        localStorage.clear();
        window.location.href = '/login.html';
    };

    // START
    loadVideo();

})();
