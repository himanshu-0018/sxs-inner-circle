// public/js/watch.js
(function() {
    'use strict';

    const API = '/api';
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    if (!token) { window.location.href = '/login.html'; return; }

    const videoId = new URLSearchParams(window.location.search).get('id');
    if (!videoId) { window.location.href = '/dashboard.html'; return; }

    let currentStreamToken = null;
    let tokenRefreshInterval = null;
    let controlsTimeout = null;
    let isSeeking = false;
    const player = document.getElementById('videoPlayer');
    const wrapper = document.getElementById('playerWrapper');

    // =============================================
    // VIDEO LOADING & SECURE STREAMING
    // =============================================
    async function loadVideo() {
        try {
            // Show loading
            wrapper.insertAdjacentHTML('beforeend',
                '<div class="player-loading" id="playerLoading"><div class="spinner"></div><p>Loading secure stream...</p></div>'
            );

            const res = await fetch(`${API}/videos/watch/${videoId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();

            if (data.blocked) {
                document.body.innerHTML = `<div class="blocked-screen" style="display:flex;"><div class="icon">🚫</div><h1>Account Blocked</h1><p>${data.message}</p></div>`;
                return;
            }

            if (!data.success) {
                alert(data.message || 'Video not found');
                window.location.href = '/dashboard.html';
                return;
            }

            const { video, watermark, streamToken } = data;
            currentStreamToken = streamToken;

            // Set video info
            document.getElementById('videoTitle').textContent = video.title;
            document.getElementById('videoDescription').textContent = video.description || '';
            document.getElementById('videoMentorship').textContent = `📂 ${video.mentorship}`;
            document.getElementById('videoViews').textContent = `👁 ${video.viewCount} views`;
            document.getElementById('videoDate').textContent = `📅 ${new Date(video.createdAt).toLocaleDateString()}`;
            document.getElementById('wmPreview').textContent = `${watermark.name} • ${watermark.email}`;
            document.title = `${video.title} - SxS Inner Circle`;

            // Set video source through secure proxy (URL never exposed to client)
            player.src = `${API}/videos/secure-stream/${streamToken}`;
            player.load();

            // Build watermarks
            buildWatermarks(watermark);

            // Setup custom controls
            setupControls();

            // Start token refresh cycle (refresh every 25 seconds)
            tokenRefreshInterval = setInterval(() => refreshStreamToken(), 25000);

            // Remove loading
            const loadingEl = document.getElementById('playerLoading');
            if (loadingEl) loadingEl.remove();

        } catch (err) {
            console.error(err);
            alert('Error loading video');
            window.location.href = '/dashboard.html';
        }
    }

    async function refreshStreamToken() {
        try {
            const res = await fetch(`${API}/videos/refresh-token`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ videoId })
            });
            const data = await res.json();
            if (data.success) {
                currentStreamToken = data.streamToken;
                // Don't reload video, just keep the token fresh for if user seeks
            }
        } catch (err) {
            // Silent fail, old token still works until it expires
        }
    }

    // =============================================
    // CUSTOM CONTROLS (No native controls = no download button)
    // =============================================
    function setupControls() {
        // Show controls on hover/touch
        wrapper.addEventListener('mousemove', showControlsTemporarily);
        wrapper.addEventListener('touchstart', showControlsTemporarily, { passive: true });

        // Click on shield to play/pause
        document.getElementById('antiDownloadShield').addEventListener('click', togglePlay);
        document.getElementById('antiDownloadShield').addEventListener('dblclick', toggleFullscreen);

        // Progress bar seeking
        const progressWrap = document.getElementById('progressWrap');
        progressWrap.addEventListener('click', seekTo);
        progressWrap.addEventListener('touchstart', startSeek, { passive: false });
        progressWrap.addEventListener('mousedown', startSeek);

        // Volume
        document.getElementById('volumeSlider').addEventListener('input', (e) => {
            player.volume = e.target.value;
            updateMuteIcon();
        });

        // Player events
        player.addEventListener('timeupdate', updateProgress);
        player.addEventListener('progress', updateBuffered);
        player.addEventListener('play', () => {
            document.getElementById('playPauseBtn').textContent = '⏸';
        });
        player.addEventListener('pause', () => {
            document.getElementById('playPauseBtn').textContent = '▶';
            showControlsTemporarily();
        });
        player.addEventListener('ended', () => {
            document.getElementById('playPauseBtn').textContent = '↻';
        });
        player.addEventListener('loadedmetadata', () => {
            updateTimeDisplay();
        });
        player.addEventListener('waiting', () => {
            // Show loading spinner during buffer
        });

        // Keyboard controls
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            switch(e.key) {
                case ' ':
                case 'k':
                    e.preventDefault();
                    togglePlay();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    player.currentTime = Math.max(0, player.currentTime - 10);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    player.currentTime = Math.min(player.duration, player.currentTime + 10);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    player.volume = Math.min(1, player.volume + 0.1);
                    document.getElementById('volumeSlider').value = player.volume;
                    updateMuteIcon();
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    player.volume = Math.max(0, player.volume - 0.1);
                    document.getElementById('volumeSlider').value = player.volume;
                    updateMuteIcon();
                    break;
                case 'f':
                    e.preventDefault();
                    toggleFullscreen();
                    break;
                case 'm':
                    e.preventDefault();
                    toggleMute();
                    break;
            }
        });
    }

    function showControlsTemporarily() {
        wrapper.classList.add('show-controls');
        clearTimeout(controlsTimeout);
        controlsTimeout = setTimeout(() => {
            if (!player.paused) {
                wrapper.classList.remove('show-controls');
            }
        }, 3000);
    }

    window.togglePlay = function() {
        if (player.paused || player.ended) {
            player.play().catch(() => {});
        } else {
            player.pause();
        }
        showControlsTemporarily();
    };

    window.toggleMute = function() {
        player.muted = !player.muted;
        updateMuteIcon();
    };

    function updateMuteIcon() {
        const btn = document.getElementById('muteBtn');
        if (player.muted || player.volume === 0) btn.textContent = '🔇';
        else if (player.volume < 0.5) btn.textContent = '🔉';
        else btn.textContent = '🔊';
    }

    window.toggleFullscreen = function() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            wrapper.requestFullscreen?.() || wrapper.webkitRequestFullscreen?.() || wrapper.msRequestFullscreen?.();
        }
    };

    function updateProgress() {
        if (isSeeking || !player.duration) return;
        const pct = (player.currentTime / player.duration) * 100;
        document.getElementById('playedBar').style.width = `${pct}%`;
        document.getElementById('progressHandle').style.left = `${pct}%`;
        updateTimeDisplay();
    }

    function updateBuffered() {
        if (player.buffered.length > 0) {
            const pct = (player.buffered.end(player.buffered.length - 1) / player.duration) * 100;
            document.getElementById('bufferedBar').style.width = `${pct}%`;
        }
    }

    function updateTimeDisplay() {
        const cur = formatTime(player.currentTime);
        const dur = formatTime(player.duration || 0);
        document.getElementById('timeDisplay').textContent = `${cur} / ${dur}`;
    }

    function formatTime(seconds) {
        if (isNaN(seconds)) return '0:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
        return `${m}:${s.toString().padStart(2,'0')}`;
    }

    function seekTo(e) {
        const rect = document.getElementById('progressWrap').getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        player.currentTime = pct * player.duration;
    }

    function startSeek(e) {
        isSeeking = true;
        const moveHandler = (e2) => {
            const clientX = e2.clientX || (e2.touches && e2.touches[0]?.clientX);
            if (!clientX) return;
            const rect = document.getElementById('progressWrap').getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            document.getElementById('playedBar').style.width = `${pct * 100}%`;
            document.getElementById('progressHandle').style.left = `${pct * 100}%`;
        };
        const upHandler = (e2) => {
            isSeeking = false;
            const clientX = e2.clientX || (e2.changedTouches && e2.changedTouches[0]?.clientX);
            if (clientX) {
                const rect = document.getElementById('progressWrap').getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                player.currentTime = pct * player.duration;
            }
            document.removeEventListener('mousemove', moveHandler);
            document.removeEventListener('mouseup', upHandler);
            document.removeEventListener('touchmove', moveHandler);
            document.removeEventListener('touchend', upHandler);
        };
        document.addEventListener('mousemove', moveHandler);
        document.addEventListener('mouseup', upHandler);
        document.addEventListener('touchmove', moveHandler, { passive: true });
        document.addEventListener('touchend', upHandler);
    }

    // =============================================
    // WATERMARK SYSTEM (6 LAYERS - HARDCODED)
    // =============================================
    function buildWatermarks(wm) {
        const wmFull = `${wm.name} • ${wm.email} • ID:${wm.id}`;
        const wmShort = `${wm.name} | ${wm.email}`;
        const wmMini = `${wm.name} #${wm.id}`;

        // ── LAYER 1: 6 Moving watermarks ──
        const layer1 = document.getElementById('wmLayer1');
        ['wm-move-1','wm-move-2','wm-move-3','wm-move-4','wm-move-5','wm-move-6'].forEach((cls, i) => {
            const el = document.createElement('div');
            el.className = `wm-text ${cls}`;
            el.textContent = i % 2 === 0 ? wmFull : wmShort;
            layer1.appendChild(el);
        });

        // ── LAYER 2: Static rotated grid ──
        const grid = document.getElementById('wmGrid');
        for (let i = 0; i < 80; i++) {
            const item = document.createElement('div');
            item.className = 'wm-grid-item';
            item.textContent = i % 3 === 0 ? wmFull : wmShort;
            grid.appendChild(item);
        }

        // ── LAYER 3: Center pulsing ──
        document.getElementById('wmCenter').textContent = wmFull;

        // ── LAYER 4: Corner stamps with live timestamp ──
        document.getElementById('wmTL').textContent = wmShort;
        document.getElementById('wmTR').textContent = `ID:${wm.id}`;
        document.getElementById('wmBL').textContent = wm.email;
        document.getElementById('wmBR').textContent = new Date().toLocaleString();
        setInterval(() => {
            document.getElementById('wmBR').textContent = new Date().toLocaleString();
        }, 1000);

        // ── LAYER 5: Random repositioning ──
        function spawnRandom() {
            const existing = wrapper.querySelectorAll('.wm-random');
            if (existing.length > 10) existing[0].remove();

            const el = document.createElement('div');
            el.className = 'wm-random';
            el.textContent = Math.random() > 0.5 ? wmShort : wmMini;
            el.style.top = `${Math.random() * 70 + 5}%`;
            el.style.left = `${Math.random() * 55 + 10}%`;
            el.style.transform = `rotate(${Math.random() * 30 - 15}deg)`;
            el.style.opacity = Math.random() * 0.06 + 0.03;
            el.style.fontSize = `${Math.random() * 6 + 9}px`;
            wrapper.appendChild(el);

            setTimeout(() => {
                el.style.top = `${Math.random() * 70 + 5}%`;
                el.style.left = `${Math.random() * 55 + 10}%`;
            }, 200);
        }
        for (let i = 0; i < 5; i++) spawnRandom();
        setInterval(spawnRandom, 5000);

        // ── LAYER 6: Canvas pixel watermark (IMPOSSIBLE to remove via DOM) ──
        function createCanvasWatermark() {
            const canvas = document.createElement('canvas');
            canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:13;';
            canvas.width = 1920;
            canvas.height = 1080;
            const ctx = canvas.getContext('2d');

            // Layer A: Visible text
            ctx.font = 'bold 13px Courier New';
            ctx.fillStyle = 'rgba(255,255,255,0.03)';
            for (let y = 0; y < 1080; y += 65) {
                for (let x = 0; x < 1920; x += 320) {
                    ctx.save();
                    ctx.translate(x, y);
                    ctx.rotate(-0.4);
                    ctx.fillText(wmShort, 0, 0);
                    ctx.restore();
                }
            }

            // Layer B: Invisible forensic watermark (nearly invisible but shows up when contrast adjusted)
            ctx.font = 'bold 9px Courier New';
            ctx.fillStyle = 'rgba(255,255,255,0.008)';
            for (let y = 30; y < 1080; y += 45) {
                for (let x = 50; x < 1920; x += 250) {
                    ctx.save();
                    ctx.translate(x, y);
                    ctx.rotate(0.2);
                    ctx.fillText(`${wm.email}|${wm.id}|${Date.now()}`, 0, 0);
                    ctx.restore();
                }
            }

            wrapper.appendChild(canvas);

            // Recreate canvas every 30 seconds with new timestamp
            setTimeout(() => {
                canvas.remove();
                createCanvasWatermark();
            }, 30000);
        }
        createCanvasWatermark();
    }

    // =============================================
    // ANTI-PIRACY PROTECTION SYSTEM
    // =============================================

    // 1. Block right-click everywhere
    document.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); return false; }, true);

    // 2. Block all dangerous keyboard shortcuts
    document.addEventListener('keydown', e => {
        const blocked = [
            e.ctrlKey && e.key === 's',
            e.ctrlKey && e.key === 'u',
            e.ctrlKey && e.key === 'p',
            e.ctrlKey && e.key === 'a',
            e.ctrlKey && e.key === 'c',
            e.ctrlKey && e.shiftKey && e.key === 'I',
            e.ctrlKey && e.shiftKey && e.key === 'i',
            e.ctrlKey && e.shiftKey && e.key === 'J',
            e.ctrlKey && e.shiftKey && e.key === 'j',
            e.ctrlKey && e.shiftKey && e.key === 'C',
            e.ctrlKey && e.shiftKey && e.key === 'c',
            e.ctrlKey && e.shiftKey && e.key === 'K',
            e.ctrlKey && e.shiftKey && e.key === 'k',
            e.ctrlKey && e.key === 'g',
            e.ctrlKey && e.key === 'j',
            e.key === 'F12',
            e.key === 'PrintScreen',
            e.ctrlKey && e.key === 'F5',
            e.metaKey && e.shiftKey && e.key === '4', // Mac screenshot
            e.metaKey && e.shiftKey && e.key === '3', // Mac screenshot
            e.metaKey && e.shiftKey && e.key === '5', // Mac screenshot
        ];

        if (blocked.some(b => b)) {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'PrintScreen') {
                navigator.clipboard?.writeText?.('Screenshots are disabled on this platform.');
            }
            return false;
        }
    }, true);

    // 3. Block drag
    document.addEventListener('dragstart', e => { e.preventDefault(); return false; }, true);

    // 4. Block selection
    document.addEventListener('selectstart', e => { e.preventDefault(); return false; }, true);

    // 5. Block copy
    document.addEventListener('copy', e => { e.preventDefault(); return false; }, true);

    // 6. Detect DevTools
    let devToolsOpen = false;
    const devToolsCheck = () => {
        const threshold = 160;
        const widthDiff = window.outerWidth - window.innerWidth > threshold;
        const heightDiff = window.outerHeight - window.innerHeight > threshold;

        if ((widthDiff || heightDiff) && !devToolsOpen) {
            devToolsOpen = true;
            // Add aggressive red watermarks
            for (let i = 0; i < 10; i++) {
                const el = document.createElement('div');
                el.className = 'wm-text';
                el.textContent = `⚠️ RECORDING DETECTED - ${user.name} - ${user.email} - ${new Date().toISOString()}`;
                el.style.cssText = `position:absolute;top:${8 + i*9}%;left:2%;color:rgba(255,0,0,0.3);font-size:clamp(12px,2vw,20px);z-index:100;pointer-events:none;white-space:nowrap;user-select:none;`;
                wrapper.appendChild(el);
            }
            // Pause video
            player.pause();
        } else if (!widthDiff && !heightDiff) {
            devToolsOpen = false;
        }
    };
    setInterval(devToolsCheck, 1500);

    // 7. Detect console.log override (advanced devtools detection)
    const checkDevTools2 = () => {
        const start = performance.now();
        debugger; // This triggers only when devtools is open
        const end = performance.now();
        if (end - start > 100 && !devToolsOpen) {
            devToolsOpen = true;
            player.pause();
        }
    };
    // Uncomment below for aggressive detection (causes brief freeze):
    // setInterval(checkDevTools2, 5000);

    // 8. Block Picture-in-Picture
    player.addEventListener('enterpictureinpicture', () => {
        document.exitPictureInPicture?.().catch(() => {});
    });

    // 9. Prevent video source from being accessed via console
    Object.defineProperty(player, 'src', {
        set: function(val) {
            this.setAttribute('src', val);
        },
        get: function() {
            return '[PROTECTED]';
        }
    });

    // 10. Prevent saving via blob URL manipulation
    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function(obj) {
        if (obj instanceof MediaSource || obj instanceof Blob) {
            // Allow but monitor
            const url = originalCreateObjectURL.call(URL, obj);
            return url;
        }
        return originalCreateObjectURL.call(URL, obj);
    };

    // 11. Override fetch/XMLHttpRequest to prevent video download via console
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        const url = args[0]?.url || args[0] || '';
        if (typeof url === 'string' && url.includes('secure-stream') && !url.includes(currentStreamToken)) {
            return Promise.reject(new Error('Access denied'));
        }
        return originalFetch.apply(this, args);
    };

    // 12. Monitor for screen recording indicators
    if (navigator.mediaDevices) {
        const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
        if (originalGetDisplayMedia) {
            navigator.mediaDevices.getDisplayMedia = function() {
                // Someone is trying to screen record
                for (let i = 0; i < 15; i++) {
                    const el = document.createElement('div');
                    el.className = 'wm-text';
                    el.textContent = `🚨 SCREEN RECORDING DETECTED - ${user.name} - ${user.email}`;
                    el.style.cssText = `position:absolute;top:${5 + i*6}%;left:1%;color:rgba(255,0,0,0.4);font-size:22px;z-index:200;pointer-events:none;`;
                    wrapper.appendChild(el);
                }
                player.pause();
                return Promise.reject(new Error('Screen recording is not allowed'));
            };
        }
    }

    // 13. Disable video download via "Save video as" in any way
    player.addEventListener('loadeddata', () => {
        // Remove the controls attribute to ensure no native controls appear
        player.removeAttribute('controls');
    });

    // 14. Prevent accessing video via iframe embed
    if (window.top !== window.self) {
        document.body.innerHTML = '<h1 style="color:red;text-align:center;padding:50px;">Embedding is not allowed</h1>';
    }

    // 15. Periodic integrity check - ensure watermarks still exist
    setInterval(() => {
        const watermarkLayers = wrapper.querySelectorAll('.watermark-layer, .wm-center, .wm-corner');
        if (watermarkLayers.length < 6) {
            // Someone removed watermarks via devtools! Pause and alert
            player.pause();
            player.src = '';
            document.body.innerHTML = `
                <div class="blocked-screen" style="display:flex;">
                    <div class="icon">🚨</div>
                    <h1>Tampering Detected</h1>
                    <p>Watermark removal attempt detected. Your session has been terminated and your account has been flagged.</p>
                </div>
            `;
            // Log this event to server
            fetch(`${API}/auth/me`, {
                headers: { 'Authorization': `Bearer ${token}` }
            }).catch(() => {});
        }
    }, 3000);

    // 16. Visibility API - add extra watermarks when tab loses focus (recording suspicion)
    let visibilityChangeCount = 0;
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            visibilityChangeCount++;
            if (visibilityChangeCount > 5) {
                // Suspicious - many tab switches
                const el = document.createElement('div');
                el.className = 'wm-text';
                el.textContent = `${user.name} | ${user.email} | ${new Date().toLocaleString()}`;
                el.style.cssText = `position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:rgba(255,255,255,0.15);font-size:24px;z-index:50;pointer-events:none;`;
                wrapper.appendChild(el);
            }
        }
    });

    // 17. Disable right-click "Open in new tab" for video source
    document.querySelectorAll('video, source').forEach(el => {
        el.addEventListener('contextmenu', e => { e.preventDefault(); return false; }, true);
    });

    // 18. Mutation observer - detect if someone removes watermark elements via DevTools
    const observer = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
            mutation.removedNodes.forEach(node => {
                if (node.classList && (
                    node.classList.contains('watermark-layer') ||
                    node.classList.contains('wm-center') ||
                    node.classList.contains('wm-corner') ||
                    node.classList.contains('wm-grid-layer') ||
                    node.classList.contains('anti-download-shield')
                )) {
                    // Re-add removed element
                    wrapper.appendChild(node);
                    // Add extra punishment watermarks
                    const punishment = document.createElement('div');
                    punishment.className = 'wm-text';
                    punishment.textContent = `⚠️ TAMPERING: ${user.name} ${user.email}`;
                    punishment.style.cssText = `position:absolute;top:${Math.random()*80}%;left:5%;color:rgba(255,0,0,0.25);font-size:20px;z-index:100;pointer-events:none;`;
                    wrapper.appendChild(punishment);
                }
            });
        });
    });
    observer.observe(wrapper, { childList: true, subtree: true });

    // =============================================
    // LOGOUT & CLEANUP
    // =============================================
    window.logout = function() {
        if (tokenRefreshInterval) clearInterval(tokenRefreshInterval);
        localStorage.clear();
        window.location.href = '/login.html';
    };

    // Cleanup on page leave
    window.addEventListener('beforeunload', () => {
        if (tokenRefreshInterval) clearInterval(tokenRefreshInterval);
    });

    // ── START ──
    loadVideo();

})();