// Request filter for SeeClickFix (unofficial). A panel on SeeClickFix pages that asks the site's own public API
// (/api/v2) for requests by several types, a date range, statuses and a keyword at once.
// Read-only: GET requests only, to the same site, at most one every 3.5 seconds (the API allows 20 a minute).
// No permissions, no stored keys, nothing saved. Data: SeeClickFix, CC BY-NC-SA 3.0 US.
(() => {
  if (window.__requestFilter) return;
  window.__requestFilter = true;

  const API = '/api/v2';
  const PAUSE_MS = 3500;          // 17 requests a minute at most
  const PER_PAGE = 100;           // the API's maximum
  const MAX_ROWS = 500;           // the list shows this many; the count is always the full total
  const STATUSES = ['open', 'acknowledged', 'closed', 'archived'];
  const PRESETS = { last7: 'Last 7 days', last30: 'Last 30 days', thisMonth: 'This month', lastMonth: 'Last month', thisYear: 'This year', custom: 'From / to' };

  let lastCall = 0;
  let types = [];                 // [{id, title, organization}]
  let lastRun = null;             // {filter, total, rows}

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function get(path) {      // one polite GET, retried once after a 429
    for (let attempt = 0; attempt < 2; attempt++) {
      const wait = lastCall + PAUSE_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      const r = await fetch(path, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (r.status === 429 && attempt === 0) {
        await sleep((parseInt(r.headers.get('Retry-After') || '10', 10) + 1) * 1000);
        continue;
      }
      if (!r.ok) throw new Error(`The site answered ${r.status} for ${path.split('?')[0]}`);
      return r.json();
    }
  }

  // ---- where: the area the page is showing (the map's position is in the page address)
  function area() {
    const q = new URLSearchParams(location.search);
    const box = ['min_lat', 'max_lat', 'min_lng', 'max_lng'].every(k => q.get(k));
    if (box) return { label: 'the map area on this page', params: { min_lat: q.get('min_lat'), max_lat: q.get('max_lat'), min_lng: q.get('min_lng'), max_lng: q.get('max_lng') }, point: { lat: q.get('lat'), lng: q.get('lng') } };
    if (q.get('lat') && q.get('lng')) return { label: 'around the map centre on this page', params: { lat: q.get('lat'), lng: q.get('lng') }, point: { lat: q.get('lat'), lng: q.get('lng') } };
    const place = location.pathname.split('/').filter(Boolean)[0];
    if (place && !['web_portal', 'issues', 'api', 'users'].includes(place)) return { label: `the place "${place}"`, params: { place_url: place }, point: null };
    return null;
  }

  // ---- dates: full local days, sent as UTC timestamps (YYYY-MM-DDTHH:MM:SSZ)
  const iso = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const day = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function range(preset, from, to) {
    const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const add = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    const r = {
      last7: [add(today, -6), today], last30: [add(today, -29), today],
      thisMonth: [new Date(today.getFullYear(), today.getMonth(), 1), today],
      lastMonth: [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0)],
      thisYear: [new Date(today.getFullYear(), 0, 1), today],
    }[preset];
    if (r) return { from: ymd(r[0]), to: ymd(r[1]) };
    return { from: from || '', to: to || '' };
  }

  // ---- the panel (in a shadow root, so the site's styles and ours never mix)
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{all:initial} *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
    .btn{background:#12786e;color:#fff;border:0;border-radius:999px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}
    .panel{display:none;position:fixed;right:16px;bottom:64px;width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 96px);overflow:auto;background:#fff;color:#1d303c;border:1px solid #d5dee2;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:14px;font-size:13.5px}
    .panel.open{display:block} h2{font-size:16px;margin:0 0 2px} .muted{color:#5f727c;font-size:12px} label{display:block;font-weight:600;margin:10px 0 4px}
    input[type=text],input[type=date],select{width:100%;padding:6px 8px;border:1px solid #c9d4d8;border-radius:8px;font-size:13px}
    .types{max-height:170px;overflow:auto;border:1px solid #c9d4d8;border-radius:8px;padding:4px 8px;margin-top:4px}
    .types label{font-weight:400;margin:2px 0;display:flex;gap:6px;align-items:flex-start} .org{font-size:11px;color:#5f727c;text-transform:uppercase;letter-spacing:.04em;margin:6px 0 2px}
    .row{display:flex;gap:8px} .row>*{flex:1} .checks{display:flex;flex-wrap:wrap;gap:4px 12px} .checks label{font-weight:400;display:flex;gap:4px;margin:0}
    .go{margin-top:12px;display:flex;gap:8px;flex-wrap:wrap} .go button{border:1px solid #12786e;background:#fff;color:#12786e;border-radius:8px;padding:6px 10px;font-size:13px;cursor:pointer}
    .go button.primary{background:#12786e;color:#fff} .go button:disabled{opacity:.5;cursor:default}
    .count{font-size:20px;font-weight:700;color:#12786e;margin:12px 0 4px} table{width:100%;border-collapse:collapse;font-size:12.5px} td,th{padding:4px;border-bottom:1px solid #e1e8eb;text-align:left;vertical-align:top} a{color:#12786e}
    .status{font-size:12px;color:#5f727c;margin-top:6px;min-height:16px} td.d{white-space:nowrap}
  </style>
  <button class="btn" id="toggle" title="Filter requests by several types, dates and statuses">Request filter</button>
  <div class="panel" id="panel" role="dialog" aria-label="Request filter">
    <h2>Request filter</h2><div class="muted" id="where"></div>
    <label for="q">Request types</label><input type="text" id="q" placeholder="Search types…"><div class="types" id="types"><div class="muted">Loading types…</div></div>
    <label for="preset">Created</label><select id="preset">${Object.entries(PRESETS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
    <div class="row" id="custom" style="display:none;margin-top:6px"><input type="date" id="from" aria-label="From"><input type="date" id="to" aria-label="To"></div>
    <label>Status</label><div class="checks" id="statuses">${STATUSES.map(s => `<label><input type="checkbox" value="${s}" ${s === 'open' || s === 'acknowledged' ? 'checked' : ''}>${s}</label>`).join('')}</div>
    <label for="kw">Keyword (optional)</label><input type="text" id="kw" placeholder="e.g. streetlight">
    <div class="go"><button class="primary" id="run">Search</button><button id="copy" disabled>Copy as table</button><button id="ids" disabled>Copy IDs</button><button id="share">Copy link to this filter</button></div>
    <div class="status" id="msg" role="status"></div><div class="count" id="count"></div><div id="list"></div>
    <div class="muted" style="margin-top:8px">Read-only, from the site's public API. Data: SeeClickFix (CC BY-NC-SA 3.0 US). Unofficial.</div>
  </div>`;
  document.documentElement.appendChild(host);
  const $ = id => root.getElementById(id);
  const say = t => { $('msg').textContent = t; };

  $('toggle').onclick = () => {   // the portal writes the map position into the address once the map has loaded: try again then
    $('panel').classList.toggle('open');
    if (!types.length) loadTypes().catch(e => say(String(e.message || e)));
  };
  $('preset').onchange = () => { $('custom').style.display = $('preset').value === 'custom' ? 'flex' : 'none'; };
  $('q').oninput = () => drawTypes();

  function drawTypes(selected) {
    const keep = selected || new Set([...root.querySelectorAll('#types input:checked')].map(i => i.value));
    const q = $('q').value.trim().toLowerCase();
    const shown = types.filter(t => !q || t.title.toLowerCase().includes(q) || (t.organization || '').toLowerCase().includes(q));
    const groups = {};
    shown.forEach(t => { (groups[t.organization || 'Community'] ||= []).push(t); });
    $('types').innerHTML = Object.entries(groups).map(([org, ts]) => `<div class="org">${esc(org)}</div>` + ts.map(t =>
      `<label><input type="checkbox" value="${esc(t.id)}" ${keep.has(String(t.id)) ? 'checked' : ''}>${esc(t.title)}</label>`).join('')).join('') || '<div class="muted">No type matches.</div>';
    // keep selections that the search hides
    [...keep].filter(id => !shown.some(t => String(t.id) === id)).forEach(id => {
      const i = document.createElement('input'); i.type = 'checkbox'; i.value = id; i.checked = true; i.hidden = true; $('types').appendChild(i);
    });
  }
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function loadTypes() {
    const a = area();
    $('where').textContent = a ? `Searching ${a.label}. Move the map to change the area.` : 'Open a city page or its map to set the area.';
    if (!a || !a.point || !a.point.lat) { $('types').innerHTML = '<div class="muted">Types need a map position: open the map view of a city portal.</div>'; return; }
    const j = await get(`${API}/issues/new?lat=${encodeURIComponent(a.point.lat)}&lng=${encodeURIComponent(a.point.lng)}`);
    types = (j.request_types || []).map(t => ({ id: String(t.url || '').split('/').pop(), title: t.title, organization: t.organization }))
      .filter(t => t.id).sort((x, y) => (x.organization || '~').localeCompare(y.organization || '~') || x.title.localeCompare(y.title));
    drawTypes();
  }

  function current() {
    const preset = $('preset').value;
    const r = range(preset, $('from').value, $('to').value);
    return { types: [...root.querySelectorAll('#types input:checked')].map(i => i.value), preset, from: r.from, to: r.to,
             status: [...root.querySelectorAll('#statuses input:checked')].map(i => i.value), q: $('kw').value.trim() };
  }

  function query(f, page) {
    const a = area();
    const p = new URLSearchParams({ ...(a ? a.params : {}), page: String(page), per_page: String(PER_PAGE), sort: 'created_at', sort_direction: 'DESC' });
    if (f.status.length) p.set('status', f.status.join(','));
    if (f.types.length) p.set('request_types', f.types.join(','));
    if (f.from) p.set('after', iso(day(f.from)));
    if (f.to) { const d = day(f.to); p.set('before', iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1))); }
    if (f.q) p.set('search', f.q);
    return `${API}/issues?${p}`;
  }

  async function run() {
    const f = current();
    if (!area()) { say('Open a city page or its map first.'); return; }
    if (!f.status.length) { say('Tick at least one status.'); return; }
    $('run').disabled = true; $('copy').disabled = true; $('ids').disabled = true;
    $('count').textContent = ''; $('list').innerHTML = '';
    try {
      const rows = []; let total = 0, page = 1, pages = 1;
      do {
        say(page === 1 ? 'Asking the site…' : `Page ${page} of ${Math.min(pages, Math.ceil(MAX_ROWS / PER_PAGE))} (one request every few seconds, to stay within the site's limit)…`);
        const j = await get(query(f, page));
        const pg = (j.metadata || {}).pagination || {};
        total = pg.entries ?? total; pages = pg.pages || 1;
        rows.push(...(j.issues || []));
        page += 1;
      } while (page <= pages && rows.length < MAX_ROWS);
      lastRun = { filter: f, total, rows: rows.slice(0, MAX_ROWS), at: new Date() };
      $('count').textContent = `${total.toLocaleString()} request${total === 1 ? '' : 's'}`;
      $('list').innerHTML = `<table><thead><tr><th>ID</th><th>Type</th><th>Created</th><th>Status</th></tr></thead><tbody>${lastRun.rows.map(i =>
        `<tr><td><a href="${esc(i.html_url)}" target="_blank" rel="noopener">${esc(i.id)}</a></td><td>${esc((i.request_type || {}).title || i.summary)}</td>` +
        `<td class="d">${esc((i.created_at || '').slice(0, 10))}</td><td>${esc(i.status)}</td></tr>`).join('')}</tbody></table>` +
        (total > lastRun.rows.length ? `<div class="muted">Showing the newest ${lastRun.rows.length}. The count is the full total.</div>` : '');
      say(''); $('copy').disabled = false; $('ids').disabled = false;
    } catch (e) {
      say(String(e.message || e));
    } finally { $('run').disabled = false; }
  }

  function describe(f) {
    const names = f.types.map(id => (types.find(t => String(t.id) === id) || {}).title || id);
    return [['Site', `${location.host}, ${(area() || {}).label || ''}`], ['Request types', names.join('; ') || 'all'],
            ['Created', f.from || f.to ? `${f.from || '…'} to ${f.to || '…'}` : 'any time'], ['Status', f.status.join(', ')],
            ['Keyword', f.q || '—'], ['Count', String(lastRun ? lastRun.total : '')], ['Run at', new Date().toLocaleString()]];
  }

  async function copy(html, text) {
    try { await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]); }
    catch { await navigator.clipboard.writeText(text); }
  }

  $('run').onclick = run;
  $('copy').onclick = async () => {
    if (!lastRun) return;
    const head = describe(lastRun.filter);
    const cols = ['ID', 'Type', 'Summary', 'Created', 'Status', 'Address', 'Link'];
    const vals = i => [i.id, (i.request_type || {}).title || '', i.summary || '', (i.created_at || '').slice(0, 10), i.status, i.address || '', i.html_url];
    const html = `<table>${head.map(([k, v]) => `<tr><th>${esc(k)}</th><td colspan="6">${esc(v)}</td></tr>`).join('')}<tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr>` +
      lastRun.rows.map(i => `<tr>${vals(i).map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('') + '</table>';
    const text = head.map(([k, v]) => `${k}\t${v}`).join('\n') + '\n\n' + cols.join('\t') + '\n' + lastRun.rows.map(i => vals(i).join('\t')).join('\n');
    await copy(html, text); say(`Copied ${lastRun.rows.length} rows with the filter used.`);
  };
  $('ids').onclick = async () => { if (lastRun) { await navigator.clipboard.writeText(lastRun.rows.map(i => i.id).join('\n')); say('Copied the IDs, one per line.'); } };
  $('share').onclick = async () => {
    const f = current();
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify({ t: f.types, p: f.preset, f: f.from, to: f.to, s: f.status, q: f.q })))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = `${location.origin}${location.pathname}${location.search}#rfilter=${b64}`;
    await navigator.clipboard.writeText(url); say('Link copied: whoever opens it gets this filter, run on the same map area.');
  };

  async function fromLink() {    // a shared link (#rfilter=…) opens the panel and runs its filter
    const m = location.hash.match(/rfilter=([A-Za-z0-9_-]+)/);
    if (!m) return;
    try {
      const b = m[1].replace(/-/g, '+').replace(/_/g, '/');
      const f = JSON.parse(decodeURIComponent(escape(atob(b + '==='.slice((b.length + 3) % 4)))));
      drawTypes(new Set((f.t || []).map(String)));
      $('preset').value = f.p in PRESETS ? f.p : 'custom';
      $('custom').style.display = $('preset').value === 'custom' ? 'flex' : 'none';
      $('from').value = f.f || ''; $('to').value = f.to || '';
      root.querySelectorAll('#statuses input').forEach(i => { i.checked = (f.s || []).includes(i.value); });
      $('kw').value = f.q || '';
      $('panel').classList.add('open');
      await run();
    } catch (e) { say('This link has a filter the panel could not read.'); }
  }

  loadTypes().then(fromLink).catch(e => say(String(e.message || e)));
})();
