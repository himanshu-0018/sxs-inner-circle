// public/js/admin.js
const API = '/api';
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || '{}');
if (!token || (user.role !== 'admin' && user.role !== 'superadmin')) {
    window.location.href = '/login.html';
}

const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

// =============================================
// API HELPER
// =============================================
async function api(url, method, body) {
    try {
        const opts = { method: method || 'GET', headers };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(`${API}${url}`, opts);

        if (res.status === 401 || res.status === 403) {
            localStorage.clear();
            window.location.href = '/login.html';
            return { success: false };
        }

        return res.json();
    } catch (err) {
        console.error('API Error:', err);
        return { success: false, message: 'Network error. Check connection.' };
    }
}

// =============================================
// UTILITIES
// =============================================
function showAlert(type, msg) {
    const el = document.getElementById(type === 'error' ? 'errorAlert' : 'successAlert');
    const other = document.getElementById(type === 'error' ? 'successAlert' : 'errorAlert');
    if (other) other.classList.remove('show');
    if (el) {
        el.textContent = msg;
        el.classList.add('show');
        setTimeout(() => el.classList.remove('show'), 5000);
    }
}

function esc(t) {
    const d = document.createElement('div');
    d.textContent = t || '';
    return d.innerHTML;
}

function fmtDate(d) {
    return d ? new Date(d).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
    }) : '-';
}

