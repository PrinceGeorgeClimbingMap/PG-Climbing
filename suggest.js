// Climbing map - "Suggest a change" form.
// Sends suggestions to the Google Apps Script web app set as suggestUrl in config.js.
// With no suggestUrl set, the buttons stay hidden and nothing here runs.
(() => {
  'use strict';

  const MAX_FILES = 6;
  const MAX_FILE_MB = 15;          // per file, before photos are shrunk
  const MAX_TOTAL_MB = 30;         // whole suggestion, after photos are shrunk
  const PHOTO_MAX_PX = 2000;       // long side of uploaded photos

  const esc = s => s == null ? '' : String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Route fields people can fill in or correct, matching the Routes tab columns.
  const ROUTE_FIELDS = [
    ['Route_Name', 'Route name'],
    ['Grade', 'Grade', 'e.g. 5.10a or V3'],
    ['Climb_Type', 'Type', 'Sport, Trad, Boulder...'],
    ['Height_m', 'Height (m)'],
    ['Gear', 'Gear', 'e.g. 8 draws, rack to 3"'],
    ['First_Ascent', 'First ascent', 'Name(s), year'],
    ['Description', 'Description', '', 'area'],
    ['Descent', 'Descent (multi-pitch)', 'Rappel, walk-off...', 'area']
  ];

  const TYPES = {
    route:    { label: 'Route edit',   title: r => `Suggest an edit: ${r.route.Route_Name || 'route'}` },
    addroute: { label: 'New route',    title: r => `Add a route: ${r.area.Area_Name}` },
    area:     { label: 'Area edit',    title: r => `Suggest an edit: ${r.area.Area_Name}` },
    crag:     { label: 'Missing crag', title: () => 'Add a missing crag' }
  };

  window.makeSuggest = function (ctx) {
    const C = ctx.config;
    if (!C.suggestUrl) return null;
    const map = ctx.map;

    // ---- the pop-up ----
    const shell = document.createElement('div');
    shell.id = 'suggest';
    shell.hidden = true;
    shell.innerHTML = '<div class="sg-box" role="dialog" aria-modal="true" aria-labelledby="sg-title"></div>';
    document.body.appendChild(shell);
    const box = shell.firstChild;

    const banner = document.createElement('div');
    banner.id = 'sg-pick';
    banner.hidden = true;
    document.getElementById('map').appendChild(banner);

    let state = null;          // what the open form is about
    let pickMarkers = [];      // pins placed with "Pick on map"

    shell.addEventListener('click', e => { if (e.target === shell) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !shell.hidden) close(); });

    function close() {
      shell.hidden = true;
      clearPicks();
      state = null;
    }

    function clearPicks() {
      pickMarkers.forEach(m => map.removeLayer(m));
      pickMarkers = [];
      banner.hidden = true;
      map.off('click', onPick);
      document.getElementById('map').classList.remove('sg-picking');
    }

    // ---- open a form ----
    // kind: route | addroute | area | crag ; id: Route_ID or Area_ID
    function open(kind, id) {
      const route = kind === 'route' ? ctx.routeById.get(id) : null;
      const area = route ? ctx.areaById.get(route.Area_ID) : kind === 'crag' ? null : ctx.areaById.get(id);
      if (kind !== 'crag' && !area) return;
      clearPicks();
      state = { kind, route, area, before: {}, picks: {} };
      box.innerHTML = formHtml(state);
      shell.hidden = false;
      box.scrollTop = 0;
      const first = box.querySelector('input:not([type=hidden]), textarea, select');
      if (first && window.matchMedia('(min-width: 701px)').matches) first.focus();
    }

    function field(name, label, value, hint, kind) {
      const v = esc(value == null ? '' : value);
      const input = kind === 'area'
        ? `<textarea name="${name}" rows="3" placeholder="${esc(hint || '')}">${v}</textarea>`
        : `<input type="text" name="${name}" value="${v}" placeholder="${esc(hint || '')}">`;
      return `<label class="sg-field"><span>${esc(label)}</span>${input}</label>`;
    }

    function pickField(name, label, value) {
      return `<div class="sg-field"><span>${esc(label)}</span><div class="sg-pickrow">` +
        `<input type="text" name="${name}" value="${esc(value || '')}" placeholder="lat, lng" inputmode="decimal">` +
        `<button type="button" class="sg-pickbtn" data-pick="${name}">&#128205; Pick on map</button></div></div>`;
    }

    function formHtml(s) {
      const t = TYPES[s.kind];
      let body = '';
      if (s.kind === 'route' || s.kind === 'addroute') {
        const r = s.route || {};
        const isMulti = s.route && (ctx.pitchesOf.get(r.Route_ID) || []).length > 1;
        ROUTE_FIELDS.forEach(([key, label, hint, kind]) => {
          if (key === 'Descent' && s.kind === 'route' && !isMulti && !r.Descent) return;
          s.before[key] = r[key] == null ? '' : String(r[key]);
          body += field(key, label, r[key], hint, kind);
        });
        body += field('Pitches', s.kind === 'route' ? 'Pitch info to add or fix (multi-pitch)' : 'Pitches (multi-pitch only)',
          '', 'One per line, e.g. P1 5.8 30m - corner to ledge', 'area');
        if (s.kind === 'route') body = `<p class="sg-hint">Change anything that's wrong or missing. Only what you change gets sent.</p>` + body;
      } else {
        const a = s.area || {};
        if (s.kind === 'area') {
          s.before.Area_Name = a.Area_Name || '';
          s.before.Access_Description = a.Access_Description || '';
          body += field('Area_Name', 'Area name', a.Area_Name);
          body += field('Access_Description', 'Access / approach notes', a.Access_Description, 'How to get there, closures, hazards...', 'area');
        } else {
          body += field('Area_Name', 'Crag name', '', 'What locals call it');
          body += `<label class="sg-field"><span>Near</span><select name="Near"><option value="">Not sure / somewhere new</option>` +
            ctx.mainAreas().map(x => `<option value="${esc(x.Area_ID)}">${esc(x.Area_Name)}</option>`).join('') + '</select></label>';
          body += field('Access_Description', 'Access / approach notes', '', 'How to get there', 'area');
          body += field('Routes', 'Routes you know', '', 'One per line, e.g. Name - 5.9 - sport, 12m', 'area');
        }
        const here = a.Latitude != null ? `${a.Latitude}, ${a.Longitude}` : '';
        body += pickField('Crag_Location', s.kind === 'area' ? 'Correct crag location (if the pin is off)' : 'Crag location', '');
        body += pickField('Parking_Location', 'Parking location', '');
        if (s.kind === 'area' && here) body += `<p class="sg-hint">Current pin: ${esc(here)}</p>`;
      }

      const where = s.kind === 'crag' ? '' :
        `<p class="sg-where">${esc(s.area.Area_Name)}${s.route ? ' &rsaquo; ' + esc(s.route.Route_Name) : ''}</p>`;

      return `<button type="button" class="sg-x" data-close aria-label="Close">&times;</button>` +
        `<h3 id="sg-title">${esc(t.title(s))}</h3>${where}` +
        `<form novalidate>${body}` +
        `<label class="sg-field"><span>Photos, topos or GPS tracks</span>` +
        `<input type="file" name="files" multiple accept="image/*,.gpx,.kml,.kmz,.geojson,.json,.pdf"></label>` +
        `<p class="sg-hint">Up to ${MAX_FILES} files. Photos are shrunk before sending.</p>` +
        field('Notes', 'Anything else?', '', 'Sources, beta, what you saw...', 'area') +
        `<div class="sg-two">${field('Name', 'Your name (optional)', '', 'For credit, and if we have questions')}` +
        `${field('Contact', 'Email (optional)', '', 'Only seen by the map maintainer')}</div>` +
        `<input type="text" name="website" class="sg-hp" tabindex="-1" autocomplete="off" aria-hidden="true">` +
        `<p class="sg-msg" role="status"></p>` +
        `<div class="sg-actions"><button type="button" data-close>Cancel</button><button type="submit" class="sg-send">Send suggestion</button></div>` +
        `</form>`;
    }

    // ---- picking a spot on the map ----
    function startPick(name) {
      state.picking = name;
      shell.hidden = true;
      const what = name === 'Parking_Location' ? 'the parking' : 'the crag';
      banner.innerHTML = `Tap the map where ${what} is <button type="button">Cancel</button>`;
      banner.hidden = false;
      banner.querySelector('button').onclick = endPick;
      document.getElementById('map').classList.add('sg-picking');
      map.on('click', onPick);
    }

    function onPick(e) {
      const name = state && state.picking;
      if (!name) return;
      const lat = e.latlng.lat.toFixed(6), lng = e.latlng.lng.toFixed(6);
      box.querySelector(`[name="${name}"]`).value = `${lat}, ${lng}`;
      setPickMarker(name, e.latlng);
      endPick();
    }

    function setPickMarker(name, latlng) {
      if (state.picks[name]) { map.removeLayer(state.picks[name]); pickMarkers = pickMarkers.filter(m => m !== state.picks[name]); }
      const isPark = name === 'Parking_Location';
      const m = L.marker(latlng, { icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13],
        html: `<div class="sg-mark${isPark ? ' park' : ''}">${isPark ? 'P' : '?'}</div>` }) }).addTo(map);
      state.picks[name] = m;
      pickMarkers.push(m);
    }

    function endPick() {
      if (state) state.picking = null;
      banner.hidden = true;
      map.off('click', onPick);
      document.getElementById('map').classList.remove('sg-picking');
      shell.hidden = false;
    }

    // ---- reading the form ----
    function parseLatLng(text) {
      const m = String(text || '').match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
      if (!m) return null;
      const lat = +m[1], lng = +m[2];
      return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? `${lat}, ${lng}` : null;
    }

    function readFile(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1]);
        r.onerror = () => reject(new Error('Could not read ' + file.name));
        r.readAsDataURL(file);
      });
    }

    // Photos are shrunk to PHOTO_MAX_PX on the long side and saved as JPEG.
    async function shrinkPhoto(file) {
      try {
        const img = await createImageBitmap(file, { imageOrientation: 'from-image' });
        const scale = Math.min(1, PHOTO_MAX_PX / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
        return { name: file.name.replace(/\.[^.]+$/, '') + '.jpg', mimeType: 'image/jpeg', data };
      } catch (err) {
        return { name: file.name, mimeType: file.type || 'application/octet-stream', data: await readFile(file) };
      }
    }

    async function collectFiles(input) {
      const list = [...(input.files || [])];
      if (list.length > MAX_FILES) throw new Error(`Please attach ${MAX_FILES} files or fewer.`);
      const big = list.find(f => f.size > MAX_FILE_MB * 1024 * 1024);
      if (big) throw new Error(`${big.name} is too big (over ${MAX_FILE_MB} MB).`);
      const out = [];
      for (const f of list) {
        out.push(/^image\/(jpeg|png|webp|heic|heif)$/i.test(f.type) ? await shrinkPhoto(f)
          : { name: f.name, mimeType: f.type || 'application/octet-stream', data: await readFile(f) });
      }
      const total = out.reduce((n, f) => n + f.data.length * 0.75, 0);
      if (total > MAX_TOTAL_MB * 1024 * 1024) throw new Error('Those files are too big together. Try fewer or smaller ones.');
      return out;
    }

    function buildPayload(form) {
      const s = state;
      const val = name => { const el = form.elements[name]; return el ? el.value.trim() : ''; };
      const changes = [];
      const details = [];
      const keys = s.kind === 'route' || s.kind === 'addroute'
        ? ROUTE_FIELDS.map(f => f[0]).filter(k => form.elements[k])
        : ['Area_Name', 'Access_Description'];
      const labels = Object.fromEntries(ROUTE_FIELDS.map(f => [f[0], f[1]]).concat([['Area_Name', 'Name'], ['Access_Description', 'Access']]));
      keys.forEach(k => {
        const now = val(k);
        const before = (s.before[k] || '').trim();
        if (s.kind === 'route' || s.kind === 'area') {
          if (now !== before) changes.push(`${labels[k]}: ${before || '(blank)'} → ${now || '(blank)'}`);
        } else if (now) {
          details.push(`${labels[k]}: ${now}`);
        }
      });
      if (val('Pitches')) details.push(`Pitches:\n${val('Pitches')}`);
      if (val('Routes')) details.push(`Routes:\n${val('Routes')}`);
      const near = form.elements.Near;
      if (near && near.value) details.unshift(`Near: ${near.options[near.selectedIndex].text} (${near.value})`);

      const crag = val('Crag_Location'), park = val('Parking_Location');
      const cragOk = crag ? parseLatLng(crag) : '', parkOk = park ? parseLatLng(park) : '';
      if (crag && !cragOk) throw new Error('The crag location should look like 54.0812, -122.3604');
      if (park && !parkOk) throw new Error('The parking location should look like 54.0812, -122.3604');

      return {
        type: s.kind,
        typeLabel: TYPES[s.kind].label,
        areaId: s.area ? s.area.Area_ID : (near && near.value) || '',
        areaName: s.kind === 'crag' ? val('Area_Name') : s.area.Area_Name,
        routeId: s.route ? s.route.Route_ID : '',
        routeName: s.route ? s.route.Route_Name : (s.kind === 'addroute' ? val('Route_Name') : ''),
        changes: changes.join('\n'),
        details: details.join('\n'),
        cragLocation: cragOk || '',
        parkingLocation: parkOk || '',
        notes: val('Notes'),
        name: val('Name'),
        contact: val('Contact'),
        website: val('website'),
        page: location.href
      };
    }

    function hasContent(p, files) {
      return p.changes || p.details || p.cragLocation || p.parkingLocation || p.notes || files.length;
    }

    async function submit(form) {
      const msg = form.querySelector('.sg-msg');
      const btn = form.querySelector('.sg-send');
      const say = (text, bad) => { msg.textContent = text; msg.className = 'sg-msg' + (bad ? ' bad' : ''); };
      let payload, files;
      try {
        payload = buildPayload(form);
        if (state.kind === 'addroute' && !form.elements.Route_Name.value.trim()) throw new Error('Please give the route a name.');
        if (state.kind === 'crag' && !payload.areaName) throw new Error('Please give the crag a name.');
        btn.disabled = true;
        say('Preparing...');
        files = await collectFiles(form.elements.files);
        if (!hasContent(payload, files)) throw new Error("Nothing's changed yet. Edit a field, add a note or attach a photo.");
      } catch (err) {
        btn.disabled = false;
        return say(err.message, true);
      }
      payload.files = files;
      say(files.length ? `Sending ${files.length} file(s)...` : 'Sending...');
      try {
        // text/plain avoids a CORS preflight, which Apps Script can't answer.
        const res = await fetch(C.suggestUrl, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || out.ok === false) throw new Error(out.error || 'The server said no.');
        box.innerHTML = `<button type="button" class="sg-x" data-close aria-label="Close">&times;</button>` +
          `<h3>Thanks!</h3><p>Your suggestion was sent. It'll show up on the map once it's checked and added.</p>` +
          `<div class="sg-actions"><button type="button" class="sg-send" data-close>Close</button></div>`;
        clearPicks();
      } catch (err) {
        btn.disabled = false;
        say("Couldn't send it. Check your connection and try again. (" + err.message + ')', true);
      }
    }

    box.addEventListener('click', e => {
      if (e.target.closest('[data-close]')) return close();
      const p = e.target.closest('[data-pick]');
      if (p) return startPick(p.dataset.pick);
    });
    box.addEventListener('submit', e => { e.preventDefault(); submit(e.target); });
    box.addEventListener('change', e => {
      const n = e.target.name;
      if ((n === 'Crag_Location' || n === 'Parking_Location') && state) {
        const ok = parseLatLng(e.target.value);
        if (ok) setPickMarker(n, ok.split(',').map(Number));
      }
    });

    return { open };
  };
})();
