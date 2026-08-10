// ═══════════════════════════════════════════════════════════════
// Vault Fantasy — App Check activation (shared)
// ═══════════════════════════════════════════════════════════════
// Firebase Auth proves *someone* is signed in; it doesn't prove the call
// came from Vault, and anyone can self-register an account in seconds.
// App Check attaches an attestation token proving the request originated
// from our real web app, which is what makes the server-side rate limits
// meaningful — without it an attacker just cycles fresh accounts.
//
// Loaded by both vault-auth.js and vault-sleeper.js, which each init the
// Firebase app; activation must happen once, after initializeApp() and
// before the first Firestore/Functions call. Both call activate() and
// share the same promise, so whichever gets there first wins.
//
// Inert until VF_APPCHECK_SITE_KEY is set in auth/firebase-config.js —
// no key means no behavior change at all.
//
// Public API (window.VaultAppCheck):
//   activate() -> Promise   (idempotent; resolves even when unconfigured)
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var SDK_VERSION = '10.14.1';
  var SDK_BASE = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';
  var SCRIPT = 'firebase-app-check-compat.js';

  var _promise = null;

  function siteKey() {
    var k = window.VF_APPCHECK_SITE_KEY;
    return (typeof k === 'string' && k.trim()) ? k.trim() : null;
  }

  function isLocalhost() {
    var h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  }

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing) {
        // Another module may have appended this already. Its load event
        // may have fired before we got here, so poll the global instead.
        if (window.firebase && window.firebase.appCheck) return res();
        var t0 = Date.now();
        var iv = setInterval(function () {
          if (window.firebase && window.firebase.appCheck) { clearInterval(iv); res(); }
          else if (Date.now() - t0 > 10000) { clearInterval(iv); rej(new Error('Timed out loading ' + src)); }
        }, 50);
        return;
      }
      var s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = res;
      s.onerror = function () { rej(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  /**
   * Activate App Check on the already-initialized Firebase app.
   * Resolves (never rejects) so a failure here can't block sign-in —
   * while enforcement is off the call still succeeds without a token, and
   * once it's on, a hard failure should surface at the callable, with its
   * own error message, rather than as a blank app at boot.
   */
  function activate() {
    if (_promise) return _promise;

    _promise = (async function () {
      var key = siteKey();
      if (!key) return false;                       // not configured yet
      if (!window.firebase || !window.firebase.apps || !window.firebase.apps.length) {
        console.warn('[VaultAppCheck] activate() called before initializeApp — skipped.');
        return false;
      }

      // Localhost has no reCAPTCHA attestation. Setting this before
      // activate() makes the SDK print a debug token to the console;
      // register it under App Check → Apps → Manage debug tokens to work
      // locally once enforcement is on.
      if (isLocalhost() && window.VF_APPCHECK_DEBUG !== false) {
        self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
      }

      try {
        await loadScript(SDK_BASE + SCRIPT);
        window.firebase.appCheck().activate(key, /* autoRefresh */ true);
        return true;
      } catch (e) {
        console.warn('[VaultAppCheck] activation failed:', e && e.message);
        return false;
      }
    })();

    return _promise;
  }

  window.VaultAppCheck = { activate: activate };
})();
