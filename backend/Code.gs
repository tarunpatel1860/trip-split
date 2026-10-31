/**
 * Trip Split — Google Apps Script backend.
 *
 * Deploy as a Web App:
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * All requests are POSTs with a text/plain JSON body (avoids CORS preflight).
 */

var TABS = {
  admins: ['adminId', 'phone', 'name', 'secretHash', 'salt', 'failed', 'lockedUntil', 'createdAt'],
  users: ['userId', 'phone', 'name', 'active', 'createdAt'],
  groups: ['groupId', 'code', 'name', 'createdBy', 'createdAt'],
  members: ['groupId', 'userId', 'addedBy', 'addedAt', 'active'],
  expenses: ['id', 'groupId', 'amountPaise', 'note', 'paidBy', 'sharesJSON', 'date', 'createdAt', 'updatedAt', 'updatedBy', 'deleted'],
  settlements: ['id', 'groupId', 'fromUser', 'toUser', 'amountPaise', 'date', 'createdAt', 'updatedAt', 'updatedBy', 'deleted']
};

/* ---------- setup ---------- */

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABS).forEach(function (name) {
    var headers = TABS[name];
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  });

  var first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0) ss.deleteSheet(first);
  Logger.log('Setup complete. Now deploy this project as a Web App.');
}

function resetAdmin(phone) {
  var p = normPhone(phone);
  var admins = readRows('admins');
  var admin = admins.filter(function (a) { return a.phone === p; })[0];
  if (!admin) throw new Error('No admin with phone ' + p);

  var secret = String(Math.floor(1000 + Math.random() * 9000));
  var salt = Utilities.getUuid();
  admin.secretHash = hashSecret(secret, salt);
  admin.salt = salt;
  admin.failed = 0;
  admin.lockedUntil = 0;
  updateObj('admins', admin._row, admin);

  Logger.log('New admin secret for %s: %s', p, secret);
  return secret;
}

/* ---------- web entry ---------- */