function fmtSize(bytes) {
    if (!bytes) return '-';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function openModal(id) {
    document.getElementById(id).classList.add('show');

    // Clear previous generated keys display
    if (id === 'keyModal') {
        const genKeys = document.getElementById('generatedKeys');
        if (genKeys) genKeys.innerHTML = '';
        // Load mentorships for checkboxes
        loadMentorshipCheckboxes();
    }

    if (id === 'videoModal') {
        // Load mentorships for video dropdown
        loadMentorshipDropdowns();
    }
}

function closeModal(id) {
    document.getElementById(id).classList.remove('show');
}

// =============================================
// SECTION NAVIGATION
// =============================================
function showSection(section, el) {
    // Hide all sections
    document.querySelectorAll('[id^="section-"]').forEach(s => s.style.display = 'none');

    // Show selected section
    const target = document.getElementById(`section-${section}`);
    if (target) target.style.display = 'block';

    // Remove active from all buttons
    document.querySelectorAll('.admin-sidebar .menu-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.mobile-admin-nav button').forEach(b => b.classList.remove('active'));

    // Set active on clicked button
    if (el) el.classList.add('active');

    // Load data for section
    const loaders = {
        dashboard: loadStats,
        mentorships: loadMentorships,
        videos: loadVideos,
        upload: loadUploadSection,
        keys: loadKeys,
        users: loadUsers,
        profile: loadProfile
        conversion: loadConversion  // ← ADD THIS
    };

    if (loaders[section]) loaders[section]();
}

// =============================================
// LOAD MENTORSHIP OPTIONS (Shared)
// =============================================

// Load mentorships into DROPDOWNS (for video forms)
async function loadMentorshipDropdowns() {
    try {
        const data = await api('/admin/mentorships');
        if (!data || !data.success || !data.mentorships) return;

        const dropdownIds = ['fuMentorship', 'vuMentorship', 'vMentorship'];
        dropdownIds.forEach(id => {
            const select = document.getElementById(id);
            if (select) {
                select.innerHTML = '<option value="">-- Select Program --</option>' +
                    data.mentorships.map(m =>
                        `<option value="${m._id}">${m.icon || '🎓'} ${esc(m.name)}</option>`
                    ).join('');
            }
        });
    } catch (err) {
        console.error('Load dropdown error:', err);
    }
}

// Load mentorships into CHECKBOXES (for key generation)
async function loadMentorshipCheckboxes() {
    try {
        const data = await api('/admin/mentorships');
        if (!data || !data.success || !data.mentorships) return;

        const container = document.getElementById('kMentorships');
        if (!container) return;

        if (data.mentorships.length === 0) {
            container.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem;padding:8px;">No programs yet. Create one first!</p>';
            return;
        }

        container.innerHTML = data.mentorships.map(m => `
            <label class="checkbox-item" style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:8px 14px;background:rgba(255,255,255,0.03);border:1px solid var(--card-border);border-radius:8px;transition:all 0.2s;">
                <input type="checkbox"
                    value="${m._id}"
                    style="width:18px;height:18px;accent-color:var(--primary);cursor:pointer;flex-shrink:0;"
                    onchange="this.closest('label').style.borderColor=this.checked?'var(--primary)':'var(--card-border)';this.closest('label').style.background=this.checked?'rgba(108,92,231,0.15)':'rgba(255,255,255,0.03)';">
                <span style="font-size:0.88rem;">${m.icon || '🎓'} ${esc(m.name)}</span>
            </label>
        `).join('');
    } catch (err) {
        console.error('Load checkboxes error:', err);
    }
}

// Load upload section
async function loadUploadSection() {
    await loadMentorshipDropdowns();
}

// =============================================
// STATS
// =============================================
async function loadStats() {
    try {
        const data = await api('/admin/stats');
        if (!data || !data.success) {
            document.getElementById('statsGrid').innerHTML = `
                <div style="grid-column:1/-1;text-align:center;padding:30px;color:var(--danger);">
                    Error loading stats. Check server.
                </div>`;
            return;
        }
        const s = data.stats;
        document.getElementById('statsGrid').innerHTML = `
            <div class="stat-card"><div class="stat-icon">👥</div><div class="stat-number">${s.totalUsers || 0}</div><div class="stat-label">Total Students</div></div>
            <div class="stat-card"><div class="stat-icon">✅</div><div class="stat-number">${s.activeUsers || 0}</div><div class="stat-label">Active</div></div>
            <div class="stat-card"><div class="stat-icon">🚫</div><div class="stat-number">${s.blockedUsers || 0}</div><div class="stat-label">Blocked</div></div>
            <div class="stat-card"><div class="stat-icon">🎓</div><div class="stat-number">${s.totalMentorships || 0}</div><div class="stat-label">Programs</div></div>
            <div class="stat-card"><div class="stat-icon">🎬</div><div class="stat-number">${s.totalVideos || 0}</div><div class="stat-label">Videos</div></div>
            <div class="stat-card"><div class="stat-icon">👁</div><div class="stat-number">${s.totalViews || 0}</div><div class="stat-label">Total Views</div></div>
            <div class="stat-card"><div class="stat-icon">🔑</div><div class="stat-number">${s.unusedKeys || 0}</div><div class="stat-label">Available Keys</div></div>
            <div class="stat-card"><div class="stat-icon">✔️</div><div class="stat-number">${s.usedKeys || 0}</div><div class="stat-label">Used Keys</div></div>
        `;
    } catch (err) {
        console.error('Stats error:', err);
        document.getElementById('statsGrid').innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:30px;color:var(--danger);">
                Error loading dashboard.
            </div>`;
    }
}

// =============================================
// MENTORSHIPS
// =============================================
async function loadMentorships() {
    const tbody = document.getElementById('mentorshipsBody');
    if (tbody) tbody.innerHTML = `
        <tr><td colspan="5" style="text-align:center;padding:20px;">
            <div class="spinner" style="margin:0 auto;"></div>
        </td></tr>`;

    const data = await api('/admin/mentorships');
    if (!data || !data.success) {
        if (tbody) tbody.innerHTML = `
            <tr><td colspan="5" style="text-align:center;padding:30px;color:var(--danger)">
                Error loading. Try again.
            </td></tr>`;
        return;
    }

    if (!data.mentorships || data.mentorships.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="5" style="text-align:center;padding:30px;color:var(--text-muted)">
                No programs yet. Create one!
            </td></tr>`;
        return;
    }

    tbody.innerHTML = data.mentorships.map(m => `
        <tr>
            <td>
                <span style="margin-right:6px;">${m.icon || '🎓'}</span>
                <strong>${esc(m.name)}</strong>
                <br><small style="color:var(--text-muted)">${esc(m.description || '')}</small>
            </td>
            <td>${m.videoCount || 0}</td>
            <td>${m.studentCount || 0}</td>
            <td>
                <span class="status-badge ${m.isActive ? 'badge-active' : 'badge-inactive'}">
                    ${m.isActive ? 'Active' : 'Hidden'}
                </span>
            </td>
            <td>
                <button class="btn btn-danger btn-small" onclick="deleteMentorship('${m._id}')">Delete</button>
            </td>
        </tr>
    `).join('');
}

document.getElementById('mentorshipForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    const data = await api('/admin/mentorships', 'POST', {
        name: document.getElementById('mName').value.trim(),
        description: document.getElementById('mDesc').value.trim(),
        icon: document.getElementById('mIcon').value.trim() || '🎓',
        color: document.getElementById('mColor').value || '#6c5ce7'
    });

    if (data.success) {
        showAlert('success', '✅ Program created!');
        closeModal('mentorshipModal');
        loadMentorships();
        loadStats();
        document.getElementById('mentorshipForm').reset();
    } else {
        showAlert('error', data.message);
    }
    btn.disabled = false;
    btn.textContent = 'Create';
});

