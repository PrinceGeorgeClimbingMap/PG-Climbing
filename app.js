// Climbing map - page logic. You should not need to edit this file;
// all settings live in config.js.
(() => {
  'use strict';

  const C = window.CONFIG;
  const SHEETS = C.sheets || {};

  // ===========================================================================
  //  Helpers
  // ===========================================================================
  const $ = id => document.getElementById(id);
  const esc = s => s == null ? '' : String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hasCoords = o => o.Latitude != null && o.Longitude != null;
  const mapsLink = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  const byLabel = (a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true });

  function addTo(map, key, value) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }

  // ===========================================================================
  //  Loading data
  // ===========================================================================
  const NO_TYPE = '(no type)';
  const NUMERIC_COLUMNS = ['Latitude', 'Longitude', 'Height_m', 'End_Latitude', 'End_Longitude'];

  // Blank cells become null; number columns become numbers.
  function cleanRow(row) {
    for (const key in row) {
      const text = row[key] == null ? '' : String(row[key]).trim();
      row[key] = text === '' ? null : NUMERIC_COLUMNS.includes(key) ? (Number(text) || null) : text;
    }
    return row;
  }

  const parseCsv = text => Papa.parse(text || '', { header: true, skipEmptyLines: true }).data.map(cleanRow);

  // ---- remembered data: repeat visits show the last copy instantly, then check for updates ----
  const CACHE_PREFIX = 'pgmap-data:';
  const cacheGet = url => { try { return localStorage.getItem(CACHE_PREFIX + url); } catch (e) { return null; } };
  const cacheSet = (url, text) => { try { localStorage.setItem(CACHE_PREFIX + url, text); } catch (e) { /* full or blocked: fine */ } };

  const fetchText = url => fetch(url, { cache: 'no-cache' }).then(r => {
    if (!r.ok) throw new Error(url + ' -> ' + r.status);
    return r.text();
  });

  // Trail files: each may be a FeatureCollection or a single Feature.
  const loadTrails = files => Promise.all(
    files.map(f => fetch(f).then(r => r.ok ? r.json() : null).catch(() => null))
  ).then(list => list.filter(Boolean).flatMap(g =>
    g.type === 'FeatureCollection' ? g.features : g.type === 'Feature' ? [g] : []));

  // ===========================================================================
  //  Grades
  // ===========================================================================
  // Rope grades become 4 steps per number (a-d); boulder grades are the V number.
  function parseGrade(text) {
    const s = (text || '').trim();
    let m;
    if ((m = s.match(/^V(\d+)/))) return { sys: 'V', val: +m[1] };
    if ((m = s.match(/^5\.(\d+)([abcd])?(\+)?/))) return { sys: 'Y', val: +m[1] * 4 + (m[2] ? 'abcd'.indexOf(m[2]) : m[3] ? 2 : 1) };
    return { sys: null };
  }

  // Seven colour bands, red (easy) to violet (hard); -1 = ungraded.
  const BAND_COLORS = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#3949ab', '#8e24aa'];
  const BAND_LABELS = ['≤5.7 / V0–1', '5.8–5.9 / V2', '5.10a–b / V3', '5.10c–d / V4', '5.11 / V5', '5.12 / V6–7', '5.13+ / V8+'];

  function gradeBand(text) {
    const g = parseGrade(text);
    if (!g.sys) return -1;
    const v = g.val;
    if (g.sys === 'V') return v <= 1 ? 0 : v === 2 ? 1 : v === 3 ? 2 : v === 4 ? 3 : v === 5 ? 4 : v <= 7 ? 5 : 6;
    return v < 32 ? 0 : v < 40 ? 1 : v < 42 ? 2 : v < 44 ? 3 : v < 48 ? 4 : v < 52 ? 5 : 6;
  }

  // ===========================================================================
  //  Photos
  // ===========================================================================
  // Turns a Google Drive share link into a displayable image address.
  function normalizeUrl(raw) {
    const u = (raw || '').trim();
    const drive = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || u.match(/drive\.google\.com\/open\?id=([\w-]+)/);
    if (drive) return `https://drive.google.com/thumbnail?id=${drive[1]}&sz=w1200`;
    return /^(https?:\/\/|[\w\-./ %]+$)/.test(u) ? u : '';
  }

  const photo = (url, alt) => {
    const src = normalizeUrl(url);
    return src ? `<a href="${esc(src)}" target="_blank" rel="noopener"><img class="photo" loading="lazy" src="${esc(src)}" alt="${esc(alt)}"></a>` : '';
  };

  // Several photos in one cell, separated by semicolons.
  const photos = cell => cell ? String(cell).split(';').map(u => photo(u, 'Photo')).join('') : '';

  // Image_Location_or_URL is a full link, or a folder name used with Image_File_Name.
  function topoImageUrl(topo) {
    const where = (topo.Image_Location_or_URL || '').trim();
    const file = (topo.Image_File_Name || '').trim();
    const looksLikeImage = /\.(jpe?g|png|webp|gif)(\?|$)/i.test(where) || /drive\.google\.com/.test(where);
    if (where && file && !looksLikeImage) return where.replace(/\/?$/, '/') + file;
    return where || file;
  }

  // ===========================================================================
  //  Start
  // ===========================================================================
  // Title and colours straight away; the rest of the page stays behind the
  // loading screen until the data is in, so nothing jumps around as it fills.
  document.title = C.title;
  $('site-title').textContent = C.title;
  $('loading-title').textContent = C.title;
  document.documentElement.style.setProperty('--header', C.headerColor);
  document.documentElement.style.setProperty('--accent', C.gradeTextColor);
  const ready = () => document.body.classList.remove('loading');

  // [link, column every real row has (optional tables only)]. Areas and Routes must load.
  const TABLES = [
    [SHEETS.areas || 'Areas.csv'],
    [SHEETS.routes || 'Routes.csv'],
    [SHEETS.topos || 'Topos.csv', 'Topo_ID'],
    [SHEETS.topoRoutes || 'Topo_Routes.csv', 'Topo_ID'],
    [SHEETS.parking || 'Parking.csv', 'Parking_ID'],
    [SHEETS.approaches || 'Approaches.csv', 'Approach_ID'],
    [SHEETS.pitches || 'Pitches.csv', 'Route_ID']
  ];
  const tablesFrom = texts => TABLES.map(([, col], i) => {
    const rows = parseCsv(texts[i]);
    return col ? rows.filter(r => r[col]) : rows;
  });
  const fetchAll = () => Promise.all(TABLES.map(([url, col]) =>
    col ? fetchText(url).catch(() => '') : fetchText(url)));

  const failed = err => {
    console.error(err);
    ready();
    $('panel').textContent = 'Could not load the site data. Check the links in config.js, or make sure Areas.csv and Routes.csv sit next to index.html. If you opened this file by double-clicking it, put it on a web host instead.';
  };
  const trailsReady = loadTrails(C.trailFiles || []);
  const cached = TABLES.map(([url]) => cacheGet(url));

  if (cached[0] && cached[1]) {
    // Seen this before: draw from the saved copy now, then quietly check Google for changes.
    trailsReady.then(trails => { start([...tablesFrom(cached), trails]); ready(); }).catch(failed);
    fetchAll().then(fresh => {
      const changed = fresh.some((t, i) => t && t !== (cached[i] || ''));
      fresh.forEach((t, i) => { if (t) cacheSet(TABLES[i][0], t); });   // a blip on one table never wipes its saved copy
      if (changed) showUpdateNotice();
    }).catch(() => { /* offline or Google is slow: the saved copy stays on screen */ });
  } else {
    // First visit: wait for Google, then remember it for next time.
    Promise.all([fetchAll(), trailsReady]).then(([texts, trails]) => {
      texts.forEach((t, i) => { if (t) cacheSet(TABLES[i][0], t); });
      start([...tablesFrom(texts), trails]);
      ready();
    }).catch(failed);
  }

  // Small bar offering the newer info. Reloading picks it up from the saved copy, instantly.
  function showUpdateNotice() {
    if ($('update-notice')) return;
    const bar = document.createElement('div');
    bar.id = 'update-notice';
    bar.innerHTML = 'New route info is available <button type="button">Show it</button><button type="button" class="later" aria-label="Dismiss">&times;</button>';
    bar.querySelector('button').onclick = () => location.reload();
    bar.querySelector('.later').onclick = () => bar.remove();
    document.body.appendChild(bar);
  }

  function start([areas, routes, topos, topoRoutes, parking, approaches, pitchRows, trailFeatures]) {
    if (C.hideUnverified) {
      routes = routes.filter(r => !/unverified|needs review/i.test((r.Data_Confidence || '') + ' ' + (r.Route_Status || '')));
    }

    // ---- page chrome ----

    // ---- area tree ----
    const areaById = new Map(areas.map(a => [a.Area_ID, a]));
    const kidsOf = new Map();
    areas.forEach(a => { if (a.Parent_Area_ID) addTo(kidsOf, a.Parent_Area_ID, a); });

    function collectDescendants(id, seen = new Set([id])) {
      const out = [];
      for (const kid of kidsOf.get(id) || []) {
        if (seen.has(kid.Area_ID)) continue;       // guards against a parent loop in the sheet
        seen.add(kid.Area_ID);
        out.push(kid.Area_ID, ...collectDescendants(kid.Area_ID, seen));
      }
      return out;
    }
    const descendants = new Map(areas.map(a => [a.Area_ID, collectDescendants(a.Area_ID)]));

    // First ancestor (or the area itself) that has map coordinates.
    function coordsOf(id) {
      for (let i = 0; id && i < 10; i++) {
        const a = areaById.get(id);
        if (!a) return null;
        if (hasCoords(a)) return [a.Latitude, a.Longitude];
        id = a.Parent_Area_ID;
      }
      return null;
    }

    // ---- topos ----
    const routeById = new Map(routes.map(r => [r.Route_ID, r]));
    const linkedTopoIds = new Set(topoRoutes.map(x => x.Topo_ID));
    topos.forEach(t => { t.title = t.Topo_Name; t.image = topoImageUrl(t); });
    const topoById = new Map(topos.map(t => [t.Topo_ID, t]));

    const routesOnTopo = new Map();    // Topo_ID  -> [{ label, route }]
    const toposOfRoute = new Map();    // Route_ID -> [{ topo, label }]
    topoRoutes.forEach(x => {
      const route = routeById.get(x.Route_ID);
      const topo = topoById.get(x.Topo_ID);
      if (route) addTo(routesOnTopo, x.Topo_ID, { label: x.Label, route });
      if (route && topo) addTo(toposOfRoute, x.Route_ID, { topo, label: x.Label });
    });
    routesOnTopo.forEach(list => list.sort(byLabel));

    // ---- multi-pitch: rows in the Pitches tab, grouped by route and sorted by pitch number ----
    const pitchesOf = new Map();
    pitchRows.forEach(x => addTo(pitchesOf, x.Route_ID, x));
    pitchesOf.forEach(list => list.sort((a, b) => (parseFloat(a.Pitch) || 0) - (parseFloat(b.Pitch) || 0)));
    // A multi-pitch route with no grade of its own takes its hardest pitch.
    const gradeRank = t => { const g = parseGrade(t); return g.sys ? (g.sys === 'V' ? 100 : 0) + g.val : -1; };
    routes.forEach(r => {
      const list = pitchesOf.get(r.Route_ID);
      if (!r.Grade && list) r.Grade = list.map(x => x.Grade).filter(Boolean).sort((a, b) => gradeRank(b) - gradeRank(a))[0] || null;
    });

    // ---- parking ----
    const lotById = new Map(parking.map(p => [p.Parking_ID, p]));

    // ===========================================================================
    //  Filters
    // ===========================================================================
    const types = [...new Set(routes.map(r => r.Climb_Type || NO_TYPE))].sort();
    $('types').innerHTML = types.map(t => `<label><input type="checkbox" class="type-box" value="${esc(t)}" checked>${esc(t)}</label>`).join(' ');

    const fillSelect = (id, options) => {
      $(id).innerHTML = '<option value="">any</option>' + options.map(o => `<option value="${o}">${o}</option>`).join('');
    };
    const ropeGrades = Array.from({ length: 11 }, (_, i) => '5.' + (i + 3));     // 5.3 .. 5.13
    const boulderGrades = Array.from({ length: 11 }, (_, i) => 'V' + i);         // V0 .. V10
    fillSelect('rmin', ropeGrades); fillSelect('rmax', ropeGrades);
    fillSelect('bmin', boulderGrades); fillSelect('bmax', boulderGrades);

    // A route counts as multi-pitch when it has two or more rows in the Pitches tab.
    const isMulti = r => (pitchesOf.get(r.Route_ID) || []).length > 1;
    // No multi-pitch routes yet: hide the checkbox.
    if ($('multi-label') && !routes.some(isMulti)) $('multi-label').style.display = 'none';

    function readFilters() {
      const rope = id => $(id).value ? +$(id).value.slice(2) * 4 : null;
      const boulder = id => $(id).value ? +$(id).value.slice(1) : null;
      return {
        types: new Set([...document.querySelectorAll('.type-box:checked')].map(x => x.value)),
        text: $('q').value.trim().toLowerCase(),
        multi: $('multi') ? $('multi').checked : false,
        rope: [rope('rmin'), rope('rmax')],
        boulder: [boulder('bmin'), boulder('bmax')]
      };
    }

    function matches(route, f) {
      if (!f.types.has(route.Climb_Type || NO_TYPE)) return false;
      if (f.text && !(route.Route_Name || '').toLowerCase().includes(f.text)) return false;
      if (f.multi && !isMulti(route)) return false;
      const g = parseGrade(route.Grade);
      const [lo, hi] = g.sys === 'V' ? f.boulder : f.rope;
      if (lo === null && hi === null) return true;
      if (!g.sys) return false;
      const step = g.sys === 'V' ? 1 : 4;       // a boulder grade or a whole rope number
      return (lo === null || g.val >= lo) && (hi === null || g.val < hi + step);
    }

    let visible = [];           // routes passing the filters
    let visibleByArea = new Map();

    function computeVisible() {
      const f = readFilters();
      visible = routes.filter(r => matches(r, f));
      visibleByArea = new Map();
      visible.forEach(r => addTo(visibleByArea, r.Area_ID, r));
    }

    // Matching routes in an area and everything inside it.
    const countIn = id => [id, ...descendants.get(id)].reduce((n, x) => n + (visibleByArea.get(x) || []).length, 0);

    // ===========================================================================
    //  Side panel
    // ===========================================================================
    const panel = $('panel');
    let current = null;

    function topoCardsHtml(route) {
      return (toposOfRoute.get(route.Route_ID) || []).map(({ topo, label }) => {
        const legend = (routesOnTopo.get(topo.Topo_ID) || []).map(o =>
          `<div class="${o.route.Route_ID === route.Route_ID ? 'hl' : ''}" style="margin-top:3px"><span class="label">${esc(o.label)}</span>${esc(o.route.Route_Name)} <span class="grade">${esc(o.route.Grade)}</span></div>`).join('');
        return `<details class="topo-card" data-key="t-${esc(route.Route_ID)}-${esc(topo.Topo_ID)}"><summary>Topo: ${esc(topo.title || 'Topo')} - this route is <span class="label">${esc(label)}</span></summary>${topoHeader(topo)}${photo(topo.image, 'Topo: ' + (topo.title || ''))}${legend}${topoFooter(topo)}</details>`;
      }).join('');
    }

    const topoHeader = t => t.Orientation_or_Coverage ? ` <span class="muted">(${esc(t.Orientation_or_Coverage)})</span>` : '';
    const topoFooter = t =>
      (t.Notes ? `<div class="muted" style="margin-top:4px">${esc(t.Notes)}</div>` : '') +
      (t.Source_or_Credit ? `<div class="muted">Credit: ${esc(t.Source_or_Credit)}</div>` : '');

    // Topos attached to an area but not yet linked to any route.
    const unlinkedToposHtml = areaId => topos
      .filter(t => t.Area_ID === areaId && !linkedTopoIds.has(t.Topo_ID))
      .sort((a, b) => (parseFloat(a.Topo_Order) || 999) - (parseFloat(b.Topo_Order) || 999))
      .map(t => `<div class="topo-box"><b>${esc(t.title || 'Topo')}</b>${topoHeader(t)}${photo(t.image, 'Topo: ' + (t.title || ''))}${topoFooter(t)}</div>`)
      .join('');

    const metres = v => v == null ? null : /^\d+(\.\d+)?$/.test(String(v)) ? v + ' m' : String(v);

    // Pitch-by-pitch list for a multi-pitch route (collapsed; the summary shows each pitch's grade).
    function pitchesHtml(r) {
      const list = pitchesOf.get(r.Route_ID);
      if (!list || !list.length) return '';
      const grades = list.map(x => x.Grade || '?').map(esc).join(', ');
      const rows = list.map((x, i) => {
        const head = [x.Grade, metres(x.Length_m)].filter(Boolean).map(esc).join(' · ');
        return `<div class="pitch"><b>P${esc(x.Pitch || i + 1)}</b>${head ? ` <span class="grade">${head}</span>` : ''}${x.Description ? `<div>${esc(x.Description)}</div>` : ''}${photos(x.Photo_URL)}</div>`;
      }).join('');
      return `<details class="pitches" data-key="p-${esc(r.Route_ID)}"><summary>${list.length} pitches: ${grades}</summary>${rows}</details>`;
    }

    // ---- "Suggest a change" buttons (only when suggestUrl is set in config.js) ----
    let suggest = null;
    let logbook = null;
    let page = null;            // 'board' or 'mine' while a logbook page is open
    const canSuggest = () => !!C.suggestUrl;
    const routeSuggestHtml = r => {
      if (!canSuggest()) return '';
      // No grade: a yellow prompt. No description: a quiet "Add a description" link. Otherwise "Suggest an edit".
      if (!r.Grade) return `<button type="button" class="sg-gap" data-suggest="route" data-id="${esc(r.Route_ID)}">Know this route? Help fill it in</button>`;
      const text = !r.Description && !(pitchesOf.get(r.Route_ID) || []).length ? 'Add a description' : 'Suggest an edit';
      return `<button type="button" class="sg-link" data-suggest="route" data-id="${esc(r.Route_ID)}">&#9998; ${text}</button>`;
    };
    const areaSuggestHtml = a => !canSuggest() ? '' :
      `<div class="sg-area"><button type="button" class="sg-btn" data-suggest="addroute" data-id="${esc(a.Area_ID)}">+ Add a route here</button>` +
      `<button type="button" class="sg-btn" data-suggest="area" data-id="${esc(a.Area_ID)}">&#9998; Fix area info</button></div>`;

    function routeHtml(r) {
      const list = pitchesOf.get(r.Route_ID);
      const pitchCount = list && list.length > 1 ? list.length + ' pitches' : null;
      const meta = [r.Climb_Type, metres(r.Height_m), pitchCount, r.Gear, r.First_Ascent].filter(Boolean).map(esc).join(' · ');
      const status = C.showStatusTags && r.Route_Status ? `<span class="tag">${esc(r.Route_Status)}</span>` : '';
      const descent = r.Descent ? `<div class="descent"><b>Descent:</b> ${esc(r.Descent)}</div>` : '';
      return `<div class="route"><span class="grade">${esc(r.Grade)}</span> <b>${esc(r.Route_Name)}</b>${status}<div class="muted">${meta}</div><div>${esc(r.Description)}</div>${pitchesHtml(r)}${descent}${topoCardsHtml(r)}${logbook ? logbook.routeRowHtml(r) : ''}${routeSuggestHtml(r)}</div>`;
    }

    // Parking spots and approaches for an area.
    function infoHtml(areaId) {
      const lots = parking.filter(p => p.Area_ID === areaId).map(p =>
        `<div class="info"><span class="pkb">P</span> <b>${esc(p.Name || 'Parking')}</b>${hasCoords(p) ? ` <a href="${esc(mapsLink(p.Latitude, p.Longitude))}" target="_blank" rel="noopener">Open in Maps</a>` : ''}<div class="muted">${esc(p.Notes)}</div>${photos(p.Photo_URL)}</div>`);
      const walks = approaches.filter(x => x.Area_ID === areaId).map(x => {
        const meta = [x.Time_Min ? x.Time_Min + ' min' : null, x.Distance_km ? x.Distance_km + ' km' : null, x.Difficulty].filter(Boolean).map(esc).join(' · ');
        const lot = lotById.get(x.Parking_ID);
        return `<div class="info"><b>Approach: ${esc(x.Title || '')}</b> <span class="muted">${meta}</span>${lot ? `<div class="muted">From: ${esc(lot.Name || 'Parking')}</div>` : ''}<div>${esc(x.Description)}</div>${photos(x.Photo_URL)}</div>`;
      });
      return lots.join('') + walks.join('');
    }

    function subAreaHtml(a) {
      const own = visibleByArea.get(a.Area_ID) || [];
      const kids = kidsOf.get(a.Area_ID) || [];
      const n = countIn(a.Area_ID);
      return `<details data-sub="${esc(a.Area_ID)}" class="${n ? '' : 'empty'}"><summary>${esc(a.Area_Name)} (${n})</summary>` +
        (a.Access_Description ? `<div class="access">${esc(a.Access_Description)}</div>` : '') +
        infoHtml(a.Area_ID) + unlinkedToposHtml(a.Area_ID) +
        own.map(routeHtml).join('') + kids.map(subAreaHtml).join('') +
        (own.length || kids.length ? '' : '<div class="muted">No matching routes.</div>') +
        areaSuggestHtml(a) + (logbook ? logbook.cragBoardHtml(a) : '') +
        '</details>';
    }

    function showHome() {
      current = null;
      page = null;
      trailLayer.clearLayers();
      updateSubPins();
      const top = areas.filter(a => !a.Parent_Area_ID).map(a => ({ a, n: countIn(a.Area_ID) })).sort((x, y) => y.n - x.n);
      panel.innerHTML =
        `<h2>Areas</h2>   ${C.aboutText ? `<p>${esc(C.aboutText).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')}</p>` : ''}<p class="muted">${visible.length} matching route(s). Click a marker or an area below.</p>` +
        (logbook ? logbook.homeButtonsHtml() : '') +
        top.map(({ a, n }) => `<div class="item${n ? '' : ' off'}" data-area="${esc(a.Area_ID)}"><span>${esc(a.Area_Name)}${hasCoords(a) ? '' : ' <span class="tag">not on map</span>'}</span><b>${n}</b></div>`).join('') +
        (canSuggest() ? `<button type="button" class="sg-btn sg-wide" data-suggest="crag">+ Know a crag that's missing? Add it</button>` : '');
      panel.scrollTop = 0;
    }

    function showArea(a) {
      current = a;
      page = null;
      const own = visibleByArea.get(a.Area_ID) || [];
      let html = `<button type="button" class="back" data-home>&larr; Back to all areas</button><h2>${esc(a.Area_Name)}</h2><div class="muted">${esc(a.Area_Level)} · ${countIn(a.Area_ID)} matching route(s)</div>`;
      html += areaSuggestHtml(a);
      if (logbook) html += logbook.cragBoardHtml(a);
      if (a.Access_Description) html += `<div class="access">${esc(a.Access_Description)}</div>`;
      html += infoHtml(a.Area_ID) + unlinkedToposHtml(a.Area_ID);
      if (own.length) html += `<details open data-key="own"><summary>Routes here (${own.length})</summary>${own.map(routeHtml).join('')}</details>`;
      html += (kidsOf.get(a.Area_ID) || []).map(subAreaHtml).join('');
      panel.innerHTML = html;
      panel.scrollTop = 0;
      if (phone.matches && sheetStop === 'mini') setSheet('half');
      drawTrails(a);
      updateSubPins();
    }

    function pick(id) {
      const a = areaById.get(id);
      if (!a) return;
      showArea(a);
      focusMap(a);
    }

    // Zoom so the area's pin, its trail and approach lines, and its parking are all in view.
    // With nothing else to show, zoom in on the area's map point instead.
    function focusMap(a) {
      const zoom = C.areaZoom || 16;
      const ids = new Set([a.Area_ID, ...descendants.get(a.Area_ID)]);
      const lotIds = new Set(approaches.filter(x => ids.has(x.Area_ID)).map(x => x.Parking_ID));
      const points = [];
      if (hasCoords(a)) points.push([a.Latitude, a.Longitude]);
      // Sub area pins too, so every wall's pin is in view.
      [...ids].forEach(id => { const x = areaById.get(id); if (x && x !== a && hasCoords(x)) points.push([x.Latitude, x.Longitude]); });
      parking.filter(p => hasCoords(p) && (ids.has(p.Area_ID) || lotIds.has(p.Parking_ID)))
        .forEach(p => points.push([p.Latitude, p.Longitude]));
      let bounds = null;
      trailLayer.eachLayer(layer => {
        const b = layer.getBounds();
        bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
      });
      points.forEach(pt => { bounds = bounds ? bounds.extend(pt) : L.latLngBounds(pt, pt); });
      if (bounds && bounds.isValid() && !bounds.getSouthWest().equals(bounds.getNorthEast())) {
        map.fitBounds(bounds, fitOpts({ maxZoom: zoom + 1 }));
      } else if (points.length) {
        centerOn(points[0], Math.max(map.getZoom(), zoom));   // never zooms back out
      }
    }

    // Opening a sub area in the panel zooms the map to it and shows only its trails.
    // Closing it goes back to the next open sub area, or to the main area.
    function focusSub(a) {
      drawTrails(a);
      focusMap(a);
    }
    let restoring = false;
    panel.addEventListener('toggle', e => {
      if (restoring) return;
      const box = e.target;
      if (!box.matches || !box.matches('details[data-sub]')) return;
      if (box.open) {
        const a = areaById.get(box.dataset.sub);
        if (a) focusSub(a);
      } else if (current) {
        const stillOpen = [...panel.querySelectorAll('details[data-sub][open]')].pop();
        const a = stillOpen && areaById.get(stillOpen.dataset.sub);
        focusSub(a || current);
      }
    }, true);

    panel.addEventListener('click', e => {
      if (logbook && logbook.handleClick(e)) return;
      const sg = e.target.closest('[data-suggest]');
      if (sg) { if (suggest) suggest.open(sg.dataset.suggest, sg.dataset.id); return; }
      if (e.target.closest('[data-home]')) return goHome();
      const item = e.target.closest('[data-area]');
      if (item) pick(item.dataset.area);
    });

    // ===========================================================================
    //  Map
    // ===========================================================================
    const map = L.map('map');

    // ===========================================================================
    //  Phones: the list is a drawer over the bottom of the map (peek / half / full)
    // ===========================================================================
    const phone = window.matchMedia('(max-width: 700px)');
    const wrapEl = $('wrap');
    let sheetStop = 'half';
    let sheetPx = 0;
    const sheetStops = () => {
      const H = wrapEl.clientHeight;
      return { mini: Math.min(96, H * 0.25), half: Math.round(H * 0.45), full: Math.round(H - 56) };
    };
    function setSheet(stop, px) {
      if (!phone.matches) { sheetPx = 0; wrapEl.style.removeProperty('--sheet-h'); return; }
      sheetStop = stop || sheetStop;
      sheetPx = Math.round(px != null ? px : sheetStops()[sheetStop]);
      wrapEl.style.setProperty('--sheet-h', sheetPx + 'px');
    }
    // How much of the map the drawer covers, so zooming keeps things in the part you can see.
    const coveredBottom = () => phone.matches ? sheetPx : 0;
    const fitOpts = extra => Object.assign({ paddingTopLeft: [50, 50], paddingBottomRight: [50, 50 + coveredBottom()] }, extra);
    function centerOn(latlng, zoom) {
      map.setView(latlng, zoom, { animate: false });
      if (coveredBottom()) map.panBy([0, coveredBottom() / 2], { animate: false });
    }

    (function drawerDrag() {
      const handle = $('sheet-handle');
      let startY = null, startPx = 0, moved = false;
      handle.addEventListener('pointerdown', e => {
        if (!phone.matches) return;
        startY = e.clientY; startPx = sheetPx; moved = false;
        handle.setPointerCapture(e.pointerId);
        wrapEl.classList.add('dragging');
      });
      handle.addEventListener('pointermove', e => {
        if (startY == null) return;
        const dy = e.clientY - startY;
        if (Math.abs(dy) > 4) moved = true;
        const st = sheetStops();
        setSheet(null, Math.max(st.mini, Math.min(st.full, startPx - dy)));
      });
      const end = e => {
        if (startY == null) return;
        const dy = e.clientY - startY;
        startY = null;
        wrapEl.classList.remove('dragging');
        const st = sheetStops();
        if (!moved) {
          setSheet(sheetStop === 'full' ? 'half' : sheetStop === 'half' ? 'full' : 'half');      // a tap steps it up or back
        } else {
          // Snap to the nearest stop, leaning the way the finger was going.
          const target = sheetPx - dy * 0.3;
          setSheet(Object.keys(st).reduce((a, b) => Math.abs(st[b] - target) < Math.abs(st[a] - target) ? b : a));
        }
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      handle.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSheet(sheetStop === 'full' ? 'half' : 'full'); }
      });
    })();

    // Filters button (phones): opens the filter controls under the title.
    $('filter-toggle').addEventListener('click', () => {
      const open = $('top').classList.toggle('open');
      $('filter-toggle').setAttribute('aria-expanded', open);
      setSheet();
      map.invalidateSize();
    });
    const relayout = () => { setSheet(); map.invalidateSize(); };
    window.addEventListener('resize', relayout);
    if (phone.addEventListener) phone.addEventListener('change', relayout);
    setSheet('half');

    // ---- background maps (switch with the layers button, top right) ----
    const basemaps = {
      'Map': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 22, maxNativeZoom: 19, attribution: '&copy; OpenStreetMap contributors'
      }),
      'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        // Esri's sharpest photos are zoom 19; past that the tiles are enlarged so you can keep zooming in.
        maxZoom: 22, maxNativeZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics'
      }),
      'Topo': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxZoom: 22, maxNativeZoom: 17, subdomains: 'abc',
        attribution: 'Map data &copy; OpenStreetMap contributors, SRTM | Style &copy; OpenTopoMap (CC-BY-SA)'
      })
    };
    (basemaps[C.defaultBasemap] || basemaps['Map']).addTo(map);
    L.control.layers(basemaps, null, { position: 'topright' }).addTo(map);

    const trailLayer = L.layerGroup().addTo(map);
    const parkLayer = L.layerGroup().addTo(map);

    // ---- approach lines: parking spot -> (optional waypoints) -> climbing area ----
    function approachPoints(x) {
      const lot = lotById.get(x.Parking_ID);
      if (!lot || !hasCoords(lot)) return null;
      const via = String(x.Path || '').split(';').map(s => s.split(',').map(Number))
        .filter(p => p.length === 2 && isFinite(p[0]) && isFinite(p[1]) && p[0] !== 0);
      const end = x.End_Latitude != null && x.End_Longitude != null ? [x.End_Latitude, x.End_Longitude] : coordsOf(x.Area_ID);
      return [[lot.Latitude, lot.Longitude], ...via, ...(end ? [end] : [])];
    }

    function drawApproaches(list) {
      list.forEach(x => {
        const pts = approachPoints(x);
        if (!pts || pts.length < 2) return;
        L.polyline(pts, { color: '#1565c0', weight: 4, dashArray: '8 6' })
          .bindTooltip(esc(`Approach: ${x.Title || ''}${x.Time_Min ? ' (' + x.Time_Min + ' min)' : ''}`))
          .addTo(trailLayer);
      });
    }

    // Trail lines and approach lines for an area and everything inside it.
    function drawTrails(a) {
      trailLayer.clearLayers();
      const ids = new Set([a.Area_ID, ...descendants.get(a.Area_ID)]);
      const features = trailFeatures.filter(f => f.properties && ids.has(f.properties.Area_ID));
      if (features.length) {
        L.geoJSON({ type: 'FeatureCollection', features }, { style: { color: '#1565c0', weight: 3, dashArray: '6 6' } }).addTo(trailLayer);
      }
      drawApproaches(approaches.filter(x => ids.has(x.Area_ID)));
      // A sub area with no trail of its own shows its main area's trail instead.
      if (!trailLayer.getLayers().length && a.Parent_Area_ID && areaById.get(a.Parent_Area_ID)) {
        drawTrails(areaById.get(a.Parent_Area_ID));
      }
    }

    // ---- parking markers ----
    // Parking for a sub area only shows while its main area (or one of its sub areas) is open.
    computeVisible();
    const subParkLayer = L.layerGroup().addTo(parkLayer);
    const subParking = [];
    parking.filter(hasCoords).forEach(p => {
      const area = areaById.get(p.Area_ID);
      const root = area && rootOf(area);
      const alwaysShown = !area || !area.Parent_Area_ID || !hasCoords(root);
      const marker = L.marker([p.Latitude, p.Longitude], { icon: L.divIcon({ className: '', iconSize: [20, 20], iconAnchor: [10, 10], html: '<div class="pk">P</div>' }) })
        .bindTooltip(esc(p.Name || 'Parking'))
        .bindPopup(`<b>${esc(p.Name || 'Parking')}</b><br>${esc(p.Notes)}<br>${photos(p.Photo_URL)}<a href="${esc(mapsLink(p.Latitude, p.Longitude))}" target="_blank" rel="noopener">Open in Maps</a>`, { maxWidth: 260 })
        .on('click', () => { trailLayer.clearLayers(); drawApproaches(approaches.filter(x => x.Parking_ID === p.Parking_ID)); });
      if (alwaysShown) marker.addTo(parkLayer);
      else subParking.push({ marker, root: root.Area_ID });
    });
    $('parking-toggle').addEventListener('change', e => e.target.checked ? parkLayer.addTo(map) : map.removeLayer(parkLayer));

    // ---- area pins: number = routes, ring = mix of grades ----
    // only (optional): count just the routes it returns true for.
    function pinIcon(a, only) {
      const perBand = new Array(7).fill(0);
      let count = 0;
      for (const id of [a.Area_ID, ...descendants.get(a.Area_ID)]) {
        for (const r of visibleByArea.get(id) || []) {
          if (only && !only(r)) continue;
          count++;
          const b = gradeBand(r.Grade);
          if (b >= 0) perBand[b]++;
        }
      }
      const total = perBand.reduce((x, y) => x + y, 0);
      let used = 0;
      const stops = [];
      perBand.forEach((n, i) => {
        if (!n) return;
        stops.push(`${BAND_COLORS[i]} ${used / total * 100}% ${(used + n) / total * 100}%`);
        used += n;
      });
      const ring = total ? `conic-gradient(${stops.join(',')})` : '#999';
      const n = count;
      return L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="pin${n ? '' : ' none'}" style="background:${ring}"><span>${n}</span></div>` });
    }

    const tooltipFor = a => esc(`${a.Area_Name}: ${countIn(a.Area_ID)} route(s)`);
    // Main area at the top of an area's family tree.
    function rootOf(a) {
      for (let i = 0; a && a.Parent_Area_ID && i < 10; i++) {
        const up = areaById.get(a.Parent_Area_ID);
        if (!up) break;
        a = up;
      }
      return a;
    }

    // Sub area pins only show while their main area (or one of its sub areas) is open.
    // A sub area whose main area has no map point is always shown, so it can still be found.
    const subPinLayer = L.layerGroup().addTo(map);
    const markers = areas.filter(hasCoords).map(a => {
      const marker = L.marker([a.Latitude, a.Longitude], { icon: pinIcon(a) }).bindTooltip(tooltipFor(a)).on('click', () => pick(a.Area_ID));
      const root = rootOf(a);
      const alwaysShown = !a.Parent_Area_ID || !hasCoords(root);
      marker.addTo(alwaysShown ? map : subPinLayer);
      return { area: a, marker, root: root.Area_ID, alwaysShown };
    });

    // True when every route in a main area sits in a sub area that has its own pin,
    // so the main pin adds nothing once the sub area pins are showing.
    // Does this route already show on a sub area pin (its area, or a parent below the main area, has a map point)?
    function onSubPin(r, rootId) {
      for (let a = areaById.get(r.Area_ID), i = 0; a && a.Area_ID !== rootId && i < 10; a = areaById.get(a.Parent_Area_ID), i++) {
        if (hasCoords(a)) return true;
      }
      return false;
    }

    function updateSubPins() {
      subPinLayer.clearLayers();
      subParkLayer.clearLayers();
      const open = current ? rootOf(current).Area_ID : null;
      const subPins = open ? markers.filter(m => !m.alwaysShown && m.root === open) : [];
      subPins.forEach(m => m.marker.addTo(subPinLayer));
      if (open) subParking.filter(m => m.root === open).forEach(m => m.marker.addTo(subParkLayer));
      // While an area with sub area pins is open, its own pin only counts the routes that
      // are NOT on a sub area pin (routes on the main area, or in sub areas with no map point).
      // If that leaves none, the main pin hides. "Back to all areas" puts the full count back.
      markers.filter(m => m.alwaysShown && !m.area.Parent_Area_ID).forEach(m => {
        const a = m.area;
        if (a.Area_ID === open && subPins.length > 0) {
          const leftover = r => !onSubPin(r, a.Area_ID);
          const n = [a.Area_ID, ...descendants.get(a.Area_ID)].reduce((t, id) => t + (visibleByArea.get(id) || []).filter(leftover).length, 0);
          if (!n) { map.removeLayer(m.marker); return; }
          m.marker.setIcon(pinIcon(a, leftover)).setTooltipContent(esc(`${a.Area_Name} (routes not on a wall pin): ${n} route(s)`));
        } else {
          m.marker.setIcon(pinIcon(a)).setTooltipContent(tooltipFor(a));
        }
        if (!map.hasLayer(m.marker)) m.marker.addTo(map);
      });
    }
    updateSubPins();

    // The starting view: every main area in sight. "Back to all areas" and Reset return here.
    const mainPins = markers.filter(m => m.alwaysShown);
    const homeBounds = mainPins.length ? L.featureGroup(mainPins.map(m => m.marker)).getBounds().pad(0.15) : null;
    const zoomHome = () => { if (homeBounds) map.fitBounds(homeBounds, fitOpts()); };
    zoomHome();

    function goHome() {
      showHome();
      zoomHome();
    }


    // Shrink the pins when zoomed far out so they do not crowd each other.
    const updateZoomClass = () => $('map').classList.toggle('far', map.getZoom() < 11);
    map.on('zoomend', updateZoomClass);
    updateZoomClass();

    // Grade legend: click it to collapse, or set showLegend: false in config.js to remove it.
    if (C.showLegend === false) {
      $('legend').remove();
    } else {
      $('legend').innerHTML = '<div class="legend-head"><b>Ring = grade mix</b> <span class="legend-arrow">&#9662;</span></div><div class="legend-body">' +
        BAND_COLORS.map((c, i) => `<div><i style="background:${c}"></i>${BAND_LABELS[i]}</div>`).join('') + 'Number = routes</div>';
      $('legend').addEventListener('click', () => $('legend').classList.toggle('collapsed'));
      if (phone.matches) $('legend').classList.add('collapsed');     // small screens start with it folded
    }

    // ===========================================================================
    //  Wiring
    // ===========================================================================
    // Filters button shows when any filter is on (phones only show the button).
    function updateFilterBadge() {
      const on = [...document.querySelectorAll('#filters select')].some(x => x.value) || $('q').value.trim() ||
        ($('multi') && $('multi').checked) || [...document.querySelectorAll('.type-box')].some(x => !x.checked);
      $('filter-toggle').classList.toggle('on', !!on);
      $('filter-toggle').textContent = on ? 'Filters \u2022 on' : 'Filters';
    }

    function refresh() {
      updateFilterBadge();
      computeVisible();
      markers.forEach(({ area, marker }) => { marker.setIcon(pinIcon(area)); marker.setTooltipContent(tooltipFor(area)); });
      return page ? showPage(page) : current ? showArea(current) : showHome();
    }

    // Leaderboard and My climbs pages.
    function showPage(name) {
      current = null;
      page = name;
      trailLayer.clearLayers();
      updateSubPins();
      panel.innerHTML = `<button type="button" class="back" data-home>&larr; Back to all areas</button>` + logbook.pageHtml(name);
      panel.scrollTop = 0;
      if (phone.matches && sheetStop === 'mini') setSheet('half');
    }

    // Redraw the panel in place (after logging a climb) without losing your spot or open sections.
    function rerender() {
      const y = panel.scrollTop;
      // Sections are matched by name (data-key / data-sub), so new ones appearing can't shuffle them.
      const keyOf = d => d.dataset.key || (d.dataset.sub ? 's-' + d.dataset.sub : null);
      const open = new Map([...panel.querySelectorAll('details')].map(d => [keyOf(d), d.open]).filter(([k]) => k));
      if (page) showPage(page); else if (current) showArea(current); else showHome();
      restoring = true;
      panel.querySelectorAll('details').forEach(d => { const k = keyOf(d); if (k && open.has(k)) d.open = open.get(k); });
      panel.scrollTop = y;
      setTimeout(() => { restoring = false; }, 0);
    }

    $('filters').addEventListener('input', refresh);
    $('reset').addEventListener('click', () => {
      document.querySelectorAll('#filters select').forEach(s => { s.value = ''; });
      $('q').value = '';
      if ($('multi')) $('multi').checked = false;
      document.querySelectorAll('.type-box').forEach(c => { c.checked = true; });
      current = null;
      refresh();
      zoomHome();
    });

    if (window.makeLogbook) {
      logbook = window.makeLogbook({ config: C, routeById, areaById, descendants, parseGrade, rerender, showPage });
    }
    if (window.makeSuggest) {
      suggest = window.makeSuggest({
        config: C, map, areaById, routeById, pitchesOf,
        mainAreas: () => areas.filter(a => !a.Parent_Area_ID).sort((x, y) => String(x.Area_Name).localeCompare(String(y.Area_Name)))
      });
    }

    showHome();
  }
})();
