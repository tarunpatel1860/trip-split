/* Trip Split — member app. Plain browser JS, no build step. */
(function () {
  'use strict';

  var Logic = window.Logic;
  var money = Logic.money;
  var toPaise = Logic.toPaise;
  var equalShares = Logic.equalShares;
  var isEqualSplit = Logic.isEqualSplit;
  var computeBalances = Logic.computeBalances;
  var suggestions = Logic.suggestions;
  var mergeRows = Logic.mergeRows;
  var uid = Logic.uid;
  var today = Logic.today;
  var timeAgo = Logic.timeAgo;
  var normPhone = Logic.normPhone;
  var esc = Logic.esc;
  var initials = Logic.initials;

  var app = document.getElementById('app');

  var LS = {
    get: function (key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota */ }
    }
  };

  var state = {
    user: LS.get('ts_user', null),
    groups: LS.get('ts_groups', []),
    online: navigator.onLine,
    syncing: false
  };

  var currentGid = null;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function api(payload) {
    var url = window.APP_CONFIG && window.APP_CONFIG.API_URL;
    if (!url || url.indexOf('PASTE') !== -1) {
      return Promise.reject(new Error('Set the Apps Script URL in config.js first.'));
    }
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    }).then(function (res) {
      if (!res.ok) {
        var netErr = new Error('Network error (' + res.status + ')');
        netErr.network = true;
        throw netErr;
      }
      return res.json();
    }).then(function (data) {
      if (!data || !data.ok) throw new Error((data && data.error) || 'Request failed');
      return data;
    }).catch(function (err) {
      if (!err.network && err instanceof TypeError) {
        var offline = new Error('You appear to be offline.');
        offline.network = true;
        throw offline;
      }
      throw err;
    });
  }

  /* ---------- group cache ---------- */

  function cacheKey(gid) { return 'ts_group_' + gid; }

  function loadGroupCache(gid) {
    var g = LS.get(cacheKey(gid), null);
    if (!g) return null;
    g.dirty = g.dirty || { expenses: {}, settlements: {} };
    g.dirty.expenses = g.dirty.expenses || {};
    g.dirty.settlements = g.dirty.settlements || {};
    g.expenses = g.expenses || [];
    g.settlements = g.settlements || [];
    g.members = g.members || [];
    return g;
  }

  function saveGroupCache(g) {
    LS.set(cacheKey(g.group.groupId), g);
  }

  function ensureGroupCache(group) {
    var g = loadGroupCache(group.groupId);
    if (g) return g;
    g = {
      group: group,
      members: [],
      expenses: [],
      settlements: [],
      dirty: { expenses: {}, settlements: {} },
      lastSync: 0
    };
    saveGroupCache(g);
    return g;
  }

  function pendingCount(g) {
    return Object.keys(g.dirty.expenses || {}).length +
      Object.keys(g.dirty.settlements || {}).length;
  }

  /* ---------- sync ---------- */

  var syncInFlight = null;
  var syncInFlightGid = null;

  function finishSync() {
    syncInFlight = null;
    syncInFlightGid = null;
    state.syncing = false;
    updateSyncPill();
  }

  function syncGroup(gid) {
    if (!state.user) return Promise.reject(new Error('Not signed in.'));

    if (syncInFlight) {
      if (syncInFlightGid === gid) return syncInFlight;
      return syncInFlight.then(
        function () { return syncGroup(gid); },
        function () { return syncGroup(gid); }
      );
    }

    state.syncing = true;
    updateSyncPill();

    var g = loadGroupCache(gid) || {
      group: { groupId: gid, name: '', code: '' },
      members: [],
      expenses: [],
      settlements: [],
      dirty: { expenses: {}, settlements: {} },
      lastSync: 0
    };

    var sent = {
      expenses: {},
      settlements: {}
    };
    Object.keys(g.dirty.expenses).forEach(function (key) {
      sent.expenses[key] = Number(g.dirty.expenses[key].updatedAt) || 0;
    });
    Object.keys(g.dirty.settlements).forEach(function (key) {
      sent.settlements[key] = Number(g.dirty.settlements[key].updatedAt) || 0;
    });

    var changes = {
      expenses: Object.keys(g.dirty.expenses).map(function (k) { return g.dirty.expenses[k]; }),
      settlements: Object.keys(g.dirty.settlements).map(function (k) { return g.dirty.settlements[k]; })
    };

    var promise = api({
      action: 'sync',
      phone: state.user.phone,
      groupId: gid,
      changes: changes
    }).then(function (data) {
      g.group = data.group || g.group;
      g.members = data.members || [];
      g.expenses = mergeRows(g.expenses, data.expenses || []);
      g.settlements = mergeRows(g.settlements, data.settlements || []);

      // Only clear the versions we actually sent. Anything edited or added
      // while this request was in flight stays queued for the next sync.
      Object.keys(sent.expenses).forEach(function (key) {
        var current = g.dirty.expenses[key];
        if (current && (Number(current.updatedAt) || 0) === sent.expenses[key]) {
          delete g.dirty.expenses[key];
        }
      });
      Object.keys(sent.settlements).forEach(function (key) {
        var current = g.dirty.settlements[key];
        if (current && (Number(current.updatedAt) || 0) === sent.settlements[key]) {
          delete g.dirty.settlements[key];
        }
      });

      g.lastSync = Date.now();
      saveGroupCache(g);
      state.online = true;
      return g;
    }).catch(function (err) {
      if (err.network) state.online = false;
      throw err;
    }).then(function (value) {
      finishSync();
      if (pendingCount(value) > 0 && state.online) {
        setTimeout(function () { syncGroup(gid).catch(function () {}); }, 200);
      }
      return value;
    }, function (err) {
      finishSync();
      throw err;
    });

    syncInFlight = promise;
    syncInFlightGid = gid;
    return promise;
  }

  function syncLabel(g) {
    if (state.syncing) return 'Syncing…';
    var pending = pendingCount(g);
    if (!state.online) return 'Offline' + (pending ? ' · ' + pending + ' pending' : '');
    if (pending) return pending + ' pending';
    if (g.lastSync) return 'Synced ' + timeAgo(g.lastSync);
    return 'Tap to sync';
  }

  function updateSyncPill() {
    var el = document.getElementById('syncPill');
    if (!el || !currentGid) return;
    var g = loadGroupCache(currentGid);
    if (!g) return;
    el.textContent = syncLabel(g);
    el.className = 'pill ' + (!state.online ? 'off' : pendingCount(g) ? 'warn' : 'ok');
  }

  function refreshCurrent() {
    if (!state.user || !currentGid || !isHomeRoute()) return;
    syncGroup(currentGid).then(function () {
      if (currentGid && isHomeRoute()) renderHome(currentGid);
    }).catch(function () {
      if (currentGid && isHomeRoute()) renderHome(currentGid);
    });
  }

  function refreshGroups() {
    if (!state.user || !navigator.onLine) return;
    var before = JSON.stringify(state.groups || []);
    api({ action: 'login', phone: state.user.phone }).then(function (data) {
      state.user = data.user;
      state.groups = data.groups || [];
      LS.set('ts_user', state.user);
      LS.set('ts_groups', state.groups);
      if (!currentGid && JSON.stringify(state.groups) !== before) renderGroups();
    }).catch(function (err) {
      if (err.network) state.online = false;
    });
  }

  /* ---------- routing ---------- */

  function go(path) {
    var target = '#' + path;
    if (location.hash === target) route();
    else location.hash = target;
  }

  function isHomeRoute() {
    var parts = location.hash.replace(/^#/, '').split('/').filter(Boolean);
    return parts[0] === 'g' && !!parts[1] && parts.length === 2;
  }

  function route() {
    var raw = location.hash.replace(/^#/, '') || '/';
    var parts = raw.split('/').filter(Boolean);

    if (!state.user) {
      currentGid = null;
      return renderLogin();
    }

    if (parts[0] === 'g' && parts[1]) {
      currentGid = parts[1];
      if (parts[2] === 'add') return renderExpenseForm(parts[1], null);
      if (parts[2] === 'edit' && parts[3]) return renderExpenseForm(parts[1], parts[3]);
      if (parts[2] === 'e' && parts[3]) return renderExpenseDetail(parts[1], parts[3]);
      if (parts[2] === 'settle') return renderSettle(parts[1]);
      return enterGroup(parts[1]);
    }

    currentGid = null;
    renderGroups();
    refreshGroups();
  }

  /* ---------- screens ---------- */

  function renderLogin(message) {
    app.innerHTML =
      '<div class="auth">' +
        '<div class="logo">₹</div>' +
        '<h1>Trip Split</h1>' +
        '<p class="muted">Enter the mobile number your admin added.</p>' +
        '<form id="loginForm" class="stack">' +
          '<label class="muted small" for="phone">Mobile number</label>' +
          '<input id="phone" inputmode="numeric" autocomplete="tel" maxlength="10" placeholder="10-digit number" required>' +
          '<button class="primary" type="submit">Login</button>' +
          (message ? '<p class="err">' + esc(message) + '</p>' : '') +
        '</form>' +
        '<p class="muted small center">Admin? <a href="admin/">Open admin</a></p>' +
      '</div>';

    var form = $('#loginForm');
    form.onsubmit = function (event) {
      event.preventDefault();
      var phone = normPhone($('#phone').value);
      if (!/^\d{10}$/.test(phone)) return renderLogin('Enter a 10-digit mobile number.');

      var button = form.querySelector('button');
      button.disabled = true;
      button.textContent = 'Logging in…';

      api({ action: 'login', phone: phone }).then(function (data) {
        state.user = data.user;
        state.groups = data.groups || [];
        LS.set('ts_user', state.user);
        LS.set('ts_groups', state.groups);
        go('/');
      }).catch(function (err) {
        if (err.message === 'not_registered') {
          renderLogin('This number is not registered. Ask the admin to add you.');
        } else {
          renderLogin(err.message);
        }
      });
    };
  }

  function renderGroups(message) {
    var groups = state.groups || [];
    var rows = groups.map(function (g) {
      return '<button class="row" data-g="' + esc(g.groupId) + '">' +
        '<span class="avatar">' + esc(initials(g.name)) + '</span>' +
        '<span class="grow"><span class="row-title">' + esc(g.name) + '</span>' +
        '<span class="muted small">Code ' + esc(g.code) + '</span></span>' +
        '<span class="chev">›</span>' +
      '</button>';
    }).join('');

    app.innerHTML =
      '<header class="top">' +
        '<div class="grow"><div class="muted small">Signed in as</div>' +
        '<div class="title">' + esc(state.user.name) + '</div></div>' +
        '<button class="ghost" id="logout">Log out</button>' +
      '</header>' +
      '<main class="wrap">' +
        '<h2 class="page-title">Your groups</h2>' +
        (rows ? '<div class="list card tight">' + rows + '</div>' :
          '<div class="empty card">You are not in any group yet.<br>Use the code from your admin.</div>') +
        '<h3 class="mt">Join a group</h3>' +
        '<form id="joinForm" class="inline">' +
          '<input id="code" inputmode="numeric" maxlength="4" placeholder="4-digit code" required>' +
          '<button class="primary" type="submit">Join</button>' +
        '</form>' +
        (message ? '<p class="err">' + esc(message) + '</p>' : '') +
        '<p class="muted small center mt">Phone ' + esc(state.user.phone) + '</p>' +
      '</main>';

    $('#logout').onclick = logout;

    $$('[data-g]').forEach(function (el) {
      el.onclick = function () { go('/g/' + el.getAttribute('data-g')); };
    });

    var form = $('#joinForm');
    form.onsubmit = function (event) {
      event.preventDefault();
      var code = $('#code').value.replace(/\D/g, '');
      if (code.length !== 4) return renderGroups('Enter the 4-digit code.');

      var button = form.querySelector('button');
      button.disabled = true;
      button.textContent = 'Joining…';

      api({ action: 'joinGroup', phone: state.user.phone, code: code }).then(function (data) {
        ensureGroupCache(data.group);
        state.groups = state.groups.filter(function (g) { return g.groupId !== data.group.groupId; });
        state.groups.push(data.group);
        LS.set('ts_groups', state.groups);
        go('/g/' + data.group.groupId);
      }).catch(function (err) {
        renderGroups(err.message);
      });
    };
  }

  function enterGroup(gid) {
    currentGid = gid;
    var cached = loadGroupCache(gid);

    if (!cached) {
      app.innerHTML = '<main class="wrap center"><p class="muted">Loading group…</p></main>';
      syncGroup(gid).then(function () {
        if (currentGid === gid && isHomeRoute()) renderHome(gid);
      }).catch(function (err) {
        if (currentGid === gid) renderFatal(err.message, gid);
      });
      return;
    }

    renderHome(gid);

    if (Date.now() - (cached.lastSync || 0) > 8000) {
      syncGroup(gid).then(function () {
        if (currentGid === gid && isHomeRoute()) renderHome(gid);
      }).catch(function () {
        if (currentGid === gid && isHomeRoute()) renderHome(gid);
      });
    }
  }

  function renderHome(gid) {
    var g = loadGroupCache(gid);
    if (!g) return enterGroup(gid);

    var members = (g.members && g.members.length) ? g.members : [{ userId: state.user.userId, name: state.user.name }];
    function nameOf(id) {
      for (var i = 0; i < members.length; i++) if (members[i].userId === id) return members[i].name;
      return 'Someone';
    }
    function labelOf(id) {
      var found = null;
      for (var i = 0; i < members.length; i++) if (members[i].userId === id) found = members[i];
      return nameOf(id) + (found && Number(found.active) === 0 ? ' (removed)' : '');
    }

    var net = computeBalances(g.expenses, g.settlements);
    var my = net.get(state.user.userId) || 0;
    var activeCount = members.filter(function (m) { return Number(m.active) !== 0; }).length;
    var live = g.expenses.filter(function (e) { return !Number(e.deleted); });
    var total = live.reduce(function (sum, e) { return sum + (Number(e.amountPaise) || 0); }, 0);
    var list = live.slice().sort(function (a, b) {
      return String(b.date || '').localeCompare(String(a.date || '')) ||
        (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
    });
    var settle = suggestions(net);

    var settleBlock = settle.length ?
      '<section class="card">' +
        '<div class="card-head"><h3>Settle up</h3><button class="link" id="settleBtn">Record payment</button></div>' +
        settle.map(function (s) {
          return '<div class="line"><span>' + esc(labelOf(s.from)) + ' pays ' + esc(labelOf(s.to)) + '</span>' +
            '<strong>' + money(s.amt) + '</strong></div>';
        }).join('') +
      '</section>' :
      '<section class="card">' +
        '<div class="line"><span class="muted">Everyone is settled up.</span>' +
        '<button class="link" id="settleBtn">Record payment</button></div>' +
      '</section>';

    var memberRows = members.map(function (m) {
      var value = net.get(m.userId) || 0;
      var cls = value > 0 ? 'pos' : value < 0 ? 'neg' : 'muted';
      var label = value === 0 ? '—' : value > 0 ? '+' + money(value) : '−' + money(-value);
      return '<div class="line"><span>' + esc(m.name) +
        (Number(m.active) === 0 ? ' <span class="tag">removed</span>' : '') +
        (m.userId === state.user.userId ? ' <span class="tag">you</span>' : '') +
        '</span><span class="' + cls + '">' + label + '</span></div>';
    }).join('');

    var expenseRows = list.map(function (e) {
      var mine = (e.shares || []).filter(function (s) { return s.userId === state.user.userId; })[0];
      var share = mine ? mine.amountPaise : 0;
      return '<button class="row" data-e="' + esc(e.id) + '">' +
        '<span class="avatar">' + esc(initials(e.note || 'E')) + '</span>' +
        '<span class="grow"><span class="row-title">' + esc(e.note || 'Expense') + '</span>' +
        '<span class="muted small">' + esc(nameOf(e.paidBy)) + ' paid ' + money(e.amountPaise) +
        ' · ' + esc(e.date || '') + '</span></span>' +
        '<span class="row-amt">' + (share ? money(share) : '') + '</span>' +
      '</button>';
    }).join('');

    app.innerHTML =
      '<header class="top">' +
        '<button class="icon-btn" id="backBtn" aria-label="Back">‹</button>' +
        '<div class="grow"><div class="title">' + esc(g.group.name || 'Group') + '</div>' +
        '<div class="muted small">Code <strong>' + esc(g.group.code || '') + '</strong></div></div>' +
        '<button id="syncPill" class="pill ' + (!state.online ? 'off' : pendingCount(g) ? 'warn' : 'ok') + '">' +
          syncLabel(g) + '</button>' +
      '</header>' +
      '<main class="wrap">' +
        '<section class="card hero">' +
          '<div class="muted small">Your balance</div>' +
          '<div class="hero-amt ' + (my > 0 ? 'pos' : my < 0 ? 'neg' : '') + '">' +
            (my === 0 ? 'Settled up' : my > 0 ? 'You are owed ' + money(my) : 'You owe ' + money(-my)) +
          '</div>' +
          '<div class="muted small">Total spent ' + money(total) + ' · ' + activeCount + ' members</div>' +
        '</section>' +
        settleBlock +
        '<section class="card"><h3>Members</h3>' + memberRows + '</section>' +
        '<section>' +
          '<div class="card-head"><h3>Expenses</h3><span class="muted small">' + list.length + '</span></div>' +
          (expenseRows ? '<div class="list card tight">' + expenseRows + '</div>' :
            '<div class="empty card">No expenses yet.<br>Tap <strong>+</strong> to add the first one.</div>') +
        '</section>' +
        '<div class="pad-bottom"></div>' +
      '</main>' +
      '<button class="fab" id="addBtn" aria-label="Add expense">+</button>';

    $('#backBtn').onclick = function () { go('/'); };
    $('#addBtn').onclick = function () { go('/g/' + gid + '/add'); };
    $('#settleBtn').onclick = function () { go('/g/' + gid + '/settle'); };
    $('#syncPill').onclick = function () {
      syncGroup(gid).then(function () { renderHome(gid); }).catch(function (err) { toast(err.message); });
    };
    $$('[data-e]').forEach(function (el) {
      el.onclick = function () { go('/g/' + gid + '/e/' + el.getAttribute('data-e')); };
    });
  }

  function renderFatal(message, gid) {
    app.innerHTML =
      '<main class="wrap center">' +
        '<div class="card">' +
          '<h2>Could not load this group</h2>' +
          '<p class="err">' + esc(message) + '</p>' +
          '<div class="actions">' +
            '<button class="secondary" id="back">Back</button>' +
            '<button class="primary" id="retry">Retry</button>' +
          '</div>' +
        '</div>' +
      '</main>';
    $('#back').onclick = function () { go('/'); };
    $('#retry').onclick = function () { enterGroup(gid); };
  }

  function renderExpenseForm(gid, editId) {
    var g = loadGroupCache(gid);
    if (!g) return go('/g/' + gid);

    var existing = editId ? g.expenses.filter(function (e) { return e.id === editId; })[0] : null;
    var members = (g.members || []).filter(function (m) {
      if (!existing) return Number(m.active) !== 0;
      if (Number(m.active) !== 0) return true;
      if (existing.paidBy === m.userId) return true;
      return existing.shares.some(function (s) { return s.userId === m.userId; });
    });
    if (!members.length) return go('/g/' + gid);
    var me = state.user.userId;

    var draft = {
      mode: existing && !isEqualSplit(existing.amountPaise, existing.shares) ? 'exact' : 'equal',
      selected: new Set(existing ? existing.shares.map(function (s) { return s.userId; }) : members.map(function (m) { return m.userId; })),
      exact: new Map(existing ? existing.shares.map(function (s) { return [s.userId, (s.amountPaise / 100).toFixed(2)]; }) : [])
    };

    app.innerHTML =
      '<header class="top">' +
        '<button class="icon-btn" id="cancel" aria-label="Cancel">‹</button>' +
        '<div class="grow"><div class="title">' + (existing ? 'Edit expense' : 'Add expense') + '</div>' +
        '<div class="muted small">' + esc(g.group.name) + '</div></div>' +
        '<button class="primary sm" id="save">Save</button>' +
      '</header>' +
      '<main class="wrap">' +
        '<section class="card">' +
          '<label class="muted small" for="amount">Amount</label>' +
          '<div class="amount-row"><span class="rupee">₹</span>' +
            '<input id="amount" class="amount-input" inputmode="decimal" placeholder="0.00" value="' +
              (existing ? esc((existing.amountPaise / 100).toFixed(2)) : '') + '"></div>' +
          '<label class="muted small" for="note">What was it for?</label>' +
          '<input id="note" placeholder="Dinner, cab, hotel…" maxlength="120" value="' + esc(existing ? existing.note : '') + '">' +
          '<div class="two">' +
            '<div><label class="muted small" for="paidBy">Paid by</label>' +
              '<select id="paidBy">' + members.map(function (m) {
                var sel = (existing ? existing.paidBy : me) === m.userId ? ' selected' : '';
                return '<option value="' + esc(m.userId) + '"' + sel + '>' + esc(m.name) +
                  (m.userId === me ? ' (you)' : '') + '</option>';
              }).join('') + '</select></div>' +
            '<div><label class="muted small" for="date">Date</label>' +
              '<input id="date" type="date" value="' + esc(existing ? existing.date : today()) + '"></div>' +
          '</div>' +
        '</section>' +
        '<section class="card">' +
          '<div class="card-head"><h3>Split</h3>' +
            '<div class="seg">' +
              '<button class="seg-btn' + (draft.mode === 'equal' ? ' active' : '') + '" data-mode="equal">Equally</button>' +
              '<button class="seg-btn' + (draft.mode === 'exact' ? ' active' : '') + '" data-mode="exact">Exact</button>' +
            '</div>' +
          '</div>' +
          '<div id="splitBox"></div>' +
          '<div id="splitHint" class="muted small"></div>' +
        '</section>' +
        '<p id="formErr" class="err"></p>' +
      '</main>';

    function updateRemain() {
      var hint = $('#splitHint');
      if (!hint) return;
      var total = toPaise($('#amount').value) || 0;
      var sum = 0;
      $$('[data-exact]').forEach(function (input) {
        if (!input.disabled) sum += (toPaise(input.value) || 0);
      });
      var diff = total - sum;
      hint.innerHTML = 'Total ' + money(total) + ' · assigned ' + money(sum) + ' · ' +
        '<strong class="' + (diff === 0 ? 'pos' : 'neg') + '">' +
        (diff === 0 ? 'balanced' : money(Math.abs(diff)) + (diff > 0 ? ' left' : ' over')) +
        '</strong>';
    }

    function drawSplit() {
      var box = $('#splitBox');
      var hint = $('#splitHint');
      var amountPaise = toPaise($('#amount').value) || 0;
      var selectedIds = members.map(function (m) { return m.userId; })
        .filter(function (id) { return draft.selected.has(id); });

      if (draft.mode === 'equal') {
        var shares = equalShares(amountPaise, selectedIds);
        var byId = new Map(shares.map(function (s) { return [s.userId, s.amountPaise]; }));
        box.innerHTML = members.map(function (m) {
          var on = draft.selected.has(m.userId);
          return '<label class="member-row">' +
            '<input type="checkbox" data-pick="' + esc(m.userId) + '"' + (on ? ' checked' : '') + '>' +
            '<span class="avatar sm">' + esc(initials(m.name)) + '</span>' +
            '<span class="grow">' + esc(m.name) + '</span>' +
            '<span class="muted">' + (on ? money(byId.get(m.userId) || 0) : '—') + '</span>' +
          '</label>';
        }).join('');
        hint.textContent = amountPaise ?
          'Split between ' + selectedIds.length + (selectedIds.length === 1 ? ' person.' : ' people.') : '';
      } else {
        box.innerHTML = members.map(function (m) {
          var on = draft.selected.has(m.userId);
          var value = draft.exact.get(m.userId) || '';
          return '<label class="member-row">' +
            '<input type="checkbox" data-pick="' + esc(m.userId) + '"' + (on ? ' checked' : '') + '>' +
            '<span class="avatar sm">' + esc(initials(m.name)) + '</span>' +
            '<span class="grow">' + esc(m.name) + '</span>' +
            '<input class="exact-input" data-exact="' + esc(m.userId) + '" inputmode="decimal" ' +
              'value="' + (on ? esc(value) : '') + '"' + (on ? '' : ' disabled') + ' placeholder="0.00">' +
          '</label>';
        }).join('');
        updateRemain();
      }

      $$('[data-pick]', box).forEach(function (checkbox) {
        checkbox.onchange = function () {
          var id = checkbox.getAttribute('data-pick');
          if (checkbox.checked) draft.selected.add(id);
          else draft.selected.delete(id);
          if (draft.mode === 'exact' && checkbox.checked && !draft.exact.has(id)) draft.exact.set(id, '');
          drawSplit();
        };
      });

      $$('[data-exact]', box).forEach(function (input) {
        input.oninput = function () {
          draft.exact.set(input.getAttribute('data-exact'), input.value);
          updateRemain();
        };
      });
    }

    $('#cancel').onclick = function () { go('/g/' + gid); };

    $('#amount').oninput = function () {
      if (draft.mode === 'equal') drawSplit();
      else updateRemain();
    };

    $$('.seg-btn').forEach(function (button) {
      button.onclick = function () {
        var next = button.getAttribute('data-mode');
        if (next === draft.mode) return;
        draft.mode = next;
        $$('.seg-btn').forEach(function (b) { b.classList.toggle('active', b === button); });
        if (draft.mode === 'exact') {
          var total = toPaise($('#amount').value) || 0;
          var ids = members.map(function (m) { return m.userId; })
            .filter(function (id) { return draft.selected.has(id); });
          draft.exact = new Map();
          equalShares(total, ids).forEach(function (s) {
            draft.exact.set(s.userId, (s.amountPaise / 100).toFixed(2));
          });
        }
        drawSplit();
      };
    });

    $('#save').onclick = function () {
      var errorBox = $('#formErr');
      errorBox.textContent = '';

      var amountPaise = toPaise($('#amount').value);
      if (!amountPaise || amountPaise <= 0) { errorBox.textContent = 'Enter an amount greater than zero.'; return; }

      var note = $('#note').value.trim() || 'Expense';
      var paidBy = $('#paidBy').value;
      var date = $('#date').value || today();
      var ids = members.map(function (m) { return m.userId; })
        .filter(function (id) { return draft.selected.has(id); });

      if (!ids.length) { errorBox.textContent = 'Pick at least one person.'; return; }

      var shares;
      if (draft.mode === 'equal') {
        shares = equalShares(amountPaise, ids);
      } else {
        shares = ids.map(function (id) {
          return { userId: id, amountPaise: toPaise(draft.exact.get(id) || '0') || 0 };
        });
        var sum = shares.reduce(function (total, s) { return total + s.amountPaise; }, 0);
        if (sum !== amountPaise) {
          errorBox.textContent = 'Exact amounts add up to ' + money(sum) + ', not ' + money(amountPaise) + '.';
          return;
        }
      }

      var now = Math.max(Date.now(), existing ? (Number(existing.updatedAt) || 0) + 1 : 0);
      var row;
      if (existing) {
        row = Object.assign({}, existing, {
          amountPaise: amountPaise,
          note: note,
          paidBy: paidBy,
          shares: shares,
          date: date,
          updatedAt: now,
          updatedBy: me,
          deleted: 0
        });
      } else {
        row = {
          id: uid(),
          groupId: gid,
          amountPaise: amountPaise,
          note: note,
          paidBy: paidBy,
          shares: shares,
          date: date,
          createdAt: now,
          updatedAt: now,
          updatedBy: me,
          deleted: 0
        };
      }

      g.expenses = mergeRows(g.expenses, [row]);
      g.dirty.expenses[row.id] = row;
      saveGroupCache(g);
      go('/g/' + gid);
      syncGroup(gid).then(function () {
        if (currentGid === gid && isHomeRoute()) renderHome(gid);
      }).catch(function (err) { toast(err.message); });
    };

    drawSplit();
  }

  function renderExpenseDetail(gid, expenseId) {
    var g = loadGroupCache(gid);
    if (!g) return go('/g/' + gid);

    var expense = g.expenses.filter(function (e) { return e.id === expenseId; })[0];
    if (!expense || Number(expense.deleted)) return go('/g/' + gid);

    var members = g.members || [];
    function nameOf(id) {
      for (var i = 0; i < members.length; i++) if (members[i].userId === id) return members[i].name;
      return 'Someone';
    }

    var mine = (expense.shares || []).filter(function (s) { return s.userId === state.user.userId; })[0];

    app.innerHTML =
      '<header class="top">' +
        '<button class="icon-btn" id="back" aria-label="Back">‹</button>' +
        '<div class="grow"><div class="title">' + esc(expense.note || 'Expense') + '</div>' +
        '<div class="muted small">' + esc(expense.date) + '</div></div>' +
        '<span class="icon-btn spacer"></span>' +
      '</header>' +
      '<main class="wrap">' +
        '<section class="card hero">' +
          '<div class="hero-amt">' + money(expense.amountPaise) + '</div>' +
          '<div class="muted small">' + esc(nameOf(expense.paidBy)) + ' paid</div>' +
        '</section>' +
        '<section class="card"><h3>Split</h3>' +
          (expense.shares || []).map(function (s) {
            return '<div class="line"><span>' + esc(nameOf(s.userId)) +
              (s.userId === state.user.userId ? ' <span class="tag">you</span>' : '') +
              '</span><strong>' + money(s.amountPaise) + '</strong></div>';
          }).join('') +
        '</section>' +
        '<section class="card">' +
          '<div class="line"><span class="muted small">Added</span><span>' +
            new Date(expense.createdAt).toLocaleString('en-IN') + '</span></div>' +
          (Number(expense.updatedAt) !== Number(expense.createdAt) ?
            '<div class="line"><span class="muted small">Last edited</span><span>' +
              esc(nameOf(expense.updatedBy)) + ' · ' +
              new Date(expense.updatedAt).toLocaleString('en-IN') + '</span></div>' : '') +
          (mine ? '<div class="line"><span class="muted small">Your share</span><strong>' +
            money(mine.amountPaise) + '</strong></div>' : '') +
        '</section>' +
        '<div class="actions">' +
          '<button class="secondary" id="edit">Edit</button>' +
          '<button class="danger" id="del">Delete</button>' +
        '</div>' +
      '</main>';

    $('#back').onclick = function () { go('/g/' + gid); };

    $('#edit').onclick = function () { go('/g/' + gid + '/edit/' + expense.id); };

    $('#del').onclick = function () {
      if (!confirm('Delete this expense for everyone?')) return;
      var now = Math.max(Date.now(), (Number(expense.updatedAt) || 0) + 1);
      var row = Object.assign({}, expense, {
        deleted: 1,
        updatedAt: now,
        updatedBy: state.user.userId
      });
      g.expenses = mergeRows(g.expenses, [row]);
      g.dirty.expenses[row.id] = row;
      saveGroupCache(g);
      go('/g/' + gid);
      syncGroup(gid).then(function () {
        if (currentGid === gid && isHomeRoute()) renderHome(gid);
      }).catch(function (err) { toast(err.message); });
    };
  }

  function renderSettle(gid) {
    var g = loadGroupCache(gid);
    if (!g) return go('/g/' + gid);

    var members = g.members || [];
    if (members.length < 2) {
      app.innerHTML = '<main class="wrap center"><div class="card"><p class="muted">You need at least two people.</p>' +
        '<button class="secondary" id="back">Back</button></div></main>';
      $('#back').onclick = function () { go('/g/' + gid); };
      return;
    }

    var me = state.user.userId;
    var net = computeBalances(g.expenses, g.settlements);
    var mine = suggestions(net).filter(function (s) {
      return s.from === me || s.to === me;
    })[0];

    function labelFor(member) {
      return esc(member.name) + (Number(member.active) === 0 ? ' (removed)' : '') +
        (member.userId === me ? ' (you)' : '');
    }

    var defaultFrom = mine ? mine.from : me;
    var defaultTo = mine ? mine.to : members.filter(function (m) { return m.userId !== me; })[0].userId;
    var defaultAmount = mine ? (mine.amt / 100).toFixed(2) : '';

    app.innerHTML =
      '<header class="top">' +
        '<button class="icon-btn" id="cancel" aria-label="Cancel">‹</button>' +
        '<div class="grow"><div class="title">Record payment</div>' +
        '<div class="muted small">' + esc(g.group.name) + '</div></div>' +
        '<button class="primary sm" id="save">Save</button>' +
      '</header>' +
      '<main class="wrap">' +
        '<section class="card">' +
          '<label class="muted small" for="from">From</label>' +
          '<select id="from">' + members.map(function (m) {
            return '<option value="' + esc(m.userId) + '"' +
              (m.userId === defaultFrom ? ' selected' : '') + '>' + labelFor(m) + '</option>';
          }).join('') + '</select>' +
          '<label class="muted small" for="to">To</label>' +
          '<select id="to">' + members.map(function (m) {
            return '<option value="' + esc(m.userId) + '"' +
              (m.userId === defaultTo ? ' selected' : '') + '>' + labelFor(m) + '</option>';
          }).join('') + '</select>' +
          '<label class="muted small" for="amount">Amount</label>' +
          '<div class="amount-row"><span class="rupee">₹</span>' +
            '<input id="amount" class="amount-input" inputmode="decimal" placeholder="0.00" value="' +
              esc(defaultAmount) + '"></div>' +
          '<label class="muted small" for="date">Date</label>' +
          '<input id="date" type="date" value="' + today() + '">' +
        '</section>' +
        '<p id="formErr" class="err"></p>' +
      '</main>';

    $('#cancel').onclick = function () { go('/g/' + gid); };

    $('#save').onclick = function () {
      var errorBox = $('#formErr');
      errorBox.textContent = '';

      var fromUser = $('#from').value;
      var toUser = $('#to').value;
      var amountPaise = toPaise($('#amount').value);
      var date = $('#date').value || today();

      if (fromUser === toUser) { errorBox.textContent = 'Pick two different people.'; return; }
      if (!amountPaise || amountPaise <= 0) { errorBox.textContent = 'Enter an amount greater than zero.'; return; }

      var now = Date.now();
      var row = {
        id: uid(),
        groupId: gid,
        fromUser: fromUser,
        toUser: toUser,
        amountPaise: amountPaise,
        date: date,
        createdAt: now,
        updatedAt: now,
        updatedBy: state.user.userId,
        deleted: 0
      };

      g.settlements = mergeRows(g.settlements, [row]);
      g.dirty.settlements[row.id] = row;
      saveGroupCache(g);
      go('/g/' + gid);
      syncGroup(gid).then(function () {
        if (currentGid === gid && isHomeRoute()) renderHome(gid);
      }).catch(function (err) { toast(err.message); });
    };
  }

  /* ---------- misc ---------- */

  function logout() {
    Object.keys(localStorage).forEach(function (key) {
      if (key.indexOf('ts_') === 0 && key !== 'ts_admin') localStorage.removeItem(key);
    });
    state.user = null;
    state.groups = [];
    currentGid = null;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    renderLogin();
  }

  var toastTimer = null;
  function toast(message) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  /* ---------- boot ---------- */

  window.addEventListener('hashchange', route);
  window.addEventListener('online', function () {
    state.online = true;
    refreshCurrent();
  });
  window.addEventListener('offline', function () {
    state.online = false;
    updateSyncPill();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      if (currentGid && isHomeRoute()) refreshCurrent();
      else if (!currentGid) refreshGroups();
    }
  });

  setInterval(function () {
    if (document.visibilityState === 'visible' && state.user && currentGid && isHomeRoute()) {
      refreshCurrent();
    }
  }, 15000);

  route();
})();