function doGet() {
  return json({ ok: true, service: 'trip-split' });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'Bad request' });
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (err) {
    return json({ ok: false, error: 'Server busy. Try again.' });
  }

  try {
    switch (body.action) {
      case 'adminStatus': return adminStatus();
      case 'adminSetup': return adminSetup(body);
      case 'adminLogin': return adminLogin(body);
      case 'adminData': return adminData(body);
      case 'adminAddUser': return adminAddUser(body);
      case 'adminEditUser': return adminEditUser(body);
      case 'adminActivateUser': return adminActivateUser(body);
      case 'adminDeactivateUser': return adminDeactivateUser(body);
      case 'adminCreateGroup': return adminCreateGroup(body);
      case 'adminAddMember': return adminAddMember(body);
      case 'adminRemoveMember': return adminRemoveMember(body);
      case 'login': return login(body);
      case 'joinGroup': return joinGroup(body);
      case 'sync': return sync(body);
      default: return json({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- admin actions ---------- */

function adminStatus() {
  return json({ ok: true, hasAdmin: readRows('admins').length > 0 });
}

function adminSetup(body) {
  if (readRows('admins').length > 0) throw new Error('An admin already exists.');

  var name = cleanName(body.name);
  var phone = requirePhone(body.phone);
  var secret = String(Math.floor(1000 + Math.random() * 9000));
  var salt = Utilities.getUuid();
  var adminId = Utilities.getUuid();

  appendObj('admins', {
    adminId: adminId,
    phone: phone,
    name: name,
    secretHash: hashSecret(secret, salt),
    salt: salt,
    failed: 0,
    lockedUntil: 0,
    createdAt: Date.now()
  });

  ensureUser(phone, name);
  return json({ ok: true, secret: secret, admin: { adminId: adminId, phone: phone, name: name } });
}

function verifyAdmin(phone, secret) {
  var admin = readRows('admins').filter(function (a) { return a.phone === phone; })[0];
  if (!admin) throw new Error('Wrong phone or secret.');
  if (Number(admin.lockedUntil || 0) > Date.now()) {
    throw new Error('Too many attempts. Try again in 15 minutes.');
  }

  if (hashSecret(secret, admin.salt) !== admin.secretHash) {
    admin.failed = Number(admin.failed || 0) + 1;
    if (admin.failed >= 5) {
      admin.lockedUntil = Date.now() + 15 * 60 * 1000;
      admin.failed = 0;
    }
    updateObj('admins', admin._row, admin);
    throw new Error('Wrong phone or secret.');
  }

  if (Number(admin.failed || 0) !== 0 || Number(admin.lockedUntil || 0) !== 0) {
    admin.failed = 0;
    admin.lockedUntil = 0;
    updateObj('admins', admin._row, admin);
  }

  return admin;
}

function adminLogin(body) {
  var phone = requirePhone(body.phone);
  var secret = String(body.secret || '').trim();
  var admin = verifyAdmin(phone, secret);
  return json({ ok: true, admin: { adminId: admin.adminId, phone: admin.phone, name: admin.name } });
}

function requireAdmin(body) {
  var phone = requirePhone(body.phone);
  var secret = String(body.secret || '').trim();
  return verifyAdmin(phone, secret);
}

function adminData(body) {
  requireAdmin(body);

  var users = readRows('users').map(function (u) {
    return { userId: u.userId, phone: u.phone, name: u.name, active: Number(u.active) || 0 };
  }).sort(function (a, b) { return a.name.localeCompare(b.name); });

  var groups = readRows('groups').map(publicGroup)
    .sort(function (a, b) { return Number(a.createdAt) - Number(b.createdAt); });

  var members = readRows('members').map(function (m) {
    return { groupId: m.groupId, userId: m.userId, active: Number(m.active) || 0 };
  });

  return json({ ok: true, users: users, groups: groups, members: members });
}

function adminAddUser(body) {
  requireAdmin(body);
  var name = cleanName(body.name);
  var phone = requirePhone(body.newPhone);

  if (readRows('users').some(function (u) { return u.phone === phone; })) {
    throw new Error('That phone is already registered.');
  }

  appendObj('users', {
    userId: Utilities.getUuid(),
    phone: phone,
    name: name,
    active: 1,
    createdAt: Date.now()
  });

  return json({ ok: true });
}

function adminEditUser(body) {
  requireAdmin(body);

  var users = readRows('users');
  var user = users.filter(function (u) { return u.userId === body.userId; })[0];
  if (!user) throw new Error('User not found.');

  var name = cleanName(body.name);
  var phone = requirePhone(body.newPhone);

  if (users.some(function (u) { return u.phone === phone && u.userId !== user.userId; })) {
    throw new Error('That phone is already registered.');
  }

  var oldPhone = user.phone;
  user.name = name;
  user.phone = phone;
  updateObj('users', user._row, user);

  // Keep admin login in sync if this person is also an admin.
  readRows('admins').forEach(function (admin) {
    if (admin.phone === oldPhone) {
      admin.phone = phone;
      admin.name = name;
      updateObj('admins', admin._row, admin);
    }
  });

  return json({ ok: true });
}

function adminActivateUser(body) {
  requireAdmin(body);

  var user = readRows('users').filter(function (u) { return u.userId === body.userId; })[0];
  if (!user) throw new Error('User not found.');

  user.active = 1;
  updateObj('users', user._row, user);
  return json({ ok: true });
}

function adminDeactivateUser(body) {
  requireAdmin(body);

  var user = readRows('users').filter(function (u) { return u.userId === body.userId; })[0];
  if (!user) throw new Error('User not found.');

  user.active = 0;
  updateObj('users', user._row, user);
  return json({ ok: true });
}

function adminCreateGroup(body) {
  var admin = requireAdmin(body);
  var name = cleanName(body.name);
  var group = {
    groupId: Utilities.getUuid(),
    code: newCode(),
    name: name,
    createdBy: admin.adminId,
    createdAt: Date.now()
  };
  appendObj('groups', group);
  return json({ ok: true, group: publicGroup(group) });
}

function adminAddMember(body) {
  requireAdmin(body);

  var groupId = String(body.groupId || '');
  var group = readRows('groups').filter(function (g) { return g.groupId === groupId; })[0];
  if (!group) throw new Error('Group not found.');

  var phone = requirePhone(body.userPhone);
  var user = readRows('users').filter(function (u) {
    return u.phone === phone && Number(u.active) !== 0;
  })[0];
  if (!user) throw new Error('No active person with that phone. Create them first.');

  var member = readRows('members').filter(function (m) {
    return m.groupId === groupId && m.userId === user.userId;
  })[0];

  if (member) {
    if (Number(member.active) === 0) {
      member.active = 1;
      updateObj('members', member._row, member);
    }
  } else {
    appendObj('members', {
      groupId: groupId,
      userId: user.userId,
      addedBy: body.phone,
      addedAt: Date.now(),
      active: 1
    });
  }

  return json({ ok: true });
}

function adminRemoveMember(body) {
  requireAdmin(body);

  var member = readRows('members').filter(function (m) {
    return m.groupId === body.groupId && m.userId === body.userId;
  })[0];
  if (!member) throw new Error('Member not found.');

  member.active = 0;
  updateObj('members', member._row, member);
  return json({ ok: true });
}

/* ---------- member actions ---------- */

function login(body) {
  var phone = requirePhone(body.phone);
  var user = activeUser(phone);
  if (!user) throw new Error('not_registered');

  var groups = readRows('groups');
  var mine = readRows('members').filter(function (m) {
    return m.userId === user.userId && Number(m.active) !== 0;
  }).map(function (m) {
    return groups.filter(function (g) { return g.groupId === m.groupId; })[0];
  }).filter(Boolean).sort(function (a, b) {
    return Number(a.createdAt) - Number(b.createdAt);
  });

  return json({
    ok: true,
    user: { userId: user.userId, phone: user.phone, name: user.name },
    groups: mine.map(publicGroup)
  });
}

function joinGroup(body) {
  var phone = requirePhone(body.phone);
  var user = activeUser(phone);
  if (!user) throw new Error('not_registered');

  var code = String(body.code || '').replace(/\D/g, '');
  var group = readRows('groups').filter(function (g) { return String(g.code) === code; })[0];
  if (!group) throw new Error('No group with that code.');

  var member = readRows('members').filter(function (m) {
    return m.groupId === group.groupId && m.userId === user.userId;
  })[0];

  if (member) {
    if (Number(member.active) === 0) {
      member.active = 1;
      updateObj('members', member._row, member);
    }
  } else {
    appendObj('members', {
      groupId: group.groupId,
      userId: user.userId,
      addedBy: user.phone,
      addedAt: Date.now(),
      active: 1
    });
  }

  return json({ ok: true, group: publicGroup(group) });
}

function sync(body) {
  var phone = requirePhone(body.phone);
  var user = activeUser(phone);
  if (!user) throw new Error('not_registered');

  var groupId = String(body.groupId || '');
  var group = readRows('groups').filter(function (g) { return g.groupId === groupId; })[0];
  if (!group) throw new Error('Group not found.');

  var members = readRows('members').filter(function (m) { return m.groupId === groupId; });
  var me = members.filter(function (m) {
    return m.userId === user.userId && Number(m.active) !== 0;
  })[0];
  if (!me) throw new Error('You are not in this group.');

  var memberSet = {};
  members.forEach(function (m) { memberSet[m.userId] = true; });

  var changes = body.changes || {};
  upsertExpenses(changes.expenses, groupId, memberSet, user.userId);
  upsertSettlements(changes.settlements, groupId, memberSet, user.userId);

  var expenses = readRows('expenses').filter(function (e) {
    return e.groupId === groupId;
  }).map(publicExpense);

  var settlements = readRows('settlements').filter(function (s) {
    return s.groupId === groupId;
  }).map(publicSettlement);

  var users = readRows('users');
  var memberInfo = members.map(function (m) {
    var u = users.filter(function (x) { return x.userId === m.userId; })[0];
    return {
      userId: m.userId,
      name: u ? u.name : 'Unknown',
      active: Number(m.active) || 0
    };
  });

  return json({
    ok: true,
    group: publicGroup(group),
    expenses: expenses,
    settlements: settlements,
    members: memberInfo
  });
}

/* ---------- row upserts ---------- */

function upsertExpenses(incoming, groupId, memberSet, actorId) {
  if (!incoming || !incoming.length) return;

  var existing = readRows('expenses');
  var byId = {};
  existing.forEach(function (row) {
    if (row.groupId === groupId) byId[row.id] = row;
  });

  var rows = incoming.map(function (raw) {
    return sanitizeExpense(raw, groupId, memberSet, actorId);
  });

  rows.forEach(function (row) {
    var current = byId[row.id];
    if (!current) {
      appendObj('expenses', row);
      byId[row.id] = row;
      return;
    }
    if (isNewer(row, current)) {
      updateObj('expenses', current._row, row);
      byId[row.id] = row;
    }
  });
}

function upsertSettlements(incoming, groupId, memberSet, actorId) {
  if (!incoming || !incoming.length) return;

  var existing = readRows('settlements');
  var byId = {};
  existing.forEach(function (row) {
    if (row.groupId === groupId) byId[row.id] = row;
  });

  var rows = incoming.map(function (raw) {
    return sanitizeSettlement(raw, groupId, memberSet, actorId);
  });

  rows.forEach(function (row) {
    var current = byId[row.id];
    if (!current) {
      appendObj('settlements', row);
      byId[row.id] = row;
      return;
    }
    if (isNewer(row, current)) {
      updateObj('settlements', current._row, row);
      byId[row.id] = row;
    }
  });
}

function sanitizeExpense(raw, groupId, memberSet, actorId) {
  var id = String(raw.id || '').slice(0, 100);
  if (!id) throw new Error('Expense is missing an id.');

  var amountPaise = Math.round(Number(raw.amountPaise));
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) throw new Error('Invalid expense amount.');

  var paidBy = String(raw.paidBy || '');
  if (!memberSet[paidBy]) throw new Error('Payer is not in the group.');

  var shares = Array.isArray(raw.shares) ? raw.shares : [];
  if (!shares.length) throw new Error('Expense has no participants.');

  var sum = 0;
  var cleanShares = shares.map(function (share) {
    var userId = String(share.userId || '');
    var amount = Math.round(Number(share.amountPaise));
    if (!memberSet[userId]) throw new Error('Participant is not in the group.');
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid share amount.');
    sum += amount;
    return { userId: userId, amountPaise: amount };
  });

  if (sum !== amountPaise) throw new Error('Shares do not add up to the total.');

  return {
    id: id,
    groupId: groupId,
    amountPaise: amountPaise,
    note: String(raw.note || '').slice(0, 120),
    paidBy: paidBy,
    sharesJSON: JSON.stringify(cleanShares),
    date: validDate(raw.date),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    updatedBy: actorId,
    deleted: raw.deleted ? 1 : 0
  };
}

function sanitizeSettlement(raw, groupId, memberSet, actorId) {
  var id = String(raw.id || '').slice(0, 100);
  if (!id) throw new Error('Payment is missing an id.');

  var fromUser = String(raw.fromUser || '');
  var toUser = String(raw.toUser || '');
  if (!memberSet[fromUser] || !memberSet[toUser]) throw new Error('Payment member is not in the group.');
  if (fromUser === toUser) throw new Error('Payment needs two different people.');

  var amountPaise = Math.round(Number(raw.amountPaise));
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) throw new Error('Invalid payment amount.');

  return {
    id: id,
    groupId: groupId,
    fromUser: fromUser,
    toUser: toUser,
    amountPaise: amountPaise,
    date: validDate(raw.date),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    updatedBy: actorId,
    deleted: raw.deleted ? 1 : 0
  };
}

function isNewer(a, b) {
  var au = Number(a.updatedAt) || 0;
  var bu = Number(b.updatedAt) || 0;
  if (au !== bu) return au > bu;
  return String(a.updatedBy || '') > String(b.updatedBy || '');
}

/* ---------- serializers ---------- */

function publicGroup(group) {
  return {
    groupId: group.groupId,
    code: String(group.code),
    name: group.name,
    createdAt: Number(group.createdAt) || 0
  };
}

function publicExpense(row) {
  return {
    id: row.id,
    groupId: row.groupId,
    amountPaise: Number(row.amountPaise),
    note: row.note,
    paidBy: row.paidBy,
    shares: parseShares(row.sharesJSON),
    date: row.date,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    updatedBy: row.updatedBy,
    deleted: Number(row.deleted) || 0
  };
}

function publicSettlement(row) {
  return {
    id: row.id,
    groupId: row.groupId,
    fromUser: row.fromUser,
    toUser: row.toUser,
    amountPaise: Number(row.amountPaise),
    date: row.date,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    updatedBy: row.updatedBy,
    deleted: Number(row.deleted) || 0
  };
}

function parseShares(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || '[]'); } catch (e) { return []; }
}

