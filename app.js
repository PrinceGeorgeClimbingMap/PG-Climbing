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

  const loadCsv = url => new Promise((resolve, reject) =>
    Papa.parse(url, {
      download: true, header: true, skipEmptyLines: true,
      complete: result => resolve(result.data.map(cleanRow)),
      error: reject
    }));

  // Optional tables: a missing or broken one is treated as empty.
  const loadOptionalCsv = (url, requiredColumn) =>
    loadCsv(url).then(rows => rows.filter(r => r[requiredColumn])).catch(() => []);

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
  Promise.all([
    loadCsv(SHEETS.areas || 'Areas.csv'),
    loadCsv(SHEETS.routes || 'Routes.csv'),
    loadOptionalCsv(SHEETS.topos || 'Topos.csv', 'Topo_ID'),
    loadOptionalCsv(SHEETS.topoRoutes || 'Topo_Routes.csv', 'Topo_ID'),
    loadOptionalCsv(SHEETS.parking || 'Parking.csv', 'Parking_ID'),
    loadOptionalCsv(SHEETS.approaches || 'Approaches.csv', 'Approach_ID'),
    loadTrails(C.trailFiles || [])
  ]).then(start).catch(err => {
    console.error(err);
    $('panel').textContent = 'Could not load the site data. Check the links in config.js, or make sure Areas.csv and Routes.csv sit next to index.html. If you opened this file by double-clicking it, put it on a web host instead.';
  });

  function start([areas, routes, topos, topoRoutes, parking, approaches, trailFeatures]) {
    if (C.hideUnverified) {
      routes = routes.filter(r => !/unverified|needs review/i.test((r.Data_Confidence || '') + ' ' + (r.Route_Status || '')));
    }

    // ---- page chrome ----
    document.title = C.title;
    $('site-title').textContent = C.title;
    document.documentElement.style.setProperty('--header', C.headerColor);
    document.documentElement.style.setProperty('--accent', C.gradeTextColor);

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

    function readFilters() {
      const rope = id => $(id).value ? +$(id).value.slice(2) * 4 : null;
      const boulder = id => $(id).value ? +$(id).value.slice(1) : null;
      return {
        types: new Set([...document.querySelectorAll('.type-box:checked')].map(x => x.value)),
        text: $('q').value.trim().toLowerCase(),
        rope: [rope('rmin'), rope('rmax')],
        boulder: [boulder('bmin'), boulder('bmax')]
      };
    }

    function matches(route, f) {
      if (!f.types.has(route.Climb_Type || NO_TYPE)) return false;
      if (f.text && !(route.Route_Name || '').toLowerCase().includes(f.text)) return false;
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
        return `<details class="topo-card"><summary>Topo: ${esc(topo.title || 'Topo')} - this route is <span class="label">${esc(label)}</span></summary>${topoHeader(topo)}${photo(topo.image, 'Topo: ' + (topo.title || ''))}${legend}${topoFooter(topo)}</details>`;
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

    function routeHtml(r) {
      const meta = [r.Climb_Type, r.Height_m ? r.Height_m + ' m' : null, r.Gear, r.First_Ascent].filter(Boolean).map(esc).join(' · ');
      const status = C.showStatusTags && r.Route_Status ? `<span class="tag">${esc(r.Route_Status)}</span>` : '';
      return `<div class="route"><span class="grade">${esc(r.Grade)}</span> <b>${esc(r.Route_Name)}</b>${status}<div class="muted">${meta}</div><div>${esc(r.Description)}</div>${topoCardsHtml(r)}</div>`;
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
      return `<details class="${n ? '' : 'empty'}"><summary>${esc(a.Area_Name)} (${n})</summary>` +
        (a.Access_Description ? `<div class="access">${esc(a.Access_Description)}</div>` : '') +
        infoHtml(a.Area_ID) + unlinkedToposHtml(a.Area_ID) +
        own.map(routeHtml).join('') + kids.map(subAreaHtml).join('') +
        (own.length || kids.length ? '' : '<div class="muted">No matching routes.</div>') +
        '</details>';
    }

    function showHome() {
      current = null;
      trailLayer.clearLayers();
      const top = areas.filter(a => !a.Parent_Area_ID).map(a => ({ a, n: countIn(a.Area_ID) })).sort((x, y) => y.n - x.n);
      panel.innerHTML =
        `<h2>Areas</h2>${C.aboutText ? `<p>${esc(C.aboutText)}</p>` : ''}<p class="muted">${visible.length} matching route(s). Click a marker or an area below.</p>` +
        top.map(({ a, n }) => `<div class="item${n ? '' : ' off'}" data-area="${esc(a.Area_ID)}"><span>${esc(a.Area_Name)}${hasCoords(a) ? '' : ' <span class="tag">not on map</span>'}</span><b>${n}</b></div>`).join('');
      panel.scrollTop = 0;
    }

    function showArea(a) {
      current = a;
      const own = visibleByArea.get(a.Area_ID) || [];
      let html = `<span class="back" data-home>&larr; All areas</span><h2>${esc(a.Area_Name)}</h2><div class="muted">${esc(a.Area_Level)} · ${countIn(a.Area_ID)} matching route(s)</div>`;
      if (a.Access_Description) html += `<div class="access">${esc(a.Access_Description)}</div>`;
      html += infoHtml(a.Area_ID) + unlinkedToposHtml(a.Area_ID);
      if (own.length) html += `<details open><summary>Routes here (${own.length})</summary>${own.map(routeHtml).join('')}</details>`;
      html += (kidsOf.get(a.Area_ID) || []).map(subAreaHtml).join('');
      panel.innerHTML = html;
      panel.scrollTop = 0;
      drawTrails(a);
    }

    function pick(id) {
      const a = areaById.get(id);
      if (!a) return;
      showArea(a);
      focusMap(a);
    }

    // Zoom so the area's trail and approach lines are all in view.
    // With no lines to show, zoom in on the area's map point instead.
    function focusMap(a) {
      const zoom = C.areaZoom || 16;
      let bounds = null;
      trailLayer.eachLayer(layer => {
        const b = layer.getBounds();
        bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
      });
      if (bounds && hasCoords(a)) bounds.extend([a.Latitude, a.Longitude]);
      if (bounds && bounds.isValid()) {
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: zoom + 1 });
      } else if (hasCoords(a)) {
        map.setView([a.Latitude, a.Longitude], Math.max(map.getZoom(), zoom));   // never zooms back out
      }
    }

    panel.addEventListener('click', e => {
      if (e.target.closest('[data-home]')) return showHome();
      const item = e.target.closest('[data-area]');
      if (item) pick(item.dataset.area);
    });

    // ===========================================================================
    //  Map
    // ===========================================================================
    const map = L.map('map');

    // ---- background maps (switch with the layers button, top right) ----
    const basemaps = {
      'Map': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
      }),
      'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics'
      }),
      'Topo': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, maxNativeZoom: 17, subdomains: 'abc',
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
    }

    // ---- parking markers ----
    computeVisible();
    parking.filter(hasCoords).forEach(p => {
      L.marker([p.Latitude, p.Longitude], { icon: L.divIcon({ className: '', iconSize: [20, 20], iconAnchor: [10, 10], html: '<div class="pk">P</div>' }) })
        .bindTooltip(esc(p.Name || 'Parking'))
        .bindPopup(`<b>${esc(p.Name || 'Parking')}</b><br>${esc(p.Notes)}<br>${photos(p.Photo_URL)}<a href="${esc(mapsLink(p.Latitude, p.Longitude))}" target="_blank" rel="noopener">Open in Maps</a>`, { maxWidth: 260 })
        .on('click', () => { trailLayer.clearLayers(); drawApproaches(approaches.filter(x => x.Parking_ID === p.Parking_ID)); })
        .addTo(parkLayer);
    });
    $('parking-toggle').addEventListener('change', e => e.target.checked ? parkLayer.addTo(map) : map.removeLayer(parkLayer));

    // ---- area pins: number = routes, ring = mix of grades ----
    function pinIcon(a) {
      const perBand = new Array(7).fill(0);
      for (const id of [a.Area_ID, ...descendants.get(a.Area_ID)]) {
        for (const r of visibleByArea.get(id) || []) {
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
      const n = countIn(a.Area_ID);
      return L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="pin${n ? '' : ' none'}" style="background:${ring}"><span>${n}</span></div>` });
    }

    const tooltipFor = a => esc(`${a.Area_Name}: ${countIn(a.Area_ID)} route(s)`);
    const markers = areas.filter(hasCoords).map(a => ({
      area: a,
      marker: L.marker([a.Latitude, a.Longitude], { icon: pinIcon(a) }).bindTooltip(tooltipFor(a)).on('click', () => pick(a.Area_ID)).addTo(map)
    }));

    if (markers.length) map.fitBounds(L.featureGroup(markers.map(m => m.marker)).getBounds().pad(0.15));

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
    }

    // ===========================================================================
    //  Wiring
    // ===========================================================================
    function refresh() {
      computeVisible();
      markers.forEach(({ area, marker }) => { marker.setIcon(pinIcon(area)); marker.setTooltipContent(tooltipFor(area)); });
      return current ? showArea(current) : showHome();
    }

    $('filters').addEventListener('input', refresh);
    $('reset').addEventListener('click', () => {
      document.querySelectorAll('#filters select').forEach(s => { s.value = ''; });
      $('q').value = '';
      document.querySelectorAll('.type-box').forEach(c => { c.checked = true; });
      current = null;
      refresh();
    });

    showHome();
  }
})();
