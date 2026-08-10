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

  // Ensure a script tag exists (append if missing). We do NOT rely on its
  // load event — vault-auth.js may have already loaded the same SDK, in which
  // case the event already fired and would never fire again. We gate on the
  // SDK *global* becoming available instead (see waitFor).
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

  function ready() {
    if (_ready) return _ready;
    _ready = (async function () {
      if (!configured()) throw new Error('Firebase is not configured (auth/firebase-config.js).');
      ensureScript(SDK_BASE + 'firebase-app-compat.js');
      await waitFor(function () { return !!window.firebase; }, 10000);
      ensureScript(SDK_BASE + 'firebase-functions-compat.js');
      await waitFor(function () { return !!(window.firebase && window.firebase.functions); }, 10000);
      if (!window.firebase.apps || !window.firebase.apps.length) {
        window.firebase.initializeApp(window.VF_FIREBASE_CONFIG);
      }
      // Every call below goes to a callable that can require an App Check
      // token, so activate before the first one. Idempotent — vault-auth.js
      // usually got here first; no-ops unless a site key is configured.
      if (window.VaultAppCheck) await window.VaultAppCheck.activate();
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

    // ── Passwordless verification-code onboarding (primary) ──
    /** Ask Sleeper to text/email a 6-digit code. identifier = username/email/phone. */
    requestCode: function (identifier, captcha) {
      return call('sleeperRequestCode', { identifier: identifier, captcha: captcha });
    },
    /** Exchange the code for a stored token. username used for identity resolution. */
    verifyCode: function (identifier, code, captcha, username) {
      return call('sleeperVerifyCode', {
        identifier: identifier, code: code, captcha: captcha, username: username
      });
    },
    /** Sleeper's hCaptcha sitekey — render the widget with this. */
    HCAPTCHA_SITEKEY: '3bb6d565-5eb0-425f-acf8-64374f8bbc7b',

    disconnect: function () { return call('disconnectSleeper'); },

    /** Single action, executed immediately (server-throttled). */
    execute: function (action) { return call('executeSleeperAction', { action: action }); },

    /** Batch of actions, drained gradually by the server. */
    enqueue: function (actions) { return call('enqueueSleeperActions', { actions: actions }); },

    /** Allowlisted read-only query with the user's token (no write throttle). */
    read: function (query) { return call('sleeperRead', { query: query }); },

    /** League transactions incl. PENDING trade offers (not in the public API). */
    leagueTransactions: function (leagueId, opts) {
      opts = opts || {};
      return VaultSleeper.read({
        type: 'league_transactions',
        leagueId: String(leagueId),
        limit: opts.limit,
        statuses: opts.statuses || null,
        types: opts.types || null
      });
    },

    /** Trade actions. leg = current week/leg of the transaction. */
    acceptTrade: function (leagueId, transactionId, leg) {
      return VaultSleeper.execute({ type: 'accept_trade', leagueId: String(leagueId), transactionId: String(transactionId), leg: Number(leg) });
    },
    rejectTrade: function (leagueId, transactionId, leg) {
      return VaultSleeper.execute({ type: 'reject_trade', leagueId: String(leagueId), transactionId: String(transactionId), leg: Number(leg) });
    },
    cancelTrade: function (leagueId, transactionId, leg) {
      return VaultSleeper.execute({ type: 'cancel_transaction', leagueId: String(leagueId), transactionId: String(transactionId), leg: Number(leg) });
    },
    proposeTrade: function (opts /* {leagueId, rosterId, rosterIds, adds, drops, draftPicks, waiverBudget} */) {
      return VaultSleeper.execute({
        type: 'propose_trade',
        leagueId: String(opts.leagueId), rosterId: Number(opts.rosterId),
        rosterIds: opts.rosterIds.map(Number),
        adds: opts.adds || {}, drops: opts.drops || {},
        draftPicks: opts.draftPicks || [], waiverBudget: opts.waiverBudget || []
      });
    },

    /** Waiver claims. adds/drops = {player_id: roster_id}; settings e.g. {waiver_bid: 12}. */
    submitWaiverClaim: function (opts /* {leagueId, rosterId, adds, drops, settings} */) {
      return VaultSleeper.execute({
        type: 'submit_waiver_claim',
        leagueId: String(opts.leagueId), rosterId: Number(opts.rosterId),
        adds: opts.adds || {}, drops: opts.drops || {}, settings: opts.settings || {}
      });
    },
    cancelWaiverClaim: function (leagueId, transactionId, leg) {
      return VaultSleeper.execute({ type: 'cancel_waiver_claim', leagueId: String(leagueId), transactionId: String(transactionId), leg: Number(leg) });
    },

    /** Fix IR from Vault: set the full reserve (IR) list for a roster. */
    updateReserve: function (leagueId, rosterId, reserve) {
      return VaultSleeper.execute({ type: 'update_reserve', leagueId: String(leagueId), rosterId: Number(rosterId), reserve: reserve });
    },
    updateTaxi: function (leagueId, rosterId, taxi) {
      return VaultSleeper.execute({ type: 'update_taxi', leagueId: String(leagueId), rosterId: Number(rosterId), taxi: taxi });
    },

    /** Draft: set the user's pick queue, or make the actual pick on their turn. */
    setDraftQueue: function (draftId, playerIds) {
      return VaultSleeper.execute({ type: 'update_draft_queue', draftId: String(draftId), playerIds: playerIds });
    },
    getDraftQueue: function (draftId) {
      return VaultSleeper.read({ type: 'draft_queue', draftId: String(draftId) });
    },
    draftPlayer: function (draftId, playerId, pickNo) {
      return VaultSleeper.execute({ type: 'draft_pick_player', draftId: String(draftId), playerId: String(playerId), pickNo: Number(pickNo) });
    },

    /** Trade block flag on a league player. */
    addTradeBlock: function (leagueId, playerId) {
      return VaultSleeper.execute({ type: 'add_trade_block', leagueId: String(leagueId), playerId: String(playerId) });
    },
    removeTradeBlock: function (leagueId, playerId) {
      return VaultSleeper.execute({ type: 'remove_trade_block', leagueId: String(leagueId), playerId: String(playerId) });
    },

    /** Convenience: push a full ordered starters array for one roster.
     *  week (leg) targets the per-week matchup lineup the Sleeper app
     *  displays; without it only roster.starters (the default) changes. */
    pushStarters: function (leagueId, rosterId, starters, week) {
      var action = {
        type: 'update_starters',
        leagueId: String(leagueId),
        rosterId: Number(rosterId),
        starters: starters
      };
      if (week != null && Number(week) >= 1) action.leg = Number(week);
      return VaultSleeper.execute(action);
    },

    /** Convenience: push starters for many leagues at once (throttled queue). */
    pushStartersBatch: function (items /* [{leagueId, rosterId, starters, week}] */) {
      return VaultSleeper.enqueue(items.map(function (it) {
        var action = {
          type: 'update_starters',
          leagueId: String(it.leagueId),
          rosterId: Number(it.rosterId),
          starters: it.starters
        };
        if (it.week != null && Number(it.week) >= 1) action.leg = Number(it.week);
        return action;
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