async function deleteMentorship(id) {
    if (!confirm('Delete this program and ALL its videos? This cannot be undone!')) return;
    const data = await api(`/admin/mentorships/${id}`, 'DELETE');
    if (data.success) {
        showAlert('success', 'Program deleted!');
        loadMentorships();
        loadStats();
    } else {
        showAlert('error', data.message || 'Error deleting.');
    }
}

// =============================================
// VIDEOS
// =============================================
async function loadVideos() {
    const tbody = document.getElementById('videosBody');
    if (tbody) tbody.innerHTML = `
        <tr><td colspan="5" style="text-align:center;padding:20px;">
            <div class="spinner" style="margin:0 auto;"></div>
        </td></tr>`;

    const data = await api('/admin/videos');
    if (!data || !data.success) {
        if (tbody) tbody.innerHTML = `
            <tr><td colspan="5" style="text-align:center;padding:30px;color:var(--danger)">
                Error loading. Try again.
            </td></tr>`;
        return;
    }

    if (!data.videos || data.videos.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="5" style="text-align:center;padding:30px;color:var(--text-muted)">
                No videos yet.
            </td></tr>`;
        return;
    }

    tbody.innerHTML = data.videos.map(v => `
        <tr>
            <td>
                <strong>${esc(v.title)}</strong>
                <br><small style="color:var(--text-muted)">${esc((v.description || '').slice(0, 50))}</small>
            </td>
            <td style="font-size:0.82rem;">
                ${v.mentorship ? `${v.mentorship.icon || ''} ${esc(v.mentorship.name)}` : '-'}
            </td>
            <td>${v.viewCount || 0}</td>
            <td>
                <span class="status-badge ${v.isActive ? 'badge-active' : 'badge-inactive'}">
                    ${v.isActive ? 'Active' : 'Hidden'}
                </span>
            </td>
            <td>
                <button class="btn btn-warning btn-small" onclick="toggleVideo('${v._id}')">
                    ${v.isActive ? 'Hide' : 'Show'}
                </button>
                <button class="btn btn-danger btn-small" onclick="deleteVideo('${v._id}')" style="margin-left:3px;">
                    Del
                </button>
            </td>
        </tr>
    `).join('');
}

// URL video form submit
document.getElementById('urlUploadForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const mentorshipId = document.getElementById('vuMentorship').value;
    if (!mentorshipId) {
        showAlert('error', 'Please select a mentorship program!');
        return;
    }

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '⏳ Adding...';

    const data = await api('/admin/videos', 'POST', {
        title: document.getElementById('vuTitle').value.trim(),
        description: document.getElementById('vuDesc').value.trim(),
        mentorship: mentorshipId,
        videoUrl: document.getElementById('vuUrl').value.trim(),
        order: parseInt(document.getElementById('vuOrder').value) || 0
    });

    if (data.success) {
        showAlert('success', '✅ Video added successfully!');
        document.getElementById('urlUploadForm').reset();
        loadVideos();
        loadStats();
    } else {
        showAlert('error', data.message || 'Error adding video.');
    }

    btn.disabled = false;
    btn.textContent = '🔗 Add Video';
});

// File upload form submit
document.getElementById('fileUploadForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const mentorshipId = document.getElementById('fuMentorship').value;
    if (!mentorshipId) {
        showAlert('error', 'Please select a mentorship program!');
        return;
    }

    const fileInput = document.getElementById('fuFile');
    if (!fileInput || !fileInput.files[0]) {
        showAlert('error', 'Please select a video file.');
        return;
    }

    const file = fileInput.files[0];
    if (file.size > 500 * 1024 * 1024) {
        showAlert('error', 'File too large! Max 500MB.');
        return;
    }

    const btn = document.getElementById('uploadBtn');
    const progressWrap = document.getElementById('uploadProgressWrap');
    const progressBar = document.getElementById('uploadProgressBar');
    const statusText = document.getElementById('uploadStatusText');
    const percentText = document.getElementById('uploadPercentText');

    btn.disabled = true;
    btn.textContent = '⏳ Uploading...';
    if (progressWrap) progressWrap.style.display = 'block';

    const formData = new FormData();
    formData.append('video', file);
    formData.append('title', document.getElementById('fuTitle').value.trim());
    formData.append('description', document.getElementById('fuDesc').value.trim());
    formData.append('mentorship', mentorshipId);
    formData.append('order', document.getElementById('fuOrder').value || '0');

    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            if (progressBar) progressBar.style.width = `${pct}%`;
            if (percentText) percentText.textContent = `${pct}%`;
            if (statusText) {
                statusText.textContent = pct < 100
                    ? `Uploading: ${fmtSize(e.loaded)} / ${fmtSize(e.total)}`
                    : '⏳ Processing on server...';
            }
        }
    });

    xhr.addEventListener('load', () => {
        try {
            const data = JSON.parse(xhr.responseText);
            if (data.success) {
                showAlert('success', `✅ Video uploaded successfully!`);
                document.getElementById('fileUploadForm').reset();
                if (progressBar) progressBar.style.width = '0%';
                if (progressWrap) progressWrap.style.display = 'none';
                loadVideos();
                loadStats();
            } else {
                showAlert('error', data.message || 'Upload failed.');
            }
        } catch (err) {
            showAlert('error', 'Upload failed. Try again.');
        }
        btn.disabled = false;
        btn.textContent = '📤 Upload Video';
    });

    xhr.addEventListener('error', () => {
        showAlert('error', 'Upload failed. Check your connection.');
        btn.disabled = false;
        btn.textContent = '📤 Upload Video';
        if (progressWrap) progressWrap.style.display = 'none';
    });

    xhr.timeout = 600000;
    xhr.open('POST', `${API}/admin/videos/upload`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.send(formData);
});

async function toggleVideo(id) {
    const data = await api(`/admin/videos/${id}/toggle`, 'PATCH');
    if (data.success) {
        showAlert('success', data.message);
        loadVideos();
    }
}

async function deleteVideo(id) {
    if (!confirm('Delete this video permanently?')) return;
    const data = await api(`/admin/videos/${id}`, 'DELETE');
    if (data.success) {
        showAlert('success', 'Video deleted!');
        loadVideos();
        loadStats();
    }
}

// Tab switching in upload section
function switchUploadTab(tab) {
    const fileForm = document.getElementById('fileUploadForm');
    const urlForm = document.getElementById('urlUploadForm');
    const tabUpload = document.getElementById('tabUpload');
    const tabUrl = document.getElementById('tabUrl');

    if (tab === 'upload') {
        if (fileForm) fileForm.style.display = 'block';
        if (urlForm) urlForm.style.display = 'none';
        if (tabUpload) tabUpload.className = 'btn btn-primary btn-small';
        if (tabUrl) tabUrl.className = 'btn btn-secondary btn-small';
    } else {
        if (fileForm) fileForm.style.display = 'none';
        if (urlForm) urlForm.style.display = 'block';
        if (tabUpload) tabUpload.className = 'btn btn-secondary btn-small';
        if (tabUrl) tabUrl.className = 'btn btn-primary btn-small';
    }

    // Make sure both tabs have flex:1
    if (tabUpload) tabUpload.style.flex = '1';
    if (tabUrl) tabUrl.style.flex = '1';

    // Reload dropdowns when switching tabs
    loadMentorshipDropdowns();
}

// =============================================
// ACCESS KEYS
// =============================================
async function loadKeys() {
    const tbody = document.getElementById('keysBody');
    if (tbody) tbody.innerHTML = `
        <tr><td colspan="6" style="text-align:center;padding:20px;">
            <div class="spinner" style="margin:0 auto;"></div>
        </td></tr>`;

    const data = await api('/admin/keys');
    if (!data || !data.success) {
        if (tbody) tbody.innerHTML = `
            <tr><td colspan="6" style="text-align:center;padding:30px;color:var(--danger)">
                Error loading keys.
            </td></tr>`;
        return;
    }

    if (!data.keys || data.keys.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="6" style="text-align:center;padding:30px;color:var(--text-muted)">
                No keys generated yet.
            </td></tr>`;
        return;
    }

    tbody.innerHTML = data.keys.map(k => {
        const expired = new Date() > new Date(k.expiresAt);
        const statusClass = k.isUsed ? 'badge-used' : expired ? 'badge-expired' : 'badge-available';
        const statusText = k.isUsed ? '✔ Used' : expired ? '⏰ Expired' : '✅ Available';

        return `
        <tr>
            <td><code style="color:var(--secondary);font-size:0.78rem;">${k.key}</code></td>
            <td style="font-size:0.75rem;">
                ${(k.mentorships || []).map(m => `${m.icon || ''} ${esc(m.name)}`).join('<br>') || '<span style="color:var(--danger)">None</span>'}
            </td>
            <td><span class="status-badge ${statusClass}">${statusText}</span></td>
            <td style="font-size:0.78rem;">${k.usedBy ? `${esc(k.usedBy.name)}<br><small>${esc(k.usedBy.email)}</small>` : '-'}</td>
            <td style="font-size:0.78rem;">${fmtDate(k.expiresAt)}</td>
            <td>
                <button class="copy-btn" onclick="copyKey('${k.key}')">Copy</button>
                ${!k.isUsed ? `<button class="btn btn-danger btn-small" onclick="deleteKey('${k._id}')" style="margin-left:4px;">Del</button>` : ''}
            </td>
        </tr>`;
    }).join('');
}

