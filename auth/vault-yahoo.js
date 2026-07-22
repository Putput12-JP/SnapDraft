// ═══════════════════════════════════════════════════════════════
// Vault Fantasy — Yahoo client (frontend wrapper)
// ═══════════════════════════════════════════════════════════════
// Thin bridge from the app to the Cloud Functions backend that talks to
// Yahoo's Fantasy Sports API. Mirrors auth/vault-sleeper.js.
//
// One structural difference from Sleeper and ESPN, and it shapes everything
// here: Yahoo sends no CORS headers, so the browser cannot call Yahoo at
// all. READS go through the backend too, not just writes. Every method below
// is a Cloud Function round trip, which is why the server caches responses
// and why `force` exists as an explicit opt-out rather than the default.
//
// Neither the OAuth tokens nor the app's client secret ever reach this file.
//
// Public API (window.VaultYahoo):
//   ready()                      -> Promise (SDK loaded)
//   status()                     -> Promise<{connected, guid, verified, expiresAt}>
//   beginConnect()               -> opens Yahoo consent in a popup, resolves on success
//   completeConnect(code, state) -> Promise<Connection>  (called by yahoo-callback.html)
//   disconnect()                 -> Promise
//   read(query, force)           -> Promise<{data, cached}>
//   execute(action)              -> Promise<{ok, response}>
//   ...plus typed helpers for each league resource and write.
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
      if (window.VaultAppCheck) await window.VaultAppCheck.activate();
      _fns = window.firebase.app().functions(REGION);
      return _fns;
    })();
    return _ready;
  }

  async function call(name, data) {
    var fns = await ready();
    var user = window.firebase.auth && window.firebase.auth().currentUser;
    if (!user) throw new Error('Sign in to Vault before connecting Yahoo.');
    var res = await fns.httpsCallable(name)(data || {});
    return res.data;
  }

  // ── OAuth popup flow ────────────────────────────────────────
  // Yahoo's consent screen refuses to render in an iframe, so this is a real
  // popup. The callback page posts the code back with postMessage; we verify
  // the message origin because any page can postMessage into this window.
  var POPUP_TIMEOUT_MS = 5 * 60 * 1000;

  function beginConnect() {
    return new Promise(function (resolve, reject) {
      call('yahooAuthUrl').then(function (r) {
        // Open BEFORE any further await — popup blockers only allow a window
        // opened synchronously in the user-gesture chain, and we've already
        // spent one await getting the URL, so open immediately on resolve.
        var win = window.open(r.url, 'vault-yahoo-oauth', 'width=520,height=700');
        if (!win) {
          reject(new Error('Your browser blocked the Yahoo sign-in window. Allow popups for Vault and try again.'));
          return;
        }

        var done = false;
        function finish(fn, arg) {
          if (done) return;
          done = true;
          window.removeEventListener('message', onMsg);
          clearInterval(pollClosed);
          clearTimeout(timer);
          try { win.close(); } catch (e) {}
          fn(arg);
        }

        function onMsg(ev) {
          // Only trust our own origin — the callback page is same-origin.
          if (ev.origin !== window.location.origin) return;
          var d = ev.data;
          if (!d || d.source !== 'vault-yahoo-oauth') return;
          if (d.error) { finish(reject, new Error(d.error)); return; }
          completeConnect(d.code, d.state).then(
            function (conn) { finish(resolve, conn); },
            function (e) { finish(reject, e); }
          );
        }
        window.addEventListener('message', onMsg);

        // The user can just close the window; without this the promise hangs.
        var pollClosed = setInterval(function () {
          if (win.closed) finish(reject, new Error('Yahoo sign-in was cancelled.'));
        }, 700);

        var timer = setTimeout(function () {
          finish(reject, new Error('Yahoo sign-in timed out.'));
        }, POPUP_TIMEOUT_MS);
      }, reject);
    });
  }

  function completeConnect(code, state) {
    return call('yahooExchangeCode', { code: code, state: state });
  }

  // ── public API ──────────────────────────────────────────────
  var VaultYahoo = {
    ready: ready,

    status: function () { return call('yahooStatus'); },
    beginConnect: beginConnect,
    completeConnect: completeConnect,
    disconnect: function () { return call('yahooDisconnect'); },

    /**
     * Allowlisted read. Served from the server-side cache unless `force`.
     * Prefer the typed helpers below — they keep query shapes in one place.
     */
    read: function (query, force) {
      return call('yahooRead', { query: query, force: force === true });
    },

    /** Single write, server-throttled and ownership-checked. */
    execute: function (action) { return call('executeYahooAction', { action: action }); },

    // ── reads ──
    myLeagues: function (season, force) {
      return VaultYahoo.read({ type: 'my_leagues', season: season }, force);
    },
    leagueSettings: function (leagueKey, force) {
      return VaultYahoo.read({ type: 'league_settings', leagueKey: leagueKey }, force);
    },
    leagueTeams: function (leagueKey, force) {
      return VaultYahoo.read({ type: 'league_teams', leagueKey: leagueKey }, force);
    },
    standings: function (leagueKey, force) {
      return VaultYahoo.read({ type: 'league_standings', leagueKey: leagueKey }, force);
    },
    roster: function (teamKey, week, force) {
      return VaultYahoo.read({ type: 'team_roster', teamKey: teamKey, week: week }, force);
    },
    scoreboard: function (leagueKey, week, force) {
      return VaultYahoo.read({ type: 'scoreboard', leagueKey: leagueKey, week: week }, force);
    },
    /**
     * One page of free agents. Yahoo hard-caps a player page at 25, so a full
     * waiver scan pages with `start` — see freeAgentsDeep().
     */
    freeAgents: function (leagueKey, opts, force) {
      opts = opts || {};
      return VaultYahoo.read({
        type: 'free_agents', leagueKey: leagueKey,
        status: opts.status || 'A', start: opts.start || 0, position: opts.position || null
      }, force);
    },
    transactions: function (leagueKey, opts, force) {
      opts = opts || {};
      return VaultYahoo.read({
        type: 'transactions', leagueKey: leagueKey,
        types: opts.types || null, count: opts.count
      }, force);
    },
    pendingTrades: function (leagueKey, teamKey, force) {
      return VaultYahoo.read({ type: 'pending_trades', leagueKey: leagueKey, teamKey: teamKey }, force);
    },
    draftResults: function (leagueKey, force) {
      return VaultYahoo.read({ type: 'draft_results', leagueKey: leagueKey }, force);
    },

    /**
     * Walk `pages` pages of free agents sequentially. Sequential, not
     * parallel: each page is a function invocation that hits Yahoo, and
     * firing a dozen at once is exactly the burst that gets an app's
     * client id throttled. Callers should ask for the fewest pages that
     * answer the question.
     */
    freeAgentsDeep: async function (leagueKey, pages, opts) {
      opts = opts || {};
      var out = [];
      var n = Math.max(1, Math.min(pages || 4, 12));
      for (var i = 0; i < n; i++) {
        var r = await VaultYahoo.freeAgents(leagueKey, {
          status: opts.status, position: opts.position, start: i * 25
        });
        out.push(r.data);
        if (r && r.data && r.data.__lastPage) break;
      }
      return out;
    },

    // ── writes ──
    /** Full weekly slotting. `slots` = [{playerKey, position}] for the whole roster. */
    setLineup: function (leagueKey, teamKey, week, slots) {
      return VaultYahoo.execute({
        type: 'set_lineup', leagueKey: leagueKey, teamKey: teamKey,
        week: Number(week), slots: slots
      });
    },
    /** FAAB bid present => waiver claim; absent => straight free-agent add. */
    addPlayer: function (leagueKey, teamKey, playerKey, faabBid) {
      return VaultYahoo.execute({
        type: 'add_player', leagueKey: leagueKey, teamKey: teamKey,
        playerKey: playerKey, faabBid: faabBid
      });
    },
    dropPlayer: function (leagueKey, teamKey, playerKey) {
      return VaultYahoo.execute({
        type: 'drop_player', leagueKey: leagueKey, teamKey: teamKey, playerKey: playerKey
      });
    },
    addDrop: function (leagueKey, teamKey, addPlayerKey, dropPlayerKey, faabBid) {
      return VaultYahoo.execute({
        type: 'add_drop', leagueKey: leagueKey, teamKey: teamKey,
        addPlayerKey: addPlayerKey, dropPlayerKey: dropPlayerKey, faabBid: faabBid
      });
    },
    proposeTrade: function (leagueKey, teamKey, tradeeTeamKey, sendKeys, receiveKeys, note) {
      return VaultYahoo.execute({
        type: 'propose_trade', leagueKey: leagueKey, teamKey: teamKey,
        tradeeTeamKey: tradeeTeamKey, sendPlayerKeys: sendKeys || [],
        receivePlayerKeys: receiveKeys || [], note: note || ''
      });
    },
    respondTrade: function (leagueKey, teamKey, transactionKey, action, note) {
      return VaultYahoo.execute({
        type: 'respond_trade', leagueKey: leagueKey, teamKey: teamKey,
        transactionKey: transactionKey, action: action, note: note || ''
      });
    },

    // ── key helpers ──
    // Yahoo keys are structured: nfl.l.{league}.t.{team}, nfl.p.{player}.
    // The server validates these shapes, so build them here rather than
    // hand-concatenating at call sites.
    leagueKey: function (leagueId, gameKey) { return (gameKey || 'nfl') + '.l.' + leagueId; },
    teamKey: function (leagueKey, teamId) { return leagueKey + '.t.' + teamId; },
    playerKey: function (playerId, gameKey) { return (gameKey || 'nfl') + '.p.' + playerId; }
  };

  window.VaultYahoo = VaultYahoo;
})();
