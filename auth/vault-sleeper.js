// ═══════════════════════════════════════════════════════════════
// Vault Fantasy — Sleeper write client (frontend wrapper)
// ═══════════════════════════════════════════════════════════════
// Thin bridge from the app to the Cloud Functions backend that performs
// Sleeper writes (lineup / waiver / trade). Loads the Firebase Functions
// compat SDK on demand and reuses the app that auth/vault-auth.js inits.
//
// The Sleeper token lives ONLY on the server — this client never sees it.
//
// Public API (window.VaultSleeper):
//   ready()                         -> Promise (SDK loaded)
//   status()                        -> Promise<{connected, sleeperUsername, verified}>
//   connect(token, username)        -> Promise<Connection>   (paste-token flow)
//   disconnect()                    -> Promise
//   execute(action)                 -> Promise<{ok, data}>   (instant, throttled)
//   enqueue(actions[])              -> Promise<{ok, jobIds}>  (batch, drained)
//   pushStarters(leagueId, rosterId, starters[])  -> convenience for lineup push
//   watchJobs(uid, cb)              -> unsubscribe fn (live job status via Firestore)
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var SDK_VERSION = '10.14.1';
  var SDK_BASE = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';
  // functions-compat needs app-compat; auth-compat/firestore-compat are loaded by vault-auth.js.
  var NEEDED = ['firebase-app-compat.js', 'firebase-functions-compat.js'];
  var REGION = 'us-central1'; // must match the functions' deployed region

  var _ready = null;
  var _fns = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      // already present?
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing && existing.getAttribute('data-loaded') === '1') return resolve();
      var s = existing || document.createElement('script');
      s.src = src;
      s.async = true;
      s.addEventListener('load', function () { s.setAttribute('data-loaded', '1'); resolve(); });
      s.addEventListener('error', function () { reject(new Error('Failed to load ' + src)); });
      if (!existing) document.head.appendChild(s);
    });
  }

  function configured() {
    return !!(window.VF_FIREBASE_CONFIG && window.VF_FIREBASE_CONFIG.apiKey);
  }

  function ready() {
    if (_ready) return _ready;
    _ready = (async function () {
      if (!configured()) throw new Error('Firebase is not configured (auth/firebase-config.js).');
      for (var i = 0; i < NEEDED.length; i++) await loadScript(SDK_BASE + NEEDED[i]);
      if (!window.firebase) throw new Error('Firebase SDK failed to load.');
      if (!window.firebase.apps || !window.firebase.apps.length) {
        window.firebase.initializeApp(window.VF_FIREBASE_CONFIG);
      }
      _fns = window.firebase.app().functions(REGION);
      return _fns;
    })();
    return _ready;
  }

  async function call(name, data) {
    var fns = await ready();
    var user = window.firebase.auth && window.firebase.auth().currentUser;
    if (!user) throw new Error('Sign in to Vault before connecting Sleeper.');
    var res = await fns.httpsCallable(name)(data || {});
    return res.data;
  }

  // ── public API ──────────────────────────────────────────────
  var VaultSleeper = {
    ready: ready,

    status: function () { return call('sleeperStatus'); },

    connect: function (token, username) {
      return call('connectSleeper', { token: token, username: username });
    },

    disconnect: function () { return call('disconnectSleeper'); },

    /** Single action, executed immediately (server-throttled). */
    execute: function (action) { return call('executeSleeperAction', { action: action }); },

    /** Batch of actions, drained gradually by the server. */
    enqueue: function (actions) { return call('enqueueSleeperActions', { actions: actions }); },

    /** Convenience: push a full ordered starters array for one roster. */
    pushStarters: function (leagueId, rosterId, starters) {
      return VaultSleeper.execute({
        type: 'update_starters',
        leagueId: String(leagueId),
        rosterId: Number(rosterId),
        starters: starters
      });
    },

    /** Convenience: push starters for many leagues at once (throttled queue). */
    pushStartersBatch: function (items /* [{leagueId, rosterId, starters}] */) {
      return VaultSleeper.enqueue(items.map(function (it) {
        return {
          type: 'update_starters',
          leagueId: String(it.leagueId),
          rosterId: Number(it.rosterId),
          starters: it.starters
        };
      }));
    },

    /** Live job-status stream for the queue UI. Returns an unsubscribe fn. */
    watchJobs: function (uid, cb) {
      if (!window.firebase || !window.firebase.firestore) return function () {};
      return window.firebase.firestore()
        .collection('users').doc(uid).collection('sleeperJobs')
        .orderBy('createdAt', 'desc').limit(50)
        .onSnapshot(function (snap) {
          var jobs = [];
          snap.forEach(function (d) { jobs.push(Object.assign({ id: d.id }, d.data())); });
          cb(jobs);
        });
    }
  };

  window.VaultSleeper = VaultSleeper;
})();
