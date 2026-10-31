/* Trip Split — admin page. */
(function () {
  'use strict';

  var Logic = window.Logic;
  var esc = Logic.esc;
  var normPhone = Logic.normPhone;
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
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
    del: function (key) {
      try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    }
  };

  var state = {
    session: LS.get('ts_admin', null),
    users: [],
    groups: [],
    members: [],
    editUser: null,
    message: ''
  };

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
        var offline = new Error('Could not reach the server. Check your connection.');
        offline.network = true;
        throw offline;
      }
      throw err;
    });
  }

  function auth() {
    return { phone: state.session.phone, secret: state.session.secret };
  }

  function toast(message) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied'); })
        .catch(function () { window.prompt('Copy this', text); });
    } else {
      window.prompt('Copy this', text);
    }
  }

  /* ---------- boot ---------- */

  function boot() {
    app.innerHTML = '<main class="wrap center"><p class="muted">Loading…</p></main>';
    api({ action: 'adminStatus' }).then(function (status) {
      if (!status.hasAdmin) return renderSetup();
      if (!state.session) return renderLogin();
      return loadData();
    }).catch(function (err) {
      renderRetry(err.message);
    });
  }

  function loadData() {
    if (!state.session) return renderLogin();
    api(Object.assign({ action: 'adminData' }, auth())).then(function (data) {
      state.users = data.users || [];
      state.groups = data.groups || [];
      state.members = data.members || [];
      renderPanel();
    }).catch(function (err) {
      if (err.network) return renderRetry(err.message);
      state.session = null;
      LS.del('ts_admin');
      renderLogin(err.message);
    });
  }

  /* ---------- auth screens ---------- */

  function renderSetup(message) {
    app.innerHTML =
      '<main class="wrap">' +
        '<div class="admin-head"><div class="logo">₹</div>' +
          '<div><h1>Set up admin</h1><p class="muted small">One-time setup. Create your admin login.</p></div></div>' +
        '<form id="setupForm" class="card stack">' +
          '<label class="muted small" for="sName">Your name</label>' +
          '<input id="sName" placeholder="Your name" maxlength="40" required>' +
          '<label class="muted small" for="sPhone">Your mobile number</label>' +
          '<input id="sPhone" inputmode="numeric" maxlength="10" placeholder="10-digit number" required>' +
          '<button class="primary" type="submit">Create admin</button>' +
          (message ? '<p class="err">' + esc(message) + '</p>' : '') +
        '</form>' +
        '<p class="muted small center">This also creates your member profile, so you can add expenses from the main app.</p>' +
        '<p class="muted small center"><a href="../">Back to app</a></p>' +
      '</main>';

    $('#setupForm').onsubmit = function (event) {
      event.preventDefault();
      var name = $('#sName').value.trim();
      var phone = normPhone($('#sPhone').value);
      if (!name) return renderSetup('Enter your name.');
      if (!/^\d{10}$/.test(phone)) return renderSetup('Enter a 10-digit mobile number.');

      var button = event.target.querySelector('button');
      button.disabled = true;
      button.textContent = 'Creating…';

      api({ action: 'adminSetup', phone: phone, name: name }).then(function (data) {
        state.session = { phone: data.admin.phone, secret: data.secret, name: data.admin.name };
        LS.set('ts_admin', state.session);
        renderSecret(data.secret);
      }).catch(function (err) {
        renderSetup(err.message);
      });
    };
  }

  function renderSecret(secret) {
    app.innerHTML =
      '<main class="wrap">' +
        '<div class="admin-head"><div class="logo">₹</div>' +
          '<div><h1>Save this secret</h1><p class="muted small">You need it to log in to admin next time.</p></div></div>' +
        '<div class="card">' +
          '<div class="secret">' + esc(secret) + '</div>' +
          '<div class="copy-row">' +
            '<button class="secondary" id="copySecret">Copy secret</button>' +
            '<button class="primary" id="continue">I saved it</button>' +
          '</div>' +
          '<p class="muted small mt">This is shown once. If you lose it, run <code>resetAdmin()</code> in Apps Script.</p>' +
        '</div>' +
      '</main>';

    $('#copySecret').onclick = function () { copyText(secret); };
    $('#continue').onclick = function () { loadData(); };
  }

  function renderLogin(message) {
    app.innerHTML =
      '<main class="wrap">' +
        '<div class="admin-head"><div class="logo">₹</div>' +
          '<div><h1>Admin login</h1><p class="muted small">Phone + 4-digit secret.</p></div></div>' +
        '<form id="loginForm" class="card stack">' +
          '<label class="muted small" for="lPhone">Mobile number</label>' +
          '<input id="lPhone" inputmode="numeric" maxlength="10" placeholder="10-digit number" required>' +
          '<label class="muted small" for="lSecret">Secret</label>' +
          '<input id="lSecret" inputmode="numeric" maxlength="4" placeholder="4-digit secret" required>' +
          '<button class="primary" type="submit">Log in</button>' +
          (message ? '<p class="err">' + esc(message) + '</p>' : '') +
        '</form>' +
        '<p class="muted small center"><a href="../">Back to app</a></p>' +
      '</main>';

    $('#loginForm').onsubmit = function (event) {
      event.preventDefault();
      var phone = normPhone($('#lPhone').value);
      var secret = $('#lSecret').value.trim();
      if (!/^\d{10}$/.test(phone)) return renderLogin('Enter a 10-digit mobile number.');
      if (!/^\d{4}$/.test(secret)) return renderLogin('Enter the 4-digit secret.');

      var button = event.target.querySelector('button');
      button.disabled = true;
      button.textContent = 'Checking…';

      api({ action: 'adminLogin', phone: phone, secret: secret }).then(function (data) {
        state.session = { phone: data.admin.phone, secret: secret, name: data.admin.name };
        LS.set('ts_admin', state.session);
        loadData();
      }).catch(function (err) {
        renderLogin(err.message);
      });
    };
  }

  function renderRetry(message) {
    app.innerHTML =
      '<main class="wrap center">' +
        '<div class="card">' +
          '<h2>Could not reach the server</h2>' +
          '<p class="err">' + esc(message) + '</p>' +
          '<div class="actions">' +
            '<button class="secondary" id="back">Back to app</button>' +
            '<button class="primary" id="retry">Retry</button>' +
          '</div>' +
        '</div>' +
      '</main>';
    $('#back').onclick = function () { location.href = '../'; };
    $('#retry').onclick = function () { boot(); };
  }

  /* ---------- panel ---------- */

  function renderPanel() {
    var users = state.users;
    var groups = state.groups;
    var members = state.members;
    var edit = state.editUser;

    var userRows = users.map(function (user) {
      return '<div class="row static">' +
        '<span class="avatar sm">' + esc(initials(user.name)) + '</span>' +
        '<span class="grow"><strong>' + esc(user.name) + '</strong>' +
          '<span class="muted small">' + esc(user.phone) + (user.active ? '' : ' · inactive') + '</span></span>' +
        '<button class="link" data-edit="' + esc(user.userId) + '">Edit</button>' +
        (user.active
          ? '<button class="link danger-text" data-off="' + esc(user.userId) + '">Off</button>'
          : '<button class="link" data-on="' + esc(user.userId) + '">On</button>') +
      '</div>';
    }).join('');

    var groupBlocks = groups.map(function (group) {
      var groupMembers = members.filter(function (m) { return m.groupId === group.groupId; });
      var chips = groupMembers.map(function (member) {
        var user = users.filter(function (u) { return u.userId === member.userId; })[0];
        var label = user ? user.name : 'Unknown';
        if (!member.active) label += ' (removed)';
        return '<span class="chip">' + esc(label) +
          (member.active ? '<button data-rm="' + esc(group.groupId) + '|' + esc(member.userId) +
            '" aria-label="Remove ' + esc(label) + '">×</button>' : '') +
          '</span>';
      }).join('');

      return '<div class="group-block">' +
        '<div class="card-head"><strong>' + esc(group.name) + '</strong>' +
          '<button class="code-badge" data-copy="' + esc(group.code) + '">' + esc(group.code) + '</button></div>' +
        '<div class="muted small">' + groupMembers.filter(function (m) { return m.active; }).length + ' active member(s)</div>' +
        '<div class="chips">' + (chips || '<span class="muted small">No members yet.</span>') + '</div>' +
        '<form class="inline add-member" data-g="' + esc(group.groupId) + '">' +
          '<input inputmode="numeric" maxlength="10" placeholder="Add member by phone">' +
          '<button class="secondary sm" type="submit">Add</button>' +
        '</form>' +
      '</div>';
    }).join('');

    app.innerHTML =
      '<main class="wrap">' +
        '<div class="admin-head">' +
          '<div class="grow"><h1>Admin</h1>' +
            '<p class="muted small">' + esc(state.session.name) + ' · ' + esc(state.session.phone) + '</p></div>' +
          '<button class="ghost" id="logout">Log out</button>' +
        '</div>' +
        (state.message ? '<div class="banner">' + esc(state.message) + '</div>' : '') +
        '<p id="adminErr" class="err"></p>' +

        '<section class="card">' +
          '<div class="card-head"><h3>People</h3><span class="muted small">' + users.length + '</span></div>' +
          '<form id="userForm" class="stack">' +
            '<div class="two">' +
              '<div><label class="muted small" for="uName">Name</label>' +
                '<input id="uName" placeholder="Name" maxlength="40" value="' + esc(edit ? edit.name : '') + '" required></div>' +
              '<div><label class="muted small" for="uPhone">Mobile</label>' +
                '<input id="uPhone" inputmode="numeric" maxlength="10" placeholder="10 digits" value="' +
                  esc(edit ? edit.phone : '') + '" required></div>' +
            '</div>' +
            '<button class="primary" type="submit">' + (edit ? 'Save changes' : 'Add person') + '</button>' +
            (edit ? '<button type="button" class="link" id="cancelEdit">Cancel edit</button>' : '') +
          '</form>' +
          '<div class="list mt">' + (userRows || '<p class="muted small">No people yet.</p>') + '</div>' +
        '</section>' +

        '<section class="card">' +
          '<div class="card-head"><h3>Groups</h3><span class="muted small">' + groups.length + '</span></div>' +
          '<form id="groupForm" class="inline">' +
            '<input id="gName" placeholder="Group name, e.g. Goa 2026" maxlength="40" required>' +
            '<button class="primary" type="submit">Create</button>' +
          '</form>' +
          '<div class="mt">' + (groupBlocks || '<p class="muted small">No groups yet.</p>') + '</div>' +
        '</section>' +

        '<p class="muted small center">Share the main app link and the 4-digit group code with your people.</p>' +
        '<p class="muted small center"><a href="../">Open member app</a></p>' +
      '</main>';

    wirePanel();
  }

  function wirePanel() {
    $('#logout').onclick = function () {
      state.session = null;
      LS.del('ts_admin');
      renderLogin('');
    };

    $('#userForm').onsubmit = function (event) {
      event.preventDefault();
      var name = $('#uName').value.trim();
      var phone = normPhone($('#uPhone').value);
      if (!name) return showError('Enter a name.');
      if (!/^\d{10}$/.test(phone)) return showError('Enter a 10-digit mobile number.');

      var payload = state.editUser ?
        Object.assign({ action: 'adminEditUser', userId: state.editUser.userId, name: name, newPhone: phone }, auth()) :
        Object.assign({ action: 'adminAddUser', name: name, newPhone: phone }, auth());

      var button = event.target.querySelector('.primary');
      button.disabled = true;

      api(payload).then(function () {
        state.editUser = null;
        state.message = 'Saved.';
        loadData();
      }).catch(function (err) {
        button.disabled = false;
        showError(err.message);
      });
    };

    var cancelEdit = $('#cancelEdit');
    if (cancelEdit) {
      cancelEdit.onclick = function () {
        state.editUser = null;
        renderPanel();
      };
    }

    $$('[data-edit]').forEach(function (button) {
      button.onclick = function () {
        var user = state.users.filter(function (u) { return u.userId === button.getAttribute('data-edit'); })[0];
        state.editUser = user;
        renderPanel();
        var input = $('#uName');
        if (input) input.focus();
      };
    });

    $$('[data-off]').forEach(function (button) {
      button.onclick = function () {
        var user = state.users.filter(function (u) { return u.userId === button.getAttribute('data-off'); })[0];
        if (!user) return;
        if (!confirm('Deactivate ' + user.name + '? They will not be able to log in.')) return;
        api(Object.assign({ action: 'adminDeactivateUser', userId: user.userId }, auth())).then(function () {
          state.message = user.name + ' deactivated.';
          loadData();
        }).catch(function (err) { showError(err.message); });
      };
    });

    $$('[data-on]').forEach(function (button) {
      button.onclick = function () {
        api(Object.assign({ action: 'adminActivateUser', userId: button.getAttribute('data-on') }, auth())).then(function () {
          state.message = 'Person reactivated.';
          loadData();
        }).catch(function (err) { showError(err.message); });
      };
    });

    $('#groupForm').onsubmit = function (event) {
      event.preventDefault();
      var name = $('#gName').value.trim();
      if (!name) return showError('Enter a group name.');

      var button = event.target.querySelector('.primary');
      button.disabled = true;

      api(Object.assign({ action: 'adminCreateGroup', name: name }, auth())).then(function (data) {
        state.message = 'Group created. Code: ' + data.group.code;
        loadData();
      }).catch(function (err) {
        button.disabled = false;
        showError(err.message);
      });
    };

    $$('.add-member').forEach(function (form) {
      form.onsubmit = function (event) {
        event.preventDefault();
        var input = form.querySelector('input');
        var phone = normPhone(input.value);
        if (!/^\d{10}$/.test(phone)) return showError('Enter a 10-digit mobile number.');

        var button = form.querySelector('button');
        button.disabled = true;

        api(Object.assign({
          action: 'adminAddMember',
          groupId: form.getAttribute('data-g'),
          userPhone: phone
        }, auth())).then(function () {
          state.message = 'Member added.';
          loadData();
        }).catch(function (err) {
          button.disabled = false;
          showError(err.message);
        });
      };
    });

    $$('[data-rm]').forEach(function (button) {
      button.onclick = function () {
        var parts = button.getAttribute('data-rm').split('|');
        if (!confirm('Remove this member from the group? Their past expenses stay.')) return;
        api(Object.assign({
          action: 'adminRemoveMember',
          groupId: parts[0],
          userId: parts[1]
        }, auth())).then(function () {
          state.message = 'Member removed.';
          loadData();
        }).catch(function (err) { showError(err.message); });
      };
    });

    $$('[data-copy]').forEach(function (button) {
      button.onclick = function () { copyText(button.getAttribute('data-copy')); };
    });
  }

  function showError(message) {
    var el = $('#adminErr');
    if (el) el.textContent = message;
    else toast(message);
  }

  boot();
})();
