'use strict';

/**
 * Shared frontend helpers + Firebase email/password login.
 * File must load as a plain script (defer) on every page: it exposes
 * window.BS and, on the login page, drives the Firebase Authentication flow.
 *
 * Security: the ID token only travels to OUR backend (/auth/session-login),
 * which verifies it with the Firebase Admin SDK before creating the session.
 * No Firebase credentials or tokens are ever stored in localStorage.
 */
(function () {
  function readCookie(name) {
    const parts = ('; ' + document.cookie).split('; ' + name + '=');
    return parts.length === 2 ? parts.pop().split(';').shift() : '';
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Robust fetch wrapper: JSON everywhere, CSRF header, readable errors. */
  async function api(url, options = {}) {
    const opts = Object.assign({ credentials: 'same-origin', headers: {} }, options);
    opts.headers['Accept'] = 'application/json';
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
      opts.headers['Content-Type'] = 'application/json';
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase())) {
      opts.headers['X-XSRF-TOKEN'] = readCookie('bs_csrf');
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      const err = new Error('Network error - is the server running?');
      err.status = 0;
      throw err;
    }
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (!res.ok) {
      const err = new Error(data.message || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      err.fieldErrors = data.fieldErrors || null;
      throw err;
    }
    return data;
  }

  function toast(message, kind) {
    let host = document.getElementById('toast-stack');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-stack';
      host.className = 'toast-stack';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = message;
    host.appendChild(t);
    setTimeout(() => t.remove(), 5200);
  }

  function debounce(fn, ms) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function prettyIso(iso) {
    if (!iso) return '';
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return iso.slice(8, 10) === '' ? iso : `${M[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
  }

  // Expose the helper namespace BEFORE the login flow uses it.
  window.BS = { readCookie, esc, api, toast, debounce, prettyIso };

  // ------------------------------------------------------------------ login
  if (window.__PAGE__ !== 'login') return;

  const FB_CONFIG_NODE = document.getElementById('fb-config');
  let fbConfig = { apiKey: '', authDomain: '', projectId: '', appId: '' };
  try { fbConfig = JSON.parse(FB_CONFIG_NODE.textContent); } catch (_) { /* keep empty */ }

  const form = document.getElementById('login-form');
  const errBox = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  const notice = document.getElementById('login-notice');
  const params = new URLSearchParams(window.location.search);

  const REASONS = {
    logout: 'You have been logged out.',
    disabled: 'This account is disabled. Contact an administrator.',
    session: 'Your session expired. Please log in again.',
  };
  if (params.get('reason') && REASONS[params.get('reason')]) {
    notice.hidden = false;
    notice.textContent = REASONS[params.get('reason')];
  }

  const pwToggle = document.getElementById('pw-toggle');
  const pw = document.getElementById('password');
  pwToggle.addEventListener('click', () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    pwToggle.textContent = show ? 'Hide' : 'Show';
    pwToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  // Demo accounts: one click fills email + demo password (seeded by the server).
  const DEMO_PASSWORD = 'demo1234';
  document.querySelectorAll('.demo-fill').forEach((fillBtn) => {
    fillBtn.addEventListener('click', () => {
      document.getElementById('email').value = fillBtn.getAttribute('data-email') || '';
      pw.value = DEMO_PASSWORD;
      errBox.hidden = true;
      document.getElementById('email').focus();
      BS.toast('Demo credentials filled - press Sign in', 'ok');
    });
  });

  function fail(msg) {
    errBox.hidden = false;
    errBox.textContent = msg;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  async function startLoginFlow() {
    if (!fbConfig.apiKey) {
      fail('Sign-in is not configured: missing Firebase web configuration on this server.');
      return;
    }
    errBox.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Signing in...';
    try {
      // 1) Firebase web SDK (compat build) authenticates email + password
      await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
      await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js');
      firebase.initializeApp(fbConfig);
      const email = document.getElementById('email').value.trim();
      const pwd = pw.value;
      if (!email || !pwd) { fail('Enter both email and password.'); return; }
      let credential;
      try {
        credential = await firebase.auth().signInWithEmailAndPassword(email, pwd);
      } catch (authErr) {
        const code = authErr && authErr.code ? authErr.code : '';
        if (code === 'auth/user-disabled') { fail('This account is disabled. Contact an administrator.'); return; }
        if (code === 'auth/network-request-failed') { fail('Network error: check your connection and try again.'); return; }
        if (code === 'auth/too-many-requests') { fail('Too many attempts - please wait and try again.'); return; }
        fail('Invalid email or password.');
        return;
      }
      // 2) exchange the ID token for a secure server session
      const idToken = await credential.user.getIdToken();
      const data = await BS.api('/auth/session-login', { method: 'POST', body: { idToken } });
      window.location.href = data.redirect || '/';
    } catch (e) {
      if (e.status === 403) fail(e.message || 'Access denied.');
      else if (e.status >= 500 || e.status === 0) fail('Server error: ' + e.message + ' Try again shortly.');
      else fail(e.message || 'Login failed. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); startLoginFlow(); });
})();
