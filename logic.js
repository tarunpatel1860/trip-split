/* Shared pure helpers. No DOM, no network. */
(function (global) {
  'use strict';

  var inr = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2
  });

  function money(paise) {
    return inr.format((Number(paise) || 0) / 100);
  }

  // "1,234.5" -> 123450. Returns null for invalid input.
  function toPaise(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.round(value * 100) : null;
    }
    var s = String(value == null ? '' : value).trim().replace(/,/g, '');
    if (!s) return null;
    if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
    var parts = s.split('.');
    var b = parts[1] || '';
    return Number(parts[0]) * 100 + Number((b + '00').slice(0, 2));
  }

  // Deterministic: remainder paise go to the lowest sorted user ids.
  function equalShares(totalPaise, userIds) {
    var ids = (userIds || []).slice().sort();
    if (!ids.length) return [];
    var total = Math.round(Number(totalPaise) || 0);
    var base = Math.floor(total / ids.length);
    var remainder = total - base * ids.length;
    return ids.map(function (id, i) {
      return { userId: id, amountPaise: base + (i < remainder ? 1 : 0) };
    });
  }

  // net > 0 => is owed money. Sums to zero.
  function computeBalances(expenses, settlements) {
    var net = new Map();
    function add(id, value) {
      net.set(id, (net.get(id) || 0) + value);
    }
    (expenses || []).forEach(function (e) {
      if (Number(e.deleted)) return;
      add(e.paidBy, Number(e.amountPaise) || 0);
      (e.shares || []).forEach(function (s) {
        add(s.userId, -(Number(s.amountPaise) || 0));
      });
    });
    (settlements || []).forEach(function (s) {
      if (Number(s.deleted)) return;
      add(s.fromUser, Number(s.amountPaise) || 0);
      add(s.toUser, -(Number(s.amountPaise) || 0));
    });
    return net;
  }

  // Greedy min-cash-flow: [{from, to, amt}]
  function suggestions(net) {
    var debtors = [];
    var creditors = [];
    net.forEach(function (value, id) {
      if (value < 0) debtors.push({ id: id, amt: -value });
      else if (value > 0) creditors.push({ id: id, amt: value });
    });
    debtors.sort(function (a, b) { return b.amt - a.amt; });
    creditors.sort(function (a, b) { return b.amt - a.amt; });
    var out = [];
    var i = 0;
    var j = 0;
    while (i < debtors.length && j < creditors.length) {
      var amt = Math.min(debtors[i].amt, creditors[j].amt);
      if (amt > 0) out.push({ from: debtors[i].id, to: creditors[j].id, amt: amt });
      debtors[i].amt -= amt;
      creditors[j].amt -= amt;
      if (debtors[i].amt <= 0) i++;
      if (creditors[j].amt <= 0) j++;
    }
    return out;
  }

  // True when the stored shares are exactly what equalShares would produce.
  function isEqualSplit(totalPaise, shares) {
    if (!shares || !shares.length) return false;
    var expected = equalShares(totalPaise, shares.map(function (s) { return s.userId; }));
    if (expected.length !== shares.length) return false;
    var actual = new Map();
    shares.forEach(function (s) { actual.set(s.userId, Number(s.amountPaise) || 0); });
    return expected.every(function (e) { return actual.get(e.userId) === e.amountPaise; });
  }

  // Newest updatedAt wins; equal timestamps break by updatedBy.
  function mergeRows(local, incoming) {
    var map = new Map();
    (local || []).forEach(function (r) { map.set(r.id, r); });
    (incoming || []).forEach(function (r) {
      var current = map.get(r.id);
      if (!current || isNewer(r, current)) map.set(r.id, r);
    });
    return Array.from(map.values());
  }

  function isNewer(a, b) {
    var au = Number(a.updatedAt) || 0;
    var bu = Number(b.updatedAt) || 0;
    if (au !== bu) return au > bu;
    return String(a.updatedBy || '') > String(b.updatedBy || '');
  }

  function uid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function timeAgo(ts) {
    var seconds = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
    if (seconds < 10) return 'just now';
    if (seconds < 60) return seconds + 's ago';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }

  function normPhone(value) {
    var digits = String(value == null ? '' : value).replace(/\D/g, '');
    return digits.length > 10 ? digits.slice(-10) : digits;
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function initials(value) {
    var s = String(value || '?').trim();
    return s ? s.slice(0, 1).toUpperCase() : '?';
  }

  global.Logic = {
    money: money,
    toPaise: toPaise,
    equalShares: equalShares,
    isEqualSplit: isEqualSplit,
    computeBalances: computeBalances,
    suggestions: suggestions,
    mergeRows: mergeRows,
    uid: uid,
    today: today,
    timeAgo: timeAgo,
    normPhone: normPhone,
    esc: esc,
    initials: initials
  };
})(typeof window !== 'undefined' ? window : globalThis);
