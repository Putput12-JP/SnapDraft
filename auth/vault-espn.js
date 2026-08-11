// ═══════════════════════════════════════════════════════════════
// Vault Fantasy — ESPN client (frontend wrapper)
// ═══════════════════════════════════════════════════════════════
// Thin bridge to the Cloud Functions backend that reads PRIVATE ESPN leagues.
// Mirrors auth/vault-sleeper.js and auth/vault-yahoo.js.
//
// Why this exists: a public ESPN league reads straight from the browser (the
// v3 host sends open CORS), so those never come here. A PRIVATE league 401s
// from the browser because the SWID + espn_s2 cookies can't be attached
// cross-site. This wrapper hands the cookies to the backend ONCE (connect),
// which stores them encrypted and attaches them server-side on every read.
//
// The cookies never live in this file, in localStorage, or in any app state —
// they go straight into the connect() call and are never read back.
//
// Public API (window.VaultEspn):
//   ready()                                  -> Promise (SDK loaded)
//   status()                                 -> Promise<{connected, verified, swidHint}>
//   connect(swid, s2, leagueId, season)      -> Promise<Connection>  (verifies + stores)
//   disconnect()                             -> Promise
//   league(leagueId, season, views)          -> Promise<rawV3Json>
//   fanLeagues()                             -> Promise<rawFanJson>  (best-effort)
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var SDK_VERSION = '10.14.1';
  var SDK_BASE = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';
  var REGION = 'us-central1'; // must match the functions' deployed region

  var _ready = null;
  var _fns = null;

  function ensureScript(src) {
    if (!document.querySelector('script[src="' + src + '"]')) {
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      document.head.appendChild(s);
    }
  }

  function waitFor(cond, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (cond()) return resolve();
      var t0 = Date.now();
      var iv = setInterval(function () {
        if (cond()) { clearInterval(iv); resolve(); }
        else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('Timed out loading Firebase SDK')); }
      }, 50);
    });
  }

  function configured() {
    return !!(window.VF_FIREBASE_CONFIG && window.VF_FIREBASE_CONFIG.apiKey);
  }

  /** True when the backend is reachable — the UI uses this to decide whether
   *  the private-league path is even available in this deployment. */
  function backendAvailable() {
    return configured();
  }

  function ready() {
    if (_ready) return _ready;
    _ready = (async function () {
      if (!configured()) throw new Error('Vault backend is not configured (auth/firebase-config.js).');
      ensureScript(SDK_BASE + 'firebase-app-compat.js');
      await waitFor(function () { return !!window.firebase; }, 10000);
      ensureScript(SDK_BASE + 'firebase-functions-compat.js');
      await waitFor(function () { return !!(window.firebase && window.firebase.functions); }, 10000);
      if (!window.firebase.apps || !window.firebase.apps.length) {
        window.firebase.initializeApp(window.VF_FIREBASE_CONFIG);
      }
      if (window.VaultAppCheck) await window.VaultAppCheck.activate();
      _fns = window.firebase.app().functions(REGION);
      return _fns;
    })();
    return _ready;
  }

  async function call(name, data) {
    var fns = await ready();
    var user = window.firebase.auth && window.firebase.auth().currentUser;
    if (!user) throw new Error('Sign in to Vault before connecting ESPN.');
    var res = await fns.httpsCallable(name)(data || {});
    return res.data;
  }

  var VaultEspn = {
    ready: ready,
    backendAvailable: backendAvailable,

    status: function () { return call('espnStatus'); },

    /**
     * Verify a cookie pair against `leagueId` and store it encrypted. Rejects
     * (nothing stored) if ESPN doesn't accept the cookies.
     */
    connect: function (swid, s2, leagueId, season) {
      return call('connectEspn', {
        swid: swid, s2: s2, leagueId: leagueId, season: season
      });
    },

    disconnect: function () { return call('disconnectEspn'); },

    /** Raw v3 league JSON, pulled server-side with the stored cookies. */
    league: function (leagueId, season, views) {
      return call('espnRead', {
        query: { type: 'league', leagueId: leagueId, season: season, views: views || null }
      }).then(function (r) { return r && r.data; });
    },

    /** Best-effort enumeration of every league the SWID is in. May return null. */
    fanLeagues: function () {
      return call('espnRead', { query: { type: 'fan_leagues' } })
        .then(function (r) { return r && r.data; })
        .catch(function () { return null; });
    }
  };

  window.VaultEspn = VaultEspn;
})();