// Key generation form
document.getElementById('keyForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Get all checked mentorship checkboxes
    const checkboxes = document.querySelectorAll('#kMentorships input[type="checkbox"]:checked');
    const mentorships = Array.from(checkboxes).map(cb => cb.value);

    // Validate
    if (mentorships.length === 0) {
        showAlert('error', '❌ Please select at least one mentorship program!');
        return;
    }

    const count = parseInt(document.getElementById('kCount').value) || 1;
    const expiresInDays = parseInt(document.getElementById('kExpiry').value) || 30;
    const note = document.getElementById('kNote').value.trim() || '';

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '⏳ Generating...';

    const data = await api('/admin/keys/generate', 'POST', {
        count,
        expiresInDays,
        note,
        mentorships
    });

    if (data.success) {
        const genDiv = document.getElementById('generatedKeys');
        if (genDiv) {
            genDiv.innerHTML = `
                <div style="margin-top:16px;padding:14px;background:rgba(46,213,115,0.08);border:1px solid rgba(46,213,115,0.2);border-radius:10px;">
                    <h4 style="color:var(--success);margin-bottom:10px;">✅ ${data.keys.length} Key(s) Generated!</h4>
                    <p style="color:var(--text-muted);font-size:0.78rem;margin-bottom:10px;">
                        Assigned to ${mentorships.length} program(s) • Valid for ${expiresInDays} days
                    </p>
                    ${data.keys.map(k => `
                        <div class="key-display">
                            <span style="font-family:monospace;">${k.key}</span>
                            <button class="copy-btn" onclick="copyKey('${k.key}')">Copy</button>
                        </div>
                    `).join('')}
                    <button class="btn btn-secondary btn-small" style="margin-top:10px;width:100%;" onclick="copyAllKeys([${data.keys.map(k => `'${k.key}'`).join(',')}])">
                        📋 Copy All Keys
                    </button>
                </div>
            `;
        }
        loadKeys();
        loadStats();
    } else {
        showAlert('error', data.message || 'Error generating keys.');
    }

    btn.disabled = false;
    btn.textContent = 'Generate';
});

