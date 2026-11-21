// Climbing map - climb logbook and leaderboard.
// Logs are always saved on the climber's own phone. Posting to the public leaderboard is
// optional and goes through the same Google Apps Script as the suggestion form (suggestUrl).
// Turn the whole thing off with  logbook: false  in config.js.
(() => {
  'use strict';

  const esc = s => s == null ? '' : String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem('pgmap-' + key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem('pgmap-' + key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ } }
  };
  const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const niceDate = s => { const d = new Date(s + 'T12:00'); return isNaN(d) ? esc(s) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };

  // A log means "I climbed it". On lead routes (sport, trad...) it only counts if you led it;
  // a top rope of a lead route is kept in My climbs but stays off the leaderboard.
  const DONE = 'Climbed', LED = 'Led', TR = 'Top rope';
  const isLeadRoute = r => /sport|trad|mixed|aid|lead/i.test((r && r.Climb_Type) || '');

  window.makeLogbook = function (ctx) {
    const C = ctx.config;
    if (!C.suggestUrl || C.logbook === false) return null;

    let ticks = store.get('ticks', []);                 // this phone's logs
    let board = store.get('board', []);                 // public logs: [name, routeId, date, style, logId]
    let me = store.get('climber', null);                // { name, code } once the server has accepted them
    let pendingMe = store.get('climber-pending', null); // typed in while offline, not checked yet
    let tab = 'routes', period = 'all';

    // ---- points: grades are worth more as they get harder ----
    //  5.5 and under 1 · 5.6 2 · 5.7 3 · 5.8 4 · 5.9 5 · 5.10a 6 · 5.10b 7 ... +1 per letter (5.11a 10, 5.12a 14)
    //  Boulders: V0 4 · V1 6 · V2 8 ... +2 per V grade (V5 14, V10 24)
    //  No grade: 1 point. Each route counts once per climber. Lead routes only count if led.
    function gradePoints(grade) {
      const g = ctx.parseGrade(grade);
      if (!g.sys) return 1;
      if (g.sys === 'V') return 4 + 2 * g.val;
      const num = Math.floor(g.val / 4), letter = g.val % 4;
      return num < 10 ? Math.max(1, num - 4) : 6 + (num - 10) * 4 + letter;
    }
    const logPoints = route => route ? gradePoints(route.Grade) : 0;
    const counts = style => !/attempt|top ?rope/i.test(style || '');

    // ---- leaderboard maths ----
    // Each climber counts each route once, at its best-scoring log.
    function standings(filter) {
      const people = new Map();
      board.forEach(([name, routeId, date, style]) => {
        const route = ctx.routeById.get(routeId);
        if (!route || !counts(style) || (filter && !filter(route, date))) return;
        const key = name.toLowerCase();
        if (!people.has(key)) people.set(key, { name, routes: new Map() });
        const p = people.get(key), pts = logPoints(route), had = p.routes.get(routeId);
        if (!had || pts > had.pts) p.routes.set(routeId, { route, pts, style, date });
      });
      return [...people.values()].map(p => {
        const list = [...p.routes.values()];
        const best = list.slice().sort((a, b) => gradePoints(b.route.Grade) - gradePoints(a.route.Grade))[0];
        return { name: p.name, count: list.length, points: list.reduce((n, x) => n + x.pts, 0), hardest: best && best.route.Grade, list };
      });
    }
    const thisYear = String(new Date().getFullYear());
    const inPeriod = date => period === 'all' || String(date).slice(0, 4) === thisYear;
    function areaFilter(areaId) {
      const ids = new Set([areaId, ...(ctx.descendants.get(areaId) || [])]);
      return route => ids.has(route.Area_ID);
    }
    const isMe = name => me && name.toLowerCase() === me.name.toLowerCase();

    function rankedHtml(rows, key, max, scope) {
      let place = 0, prev = null;
      return rows.slice(0, max).map((r, i) => {
        if (r[key] !== prev) { place = i + 1; prev = r[key]; }
        const medal = ['&#129351;', '&#129352;', '&#129353;'][place - 1] || place + '.';
        const sub = key === 'count' ? `${r.points} pts` : `${r.count} route${r.count === 1 ? '' : 's'}`;
        const climbs = r.list.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).map(x => {
          const area = ctx.areaById.get(x.route.Area_ID);
          return `<div class="lb-route"><span class="grade">${esc(x.route.Grade)}</span> ${esc(x.route.Route_Name)} <span class="muted">${esc(area ? area.Area_Name : '')} · ${niceDate(x.date)} · ${x.pts} pts</span></div>`;
        }).join('');
        return `<details class="lb-row${isMe(r.name) ? ' me' : ''}" data-key="lb-${esc(scope)}-${esc(r.name.toLowerCase())}"><summary><span class="lb-place">${medal}</span>` +
          `<span class="lb-name">${esc(r.name)}${r.hardest ? ` <span class="muted">hardest ${esc(r.hardest)}</span>` : ''}</span>` +
          `<span class="lb-val">${r[key]}<small>${key === 'count' ? (r.count === 1 ? ' route' : ' routes') : ' pts'}</small><br><span class="muted">${sub}</span></span></summary>${climbs}</details>`;
      }).join('');
    }

    // ---- pages ----
    // ---- latest sends: newest first (same date: most recently posted first) ----
    function latestSends(max) {
      return board.map((b, i) => ({ name: b[0], route: ctx.routeById.get(b[1]), date: b[2], style: b[3], i }))
        .filter(x => x.route && counts(x.style))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.i - a.i)
        .slice(0, max);
    }
    function ago(date) {
      const days = Math.round((new Date(today() + 'T12:00') - new Date(date + 'T12:00')) / 86400000);
      return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 7 ? `${days} days ago` : niceDate(date);
    }
    const sentence = x => `<b>${esc(x.name)}</b> ${x.style === LED ? 'led' : 'climbed'} <b>${esc(x.route.Route_Name)}</b> <span class="grade">${esc(x.route.Grade)}</span>`;
    function feedHtml() {
      const list = latestSends(40);
      if (!list.length) return `<p class="muted">No climbs posted yet. Be the first: tap <b>&#10003; Log</b> on any route.</p>`;
      return list.map(x => {
        const area = ctx.areaById.get(x.route.Area_ID);
        return `<div class="feed-row" data-goto-route="${esc(x.route.Route_ID)}">${sentence(x)}<div class="muted">${esc(area ? area.Area_Name : '')} · ${ago(x.date)}</div></div>`;
      }).join('');
    }
    // Card for the front page.
    function latestSendCardHtml() {
      const x = latestSends(1)[0];
      return `<button type="button" class="hl-card" data-lb-page="board" data-lb-goto="feed"><span class="hl-label">&#129495; Latest send</span>` +
        (x ? `<span class="hl-main">${sentence(x)}</span><span class="muted">${esc((ctx.areaById.get(x.route.Area_ID) || {}).Area_Name || '')} · ${ago(x.date)}</span>`
          : `<span class="hl-main">Nothing posted yet</span><span class="muted">Log a climb to get on the board</span>`) + `</button>`;
    }

    function boardPageHtml() {
      const btn = (attr, val, cur, label) => `<button type="button" class="lb-tab${val === cur ? ' on' : ''}" ${attr}="${val}">${label}</button>`;
      const tabs = `<h2>&#127942; Leaderboard</h2>` +
        `<div class="lb-tabs">${btn('data-lb-tab', 'routes', tab, 'Most routes')}${btn('data-lb-tab', 'points', tab, 'Points')}${btn('data-lb-tab', 'feed', tab, 'Latest sends')}</div>`;
      if (tab === 'feed') return tabs + feedHtml();
      const rows = standings((route, date) => inPeriod(date)).sort((a, b) =>
        tab === 'routes' ? b.count - a.count || b.points - a.points : b.points - a.points || b.count - a.count);
      const key = tab === 'routes' ? 'count' : 'points';
      return tabs +
        `<div class="lb-tabs small">${btn('data-lb-period', 'all', period, 'All time')}${btn('data-lb-period', 'year', period, thisYear)}</div>` +
        (rows.length ? rankedHtml(rows, key, 50, 'board') : `<p class="muted">No climbs posted ${period === 'year' ? 'this year ' : ''}yet. Be the first: tap <b>&#10003; Log</b> on any route.</p>`) +
        `<details class="lb-help" data-key="lb-help"><summary>How points work</summary><p>Harder grades are worth more: 5.6 = 2, 5.8 = 4, 5.9 = 5, 5.10a = 6, then +1 per letter (5.11a = 10, 5.12a = 14). ` +
        `Boulders: V0 = 4, then +2 per grade (V3 = 10, V5 = 14). Sport and trad routes only count if you led them. Each route counts once per climber.</p></details>` +
        `<p class="muted">Logging is honour system. Posting is optional; your logs are always saved on your phone.</p>`;
    }

    function myLogs() {
      const local = ticks.map(t => ({ ...t, where: !counts(t.style) ? 'tr' : t.posted ? 'public' : t.wantPost ? 'waiting' : 'phone' }));
      const ids = new Set(local.map(t => t.id));
      const remote = me ? board.filter(b => isMe(b[0]) && !ids.has(b[4]))
        .map(b => ({ id: b[4], routeId: b[1], date: b[2], style: b[3], where: 'elsewhere', posted: true })) : [];
      return local.concat(remote).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    }

    function minePageHtml() {
      const logs = myLogs();
      const best = new Map();
      logs.forEach(t => {
        const r = ctx.routeById.get(t.routeId);
        if (!r || !counts(t.style)) return;
        const pts = logPoints(r);
        if (!best.has(t.routeId) || pts > best.get(t.routeId)) best.set(t.routeId, pts);
      });
      const points = [...best.values()].reduce((a, b) => a + b, 0);
      const label = { public: 'on leaderboard', waiting: 'will post when online', phone: 'only on this phone', elsewhere: 'posted from another device', tr: "top roped, doesn't count" };
      const rows = logs.map(t => {
        const r = ctx.routeById.get(t.routeId) || { Route_Name: '(route removed)', Grade: '' };
        const area = ctx.areaById.get(r.Area_ID);
        return `<div class="my-log"><div><span class="grade">${esc(r.Grade)}</span> <b>${esc(r.Route_Name)}</b>` +
          `<div class="muted">${esc(area ? area.Area_Name : '')} · ${niceDate(t.date)} · <span class="tag ${t.where}">${label[t.where]}</span></div>` +
          `${t.note ? `<div class="my-note">${esc(t.note)}</div>` : ''}</div>` +
          `<button type="button" class="my-del" data-lb-del="${esc(t.id)}" aria-label="Delete this log">&times;</button></div>`;
      }).join('');
      return `<h2>&#10003; My climbs</h2>` +
        (me ? `<p class="muted">Climbing as <b>${esc(me.name)}</b> <button type="button" class="linkish" data-lb-signout>Not you?</button></p>` : '') +
        `<div class="my-stats"><div><b>${best.size}</b><span>routes</span></div><div><b>${points}</b><span>points</span></div><div><b>${logs.length}</b><span>logs</span></div></div>` +
        (rows || '<p class="muted">Nothing logged yet. Tap <b>&#10003; Log</b> on any route you\'ve climbed.</p>');
    }

    // ---- bits added to the existing panels ----
    function homeButtonsHtml() {
      return `<div class="lb-home"><button type="button" class="sg-btn" data-lb-page="board">&#127942; Leaderboard</button>` +
        `<button type="button" class="sg-btn" data-lb-page="mine">&#10003; My climbs${ticks.length ? ` (${new Set(ticks.map(t => t.routeId)).size})` : ''}</button></div>`;
    }

    function cragBoardHtml(area) {
      const rows = standings(areaFilter(area.Area_ID)).sort((a, b) => b.count - a.count || b.points - a.points);
      if (!rows.length) return '';
      return `<details class="crag-board" data-key="cb-${esc(area.Area_ID)}"><summary>&#127942; Top climbers here</summary>${rankedHtml(rows, 'count', 5, area.Area_ID)}</details>`;
    }

    function routeRowHtml(r) {
      const sends = new Map();
      board.forEach(([name, routeId, date, style]) => {
        if (routeId !== r.Route_ID || !counts(style)) return;
        const k = name.toLowerCase();
        if (!sends.has(k) || String(date) < String(sends.get(k).date)) sends.set(k, { name, date, style });
      });
      const mine = ticks.filter(t => t.routeId === r.Route_ID && counts(t.style)).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
      const trOnly = !mine && ticks.some(t => t.routeId === r.Route_ID);
      const who = [...sends.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .map(s => `<div><b>${esc(s.name)}</b> <span class="muted">${niceDate(s.date)}</span></div>`).join('');
      return `<div class="lb-routebar">` +
        `<button type="button" class="lb-log${mine ? ' done' : ''}" data-lb-log="${esc(r.Route_ID)}">${mine ? (mine.style === LED ? '&#10003; Led' : '&#10003; Climbed') : trOnly ? '&#10003; Top roped' : '&#10003; Log'}</button>` +
        (sends.size ? `<details class="lb-who" data-key="w-${esc(r.Route_ID)}"><summary>${sends.size} climber${sends.size === 1 ? ' has' : 's have'} done this</summary>${who}</details>` : '') +
        `</div>`;
    }

    // ---- the Log pop-up ----
    const shell = document.createElement('div');
    shell.id = 'logbox';
    shell.hidden = true;
    shell.innerHTML = '<div class="sg-box" role="dialog" aria-modal="true" aria-labelledby="lb-title"></div>';
    document.body.appendChild(shell);
    const box = shell.firstChild;
    let editing = null;      // { route, tick }

    shell.addEventListener('click', e => { if (e.target === shell) closeLog(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !shell.hidden) closeLog(); });
    function closeLog() { shell.hidden = true; editing = null; }

    function openLog(routeId) {
      const route = ctx.routeById.get(routeId);
      if (!route) return;
      editing = { route, tick: null };
      const post = store.get('postdefault', true);
      const before = ticks.filter(t => t.routeId === routeId).sort((x, y) => String(y.date).localeCompare(String(x.date)))[0];
      box.innerHTML = `<button type="button" class="sg-x" data-lb-close aria-label="Close">&times;</button>` +
        `<h3 id="lb-title">Log: ${esc(route.Route_Name)}</h3><p class="sg-where"><span class="grade">${esc(route.Grade)}</span> · ${gradePoints(route.Grade)} pts</p>` +
        `<form novalidate>` +
        (before ? `<p class="sg-hint lb-again">You logged this on ${niceDate(before.date)}. Saving again adds another log (it still only counts once). To undo, use &#10003; My climbs.</p>` : '') +
        (isLeadRoute(route) ? `<div class="sg-field"><span>How did you climb it?</span><div class="lb-how">` +
          `<label><input type="radio" name="how" value="${LED}" checked> Led it</label>` +
          `<label><input type="radio" name="how" value="${TR}"> Top roped it</label></div>` +
          `<p class="sg-hint lb-tr-note" hidden>Top ropes of lead routes are saved to My climbs but don't count on the leaderboard.</p></div>` : '') +
        `<label class="sg-field"><span>Date climbed</span><input type="date" name="date" value="${today()}" max="${today()}"></label>` +
        `<label class="sg-field"><span>Note (only on your phone)</span><textarea name="note" rows="2" placeholder="Beta, partners, conditions..."></textarea></label>` +
        `<label class="lb-post"><input type="checkbox" name="post"${post ? ' checked' : ''}> Post to the public leaderboard</label>` +
        `<div class="lb-who-fields"${post ? '' : ' hidden'}>` +
        (me || pendingMe ? `<p class="sg-hint">Posting as <b>${esc((me || pendingMe).name)}</b>.</p>` :
          `<div class="sg-two"><label class="sg-field"><span>Climber name</span><input type="text" name="name" maxlength="30" autocomplete="nickname" placeholder="Shown on the leaderboard"></label>` +
          `<label class="sg-field"><span>Password</span><input type="password" name="code" autocomplete="off" placeholder="4+ characters"></label></div>` +
          `<p class="sg-hint">First time? Pick a name and a password. Only you can post under that name, and you can use it on any phone. ` +
          `Capitals don't matter in your name, but they do in your password. Don't use a password you use anywhere else.</p>`) +
        `</div>` +
        `<p class="sg-msg" role="status"></p>` +
        `<div class="sg-actions"><button type="button" data-lb-close>Cancel</button><button type="submit" class="sg-send">Save</button></div></form>`;
      shell.hidden = false;
    }

    box.addEventListener('change', e => {
      if (e.target.name === 'post') box.querySelector('.lb-who-fields').hidden = !e.target.checked;
      if (e.target.name === 'how') {
        const tr = e.target.value === TR;
        box.querySelector('.lb-tr-note').hidden = !tr;
        box.querySelector('.lb-post').hidden = tr;
        box.querySelector('.lb-who-fields').hidden = tr || !box.querySelector('[name=post]').checked;
      }
    });
    box.addEventListener('click', e => { if (e.target.closest('[data-lb-close]')) closeLog(); });
    box.addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target, msg = f.querySelector('.sg-msg'), btn = f.querySelector('.sg-send');
      const say = (t, bad) => { msg.textContent = t; msg.className = 'sg-msg' + (bad ? ' bad' : ''); };
      const how = f.elements.how ? [...f.elements.how].find(x => x.checked).value : DONE;
      const post = f.elements.post.checked && how !== TR;      // top ropes of lead routes never go public
      if (how !== TR) store.set('postdefault', f.elements.post.checked);
      let who = me || pendingMe;
      if (post && !who) {
        const name = f.elements.name.value.replace(/\s+/g, ' ').trim(), code = f.elements.code.value;
        if (name.length < 2) return say('Pick a climber name for the leaderboard.', true);
        if (code.length < 4) return say('Your password needs at least 4 characters.', true);
        who = { name, code };
      }
      // Saved on the phone first, so a log is never lost to a bad signal.
      if (!editing.tick) {
        editing.tick = { id: newId(), routeId: editing.route.Route_ID, date: f.elements.date.value || today(),
          style: how, note: f.elements.note.value.trim(), createdAt: new Date().toISOString(), wantPost: post, posted: false };
        ticks.push(editing.tick);
      } else {
        Object.assign(editing.tick, { date: f.elements.date.value || today(), style: how, note: f.elements.note.value.trim(), wantPost: post });
      }
      store.set('ticks', ticks);
      if (!post) { closeLog(); ctx.rerender(); return; }
      btn.disabled = true;
      say('Posting...');
      const res = await sendLog(editing.tick, who);
      btn.disabled = false;
      if (res.ok) { closeLog(); ctx.rerender(); return; }
      if (res.offline) { if (!me) { pendingMe = who; store.set('climber-pending', who); } say("No signal right now. It's saved on your phone and will post next time you open the map online."); setTimeout(() => { closeLog(); ctx.rerender(); }, 2200); return; }
      say(res.error + ' Your climb is saved on your phone either way.', true);
    });

    async function call(payload) {
      const res = await fetch(C.suggestUrl, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
      return res.json();
    }

    async function sendLog(tick, who) {
      const route = ctx.routeById.get(tick.routeId);
      try {
        const out = await call({ action: 'log', logId: tick.id, name: who.name, code: who.code, routeId: tick.routeId,
          routeName: route ? route.Route_Name : '', areaId: route ? route.Area_ID : '', grade: route ? route.Grade : '', style: tick.style, date: tick.date });
        if (!out.ok) return { error: out.error || 'Could not post.' };
        me = { name: out.name || who.name, code: who.code };
        store.set('climber', me);
        pendingMe = null;
        store.set('climber-pending', null);
        tick.posted = true;
        store.set('ticks', ticks);
        if (!board.some(b => b[4] === tick.id)) board.push([me.name, tick.routeId, tick.date, tick.style, tick.id]);
        store.set('board', board);
        return { ok: true };
      } catch (err) {
        return { offline: true };
      }
    }

    async function deleteTick(id) {
      const t = ticks.find(x => x.id === id);
      const fromBoard = board.find(b => b[4] === id);
      if ((t && t.posted) || fromBoard) {
        if (!me) return false;
        try {
          const out = await call({ action: 'unlog', logId: id, name: me.name, code: me.code });
          if (!out.ok) return false;
        } catch (err) { return false; }
      }
      ticks = ticks.filter(x => x.id !== id);
      board = board.filter(b => b[4] !== id);
      store.set('ticks', ticks);
      store.set('board', board);
      return true;
    }

    // Posts any climbs logged with no signal, once we're back online.
    async function postWaiting() {
      const who = me || pendingMe;
      if (!who) return;
      for (const t of ticks.filter(x => x.wantPost && !x.posted)) {
        const res = await sendLog(t, me || who);
        if (!res.ok) break;     // offline again, or the name/code was refused: try again next visit
      }
    }

    function loadBoard() {
      fetch(C.suggestUrl + (C.suggestUrl.includes('?') ? '&' : '?') + 'action=board')
        .then(r => r.json())
        .then(out => {
          if (!out || !out.ok || !Array.isArray(out.logs)) return;
          const changed = JSON.stringify(out.logs) !== JSON.stringify(board);
          board = out.logs;
          store.set('board', board);
          return postWaiting().then(() => { if (changed || ticks.some(t => t.wantPost)) ctx.rerender(); });
        })
        .catch(() => { /* offline: the saved board stays */ });
    }
    loadBoard();

    // ---- clicks from the panel ----
    function handleClick(e) {
      const log = e.target.closest('[data-lb-log]');
      if (log) { openLog(log.dataset.lbLog); return true; }
      const page = e.target.closest('[data-lb-page]');
      if (page) { if (page.dataset.lbGoto) tab = page.dataset.lbGoto; ctx.showPage(page.dataset.lbPage); return true; }
      const t = e.target.closest('[data-lb-tab]');
      if (t) { tab = t.dataset.lbTab; ctx.showPage('board'); return true; }
      const p = e.target.closest('[data-lb-period]');
      if (p) { period = p.dataset.lbPeriod; ctx.showPage('board'); return true; }
      if (e.target.closest('[data-lb-signout]')) { me = null; store.set('climber', null); ctx.showPage('mine'); return true; }
      const del = e.target.closest('[data-lb-del]');
      if (del) {
        if (!del.classList.contains('confirm')) { del.classList.add('confirm'); del.textContent = 'Delete?'; return true; }
        del.disabled = true;
        deleteTick(del.dataset.lbDel).then(ok => {
          if (ok) ctx.showPage('mine');
          else { del.disabled = false; del.textContent = "Couldn't delete (offline?)"; }
        });
        return true;
      }
      return false;
    }

    return {
      homeButtonsHtml, cragBoardHtml, routeRowHtml, handleClick, latestSendCardHtml,
      pageHtml: name => name === 'board' ? boardPageHtml() : minePageHtml(),
      gradePoints
    };
  };
})();
