// public/js/dashboard.js
const API = '/api';
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || '{}');
if (!token) window.location.href = '/login.html';

document.getElementById('welcomeText').textContent = `Welcome, ${user.name}! 👋`;
document.getElementById('userGreeting').textContent = user.name;

let currentView = 'mentorships';
let currentMentorshipId = null;
let currentMentorshipName = '';

async function apiFetch(url) {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    if (data.blocked) {
        document.getElementById('mainContent').style.display = 'none';
        document.getElementById('blockedScreen').style.display = 'flex';
        document.getElementById('blockMessage').textContent = data.message;
        return null;
    }
    if (res.status === 401) { localStorage.clear(); window.location.href = '/login.html'; return null; }
    return data;
}

async function loadMentorships() {
    currentView = 'mentorships';
    currentMentorshipId = null;
    const area = document.getElementById('contentArea');
    area.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

    const data = await apiFetch(`${API}/videos/my-mentorships`);
    if (!data) return;

    if (!data.mentorships || data.mentorships.length === 0) {
        area.innerHTML = `<div class="empty-state"><div class="icon">📭</div><h3>No Programs Available</h3><p>You haven't been assigned to any mentorship program yet.</p></div>`;
        return;
    }

    area.innerHTML = `
        <h2 class="section-title">🎓 Your Mentorship Programs</h2>
        <div class="mentorship-grid">
            ${data.mentorships.map(m => `
                <div class="mentorship-card" onclick="loadVideos('${m._id}','${esc(m.name)}')">
                    <div class="mc-color-bar" style="background:${m.color || '#6c5ce7'}"></div>
                    <div class="mc-icon">${m.icon || '🎓'}</div>
                    <h3>${esc(m.name)}</h3>
                    <p>${esc(m.description || 'Access your lectures here.')}</p>
                    <div class="mc-meta">
                        <span>🎬 ${m.videoCount || 0} lectures</span>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

async function loadVideos(mentorshipId, mentorshipName) {
    currentView = 'videos';
    currentMentorshipId = mentorshipId;
    currentMentorshipName = mentorshipName;
    const area = document.getElementById('contentArea');
    area.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

    const data = await apiFetch(`${API}/videos/mentorship/${mentorshipId}`);
    if (!data) return;

    if (!data.videos || data.videos.length === 0) {
        area.innerHTML = `
            <button class="back-btn" onclick="loadMentorships()">← Back to Programs</button>
            <h2 class="section-title">${esc(mentorshipName)}</h2>
            <div class="empty-state"><div class="icon">📭</div><h3>No Lectures Yet</h3><p>Check back later for new recordings.</p></div>
        `;
        return;
    }

    area.innerHTML = `
        <button class="back-btn" onclick="loadMentorships()">← Back to Programs</button>
        <h2 class="section-title">${esc(mentorshipName)} — ${data.videos.length} Lectures</h2>
        <div class="video-list">
            ${data.videos.map((v, i) => `
                <div class="video-item" onclick="window.location.href='/watch.html?id=${v._id}'">
                    <div class="vi-number">${i + 1}</div>
                    <div class="vi-info">
                        <h4>${esc(v.title)}</h4>
                        <p>${esc(v.description || '')} · 👁 ${v.viewCount} views · ${fmtDate(v.createdAt)}</p>
                    </div>
                    <div class="vi-play">▶</div>
                </div>
            `).join('')}
        </div>
    `;
}

function esc(t) { const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML; }
function fmtDate(d) { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
function logout() { localStorage.clear(); window.location.href = '/login.html'; }

loadMentorships();