function copyKey(key) {
    navigator.clipboard.writeText(key).then(() => {
        showAlert('success', `✅ Copied: ${key}`);
    }).catch(() => {
        showAlert('error', 'Copy failed. Try manually.');
    });
}

function copyAllKeys(keys) {
    const text = keys.join('\n');
    navigator.clipboard.writeText(text).then(() => {
        showAlert('success', `✅ All ${keys.length} keys copied!`);
    }).catch(() => {
        showAlert('error', 'Copy failed. Try manually.');
    });
}

async function deleteKey(id) {
    if (!confirm('Delete this key?')) return;
    const data = await api(`/admin/keys/${id}`, 'DELETE');
    if (data.success) {
        showAlert('success', 'Key deleted.');
        loadKeys();
    }
}

// =============================================
// USERS
// =============================================
async function loadUsers() {
    const tbody = document.getElementById('usersBody');
    if (tbody) tbody.innerHTML = `
        <tr><td colspan="6" style="text-align:center;padding:20px;">
            <div class="spinner" style="margin:0 auto;"></div>
        </td></tr>`;

    const data = await api('/admin/users');
    if (!data || !data.success) {
        if (tbody) tbody.innerHTML = `
            <tr><td colspan="6" style="text-align:center;padding:30px;color:var(--danger)">
                Error loading users.
            </td></tr>`;
        return;
    }

    if (!data.users || data.users.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="6" style="text-align:center;padding:30px;color:var(--text-muted)">
                No students registered yet.
            </td></tr>`;
        return;
    }

    tbody.innerHTML = data.users.map(u => {
        const ipCount = u.uniqueIPs?.length || 0;
        const suspicious = ipCount >= 4;
        const isBlocked = u.isBlocked;

        let statusBadge = isBlocked
            ? '<span class="status-badge badge-blocked">🚫 BLOCKED</span>'
            : u.isActive
                ? '<span class="status-badge badge-active">✅ Active</span>'
                : '<span class="status-badge badge-inactive">❌ Inactive</span>';

        return `
        <tr style="${isBlocked ? 'background:rgba(255,71,87,0.05);' : ''}">
            <td>
                <strong>${esc(u.name)}</strong>
                <br><small style="color:var(--text-muted)">Logins: ${u.loginCount || 0}</small>
            </td>
            <td style="font-size:0.78rem;">
                ${esc(u.email)}
                ${u.phone ? `<br><small style="color:var(--text-muted)">${esc(u.phone)}</small>` : ''}
            </td>
            <td style="font-size:0.75rem;">
                ${(u.mentorships || []).map(m => `${m.icon || ''} ${esc(m.name)}`).join('<br>') || '-'}
            </td>
            <td style="${suspicious ? 'color:var(--danger);font-weight:700;' : 'color:var(--text-muted);'}">
                ${ipCount} ${suspicious ? '⚠️' : ''}
            </td>
            <td>
                ${statusBadge}
                ${isBlocked ? `<br><small style="color:var(--danger);font-size:0.7rem;line-height:1.3;display:block;margin-top:4px;">${esc(u.blockReason || '')}</small>` : ''}
            </td>
            <td>
                ${isBlocked
                    ? `<button class="btn btn-success btn-small" onclick="unblockUser('${u._id}')">✅ Unblock</button>`
                    : `<button class="btn btn-warning btn-small" onclick="toggleUser('${u._id}')">${u.isActive ? '🚫 Ban' : '✅ Unban'}</button>`
                }
                <button class="btn btn-danger btn-small" onclick="deleteUser('${u._id}')" style="margin-left:3px;">🗑 Del</button>
            </td>
        </tr>`;
    }).join('');
}

async function toggleUser(id) {
    const data = await api(`/admin/users/${id}/toggle`, 'PATCH');
    if (data.success) {
        showAlert('success', data.message);
        loadUsers();
        loadStats();
    } else {
        showAlert('error', data.message);
    }
}

async function unblockUser(id) {
    const data = await api(`/admin/users/${id}/unblock`, 'PATCH');
    if (data.success) {
        showAlert('success', data.message);
        loadUsers();
        loadStats();
    } else {
        showAlert('error', data.message);
    }
}

async function deleteUser(id) {
    if (!confirm('Permanently delete this user? This cannot be undone!')) return;
    const data = await api(`/admin/users/${id}`, 'DELETE');
    if (data.success) {
        showAlert('success', 'User deleted.');
        loadUsers();
        loadStats();
    }
}

// =============================================
// PROFILE & CHANGE PASSWORD
// =============================================
async function loadProfile() {
    try {
        const data = await api('/auth/me');
        if (!data || !data.success) return;

        const u = data.user;
        const nameEl = document.getElementById('profileName');
        const emailEl = document.getElementById('profileEmail');
        const roleEl = document.getElementById('profileRole');

        if (nameEl) nameEl.textContent = u.name;
        if (emailEl) emailEl.textContent = u.email;

        if (roleEl) {
            if (u.role === 'superadmin') {
                roleEl.textContent = '👑 Super Admin';
                roleEl.className = 'status-badge badge-active';
            } else {
                roleEl.textContent = '🛡️ Admin';
                roleEl.className = 'status-badge badge-available';
            }
        }
    } catch (err) {
        console.error('Profile load error:', err);
    }
}

function togglePw(id) {
    const input = document.getElementById(id);
    if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
    }
}

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
    if (bar) { bar.style.width = level.w; bar.style.background = level.color; }
    if (text) { text.textContent = level.label; text.style.color = level.color; }
});

document.getElementById('changePasswordForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmNewPassword = document.getElementById('confirmNewPassword').value;
    const btn = document.getElementById('changePwBtn');

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

    if (newPassword !== confirmNewPassword) {
        showPwAlert('error', 'Passwords do not match!');
        return;
    }

    if (newPassword === currentPassword) {
        showPwAlert('error', 'New password must be different.');
        return;
    }

    if (newPassword.length < 6) {
        showPwAlert('error', 'Password must be at least 6 characters.');
        return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Changing...';

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
            const strengthBar = document.getElementById('strengthBar');
            const strengthText = document.getElementById('strengthText');
            if (strengthBar) strengthBar.style.width = '0%';
            if (strengthText) strengthText.textContent = '';

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

// ===== CONVERSION STATUS =====
async function loadConversion() {
    const data = await api('/admin/conversion-stats');
    if (!data || !data.success) return;

    const s = data.stats;
    document.getElementById('conversionStats').innerHTML = `
        <div class="stat-card"><div class="stat-icon">🎬</div><div class="stat-number">${s.total}</div><div class="stat-label">Total Videos</div></div>
        <div class="stat-card"><div class="stat-icon">✅</div><div class="stat-number">${s.ready}</div><div class="stat-label">Converted</div></div>
        <div class="stat-card"><div class="stat-icon">⏳</div><div class="stat-number">${s.pending + s.converting}</div><div class="stat-label">In Queue</div></div>
        <div class="stat-card"><div class="stat-icon">❌</div><div class="stat-number">${s.failed}</div><div class="stat-label">Failed</div></div>
        <div class="stat-card"><div class="stat-icon">📊</div><div class="stat-number">${s.percentage}%</div><div class="stat-label">Complete</div></div>
    `;

    const tbody = document.getElementById('conversionBody');
    if (!data.videos || data.videos.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--text-muted)">No videos yet.</td></tr>';
        return;
    }

    tbody.innerHTML = data.videos.map(v => {
        let statusBadge = '';
        let progressBar = '';

        switch (v.hlsStatus) {
            case 'ready':
                statusBadge = '<span class="status-badge badge-active">✅ Ready</span>';
                progressBar = '<div style="width:100%;height:6px;background:var(--card-border);border-radius:3px;"><div style="width:100%;height:100%;background:var(--success);border-radius:3px;"></div></div>';
                break;
            case 'converting':
            case 'downloading':
                statusBadge = `<span class="status-badge badge-available">⏳ ${v.hlsStatus === 'downloading' ? 'Downloading' : 'Converting'}</span>`;
                progressBar = `<div style="width:100%;height:6px;background:var(--card-border);border-radius:3px;"><div style="width:${v.hlsProgress||0}%;height:100%;background:var(--secondary);border-radius:3px;transition:width 0.3s;"></div></div><span style="font-size:0.72rem;color:var(--secondary);">${v.hlsProgress||0}%</span>`;
                break;
            case 'failed':
                statusBadge = '<span class="status-badge badge-blocked">❌ Failed</span>';
                progressBar = `<span style="font-size:0.72rem;color:var(--danger);">${esc(v.hlsError || 'Unknown error')}</span>`;
                break;
            default:
                statusBadge = '<span class="status-badge badge-used">⏸ Pending</span>';
                progressBar = '<span style="font-size:0.72rem;color:var(--text-muted);">Waiting in queue</span>';
        }

        return `<tr>
            <td><strong>${esc(v.title)}</strong></td>
            <td>${statusBadge}</td>
            <td style="min-width:120px;">${progressBar}</td>
            <td>${v.duration || '-'}</td>
            <td style="font-size:0.78rem;">${v.hlsConvertedAt ? fmtDate(v.hlsConvertedAt) : '-'}</td>
            <td>
                ${v.hlsStatus === 'failed' || v.hlsStatus === 'pending' ?
                    `<button class="btn btn-warning btn-small" onclick="retryConversion('${v._id}')">🔄 Retry</button>` : ''}
            </td>
        </tr>`;
    }).join('');
}

async function retryConversion(id) {
    const data = await api(`/admin/convert-retry/${id}`, 'POST');
    if (data.success) {
        showAlert('success', data.message);
        loadConversion();
    } else {
        showAlert('error', data.message);
    }
}

async function convertAllVideos() {
    const btn = document.getElementById('convertAllBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Starting...';

    const data = await api('/admin/convert-all', 'POST');
    if (data.success) {
        showAlert('success', data.message);
    } else {
        showAlert('error', data.message);
    }

    btn.disabled = false;
    btn.textContent = '🔄 Convert All Pending';

    // Auto refresh every 5 seconds while converting
    const refreshInterval = setInterval(async () => {
        await loadConversion();
        const statsData = await api('/admin/conversion-stats');
        if (statsData.success && statsData.stats.converting === 0 && statsData.stats.pending === 0) {
            clearInterval(refreshInterval);
        }
    }, 5000);
}

// =============================================
// LOGOUT
// =============================================
function logout() {
    localStorage.clear();
    window.location.href = '/login.html';
}

// =============================================
// INITIAL LOAD
// =============================================
loadStats();

setTimeout(async () => {
    try {
        await loadMentorships();
        loadVideos();
        loadKeys();
        loadUsers();
        loadMentorshipDropdowns();
        loadMentorshipCheckboxes();
    } catch (err) {
        console.error('Initial load error:', err);
    }
}, 500);