/* ---------- sheet helpers ---------- */

function sheet(name) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var found = spreadsheet.getSheetByName(name);
  if (!found) throw new Error('Missing tab "' + name + '". Run setup() first.');
  return found;
}

function readRows(name) {
  var tab = sheet(name);
  var lastRow = tab.getLastRow();
  if (lastRow < 2) return [];

  var headers = TABS[name];
  var values = tab.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var rows = [];

  for (var i = 0; i < values.length; i++) {
    var row = { _row: i + 2 };
    for (var j = 0; j < headers.length; j++) row[headers[j]] = values[i][j];
    rows.push(row);
  }
  return rows;
}

function appendObj(name, obj) {
  var headers = TABS[name];
  sheet(name).appendRow(headers.map(function (header) {
    var value = obj[header];
    return value === undefined || value === null ? '' : value;
  }));
}

function updateObj(name, rowNumber, obj) {
  var headers = TABS[name];
  sheet(name).getRange(rowNumber, 1, 1, headers.length).setValues([
    headers.map(function (header) {
      var value = obj[header];
      return value === undefined || value === null ? '' : value;
    })
  ]);
}

/* ---------- utilities ---------- */

function activeUser(phone) {
  return readRows('users').filter(function (user) {
    return user.phone === phone && Number(user.active) !== 0;
  })[0];
}

