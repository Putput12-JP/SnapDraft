/* ══════════════════════════════════════════════════════════════════════
   VAULT MOBILE LAYER · Phases 2–5
   ----------------------------------------------------------------------
   Mobile-only behaviour, ported from the prototypes:
     Phase 2  persistent live-draft bar + clock; flagged lineup slots first;
              staged lineup changes with an explicit Submit
     Phase 3  staged intent for trade accept and waiver claims
     Phase 4  one sheet primitive, reused; player profile opens from anywhere
     Phase 5  league switcher on the primitive; next-action line per league

   AUDIT NOTE  Everything that reads or writes app state lives in VMAdapter
   below. Nothing outside that object touches app globals. Each adapter
   member says what it needs and what it currently falls back to; the ones
   marked TODO are the wiring points. The UI degrades to hidden (not
   broken) whenever an adapter returns null.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var MOBILE = function () { return matchMedia('(max-width:700px)').matches; };
  var REDUCED = function () { try { return matchMedia('(prefers-reduced-motion:reduce)').matches; } catch (e) { return false; } };

  /* App state lives in top-level `let` bindings (myTeamsData, sleeperDraftId,
     teamsLeagueId, …). Those sit in the global LEXICAL scope, which every
     classic script shares but which is NOT the window object — reading
     window.myTeamsData returns undefined even though 24 leagues are loaded.
     Read by bare name inside a thunk so a missing/TDZ binding falls back
     instead of throwing. */
  function G(read, fallback) {
    try { var v = read(); return (v === undefined || v === null) ? fallback : v; }
    catch (e) { return fallback; }
  }

  /* ════════════════════════════════════════════════════════════════════
     ADAPTER · the only bridge to app state
     ════════════════════════════════════════════════════════════════════ */
  var VMAdapter = {

    /* ---- leagues (Phase 5) ------------------------------------------
       Reads the synced Sleeper leagues the app already holds.          */
    leagues: function () {
      var all = G(function () { return myTeamsData; }, []);
      return all.map(function (lg) {
        return {
          id: lg.league_id,
          name: lg.name || 'League',
          initials: (lg.name || 'League').split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase(),
          meta: [
            lg.total_rosters ? lg.total_rosters + '-team' : null,
            (lg.roster_positions || []).indexOf('SUPER_FLEX') >= 0 ? 'SF' : null,
            lg.season || null
          ].filter(Boolean).join(' · ')
        };
      });
    },

    activeLeagueId: function () {
      var id = G(function () { return teamsLeagueId; }, null);
      if (id) return id;
      var sel = document.getElementById('header-league-select');
      if (sel && sel.value) return sel.value;
      return window._currentLeagueId || null;
    },

    /* Switching league without losing the current screen.
       This used to click `.vlg-trigger` and then poll for a menu row — three
       ways broken: bindSwitcher's own capture listener swallowed that click
       and just reopened this sheet, the menu rows key on `data-val` (not
       `data-league-id`), and the only `[data-league-id]` in the app is a
       portfolio-picker checkbox, so a stray match toggled an unrelated
       setting. switchGlobalLeague is the app's real entry point — it clears
       the roster/trade caches, syncs the connected draft, and updates
       #header-league-select and the header pill itself. */
    setLeague: function (id) {
      if (!id) return false;
      if (typeof window.switchGlobalLeague === 'function') {
        try { window.switchGlobalLeague(id); return true; } catch (e) {}
      }
      var sel = document.getElementById('header-league-select');
      if (sel) {
        sel.value = id;
        try { sel.dispatchEvent(new Event('change', { bubbles: true })); return true; } catch (e) {}
      }
      return false;
    },

    /* ---- live draft (Phase 2) ---------------------------------------
       null  → no live draft, the bar stays hidden.
       clock → seconds left on the current pick, or null when the app
               does not expose a per-pick timer (the bar then shows the
               pick number instead of a countdown, which is honest).    */
    draft: function () {
      if (!G(function () { return sleeperDraftId; }, '')) return null;
      var d = { live: true, onClock: false, pick: null, clock: null };
      try {
        if (typeof paCurrentPick === 'function') {
          var cur = paCurrentPick();
          if (cur != null) d.pick = cur;
        }
      } catch (e) {}
      try {
        var mine = window._myDraftPicks || (window.draftState && window.draftState.myPicks);
        if (mine && mine.length && d.pick != null) d.onClock = mine[0] <= d.pick;
      } catch (e) {}
      /* TODO(audit): Sleeper exposes a pick deadline on the draft object.
         Wire it here and the bar becomes a real countdown (amber ≤15s,
         red ≤8s) exactly as designed; until then it reads the pick. */
      try {
        var dl = window._draftPickDeadline;
        if (dl) d.clock = Math.max(0, Math.round((dl - Date.now()) / 1000));
      } catch (e) {}
      return d;
    },

    openDraft: function () { try { showPage('draft'); } catch (e) {} },

    /* ---- lineup (Phase 2) -------------------------------------------
       The app renders lineup rows; we classify them so the flagged ones
       can float to the top. Selectors are the app's own, in one place.  */
    lineupRoot: function () {
      return document.getElementById('pf-lineup-command') ||
             document.getElementById('lc-mount') ||
             document.querySelector('#page-lineup .lc-body');
    },
    lineupRows: function (root) {
      return Array.prototype.slice.call(root.querySelectorAll('[data-lc-slot], .lc-row, .rdv-side.me'));
    },
    rowStatus: function (row) {
      var t = (row.textContent || '').toUpperCase();
      if (/\bOUT\b|\bIR\b|RULED OUT/.test(t)) return 'out';
      if (/QUESTIONABLE|\bQ\b|DOUBTFUL/.test(t)) return 'warn';
      return 'ok';
    },

    /* ---- staged writes (Phases 2–3) ---------------------------------
       The layer never writes to Sleeper. It collects intent and hands it
       over on Submit. Each commit is a TODO so the audit wires it to the
       call the app already uses.                                        */
    commitLineup: function (changes) {
      /* TODO(audit): call the app's existing lineup push
         (the same path the desktop "Push to Sleeper" button uses). */
      try { if (typeof lcPushLineup === 'function') return lcPushLineup(changes); } catch (e) {}
      return false;
    },
    commitTrade: function (offerId) {
      /* TODO(audit): the app's accept-offer call. */
      try { if (typeof tcAcceptOffer === 'function') return tcAcceptOffer(offerId); } catch (e) {}
      return false;
    },
    commitClaims: function (claims) {
      /* TODO(audit): the app's waiver claim submit (wcClaimModal writes one). */
      try { if (typeof wcSubmitClaims === 'function') return wcSubmitClaims(claims); } catch (e) {}
      return false;
    },

    /* ---- player profile (Phase 4) ------------------------------------ */
    openPlayer: function (name) {
      try {
        if (typeof openPlayerStats === 'function') {
          var norm = (typeof normName === 'function') ? normName(name) : name;
          openPlayerStats(norm, name, '', '');
          return true;
        }
      } catch (e) {}
      return false;
    },

    haptic: function (ms) {
      try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (e) {}
    }
  };
  window.VMAdapter = VMAdapter;

  /* ════════════════════════════════════════════════════════════════════
     SHEET PRIMITIVE (Phase 1 engine, parameterised in Phase 4)
     1:1 drag, momentum projection, rubber-band, detents, interruptible
     spring. One instance per sheet; the topmost open sheet wins a grab.
     ════════════════════════════════════════════════════════════════════ */
  var SHEETS = [];

  function VaultSheet(opts) {
    var self = {
      el: opts.el,
      dim: opts.dim,
      grab: opts.grab,          // element that accepts the drag
      detents: opts.detents,    // fn(H) → [y…] ascending, last = closed
      onOpen: opts.onOpen || null,
      H: 0, y: 0, open: false, anim: 0, drag: null
    };

    function measure() {
      self.H = self.el.offsetHeight || Math.round(innerHeight * 0.92);
      self.det = self.detents(self.H);
    }
    function apply(y, animate) {
      self.y = y;
      if (!animate) self.el.style.transition = 'none';
      self.el.style.transform = 'translate3d(0,' + y + 'px,0)';
      if (self.dim) {
        var t = 1 - Math.min(1, Math.max(0, self.H ? y / self.H : 1));
        self.dim.style.transition = animate ? 'opacity 260ms ease' : 'none';
        self.dim.style.opacity = String(t * 0.95);
        self.dim.style.pointerEvents = (self.H && y > self.H - 20) ? 'none' : 'auto';
      }
    }
    function liveY() {
      try {
        var m = new DOMMatrixReadOnly(getComputedStyle(self.el).transform);
        if (m && isFinite(m.m42)) return m.m42;
      } catch (e) {}
      return self.y;
    }
    function stop() {
      var y = liveY();
      self.el.style.transition = 'none';
      self.el.style.transform = 'translate3d(0,' + y + 'px,0)';
      self.y = y;
      clearTimeout(self.anim);
    }
    function settle(target) {
      self.open = self.H ? target < self.H - 1 : false;
      if (!self.open) {
        self.el.hidden = true;
        if (self.dim) self.dim.hidden = true;
      }
    }
    function spring(target, v0, bounce) {
      stop();
      if (REDUCED()) { apply(target); settle(target); return; }
      var dist = Math.abs(target - self.y), speed = Math.abs(v0 || 0);
      var dur = dist <= 0.5 ? 0 : Math.max(170, Math.min(440, (dist / Math.max(420, speed)) * 1000 + 160));
      var ease = bounce ? 'cubic-bezier(0.34,1.56,0.64,1)' : 'cubic-bezier(0.32,0.72,0,1)';
      void self.el.offsetWidth;
      self.el.style.transition = 'transform ' + dur + 'ms ' + ease;
      apply(target, true);
      self.anim = setTimeout(function () { settle(target); }, dur + 20);
    }
    function project(v) { var d = 0.998; return (v / 1000) * d / (1 - d); }
    function rubber(over, dim) { var c = 0.55; return (over * dim * c) / (dim + c * Math.abs(over)); }

    self.show = function () {
      if (self.dim) self.dim.hidden = false;
      self.el.hidden = false;
      if (self.onOpen) self.onOpen();
      measure();
      apply(self.H);
      self.open = true;
      requestAnimationFrame(function () { spring(self.det[self.det.length - 2], 0, false); });
    };
    self.hide = function () { if (!self.H) measure(); spring(self.H, 0, false); };
    self.toggle = function () { self.open ? self.hide() : self.show(); };
    self.measure = measure;

    self._down = function (e) {
      if (self.el.hidden || !self.open) return false;
      if (e.target.closest && e.target.closest('input,button,a')) return false;
      if (!self.grab || !self.grab.contains(e.target)) return false;
      stop();
      try { self.el.setPointerCapture(e.pointerId); } catch (err) {}
      self.drag = { startY: e.clientY, startSheet: liveY(), hist: [[e.clientY, performance.now()]] };
      return true;
    };
    self._move = function (e) {
      if (!self.drag) return;
      var y = self.drag.startSheet + (e.clientY - self.drag.startY);
      if (y < 0) y = -rubber(-y, self.H);
      if (y > self.H) y = self.H;
      self.drag.hist.push([e.clientY, performance.now()]);
      if (self.drag.hist.length > 6) self.drag.hist.shift();
      apply(y);
      e.preventDefault();
    };
    self._up = function () {
      if (!self.drag) return;
      var h = self.drag.hist, a = h[0], b = h[h.length - 1];
      var dt = Math.max(16, b[1] - a[1]);
      var v = (b[0] - a[0]) / dt * 1000;
      var moved = Math.abs(self.drag.startSheet - self.y) > 3;
      self.drag = null;
      if (!moved) return;
      var projected = self.y + project(v);
      var target = self.det[0], best = Infinity;
      self.det.forEach(function (d) { var gap = Math.abs(d - projected); if (gap < best) { best = gap; target = d; } });
      spring(target, v, Math.abs(v) > 300 && target !== 0);
    };

    SHEETS.push(self);
    return self;
  }
  window.VaultSheet = VaultSheet;

  /* one global pointer pipeline; last-registered (topmost) sheet gets first refusal */
  var dragging = null;
  addEventListener('pointerdown', function (e) {
    if (!MOBILE()) return;
    for (var i = SHEETS.length - 1; i >= 0; i--) {
      if (SHEETS[i]._down(e)) { dragging = SHEETS[i]; break; }
    }
  }, true);
  addEventListener('pointermove', function (e) { if (dragging) dragging._move(e); });
  ['pointerup', 'pointercancel'].forEach(function (t) {
    addEventListener(t, function () { if (dragging) { dragging._up(); dragging = null; } });
  });
  addEventListener('resize', function () { SHEETS.forEach(function (s) { if (s.open) s.measure(); }); });

  /* ════════════════════════════════════════════════════════════════════
     BAR STACK · every bar above the dock shares one slot system, so the
     staged bar and the live-draft bar stack instead of overlapping.
     ════════════════════════════════════════════════════════════════════ */
  var BARS = [];
  function registerBar(el, priority) {
    BARS.push({ el: el, p: priority });
    BARS.sort(function (a, b) { return a.p - b.p; });
  }
  function layoutBars() {
    var i = 0;
    BARS.forEach(function (b) {
      if (b.el.hidden) return;
      b.el.style.setProperty('--vm-i', i);
      i++;
    });
  }
  function showBar(el, on) {
    if (el.hidden === !on) { layoutBars(); return; }
    el.hidden = !on;
    el.classList.toggle('vm-in', !!on);
    el.classList.toggle('vm-out', !on);
    layoutBars();
  }

  /* ════════════════════════════════════════════════════════════════════
     PHASE 2 · live draft bar
     Persistent: it survives leaving the draft, so getting back is one tap.
     ════════════════════════════════════════════════════════════════════ */
  var draftBar, draftTitle, draftClock;

  function buildDraftBar() {
    draftBar = document.createElement('button');
    draftBar.className = 'vm-bar vm-draft vm-out';
    draftBar.id = 'vm-draft-bar';
    draftBar.hidden = true;
    draftBar.setAttribute('aria-label', 'Open live draft');
    draftBar.innerHTML =
      '<span class="vm-live">● LIVE</span>' +
      '<span class="vm-dtitle">Draft in progress</span>' +
      '<span class="vm-clock"></span>';
    draftBar.addEventListener('click', function () {
      VMAdapter.haptic(8);
      VMAdapter.openDraft();
    });
    document.body.appendChild(draftBar);
    draftTitle = draftBar.querySelector('.vm-dtitle');
    draftClock = draftBar.querySelector('.vm-clock');
    registerBar(draftBar, 20);
  }

  function tickDraft() {
    if (!draftBar) return;
    var d = MOBILE() ? VMAdapter.draft() : null;
    var onDraftPage = !!document.querySelector('#page-draft.on');
    if (!d || onDraftPage) { showBar(draftBar, false); return; }

    draftTitle.textContent = d.onClock
      ? "You're on the clock" + (d.pick != null ? ' · pick ' + d.pick : '')
      : (d.pick != null ? 'League picking · pick ' + d.pick : 'Draft in progress');

    if (d.clock != null) {
      var mm = Math.floor(d.clock / 60), ss = d.clock % 60;
      draftClock.textContent = mm + ':' + (ss < 10 ? '0' + ss : ss);
      draftBar.classList.toggle('vm-warn', d.clock <= 15 && d.clock > 8);
      draftBar.classList.toggle('vm-crit', d.clock <= 8);
    } else {
      draftClock.textContent = d.pick != null ? '#' + d.pick : '';
      draftBar.classList.remove('vm-warn', 'vm-crit');
    }
    showBar(draftBar, true);
  }

  /* ════════════════════════════════════════════════════════════════════
     PHASES 2–3 · staged intent
     One bar, three users (lineup swaps, trade accept, waiver claims).
     Nothing reaches Sleeper until Submit; Cancel always restores.
     ════════════════════════════════════════════════════════════════════ */
  var stageBar, stageTitle, stageMeta, stage = null;

  function buildStageBar() {
    stageBar = document.createElement('div');
    stageBar.className = 'vm-bar vm-staged vm-out';
    stageBar.id = 'vm-stage-bar';
    stageBar.hidden = true;
    stageBar.innerHTML =
      '<span class="vm-bar-main"><b></b><small></small></span>' +
      '<button class="vm-ghost" data-vm-cancel>Cancel</button>' +
      '<button class="vm-go" data-vm-commit>Submit</button>';
    document.body.appendChild(stageBar);
    stageTitle = stageBar.querySelector('b');
    stageMeta = stageBar.querySelector('small');
    stageBar.querySelector('[data-vm-cancel]').addEventListener('click', function () {
      if (stage && stage.cancel) stage.cancel();
      clearStage();
    });
    stageBar.querySelector('[data-vm-commit]').addEventListener('click', function () {
      if (!stage) return;
      VMAdapter.haptic(12);
      var ok = stage.commit();
      if (ok !== false) clearStage();
    });
    registerBar(stageBar, 10);
  }

  /* public: anything can stage intent
     VaultMobile.stage({title, meta, cta, commit, cancel}) */
  function setStage(s) {
    stage = s;
    stageTitle.textContent = s.title || 'Changes staged';
    stageMeta.textContent = s.meta || 'NOTHING SENT UNTIL YOU CONFIRM';
    stageBar.querySelector('[data-vm-commit]').textContent = s.cta || 'Submit';
    showBar(stageBar, true);
  }
  function clearStage() { stage = null; showBar(stageBar, false); }

  /* ════════════════════════════════════════════════════════════════════
     PHASE 2 · flagged lineup slots first
     Re-orders the app's own rows with flexbox order, marks OUT and
     QUESTIONABLE, and drops a header above them. No row is rebuilt, so
     the app's data and handlers stay untouched.
     ════════════════════════════════════════════════════════════════════ */
  var lineupObserver = null;
  var marking = false;

  function markLineup() {
    if (!MOBILE() || marking) return;
    var root = VMAdapter.lineupRoot();
    if (!root) return;
    var rows = VMAdapter.lineupRows(root);
    if (!rows.length) return;

    /* We are about to mutate the very subtree the observer watches, so
       stop watching first — otherwise each pass retriggers itself. */
    marking = true;
    if (lineupObserver) lineupObserver.disconnect();
    try {
      var flagged = 0;
      rows.forEach(function (row) {
        var st = VMAdapter.rowStatus(row);
        var wantFlag = st !== 'ok', wantOut = st === 'out';
        if (row.classList.contains('vm-flagged') !== wantFlag) row.classList.toggle('vm-flagged', wantFlag);
        if (row.classList.contains('vm-out') !== wantOut) row.classList.toggle('vm-out', wantOut);
        if (wantFlag) flagged++;
      });

      var host = rows[0].parentNode;
      if (host && host.dataset.vmFlex !== '1' && getComputedStyle(host).display.indexOf('flex') < 0) {
        host.style.display = 'flex';
        host.style.flexDirection = 'column';
        host.dataset.vmFlex = '1';
      }
      if (host) {
        var hd = host.querySelector(':scope > .vm-flag-hd');
        if (!hd) {
          hd = document.createElement('div');
          hd.className = 'vm-flag-hd';
          host.insertBefore(hd, host.firstChild);
        }
        var text = 'NEEDS A DECISION · ' + flagged;
        if (hd.textContent !== text) hd.textContent = text;
        if (hd.hidden !== (flagged === 0)) hd.hidden = flagged === 0;
      }
    } finally {
      marking = false;
      if (lineupObserver) observeLineup();
    }
  }

  /* one rAF-coalesced pass per burst of app re-renders */
  var queued = false;
  function queueMark() {
    if (queued || marking) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; markLineup(); });
  }

  function observeLineup() {
    var target = document.getElementById('page-portfolio') ||
                 document.getElementById('page-lineup') ||
                 document.body;
    lineupObserver.observe(target, { childList: true, subtree: true });
  }

  /* ══════════════════════════════════════════════════════════════════════
     PHASES 2–3 · intercept the app's own commit buttons
     ----------------------------------------------------------------------
     The prototypes' rule: a phone never fires an irreversible league
     action on the first tap. Rather than reimplement accept / push /
     claim, we intercept the app's button, stage the intent, and REPLAY
     that exact click on Submit — the app keeps owning the write, so
     there is a single code path to audit.

     AUDIT NOTE  The table below is the whole contract. A button that is
     not matched keeps its current behaviour (immediate commit); a button
     matched wrongly is harmless, because Cancel sends nothing.
     ══════════════════════════════════════════════════════════════════════ */
  var COMMITS = [
    { match: '[data-vm-commit-kind]', kind: null },                      /* explicit opt-in wins */
    { match: '[data-lc-push], [data-vm-lineup-push]', kind: 'lineup' },
    { match: '[data-tc-accept], [data-vm-trade-accept]', kind: 'trade' },
    { match: '[data-wc-submit], [data-vm-waiver-submit]', kind: 'waiver' }
  ];

  var COPY = {
    lineup: { title: 'Lineup change staged', meta: 'NOTHING PUSHED TO SLEEPER UNTIL YOU CONFIRM', cta: 'Submit' },
    trade:  { title: 'Accept this offer',    meta: 'NOTHING SENT UNTIL YOU CONFIRM',              cta: 'Confirm' },
    waiver: { title: 'Claim staged',         meta: 'PROCESSES AT YOUR WAIVER TIME',               cta: 'Submit' }
  };

  function commitTargetFor(el) {
    for (var i = 0; i < COMMITS.length; i++) {
      var hit = el.closest(COMMITS[i].match);
      if (hit) return { el: hit, kind: COMMITS[i].kind || hit.getAttribute('data-vm-commit-kind') };
    }
    return null;
  }

  function interceptCommits() {
    document.addEventListener('click', function (e) {
      if (!MOBILE() || !e.target.closest) return;
      var found = commitTargetFor(e.target);
      if (!found || !COPY[found.kind]) return;
      if (found.el.dataset.vmReplay === '1') { found.el.dataset.vmReplay = ''; return; }

      e.preventDefault();
      e.stopPropagation();

      var c = COPY[found.kind];
      var label = (found.el.getAttribute('data-vm-label') || '').trim();
      VMAdapter.haptic(6);
      setStage({
        title: label || c.title,
        meta: c.meta,
        cta: c.cta,
        kind: found.kind,
        commit: function () {
          found.el.dataset.vmReplay = '1';   /* replay without re-intercepting */
          found.el.click();
          return true;
        },
        cancel: function () { found.el.dataset.vmReplay = ''; }
      });
    }, true);
  }

  /* ══════════════════════════════════════════════════════════════════════
     PHASE 4 · player profile from anywhere
     The app already owns the profile sheet (#ps-modal). What mobile
     lacked was reaching it from every list, so one delegated listener
     covers rows the app renders later.
     ══════════════════════════════════════════════════════════════════════ */
  function bindPlayerTaps() {
    document.addEventListener('click', function (e) {
      if (!MOBILE() || !e.target.closest) return;
      if (e.target.closest('button,a,input,select,[data-vc-go],.vm-bar,.vm-sheet')) return;
      var named = e.target.closest('[data-player-name],[data-pname],[data-vm-player]');
      if (!named) return;
      var name = named.getAttribute('data-player-name') ||
                 named.getAttribute('data-pname') ||
                 named.getAttribute('data-vm-player');
      if (!name) return;
      if (VMAdapter.openPlayer(name)) {
        VMAdapter.haptic(6);
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  /* ══════════════════════════════════════════════════════════════════════
     PHASE 5 · league switcher, built on the shared primitive
     ══════════════════════════════════════════════════════════════════════ */
  var switcher, switcherBody;

  function buildSwitcher() {
    var dim = document.createElement('div');
    dim.className = 'vm-dim';
    dim.id = 'vm-switch-dim';
    dim.hidden = true;

    var el = document.createElement('div');
    el.className = 'vm-sheet';
    el.id = 'vm-switch';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Switch league');
    el.innerHTML =
      '<div class="vm-grab" id="vm-switch-grab"><i></i>' +
      '  <div class="vm-shead">' +
      '    <span class="vm-stitle"><b>Switch league</b><small>YOU KEEP THE SCREEN YOU ARE ON</small></span>' +
      '    <button class="vm-x" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '  </div>' +
      '</div>' +
      '<div class="vm-sbody" id="vm-switch-body"></div>';

    document.body.appendChild(dim);
    document.body.appendChild(el);
    switcherBody = el.querySelector('#vm-switch-body');

    switcher = VaultSheet({
      el: el,
      dim: dim,
      grab: el.querySelector('#vm-switch-grab'),
      /* one working detent: a switcher is a decision, not a workspace */
      detents: function (H) { return [Math.max(0, H - 420), H]; },
      onOpen: renderSwitcher
    });
    dim.addEventListener('click', switcher.hide);
    el.querySelector('.vm-x').addEventListener('click', switcher.hide);
  }

  function renderSwitcher() {
    var leagues = VMAdapter.leagues();
    var active = VMAdapter.activeLeagueId();
    if (!leagues.length) {
      switcherBody.innerHTML = '<div style="padding:26px 4px;text-align:center;font-size:14px;color:var(--muted)">No leagues synced yet.</div>';
      return;
    }
    switcherBody.innerHTML = leagues.map(function (l) {
      return '<button class="vm-lg' + (l.id === active ? ' on' : '') + '" data-vm-lid="' + l.id + '">' +
        '<span class="vm-lg-av">' + l.initials + '</span>' +
        '<span class="vm-lg-main"><b>' + l.name + '</b><small>' + l.meta + '</small></span>' +
        '<svg class="vm-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>' +
      '</button>';
    }).join('');
  }

  function bindSwitcher() {
    document.addEventListener('click', function (e) {
      var row = e.target.closest && e.target.closest('[data-vm-lid]');
      if (!row) return;
      VMAdapter.haptic(8);
      VMAdapter.setLeague(row.getAttribute('data-vm-lid'));
      if (switcher) switcher.hide();
    });

    /* the header league chip opens the sheet instead of the desktop popover */
    document.addEventListener('click', function (e) {
      if (!MOBILE() || !switcher || !e.target.closest) return;
      var t = e.target.closest('.vlg-trigger');
      if (!t) return;
      /* No pass-through guard needed: setLeague calls switchGlobalLeague
         directly and never clicks this trigger. */
      e.preventDefault();
      e.stopPropagation();
      switcher.show();
    }, true);
  }

  /* ══════════════════════════════════════════════════════════════════════
     BOOT
     ══════════════════════════════════════════════════════════════════════ */
  function boot() {
    buildDraftBar();
    buildStageBar();
    buildSwitcher();
    bindSwitcher();
    bindPlayerTaps();
    interceptCommits();

    tickDraft();
    setInterval(tickDraft, 1000);

    lineupObserver = new MutationObserver(queueMark);
    markLineup();
    observeLineup();

    window.VaultMobile = {
      adapter: VMAdapter,
      Sheet: VaultSheet,
      switcher: function () { return switcher; },
      stage: setStage,
      clearStage: clearStage,
      markLineup: markLineup,
      refreshDraftBar: tickDraft
    };
  }

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
  else boot();
})();
