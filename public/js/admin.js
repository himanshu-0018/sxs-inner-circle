// public/js/admin.js
const API = '/api';
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || '{}');
if (!token || user.role !== 'admin') window.location.href = '/login.html';

const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

async function api(url, method = 'GET', body = null) {
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API}${url}`, opts);
    return res.json();
}

function showAlert(type, msg) {
    const el = document.getElementById(type === 'error' ? 'errorAlert' : 'successAlert');
    const other = document.getElementById(type === 'error' ? 'successAlert' : 'errorAlert');
    if (other) other.classList.remove('show');
    el.textContent = msg; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 5000);
}

function esc(t) { const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML; }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '-'; }
function openModal(id) { document.getElementById(id).classList.add('show'); if (id === 'videoModal' || id === 'keyModal') loadMentorshipOptions(); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

function showSection(section, el) {
    document.querySelectorAll('[id^="section-"]').forEach(s => s.style.display = 'none');
    document.getElementById(`section-${section}`).style.display = 'block';
    document.querySelectorAll('.admin-sidebar .menu-item, .mobile-admin-nav button').forEach(b => b.classList.remove('active'));
    if (el) el.classList.add('active');
    // Also update other nav
    document.querySelectorAll('.mobile-admin-nav button, .admin-sidebar .menu-item').forEach(b => {
        if (b.textContent.toLowerCase().includes(section.slice(0, 4))) b.classList.add('active');
    });
    const loaders = { 
    dashboard: loadStats, 
    mentorships: loadMentorships, 
    videos: loadVideos, 
    upload: loadUploadOptions, 
    keys: loadKeys, 
    users: loadUsers,
    profile: loadProfile  // ← ADD THIS
};
    loaders[section]?.();
}

// ===== STATS =====
async function loadStats() {
    const data = await api('/admin/stats');
    if (!data.success) return;
    const s = data.stats;
    document.getElementById('statsGrid').innerHTML = `
        <div class="stat-card"><div class="stat-icon">👥</div><div class="stat-number">${s.totalUsers}</div><div class="stat-label">Total Students</div></div>
        <div class="stat-card"><div class="stat-icon">✅</div><div class="stat-number">${s.activeUsers}</div><div class="stat-label">Active</div></div>
        <div class="stat-card"><div class="stat-icon">🚫</div><div class="stat-number">${s.blockedUsers}</div><div class="stat-label">Blocked</div></div>
        <div class="stat-card"><div class="stat-icon">🎓</div><div class="stat-number">${s.totalMentorships}</div><div class="stat-label">Programs</div></div>
        <div class="stat-card"><div class="stat-icon">🎬</div><div class="stat-number">${s.totalVideos}</div><div class="stat-label">Videos</div></div>
        <div class="stat-card"><div class="stat-icon">👁</div><div class="stat-number">${s.totalViews}</div><div class="stat-label">Total Views</div></div>
        <div class="stat-card"><div class="stat-icon">🔑</div><div class="stat-number">${s.unusedKeys}</div><div class="stat-label">Available Keys</div></div>
        <div class="stat-card"><div class="stat-icon">✔️</div><div class="stat-number">${s.usedKeys}</div><div class="stat-label">Used Keys</div></div>
    `;
}

// ===== MENTORSHIPS =====
async function loadMentorships() {
    const data = await api('/admin/mentorships');
    if (!data.success) return;
    const tbody = document.getElementById('mentorshipsBody');
    if (!data.mentorships.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:30px;color:var(--text-muted)">No programs yet.</td></tr>'; return; }
    tbody.innerHTML = data.mentorships.map(m => `<tr>
        <td><span style="margin-right:6px;">${m.icon}</span><strong>${esc(m.name)}</strong><br><small style="color:var(--text-muted)">${esc(m.description||'')}</small></td>
        <td>${m.videoCount}</td><td>${m.studentCount}</td>
        <td><span class="status-badge ${m.isActive ? 'badge-active' : 'badge-inactive'}">${m.isActive ? 'Active' : 'Hidden'}</span></td>
        <td><button class="btn btn-danger btn-small" onclick="deleteMentorship('${m._id}')">Delete</button></td>
    </tr>`).join('');
}

document.getElementById('mentorshipForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = await api('/admin/mentorships', 'POST', {
        name: document.getElementById('mName').value,
        description: document.getElementById('mDesc').value,
        icon: document.getElementById('mIcon').value,
        color: document.getElementById('mColor').value
    });
    if (data.success) { showAlert('success', 'Program created!'); closeModal('mentorshipModal'); loadMentorships(); loadStats(); document.getElementById('mentorshipForm').reset(); }
    else showAlert('error', data.message);
});

async function deleteMentorship(id) {
    if (!confirm('Delete this program and ALL its videos?')) return;
    const data = await api(`/admin/mentorships/${id}`, 'DELETE');
    if (data.success) { showAlert('success', 'Deleted!'); loadMentorships(); loadStats(); }
}

// ===== VIDEOS =====
async function loadVideos() {
    const data = await api('/admin/videos');
    if (!data.success) return;
    const tbody = document.getElementById('videosBody');
    if (!data.videos.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:30px;color:var(--text-muted)">No videos.</td></tr>'; return; }
    tbody.innerHTML = data.videos.map(v => `<tr>
        <td><strong>${esc(v.title)}</strong><br><small style="color:var(--text-muted)">${esc(v.description||'').slice(0,50)}</small></td>
        <td>${v.mentorship ? `${v.mentorship.icon||''} ${esc(v.mentorship.name)}` : '-'}</td>
        <td>${v.viewCount}</td>
        <td><span class="status-badge ${v.isActive ? 'badge-active' : 'badge-inactive'}">${v.isActive ? 'Active' : 'Hidden'}</span></td>
        <td>
            <button class="btn btn-warning btn-small" onclick="toggleVideo('${v._id}')">${v.isActive ? 'Hide' : 'Show'}</button>
            <button class="btn btn-danger btn-small" onclick="deleteVideo('${v._id}')">Del</button>
        </td>
    </tr>`).join('');
}

async function loadMentorshipOptions() {
    const data = await api('/admin/mentorships');
    if (!data.success) return;

    const select = document.getElementById('vMentorship');
    if (select) {
        select.innerHTML = '<option value="">Select program</option>' +
            data.mentorships.map(m => `<option value="${m._id}">${m.icon} ${esc(m.name)}</option>`).join('');
    }

    const checkboxes = document.getElementById('kMentorships');
    if (checkboxes) {
        checkboxes.innerHTML = data.mentorships.map(m => `
            <label class="checkbox-item"><input type="checkbox" value="${m._id}">${m.icon} ${esc(m.name)}</label>
        `).join('');
    }
}

document.getElementById('videoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = await api('/admin/videos', 'POST', {
        title: document.getElementById('vTitle').value,
        description: document.getElementById('vDesc').value,
        mentorship: document.getElementById('vMentorship').value,
        videoUrl: document.getElementById('vUrl').value,
        order: parseInt(document.getElementById('vOrder').value) || 0
    });
    if (data.success) { showAlert('success', 'Video added!'); closeModal('videoModal'); loadVideos(); loadStats(); document.getElementById('videoForm').reset(); }
    else showAlert('error', data.message);
});

async function toggleVideo(id) { await api(`/admin/videos/${id}/toggle`, 'PATCH'); loadVideos(); }
async function deleteVideo(id) {
    if (!confirm('Delete this video?')) return;
    await api(`/admin/videos/${id}`, 'DELETE'); loadVideos(); loadStats();
}

// ===== KEYS =====
async function loadKeys() {
    const data = await api('/admin/keys');
    if (!data.success) return;
    const tbody = document.getElementById('keysBody');
    if (!data.keys.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--text-muted)">No keys.</td></tr>'; return; }
    tbody.innerHTML = data.keys.map(k => {
        const expired = new Date() > new Date(k.expiresAt);
        let statusClass = k.isUsed ? 'badge-used' : expired ? 'badge-expired' : 'badge-available';
        let statusText = k.isUsed ? 'Used' : expired ? 'Expired' : 'Available';
        return `<tr>
            <td><code style="color:var(--secondary);font-size:0.78rem;">${k.key}</code></td>
            <td style="font-size:0.75rem;">${(k.mentorships||[]).map(m => `${m.icon||''} ${esc(m.name)}`).join(', ') || 'None'}</td>
            <td><span class="status-badge ${statusClass}">${statusText}</span></td>
            <td style="font-size:0.78rem;">${k.usedBy ? `${k.usedBy.name}` : '-'}</td>
            <td style="font-size:0.78rem;">${fmtDate(k.expiresAt)}</td>
            <td>
                <button class="copy-btn" onclick="copyKey('${k.key}')">Copy</button>
                ${!k.isUsed ? `<button class="btn btn-danger btn-small" onclick="deleteKey('${k._id}')" style="margin-left:4px;">Del</button>` : ''}
            </td>
        </tr>`;
    }).join('');
}

document.getElementById('keyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mentorships = [...document.querySelectorAll('#kMentorships input:checked')].map(cb => cb.value);
    const data = await api('/admin/keys/generate', 'POST', {
        count: parseInt(document.getElementById('kCount').value),
        expiresInDays: parseInt(document.getElementById('kExpiry').value),
        note: document.getElementById('kNote').value,
        mentorships
    });
    if (data.success) {
        document.getElementById('generatedKeys').innerHTML =
            `<h4 style="color:var(--success);margin-bottom:8px;">✅ ${data.keys.length} Key(s) Generated!</h4>` +
            data.keys.map(k => `<div class="key-display"><span>${k.key}</span><button class="copy-btn" onclick="copyKey('${k.key}')">Copy</button></div>`).join('');
        loadKeys(); loadStats();
    } else showAlert('error', data.message);
});

function copyKey(key) { navigator.clipboard.writeText(key); showAlert('success', `Copied: ${key}`); }
async function deleteKey(id) { await api(`/admin/keys/${id}`, 'DELETE'); loadKeys(); }

// ===== USERS =====
async function loadUsers() {
    const data = await api('/admin/users');
    if (!data.success) return;
    const tbody = document.getElementById('usersBody');
    if (!data.users.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--text-muted)">No students.</td></tr>'; return; }
    tbody.innerHTML = data.users.map(u => {
        const ipCount = u.uniqueIPs?.length || 0;
        const suspicious = ipCount >= 4;
        const isBlocked = u.isBlocked;
        let statusBadge = isBlocked ? '<span class="status-badge badge-blocked">🚫 BLOCKED</span>' :
            u.isActive ? '<span class="status-badge badge-active">Active</span>' :
            '<span class="status-badge badge-inactive">Inactive</span>';
        return `<tr style="${isBlocked ? 'background:rgba(255,71,87,0.05);' : ''}">
            <td><strong>${esc(u.name)}</strong><br><small style="color:var(--text-muted)">Logins: ${u.loginCount||0}</small></td>
            <td style="font-size:0.78rem;">${esc(u.email)}${u.phone ? `<br>${esc(u.phone)}` : ''}</td>
            <td style="font-size:0.75rem;">${(u.mentorships||[]).map(m => `${m.icon||''} ${esc(m.name)}`).join('<br>') || '-'}</td>
            <td style="${suspicious ? 'color:var(--danger);font-weight:700;' : ''}">${ipCount} ${suspicious ? '⚠️' : ''}</td>
            <td>${statusBadge}${isBlocked ? `<br><small style="color:var(--danger);font-size:0.7rem;">${esc(u.blockReason||'')}</small>` : ''}</td>
            <td>
                ${isBlocked ? `<button class="btn btn-success btn-small" onclick="unblockUser('${u._id}')">Unblock</button>` :
                `<button class="btn btn-warning btn-small" onclick="toggleUser('${u._id}')">${u.isActive ? 'Ban' : 'Unban'}</button>`}
                <button class="btn btn-danger btn-small" onclick="deleteUser('${u._id}')" style="margin-left:3px;">Del</button>
            </td>
        </tr>`;
    }).join('');
}

async function toggleUser(id) { const d = await api(`/admin/users/${id}/toggle`, 'PATCH'); showAlert('success', d.message); loadUsers(); loadStats(); }
async function unblockUser(id) { const d = await api(`/admin/users/${id}/unblock`, 'PATCH'); showAlert('success', d.message); loadUsers(); loadStats(); }
async function deleteUser(id) { if (!confirm('Delete this user permanently?')) return; await api(`/admin/users/${id}`, 'DELETE'); loadUsers(); loadStats(); }

// ===== PROFILE & CHANGE PASSWORD =====
async function loadProfile() {
    try {
        const data = await api('/auth/me');
        if (!data.success) return;

        const u = data.user;
        document.getElementById('profileName').textContent = u.name;
        document.getElementById('profileEmail').textContent = u.email;

        const roleEl = document.getElementById('profileRole');
        if (u.role === 'superadmin') {
            roleEl.textContent = '👑 Super Admin';
            roleEl.className = 'status-badge badge-active';
        } else {
            roleEl.textContent = '🛡️ Admin';
            roleEl.className = 'status-badge badge-available';
        }
    } catch (err) {
        console.error('Profile load error:', err);
    }
}

// Toggle password visibility
function togglePw(id) {
    const input = document.getElementById(id);
    input.type = input.type === 'password' ? 'text' : 'password';
}

// Password strength checker
document.getElementById('newPassword')?.addEventListener('input', function () {
    const val = this.value;
    const bar = document.getElementById('strengthBar');
    const text = document.getElementById('strengthText');
    let strength = 0;

    if (val.length >= 6) strength++;
    if (val.length >= 10) strength++;
    if (/[A-Z]/.test(val)) strength++;
    if (/[0-9]/.test(val)) strength++;
    if (/[^A-Za-z0-9]/.test(val)) strength++;

    const levels = [
        { w: '0%', color: 'transparent', label: '' },
        { w: '25%', color: '#ff4757', label: 'Weak' },
        { w: '50%', color: '#ffa502', label: 'Fair' },
        { w: '75%', color: '#1e90ff', label: 'Good' },
        { w: '90%', color: '#2ed573', label: 'Strong' },
        { w: '100%', color: '#2ed573', label: '💪 Very Strong' }
    ];

    const level = levels[Math.min(strength, 5)];
    if (bar) {
        bar.style.width = level.w;
        bar.style.background = level.color;
    }
    if (text) {
        text.textContent = level.label;
        text.style.color = level.color;
    }
});

// Change password form
document.getElementById('changePasswordForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmNewPassword = document.getElementById('confirmNewPassword').value;
    const btn = document.getElementById('changePwBtn');

    // Show alerts inside profile section
    function showPwAlert(type, msg) {
        const el = document.getElementById(type === 'error' ? 'pwErrorAlert' : 'pwSuccessAlert');
        const other = document.getElementById(type === 'error' ? 'pwSuccessAlert' : 'pwErrorAlert');
        if (other) other.classList.remove('show');
        if (el) {
            el.textContent = msg;
            el.classList.add('show');
            setTimeout(() => el.classList.remove('show'), 5000);
        }
    }

    // Validate
    if (newPassword !== confirmNewPassword) {
        showPwAlert('error', 'New passwords do not match!');
        return;
    }

    if (newPassword === currentPassword) {
        showPwAlert('error', 'New password must be different from current password.');
        return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Changing Password...';

    try {
        const res = await fetch(`${API}/auth/change-password`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ currentPassword, newPassword })
        });

        const data = await res.json();

        if (data.success) {
            showPwAlert('success', '✅ Password changed! Logging out in 3 seconds...');
            document.getElementById('changePasswordForm').reset();
            document.getElementById('strengthBar').style.width = '0%';
            document.getElementById('strengthText').textContent = '';

            // Auto logout after 3 seconds
            setTimeout(() => {
                localStorage.clear();
                window.location.href = '/login.html';
            }, 3000);
        } else {
            showPwAlert('error', data.message);
            btn.disabled = false;
            btn.textContent = '🔑 Change Password';
        }
    } catch (err) {
        showPwAlert('error', 'Network error. Try again.');
        btn.disabled = false;
        btn.textContent = '🔑 Change Password';
    }
});

function logout() { localStorage.clear(); window.location.href = '/login.html'; }
// Initial load - load all data on page open
loadStats();

// Also preload mentorships and videos in background
setTimeout(() => {
    loadMentorships();
    loadVideos();
    loadKeys();
    loadUsers();
}, 500);