function ensureUser(phone, name) {
  var existing = readRows('users').filter(function (user) { return user.phone === phone; })[0];
  if (existing) return existing;

  var user = {
    userId: Utilities.getUuid(),
    phone: phone,
    name: name,
    active: 1,
    createdAt: Date.now()
  };
  appendObj('users', user);
  return user;
}

function newCode() {
  var used = {};
  readRows('groups').forEach(function (group) { used[String(group.code)] = true; });

  for (var i = 0; i < 500; i++) {
    var code = String(Math.floor(1000 + Math.random() * 9000));
    if (!used[code]) return code;
  }
  throw new Error('Could not allocate a group code.');
}

function cleanName(value) {
  var name = String(value || '').trim().slice(0, 40);
  if (!name) throw new Error('Enter a name.');
  return name;
}

function normPhone(value) {
  var digits = String(value == null ? '' : value).replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function requirePhone(value) {
  var phone = normPhone(value);
  if (!/^\d{10}$/.test(phone)) throw new Error('Enter a 10-digit mobile number.');
  return phone;
}

function validDate(value) {
  var text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : today();
}

function today() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function hashSecret(secret, salt) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(salt) + ':' + String(secret),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function (byte) {
    var value = (byte < 0 ? byte + 256 : byte).toString(16);
    return value.length === 1 ? '0' + value : value;
  }).join('');
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
