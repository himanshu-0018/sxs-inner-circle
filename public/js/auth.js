// public/js/auth.js
const API = '/api';

function showAlert(type, msg) {
    const el = document.getElementById(type === 'error' ? 'errorAlert' : 'successAlert');
    const other = document.getElementById(type === 'error' ? 'successAlert' : 'errorAlert');
    if (other) other.classList.remove('show');
    if (el) { el.textContent = msg; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 6000); }
}

const loginForm = document.getElementById('loginForm');
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('submitBtn');
        btn.disabled = true; btn.textContent = 'Logging in...';
        try {
            const res = await fetch(`${API}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: document.getElementById('email').value.trim(),
                    password: document.getElementById('password').value
                })
            });
            const data = await res.json();
            if (data.blocked) {
                showAlert('error', data.message);
                btn.disabled = false; btn.textContent = 'Login';
                return;
            }
            if (data.success) {
                localStorage.setItem('token', data.token);
                localStorage.setItem('user', JSON.stringify(data.user));
                window.location.href = data.user.role === 'admin' ? '/admin.html' : '/dashboard.html';
            } else {
                showAlert('error', data.message);
                btn.disabled = false; btn.textContent = 'Login';
            }
        } catch (err) {
            showAlert('error', 'Network error.');
            btn.disabled = false; btn.textContent = 'Login';
        }
    });
}

const registerForm = document.getElementById('registerForm');
if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('submitBtn');
        btn.disabled = true; btn.textContent = 'Creating...';
        try {
            const res = await fetch(`${API}/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: document.getElementById('name').value.trim(),
                    email: document.getElementById('email').value.trim(),
                    phone: document.getElementById('phone').value.trim(),
                    password: document.getElementById('password').value,
                    accessKey: document.getElementById('accessKey').value.trim()
                })
            });
            const data = await res.json();
            if (data.success) {
                localStorage.setItem('token', data.token);
                localStorage.setItem('user', JSON.stringify(data.user));
                showAlert('success', 'Account created!');
                setTimeout(() => { window.location.href = '/dashboard.html'; }, 800);
            } else {
                showAlert('error', data.message);
                btn.disabled = false; btn.textContent = 'Create Account';
            }
        } catch (err) {
            showAlert('error', 'Network error.');
            btn.disabled = false; btn.textContent = 'Create Account';
        }
    });
}

function logout() {
    localStorage.clear();
    window.location.href = '/login.html';
}

// Redirect if logged in
if (window.location.pathname.includes('login') || window.location.pathname.includes('register')) {
    const t = localStorage.getItem('token');
    if (t) {
        const u = JSON.parse(localStorage.getItem('user') || '{}');
        window.location.href = u.role === 'admin' ? '/admin.html' : '/dashboard.html';
    }
}