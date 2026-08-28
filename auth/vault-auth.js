// ═══════════════════════════════════════════════════════════════
// Vault Fantasy — auth + cross-device sync engine
// ═══════════════════════════════════════════════════════════════
// Plain script (no build step). Loads the Firebase SDK on demand,
// only when auth/firebase-config.js contains a real config.
//
// Providers: Google sign-in + native email/password. (No Apple.)
//
// Sync model:
//   • Mirrors the app's localStorage keys (snapdraft-*, dcmd-*,
//     vault-*, lc-*) to Firestore at users/{uid}/kv/{key}.
//   • Per-key last-write-wins using millisecond timestamps.
//   • Live: localStorage writes are intercepted and pushed
//     (debounced); remote changes stream down via onSnapshot.
//   • 'vf-*' keys are internal and never synced.
//
// Public API (window.VaultAuth):
//   configured()                     → bool
//   ready()                          → Promise (SDK loaded + initialized)
//   signInWithGoogle()               → Promise<user>
//   signInEmail(email, pass)         → Promise<user>
//   signUpEmail(email, pass, name)   → Promise<user>
//   resetPassword(email)             → Promise
//   signOutUser()                    → Promise (also clears gate flags)
//   initialSync(uid, onKey?)         → Promise<count>  (pull+merge+push, then live)
//   guard()                          → call on index.html; redirects to
//                                      login.html when signed out (and not guest)
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var SDK_VERSION = '10.14.1';
  var SDK_BASE = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';
  var SDK_SCRIPTS = ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js'];

  var SYNC_PREFIXES = ['snapdraft-', 'dcmd-', 'vault-', 'lc-'];
  var NEVER_SYNC_PREFIX = 'vf-';
  var META_KEY = 'vf-sync-meta';         // {key: lastSyncedTimestamp}
  var MAX_VALUE_BYTES = 900000;          // skip values near Firestore's 1MB doc cap

  var _readyPromise = null;
  var _db = null;
  var _uid = null;
  var _liveUnsub = null;
  var _pushQueue = {};                   // key -> true
  var _pushTimer = null;
  var _origSet = null;
  var _origRemove = null;
  var _applyingRemote = false;

  // ── helpers ────────────────────────────────────────────────
  function configured() {
    return !!(window.VF_FIREBASE_CONFIG && window.VF_FIREBASE_CONFIG.apiKey);
  }

  function isSyncKey(k) {
    if (!k || k.indexOf(NEVER_SYNC_PREFIX) === 0) return false;
    for (var i = 0; i < SYNC_PREFIXES.length; i++) {
      if (k.indexOf(SYNC_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  function getMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch (e) { return {}; }
  }
  function setMeta(m) {
    try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) {}
  }

  function rawSet(k, v) {
    _applyingRemote = true;
    try { (_origSet || Storage.prototype.setItem).call(localStorage, k, v); } finally { _applyingRemote = false; }
  }
  function rawRemove(k) {
    _applyingRemote = true;
    try { (_origRemove || Storage.prototype.removeItem).call(localStorage, k); } finally { _applyingRemote = false; }
  }

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = res; s.onerror = function () { rej(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  // ── SDK boot ───────────────────────────────────────────────
  function ready() {
    if (!configured()) return Promise.reject(new Error('Firebase not configured (auth/firebase-config.js)'));
    if (_readyPromise) return _readyPromise;
    _readyPromise = SDK_SCRIPTS.reduce(function (p, file) {
      return p.then(function () { return loadScript(SDK_BASE + file); });
    }, Promise.resolve()).then(function () {
      if (!firebase.apps.length) firebase.initializeApp(window.VF_FIREBASE_CONFIG);
      // Must land between initializeApp and the first Firestore/Functions
      // use. No-ops unless VF_APPCHECK_SITE_KEY is configured.
      return window.VaultAppCheck ? window.VaultAppCheck.activate() : null;
    }).then(function () {
      _db = firebase.firestore();
      return firebase.auth();
    });
    return _readyPromise;
  }

  // ── auth actions ───────────────────────────────────────────
  function afterSignIn(user) {
    try {
      localStorage.setItem('vf-auth-uid', user.uid);
      localStorage.removeItem('vf-guest');
    } catch (e) {}
    return user;
  }

  function signInWithGoogle() {
    return ready().then(function (auth) {
      var provider = new firebase.auth.GoogleAuthProvider();
      return auth.signInWithPopup(provider).then(function (cred) { return afterSignIn(cred.user); });
    });
  }

  function signInEmail(email, pass) {
    return ready().then(function (auth) {
      return auth.signInWithEmailAndPassword(email, pass).then(function (cred) { return afterSignIn(cred.user); });
    });
  }

  function signUpEmail(email, pass, name) {
    return ready().then(function (auth) {
      return auth.createUserWithEmailAndPassword(email, pass).then(function (cred) {
        var p = name ? cred.user.updateProfile({ displayName: name }) : Promise.resolve();
        return p.then(function () { return afterSignIn(cred.user); });
      });
    });
  }

  function resetPassword(email) {
    return ready().then(function (auth) { return auth.sendPasswordResetEmail(email); });
  }

  function signOutUser() {
    var done = function () {
      try {
        localStorage.removeItem('vf-auth-uid');
        localStorage.removeItem('vf-guest');
      } catch (e) {}
      stopLive();
    };
    if (!configured()) { done(); return Promise.resolve(); }
    return ready().then(function (auth) { return auth.signOut(); }).then(done, done);
  }

  // ── sync: pull + merge + push ──────────────────────────────
  function kvCol(uid) { return _db.collection('users').doc(uid).collection('kv'); }

  function collectLocal() {
    var out = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (isSyncKey(k)) out[k] = localStorage.getItem(k);
    }
    return out;
  }

  function pushKeys(uid, keys) {
    if (!keys.length) return Promise.resolve();
    var meta = getMeta();
    var now = Date.now();
    var batch = _db.batch();
    var col = kvCol(uid);
    var wrote = 0;
    keys.forEach(function (k) {
      var v = localStorage.getItem(k);
      if (v !== null && v.length > MAX_VALUE_BYTES) return; // too big, skip
      batch.set(col.doc(k), { v: v, t: now });
      meta[k] = now;
      wrote++;
    });
    if (!wrote) return Promise.resolve();
    return batch.commit().then(function () { setMeta(meta); });
  }

  function initialSync(uid, onKey) {
    _uid = uid;
    return ready().then(function () {
      return kvCol(uid).get();
    }).then(function (snap) {
      var meta = getMeta();
      var local = collectLocal();
      var toPush = [];
      var remoteKeys = {};
      var count = 0;

      snap.forEach(function (doc) {
        var k = doc.id;
        var r = doc.data() || {};
        remoteKeys[k] = true;
        var metaT = meta[k] || 0;
        if (r.t > metaT) {
          // remote is newer than anything this device has synced → apply
          if (r.v === null || r.v === undefined) rawRemove(k);
          else rawSet(k, r.v);
          meta[k] = r.t;
          count++;
          if (onKey) try { onKey(k, 'pulled'); } catch (e) {}
        } else if (local[k] !== undefined && local[k] !== r.v) {
          // this device changed the key since last sync → push
          toPush.push(k);
        }
      });

      // local keys the cloud has never seen → push
      Object.keys(local).forEach(function (k) {
        if (!remoteKeys[k]) toPush.push(k);
      });

      setMeta(meta);
      return pushKeys(uid, toPush).then(function () {
        if (onKey && toPush.length) try { onKey(null, 'pushed:' + toPush.length); } catch (e) {}
        startLive(uid);
        patchStorage();
        return count;
      });
    });
  }

  // ── sync: live down (Firestore → localStorage) ─────────────
  function startLive(uid) {
    stopLive();
    _liveUnsub = kvCol(uid).onSnapshot(function (snap) {
      var meta = getMeta();
      var changed = false;
      snap.docChanges().forEach(function (ch) {
        if (ch.type === 'removed') return;
        var k = ch.doc.id;
        var r = ch.doc.data() || {};
        if (r.t > (meta[k] || 0)) {
          if (r.v === null || r.v === undefined) rawRemove(k);
          else rawSet(k, r.v);
          meta[k] = r.t;
          changed = true;
        }
      });
      if (changed) setMeta(meta);
    }, function (err) {
      console.warn('[VaultAuth] live sync error:', err && err.message);
    });
  }

  function stopLive() {
    if (_liveUnsub) { try { _liveUnsub(); } catch (e) {} _liveUnsub = null; }
  }

  // ── sync: live up (localStorage → Firestore) ───────────────
  function queuePush(k) {
    if (!_uid || !isSyncKey(k) || _applyingRemote) return;
    _pushQueue[k] = true;
    clearTimeout(_pushTimer);
    _pushTimer = setTimeout(flushQueue, 2000);
  }

  function flushQueue() {
    var keys = Object.keys(_pushQueue);
    _pushQueue = {};
    if (!keys.length || !_uid) return;
    pushKeys(_uid, keys).catch(function (err) {
      console.warn('[VaultAuth] push failed:', err && err.message);
    });
  }

  function patchStorage() {
    if (_origSet) return; // already patched
    _origSet = Storage.prototype.setItem;
    _origRemove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (k, v) {
      _origSet.apply(this, arguments);
      if (this === localStorage) queuePush(k);
    };
    Storage.prototype.removeItem = function (k) {
      _origRemove.apply(this, arguments);
      if (this === localStorage) queuePush(k);
    };
    // flush pending writes when the tab closes
    window.addEventListener('pagehide', flushQueue);
  }

  // ── gate for index.html ────────────────────────────────────
  function guard() {
    if (!configured()) return; // not set up yet → app behaves exactly as before
    var guest = false, cached = null;
    try {
      guest = localStorage.getItem('vf-guest') === '1';
      cached = localStorage.getItem('vf-auth-uid');
    } catch (e) {}
    if (guest) return;
    if (!cached) { location.replace('login.html'); return; }
    // cached session: start sync in background, verify it's still valid
    ready().then(function (auth) {
      auth.onAuthStateChanged(function (u) {
        if (u) {
          try { localStorage.setItem('vf-auth-uid', u.uid); } catch (e) {}
          initialSync(u.uid).catch(function (err) {
            console.warn('[VaultAuth] sync failed:', err && err.message);
          });
        } else {
          try { localStorage.removeItem('vf-auth-uid'); } catch (e) {}
          location.replace('login.html');
        }
      });
    }).catch(function (err) {
      console.warn('[VaultAuth] init failed:', err && err.message);
    });
  }

  window.VaultAuth = {
    configured: configured,
    ready: ready,
    signInWithGoogle: signInWithGoogle,
    signInEmail: signInEmail,
    signUpEmail: signUpEmail,
    resetPassword: resetPassword,
    signOutUser: signOutUser,
    initialSync: initialSync,
    guard: guard
  };
})();
