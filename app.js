/* Nanohaのコンクール手帳 — 独立アプリ版
 * データは毎回 catalog.json を読みにいく（埋め込みなし）。
 * 「出場する／検討中」は Supabase（設定時）で親子共有。未設定時はこの端末内に保存。
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  var FILTERS = [
    { key: 'all', label: 'ALL' },
    { key: 'open', label: '申込受付中', cls: 'open' },
    { key: 'contemp', label: 'コンテ系あり' },
    { key: 'ok', label: '出場可能のみ' },
    { key: 'likely', label: '要確認を含む' },
    { key: 'unc', label: '部門境界・未確定のみ' }
  ];

  var state = {
    catalog: null,
    comps: [],
    byId: {},
    sel: {},          // id -> 'entered' | 'considering'
    view: 'list',
    month: 'all',
    filter: 'all',
    q: '',
    today: ''
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- utils ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function rich(arr) {
    if (!arr) return '';
    if (typeof arr === 'string') return esc(arr);
    return arr.map(function (p) {
      return p.b ? '<strong>' + esc(p.t) + '</strong>' : esc(p.t);
    }).join('');
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localToday() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function ymdToUTC(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  }
  function daysUntil(ymd) {
    return Math.round((ymdToUTC(ymd) - ymdToUTC(state.today)) / 86400000);
  }
  function wd(ymd) { return WEEK[new Date(ymdToUTC(ymd)).getUTCDay()]; }
  function mdJa(ymd) {
    var p = ymd.split('-');
    return (+p[1]) + '月' + (+p[2]) + '日（' + wd(ymd) + '）';
  }
  function norm(s) {
    return String(s || '').normalize('NFKC').toLowerCase().replace(/[\s　]/g, '');
  }
  function bigrams(s) {
    var out = {};
    for (var i = 0; i < s.length - 1; i++) out[s.substr(i, 2)] = 1;
    return out;
  }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ---------- データ判定 ---------- */
  function isOpen(c) {
    // 申込期間（開始〜締切）が発表済み → 期間内のみ。
    // 締切未発表で entryStart のみ（＝公式で受付中を確認した日）→ その日以降は受付中。
    if (!c.entryStart) return false;
    if (state.today < c.entryStart) return false;
    if (c.entryEnd && state.today > c.entryEnd) return false;
    return true;
  }
  function hasContemp(c) { return (c.genre || []).indexOf('contemporary') >= 0; }
  function isUnc(c) {
    return (c.genre || []).indexOf('unconfirmed') >= 0 ||
      (c.badges || []).some(function (b) { return b.cls === 'b-unc'; });
  }
  function dateLabel(c) { return c.dateShort + '（' + c.weekShort + '）'; }
  function venue(c) {
    var r = (c.rows || []).filter(function (x) { return x.dt === '会場'; })[0];
    return r ? r.dd.map(function (p) { return p.t; }).join('') : '';
  }
  function guideHref(c) {
    if (c.guideLink && c.guideLink.href) return c.guideLink;
    return (c.links || [])[0] || null;
  }

  function matchesFilters(c) {
    if (state.month !== 'all' && c.month !== state.month) return false;
    switch (state.filter) {
      case 'open': if (!isOpen(c)) return false; break;
      case 'contemp': if (!hasContemp(c)) return false; break;
      case 'ok': if (c.status !== 'ok') return false; break;
      case 'likely': if (c.status !== 'likely') return false; break;
      case 'unc': if (!isUnc(c)) return false; break;
    }
    if (state.q) {
      var hay = norm(c.title + ' ' + (c.search || '') + ' ' + venue(c) + ' ' + (c.organizer || ''));
      var qs = state.q.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
      for (var i = 0; i < qs.length; i++) if (hay.indexOf(norm(qs[i])) < 0) return false;
    }
    return true;
  }

  /* 締切名（deadlines[].name）→ カードを特定 */
  function findCardForDeadline(name, ymd) {
    var nb = bigrams(norm(name));
    var best = null, bestScore = 0;
    state.comps.forEach(function (c) {
      var hb = bigrams(norm(c.title + ' ' + (c.search || '')));
      var s = 0;
      for (var k in nb) if (hb[k]) s++;
      if (s > 0 && ymd && c.entryEnd === ymd) s += 6;
      if (s > bestScore) { bestScore = s; best = c; }
    });
    return bestScore >= 3 ? best : null;
  }
  function parseDeadlineDate(t) {
    var m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((t || '').trim());
    return m ? m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]) : null;
  }

  /* ---------- 選択の保存（親子共有） ---------- */
  var LS_KEY = 'nanoha-selections-v1';
  var Store = {
    remote: !!(CFG.supabaseUrl && CFG.supabaseAnonKey),
    headers: function (extra) {
      var h = { apikey: CFG.supabaseAnonKey, 'Content-Type': 'application/json' };
      // 旧形式の anon キー（JWT）のときだけ Authorization も付ける。新形式 sb_publishable_… は apikey のみ。
      if (/^eyJ/.test(CFG.supabaseAnonKey)) h.Authorization = 'Bearer ' + CFG.supabaseAnonKey;
      for (var k in extra || {}) h[k] = extra[k];
      return h;
    },
    url: function (q) {
      return CFG.supabaseUrl.replace(/\/$/, '') + '/rest/v1/' + (CFG.supabaseTable || 'selections') + (q || '');
    },
    readLocal: function () {
      try { var v = localStorage.getItem(LS_KEY); return v ? JSON.parse(v) : null; } catch (e) { return null; }
    },
    writeLocal: function (map) {
      try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch (e) {}
    },
    fromRows: function (rows) {
      var m = {};
      (rows || []).forEach(function (r) {
        if (r && r.competition_id && (r.status === 'entered' || r.status === 'considering')) m[r.competition_id] = r.status;
      });
      return m;
    },
    load: function () {
      if (this.remote) {
        return fetch(this.url('?select=competition_id,status'), { headers: this.headers(), cache: 'no-store' })
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
          .then(function (rows) { var m = Store.fromRows(rows); Store.writeLocal(m); return m; })
          .catch(function () { return Store.readLocal() || {}; });
      }
      var local = this.readLocal();
      if (local) return Promise.resolve(local);
      return fetch('selections-seed.json', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var m = Store.fromRows(((j && j.data) || j || {}).selections);
          Store.writeLocal(m); return m;
        })
        .catch(function () { return {}; });
    },
    set: function (id, status) {
      if (!this.remote) return Promise.resolve();
      if (!status) {
        return fetch(this.url('?competition_id=eq.' + encodeURIComponent(id)), {
          method: 'DELETE', headers: this.headers()
        }).then(function (r) { if (!r.ok) throw new Error(r.status); });
      }
      return fetch(this.url('?on_conflict=competition_id'), {
        method: 'POST',
        headers: this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify([{ competition_id: id, status: status, updated_at: new Date().toISOString() }])
      }).then(function (r) { if (!r.ok) throw new Error(r.status); });
    }
  };

  function setSelection(id, status) {
    var prev = state.sel[id] || null;
    if (prev === status) status = null; // 同じボタン再タップで解除
    if (status) state.sel[id] = status; else delete state.sel[id];
    Store.writeLocal(state.sel);
    renderSelections();
    updateCardButtons(id);
    Store.set(id, status).catch(function () {
      if (prev) state.sel[id] = prev; else delete state.sel[id];
      Store.writeLocal(state.sel);
      renderSelections(); updateCardButtons(id);
      toast('保存できませんでした。通信状態を確認してください');
    });
  }

  function refreshSelections() {
    if (!Store.remote) return;
    Store.load().then(function (m) {
      if (JSON.stringify(m) === JSON.stringify(state.sel)) return;
      var ids = Object.keys(m).concat(Object.keys(state.sel));
      state.sel = m;
      renderSelections();
      ids.forEach(updateCardButtons);
    });
  }

  /* ---------- Hero ---------- */
  function renderHero() {
    var d = state.catalog;
    var months = (d.months || []).filter(function (m) { return m.key !== 'extra'; });
    var last = months[months.length - 1];
    var until = last ? last.title.replace(/\s+/g, '') : '';
    var checked = '';
    if (d.lastCheckedAt) {
      var t = new Date(d.lastCheckedAt);
      checked = t.getFullYear() + '年' + (t.getMonth() + 1) + '月' + t.getDate() + '日';
    }
    $('heroDesc').innerHTML =
      '関東と、山梨・長野・静岡のコンクールを集めたNanoha専用の手帳です。<br class="pc-only">' +
      '現在は<b>' + esc(until) + 'まで</b>のコンクールを掲載中・<b>毎日更新</b>しています。' +
      (checked ? '<span style="white-space:nowrap">最終チェック：<b>' + esc(checked) + '</b></span>' : '');
  }

  function renderNotice() {
    var items = [];
    (state.catalog.deadlines || []).forEach(function (dl) {
      var ymd = parseDeadlineDate(dl.dateText);
      if (!ymd) return;
      var n = daysUntil(ymd);
      if (n < 0 || n > 30) return;
      var card = findCardForDeadline(dl.name, ymd);
      items.push({ ymd: ymd, n: n, dl: dl, card: card });
    });
    items.sort(function (a, b) { return a.ymd < b.ymd ? -1 : a.ymd > b.ymd ? 1 : 0; });
    var box = $('notice');
    var hero = box.parentNode;
    if (!items.length) { box.hidden = true; hero.classList.add('no-notice'); return; }
    hero.classList.remove('no-notice');
    box.hidden = false;
    box.innerHTML = '<h2>締切のお知らせ</h2><ul>' + items.map(function (it) {
      var c = it.card;
      var name = c
        ? '<a href="#card-' + esc(c.id) + '" class="n-name" data-jump="' + esc(c.id) + '">' + esc(it.dl.name) + '</a>'
        : '<span class="n-name">' + esc(it.dl.name) + '</span>';
      var held = c ? '<span class="n-date">開催：' + esc(c.dateShort) + '(' + esc(c.weekShort) + ')</span>' : '';
      var label = /早期(エントリー|割引)/.test(it.dl.note || '') ? '早期割引締切まで' : '申込締切まで';
      var days = it.n === 0 ? label.replace('まで', 'は') + '<span class="n-days">今日</span>' : label + '<span class="n-days">あと' + it.n + '日</span>';
      return '<li>' + name + (held ? ' ' + held : '') +
        '<span class="n-rest">' + days + '<span class="n-until">※' + mdJa(it.ymd).replace('（', '(').replace('）', ')') + 'まで</span></span></li>';
    }).join('') + '</ul>';
  }

  /* ---------- 出場する／検討中 ---------- */
  function selList(status) {
    return state.comps.filter(function (c) { return state.sel[c.id] === status; })
      .sort(byDate);
  }
  function byDate(a, b) {
    var x = a.eventDate || '9999', y = b.eventDate || '9999';
    return x < y ? -1 : x > y ? 1 : 0;
  }
  function countdownPill(c) {
    if (!c.eventDate) return '';
    var n = daysUntil(c.eventDate);
    if (n < 0) return '<span class="pill light">終了</span>';
    return '<span class="pill">' + (n === 0 ? '本番は今日！' : '本番まで あと ' + n + '日') + '</span>';
  }
  function dateBadge(c, sm) {
    return '<div class="datebadge' + (sm ? ' sm' : '') + '"><span class="d">' + esc(c.dateShort) +
      '</span><span class="w">' + esc(c.weekShort) + '</span></div>';
  }

  function fullDate(c) {
    if (!c.eventDate) return c.dateShort;
    var p = c.eventDate.split('-');
    return p[0] + '年' + (+p[1]) + '月' + (+p[2]) + '日（' + wd(c.eventDate) + '）';
  }
  function renderSelections() {
    var entered = selList('entered');
    var cons = selList('considering');
    var html = '';

    html += '<section class="sel sel-entered frame"><h2 class="sel-head"><span class="mark">♥</span>出場するコンクール <span class="count-pill">' + entered.length + '件 選択中</span></h2>';
    if (!entered.length) {
      html += '<p class="sel-empty">カードの「♥ 出場する」を押すと、ここに表示されます。</p>';
    } else {
      var next = entered.filter(function (c) { return c.eventDate && daysUntil(c.eventDate) >= 0; })[0];
      if (next) {
        var nn = daysUntil(next.eventDate);
        html += '<div class="next"><div class="next-main"><span class="next-label">NEXT — 次の本番</span>' +
          '<a class="next-name" href="#card-' + esc(next.id) + '" data-jump="' + esc(next.id) + '">' + esc(next.title) + '</a>' +
          '<div class="next-meta">' + esc(fullDate(next)) + (venue(next) ? ' ・ ' + esc(venue(next)) : '') + '</div></div>' +
          '<div class="next-count">' + (nn === 0 ? '本番は<b>今日</b>' : '本番まで あと<b>' + nn + ' <small>日</small></b>') + '</div></div>';
      }
      entered.forEach(function (c) {
        var g = guideHref(c);
        html += '<div class="sel-item">' + dateBadge(c, true) + '<div class="sel-body">' +
          '<a class="sel-name" href="#card-' + esc(c.id) + '" data-jump="' + esc(c.id) + '">' + esc(c.title) + '</a>' +
          (g ? '<a class="sel-link" href="' + esc(g.href) + '" target="_blank" rel="noopener">' + esc(g.text) + ' ↗</a>' : '') +
          '<div class="sel-pills">' + countdownPill(c) + '</div></div>' +
          '<div class="sel-actions"><button class="mini-btn ghost" data-set="none" data-id="' + esc(c.id) + '">取り消す</button></div></div>';
      });
    }
    html += '</section>';

    html += '<section class="sel sel-considering frame"><h2 class="sel-head"><span class="mark">?</span>検討中のコンクール <span class="count-pill">' + cons.length + '件 検討中</span></h2>';
    if (!cons.length) {
      html += '<p class="sel-empty">カードの「✓ 検討中」を押すと、ここに表示されます。</p>';
    } else {
      cons.forEach(function (c) {
        var g = guideHref(c);
        var dpill = '';
        if (c.entryEnd) {
          var dn = daysUntil(c.entryEnd);
          if (dn >= 0) dpill = '<span class="pill light">' + (dn === 0 ? '締切は今日' : '締切まで あと ' + dn + '日') + '</span>';
        }
        html += '<div class="sel-item">' + dateBadge(c, true) + '<div class="sel-body">' +
          '<a class="sel-name" href="#card-' + esc(c.id) + '" data-jump="' + esc(c.id) + '">' + esc(c.title) + '</a>' +
          (g ? '<a class="sel-link" href="' + esc(g.href) + '" target="_blank" rel="noopener">' + esc(g.text) + ' ↗</a>' : '') +
          '<div class="sel-pills">' + countdownPill(c) + dpill + '</div></div>' +
          '<div class="sel-actions"><button class="mini-btn" data-set="entered" data-id="' + esc(c.id) + '">♥ 出場する</button>' +
          '<button class="mini-btn ghost" data-set="none" data-id="' + esc(c.id) + '">外す</button></div></div>';
      });
    }
    html += '</section>';
    $('selections').innerHTML = html;
  }

  /* ---------- 絞り込み ---------- */
  function renderChips() {
    var months = [{ key: 'all', label: 'すべて' }].concat((state.catalog.months || []).map(function (m) {
      return { key: m.key, label: m.key === 'extra' ? '例年・通年' : m.key + '月' };
    }));
    $('monthChips').innerHTML = months.map(function (m) {
      return '<button class="chip' + (state.month === m.key ? ' is-on' : '') + '" data-month="' + m.key + '">' + m.label + '</button>';
    }).join('');
    $('filterChips').innerHTML = FILTERS.map(function (f) {
      return '<button class="chip' + (f.cls ? ' ' + f.cls : '') + (state.filter === f.key ? ' is-on' : '') + '" data-filter="' + f.key + '">' + f.label + '</button>';
    }).join('');
  }

  /* ---------- カード ---------- */
  var INSTA = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.4" cy="6.6" r="1" fill="currentColor" stroke="none"/></svg>';

  function cardHTML(c) {
    var s = state.sel[c.id];
    var badges = (isOpen(c) ? '<span class="badge b-open">申込受付中</span>' : '') +
      (c.badges || []).map(function (b) {
        return '<span class="badge ' + esc(b.cls) + '">' + esc(b.text) + '</span>';
      }).join('') +
      (s === 'considering' ? '<span class="badge b-cons">? 検討中</span>' : '');
    var rows = (c.rows || []).map(function (r) {
      return '<div class="row' + (r.contemp ? ' contemp' : '') + '"><dt>' + esc(r.dt) + '</dt><dd>' + rich(r.dd) + '</dd></div>';
    }).join('');
    var links = (c.links || []).map(function (l) {
      var insta = /instagram/i.test(l.href) || /Instagram/.test(l.text);
      return '<a class="lbtn' + (insta ? ' insta' : l.ghost ? ' ghost' : '') + '" href="' + esc(l.href) + '" target="_blank" rel="noopener">' +
        (insta ? INSTA : '') + esc(l.text) + '</a>';
    }).join('');
    return '<article class="card frame' + (s === 'entered' ? ' is-entered' : '') + '" id="card-' + esc(c.id) + '">' +
      '<div class="card-head">' + dateBadge(c) +
      '<div class="card-main"><h3 class="card-title">' + esc(c.title) + '</h3>' +
      (c.organizer ? '<p class="card-org">' + esc(c.organizer) + '</p>' : '') +
      '</div></div>' +
      '<div class="badges">' + badges + '</div>' +
      (rows ? '<dl class="rows">' + rows + '</dl>' : '') +
      (c.deadline ? '<p class="deadline">' + rich(c.deadline) + '</p>' : '') +
      (c.unc ? '<div class="unc">' + rich(c.unc) + '</div>' : '') +
      (c.note ? '<p class="cnote">' + rich(c.note) + '</p>' : '') +
      (links ? '<div class="links">' + links + '</div>' : '') +
      '<div class="pick">' +
      '<button class="pbtn enter' + (s === 'entered' ? ' is-on' : '') + '" data-set="entered" data-id="' + esc(c.id) + '">♥ 出場する</button>' +
      '<button class="pbtn consider' + (s === 'considering' ? ' is-on' : '') + '" data-set="considering" data-id="' + esc(c.id) + '">' + (s === 'considering' ? '✓ 検討中 — 外す' : '? 検討中') + '</button>' +
      '</div></article>';
  }

  function updateCardButtons(id) {
    var el = document.getElementById('card-' + id);
    var c = state.byId[id];
    if (!el || !c) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = cardHTML(c);
    el.replaceWith(tmp.firstChild);
  }

  function renderList() {
    var total = state.comps.length;
    var shown = 0;
    var html = '';
    (state.catalog.months || []).forEach(function (m) {
      var cs = state.comps.filter(function (c) { return c.month === m.key && matchesFilters(c); });
      if (!cs.length) return;
      shown += cs.length;
      html += '<section class="month" id="m-' + esc(m.key) + '"><div class="month-head"><h2>' + esc(m.title) + '</h2>' +
        (m.note ? '<p class="month-note"><span class="gold">✦</span>' + esc(m.note) + '</p>' : '') +
        '</div>' + cs.map(cardHTML).join('') + '</section>';
    });
    if (!shown) {
      html = '<div class="empty"><img src="img/bear.png" alt="">条件に合うコンクールがありません</div>';
    }
    html += '<footer class="list-end"><img src="img/pointe-shoes.png" alt="" aria-hidden="true"><p><span>✦</span>For Nanoha<span>✦</span></p></footer>';
    $('list').innerHTML = html;
    $('count').textContent = shown + ' 件を表示中（全 ' + total + ' 件）';
  }

  /* ---------- ガイド ---------- */
  function divider(name) {
    return '<img class="divider" src="img/' + name + '.png" alt="" aria-hidden="true">';
  }
  function deadlineTable() {
    var rows = (state.catalog.deadlines || []).filter(function (d) {
      var m = /(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(d.dateText || '');
      if (!m) return true;
      return daysUntil(m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3])) >= 0;
    });
    return '<h2>Nanohaの申込締切カレンダー（判明分のみ・日付順）</h2>' +
      '<p class="small">「早期割引」は最終締切ではありません。未発表のコンクールは含んでいません。各カードでご確認ください。</p><table class="deadline-table"><thead><tr><th>締切・期間</th><th>コンクール</th><th>備考</th></tr></thead><tbody>' +
      rows.map(function (d) {
        return '<tr><td class="dt">' + esc(d.dateText) + '</td><td class="nm">' + esc(d.name) + '</td><td class="nt">' + esc(d.note) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function boldLead(root) {
    // 箇条書きの文頭（名前〜「：」まで）を太字に
    root.querySelectorAll('li').forEach(function (li) {
      var first = li.firstChild;
      if (!first || first.nodeType !== 3) return;
      var t = first.nodeValue;
      var i = t.indexOf('：');
      if (i <= 0 || i > 60) return; // 長すぎる前置きは太字にしない（現在の手帳どおり）
      var strong = document.createElement('strong');
      strong.textContent = t.slice(0, i + 1);
      first.nodeValue = t.slice(i + 1);
      li.insertBefore(strong, first);
    });
  }
  function renderGuide() {
    var g = state.catalog.guide || {};
    // [クラス, HTML, 直後の区切りイラスト]
    var parts = [
      ['about gbox frame', g.aboutHtml, 'ballerina'],
      ['alert', g.alertHtml, 'tiara'],
      ['calendar', deadlineTable(), 'pointe-shoes'],
      ['unconfirmed', g.unconfirmedHtml, 'tutu'],
      ['excluded', g.excludedHtml, 'bear'],
      ['reference', g.referenceHtml, 'swan'],
      ['footer', g.footerHtml, null]
    ];
    var html = '';
    parts.forEach(function (p, i) {
      html += '<section class="gsec ' + p[0] + '">' + (p[1] || '') + '</section>';
      if (p[2]) html += divider(p[2]);
    });
    html += '<button class="back-btn" data-view="list">♡ コンクール一覧に戻る</button>';
    var v = $('view-guide');
    v.innerHTML = html;
    v.querySelectorAll('.gsec.alert > p').forEach(function (p) { p.classList.add('check'); });
    v.querySelectorAll('.gsec a[href^="http"]').forEach(function (a) { a.target = '_blank'; a.rel = 'noopener'; });
    boldLead(v);
  }

  /* ---------- 画面切替・スクロール ---------- */
  function setView(view) {
    state.view = view;
    document.querySelectorAll('.tab').forEach(function (t) {
      var on = t.getAttribute('data-view') === view;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('view-list').hidden = view !== 'list';
    $('view-guide').hidden = view !== 'guide';
    window.scrollTo(0, 0);
  }

  function jumpTo(id) {
    var c = state.byId[id];
    if (!c) return;
    if (state.view !== 'list') setView('list');
    if (!matchesFilters(c)) {
      state.month = 'all'; state.filter = 'all'; state.q = '';
      $('search').value = '';
      renderChips(); renderList();
    }
    var el = document.getElementById('card-' + id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }

  function bind() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-view],[data-jump],[data-set],[data-month],[data-filter]');
      if (!t) return;
      if (t.hasAttribute('data-view')) { setView(t.getAttribute('data-view')); return; }
      if (t.hasAttribute('data-jump')) { e.preventDefault(); jumpTo(t.getAttribute('data-jump')); return; }
      if (t.hasAttribute('data-set')) {
        var st = t.getAttribute('data-set');
        var id = t.getAttribute('data-id');
        setSelection(id, st === 'none' ? null : st);
        return;
      }
      if (t.hasAttribute('data-month')) {
        state.month = t.getAttribute('data-month');
        renderChips(); renderList();
        var target = state.month === 'all' ? $('list').querySelector('.month') : document.getElementById('m-' + state.month);
        (target || $('filters')).scrollIntoView({ block: 'start' });
        return;
      }
      if (t.hasAttribute('data-filter')) {
        state.filter = t.getAttribute('data-filter');
        renderChips(); renderList();
      }
    });
    var timer;
    $('search').addEventListener('input', function (e) {
      clearTimeout(timer);
      timer = setTimeout(function () { state.q = e.target.value.trim(); renderList(); }, 120);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { checkDayChange(); refreshSelections(); }
    });
    setInterval(function () { if (document.visibilityState === 'visible') refreshSelections(); }, 15000);
  }

  function checkDayChange() {
    var t = localToday();
    if (t !== state.today) { state.today = t; renderAll(); }
  }

  function renderAll() {
    renderHero(); renderNotice(); renderSelections(); renderChips(); renderList(); renderGuide();
  }

  /* ---------- 起動 ---------- */
  function loadCatalog() {
    var url = CFG.catalogUrl || 'catalog.json';
    return fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) {
        var d = j && j.data ? j.data : j;
        try { localStorage.setItem('nanoha-catalog-cache', JSON.stringify(d)); } catch (e) {}
        return d;
      })
      .catch(function () {
        try { var c = localStorage.getItem('nanoha-catalog-cache'); if (c) { toast('オフラインのため前回のデータを表示しています'); return JSON.parse(c); } } catch (e) {}
        throw new Error('catalog');
      });
  }

  function init() {
    state.today = (CFG.debugToday) || localToday();
    bind();
    Promise.all([loadCatalog(), Store.load()]).then(function (res) {
      var d = res[0];
      state.catalog = d;
      // 月内は開催日順（日付未定は月内の後ろ）
      var order = {};
      (d.competitions || []).forEach(function (c, i) { order[c.id] = i; });
      state.comps = (d.competitions || []).slice().sort(function (a, b) {
        var x = byDate(a, b);
        return x !== 0 ? x : order[a.id] - order[b.id];
      });
      state.comps.forEach(function (c) { state.byId[c.id] = c; });
      state.sel = res[1] || {};
      $('loading').hidden = true;
      renderAll();
      if (location.hash && location.hash.indexOf('#card-') === 0) jumpTo(location.hash.slice(6));
    }).catch(function () {
      $('loading').textContent = 'データを読み込めませんでした。通信状態を確認して、もう一度開いてください。';
    });

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  // テスト用に公開
  window.__nanoha = { state: state, findCardForDeadline: findCardForDeadline, isOpen: isOpen, jumpTo: jumpTo };
  init();
})();
