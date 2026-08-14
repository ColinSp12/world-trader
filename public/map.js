import { el, api, timeAgo, safeUrl, fmtPrice, KIND_LABEL, SEV_LABEL } from '/shared.js';

const KIND_COLOR = { quake: '#3987e5', unrest: '#d95926', conflict: '#d95926', natural: '#199e70' };

// preferCanvas keeps 1000+ ship markers cheap to render
const map = L.map('map', { worldCopyJump: true, zoomControl: true, preferCanvas: true }).setView([25, 15], 2);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: 'abcd', maxZoom: 12,
}).addTo(map);

// Layer preferences persist — declutter choices should survive a reload.
const pref = (k, dflt = true) => localStorage.getItem(k) === null ? dflt : localStorage.getItem(k) === '1';
const setPref = (k, v) => localStorage.setItem(k, v ? '1' : '0');
let flightsOn = pref('wt-map-flights');
let shipsOn = pref('wt-map-ships');
let chokesOn = pref('wt-map-chokes');
let nightOn = pref('wt-map-night');
let fxOn = pref('wt-map-fx');

const legend = L.control({ position: 'bottomleft' });
legend.onAdd = () => {
  const div = document.createElement('div');
  div.className = 'legend';
  for (const [kind, label] of [['unrest', 'Unrest / conflict'], ['quake', 'Earthquake'], ['natural', 'Natural event']]) {
    div.append(el('div', {}, el('span', { class: `dot ${kind}` }), label));
  }
  div.append(el('button', {
    class: 'legend-toggle', id: 'flights-toggle',
    title: 'military worldwide · all air traffic when zoomed in',
    onclick: () => {
      flightsOn = !flightsOn;
      setPref('wt-map-flights', flightsOn);
      if (!flightsOn) flightLayer.clearLayers();
      else refreshFlights();
      updateFlightsToggle(null);
    },
  }, '✈ aircraft'));
  div.append(el('button', {
    class: 'legend-toggle ships', id: 'ships-toggle',
    onclick: () => {
      shipsOn = !shipsOn;
      setPref('wt-map-ships', shipsOn);
      if (!shipsOn) shipLayer.clearLayers();
      else refreshShips();
      updateShipsToggle(null);
    },
  }, '⚓ ships'));
  const simpleToggle = (id, label, get, flip) => el('button', {
    class: `legend-toggle${get() ? '' : ' off'}`, id,
    onclick: (e) => { flip(); e.target.classList.toggle('off', !get()); },
  }, label);
  div.append(simpleToggle('chokes-toggle', '◆ chokepoints', () => chokesOn, () => {
    chokesOn = !chokesOn;
    setPref('wt-map-chokes', chokesOn);
    for (const { marker } of chokeMarkers.values()) chokesOn ? marker.addTo(map) : map.removeLayer(marker);
    for (const m of extraChokeMarkers) chokesOn ? m.addTo(map) : map.removeLayer(m);
  }));
  div.append(simpleToggle('night-toggle', '☾ night shade', () => nightOn, () => {
    nightOn = !nightOn;
    setPref('wt-map-night', nightOn);
    nightOn ? nightLayer.addTo(map) : map.removeLayer(nightLayer);
  }));
  div.append(simpleToggle('fx-toggle', '✨ signal glow', () => fxOn, () => {
    fxOn = !fxOn;
    setPref('wt-map-fx', fxOn);
    if (!fxOn) fxLayer.clearLayers();
    else renderAmbience(signalsCache);
  }));
  div.append(el('div', { style: 'color: var(--muted)' }, 'marker size = severity'));
  L.DomEvent.disableClickPropagation(div);
  return div;
};
legend.addTo(map);

function updateFlightsToggle(counts) {
  const btn = document.getElementById('flights-toggle');
  if (!btn) return;
  btn.classList.toggle('off', !flightsOn);
  btn.textContent = flightsOn ? `✈ aircraft${counts ? ` (${counts})` : ''}` : '✈ aircraft — off';
}

let shipSourceIsDemo = false;
function updateShipsToggle(count, source) {
  const btn = document.getElementById('ships-toggle');
  if (!btn) return;
  btn.classList.toggle('off', !shipsOn);
  if (source) {
    btn.title = source;
    shipSourceIsDemo = source.includes('Digitraffic');
  }
  const demo = shipSourceIsDemo ? ' · Baltic demo' : '';
  btn.textContent = shipsOn ? `⚓ ships${count != null ? ` (${count}${demo})` : ''}` : '⚓ ships — off';
}

// ---- day/night terminator (approximate solar position; visual only) ----
const nightLayer = L.polygon([], { stroke: false, fillColor: '#000', fillOpacity: 0.24, interactive: false });
if (nightOn) nightLayer.addTo(map);
function updateTerminator() {
  const now = new Date();
  const dayOfYear = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000;
  const decl = (-23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10))) || 0.01; // solar declination, deg
  const utcFrac = (now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()) / 86400;
  const subsolarLon = 180 - utcFrac * 360;
  const declRad = decl * Math.PI / 180;
  const pts = [];
  for (let lon = -180; lon <= 180; lon += 2) {
    const hourAngle = (lon - subsolarLon) * Math.PI / 180;
    pts.push([Math.atan(-Math.cos(hourAngle) / Math.tan(declRad)) * 180 / Math.PI, lon]);
  }
  const darkPole = decl > 0 ? -90 : 90;
  pts.push([darkPole, 180], [darkPole, -180]);
  nightLayer.setLatLngs(pts);
}
updateTerminator();
setInterval(updateTerminator, 5 * 60 * 1000);

// ---- shipping chokepoints (static, thematic anchors for the ships layer) ----
const CHOKEPOINTS = [
  { name: 'Strait of Hormuz', lat: 26.6, lon: 56.5, note: '~20% of global oil transits here', syms: 'USO · XLE' },
  { name: 'Suez Canal', lat: 30.5, lon: 32.35, note: 'Asia–Europe shortcut', syms: 'ZIM · FRO' },
  { name: 'Bab el-Mandeb', lat: 12.6, lon: 43.3, note: 'Red Sea southern gate', syms: 'FRO · USO' },
  { name: 'Strait of Malacca', lat: 1.8, lon: 102.5, note: 'Asia’s main maritime artery', syms: 'FXI · EWS' },
  { name: 'Panama Canal', lat: 9.08, lon: -79.68, note: 'Atlantic–Pacific link', syms: 'ZIM' },
  { name: 'Bosporus', lat: 41.1, lon: 29.06, note: 'Black Sea grain & oil', syms: 'WEAT · USO' },
  { name: 'Taiwan Strait', lat: 24.5, lon: 119.5, note: 'semiconductor supply lifeline', syms: 'EWT · SMH' },
  { name: 'Strait of Gibraltar', lat: 35.95, lon: -5.6, note: 'Mediterranean gate', syms: null },
  { name: 'Dover Strait', lat: 51.0, lon: 1.4, note: 'world’s busiest shipping lane', syms: null },
];
const PW_IDS = {
  'Strait of Hormuz': 'chokepoint6', 'Suez Canal': 'chokepoint1', 'Bab el-Mandeb': 'chokepoint4',
  'Strait of Malacca': 'chokepoint5', 'Panama Canal': 'chokepoint2', 'Bosporus': 'chokepoint3',
  'Taiwan Strait': 'chokepoint11', 'Strait of Gibraltar': 'chokepoint8', 'Dover Strait': 'chokepoint9',
};
const chokeMarkers = new Map();

function chokePopup(c, stats) {
  const wrap = el('div', {},
    el('div', { style: 'font-weight:600' }, `◆ ${c.name}`),
    el('div', { class: 'm' }, `shipping chokepoint · ${c.note}`),
  );
  if (stats && stats.ratio != null) {
    const pct = Math.round((stats.ratio - 1) * 100);
    wrap.append(el('div', {
      class: 'm',
      style: stats.ratio < 0.7 ? 'color: var(--down); font-weight: 600' : '',
    }, `${stats.transits} transits ${new Date(stats.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${pct >= 0 ? '+' : ''}${pct}% vs 28-day avg`));
  }
  if (c.syms) {
    // Symbols deep-link to the Trades chart — chokepoint stress → chart in one click.
    const symRow = el('div', { class: 'm' }, 'watch on disruption: ');
    c.syms.split('·').map((s) => s.trim()).forEach((sym, i) => {
      if (i) symRow.append(' · ');
      symRow.append(el('a', { href: `/trades?symbol=${encodeURIComponent(sym)}` }, sym));
    });
    wrap.append(symRow);
  }
  if (stats) wrap.append(el('div', { class: 'm' }, 'transit data: IMF PortWatch'));
  return wrap;
}

const extraChokeMarkers = [];
for (const c of CHOKEPOINTS) {
  const marker = L.marker([c.lat, c.lon], {
    icon: L.divIcon({ className: 'choke-icon', html: '◆', iconSize: [14, 14], iconAnchor: [7, 7] }),
    keyboard: false,
  }).bindPopup(chokePopup(c, null));
  if (chokesOn) marker.addTo(map);
  if (PW_IDS[c.name]) chokeMarkers.set(PW_IDS[c.name], { marker, info: c });
  else extraChokeMarkers.push(marker);
}

async function refreshChokepoints() {
  try {
    const d = await api('/api/chokepoints');
    for (const stats of d.chokepoints) {
      const entry = chokeMarkers.get(stats.id);
      if (entry) entry.marker.setPopupContent(chokePopup(entry.info, stats));
    }
  } catch { /* popups keep static content */ }
}
refreshChokepoints();
setInterval(refreshChokepoints, 60 * 60 * 1000);

const markerLayer = L.layerGroup().addTo(map);
const markerById = new Map();
const flightLayer = L.layerGroup().addTo(map);

const shipLayer = L.layerGroup().addTo(map);

// ---- ambience: glow under active-signal events, animated arcs to the
// related chokepoint. SVG renderer (not canvas) so CSS can animate the dashes.
const fxRenderer = L.svg({ padding: 0.3 });
const fxLayer = L.layerGroup().addTo(map);

function nearestChokepoint(lat, lon) {
  let best = null, bestD = Infinity;
  for (const c of CHOKEPOINTS) {
    const d = (c.lat - lat) ** 2 + (c.lon - lon) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD < 40 * 40 ? best : null; // only when reasonably close (~<40°)
}

function arcLine(from, to) {
  const mid = [(from[0] + to[0]) / 2 + Math.abs(from[1] - to[1]) * 0.18, (from[1] + to[1]) / 2];
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24, a = 1 - t;
    pts.push([
      a * a * from[0] + 2 * a * t * mid[0] + t * t * to[0],
      a * a * from[1] + 2 * a * t * mid[1] + t * t * to[1],
    ]);
  }
  return L.polyline(pts, {
    renderer: fxRenderer, className: 'arc-line', color: '#9085e9',
    weight: 1.5, opacity: 0.65, dashArray: '6 9', interactive: false,
  });
}

// Glow popup: the most eye-catching layer must not be a dead end — a click
// reveals which signal lit it up and links to the trade side.
function glowPopup(s) {
  return el('div', {},
    el('div', { style: 'font-weight:600' }, s.headline),
    el('div', { class: 'm' }, `${s.rule} · ${s.direction} · ${s.status}`),
    Number.isFinite(s.plan_entry)
      ? el('div', { class: 'm' }, `${s.tv_symbol}: entry ${fmtPrice(s.plan_entry)} · stop ${fmtPrice(s.plan_stop)} · target ${fmtPrice(s.plan_target)}`)
      : null,
    el('div', { class: 'm' }, el('a', { href: `/trades?signal=${encodeURIComponent(s.id)}` }, 'Open in Trades →')));
}

function renderAmbience(signals) {
  fxLayer.clearLayers();
  if (!fxOn) return;
  const active = signals.filter((s) => s.status === 'new' || s.status === 'taken');
  for (const s of active.slice(0, 20)) {
    const ev = s.event;
    // pulsing ring around a chokepoint named in a transit-drop signal
    if (s.rule === 'chokepoint-transit-drop') {
      const cp = CHOKEPOINTS.find((c) => s.headline.includes(c.name));
      if (cp) {
        L.marker([cp.lat, cp.lon], {
          icon: L.divIcon({ className: 'glow-icon', html: '<span class="glow choke"></span>', iconSize: [70, 70], iconAnchor: [35, 35] }),
          keyboard: false,
        }).bindPopup(glowPopup(s)).addTo(fxLayer);
      }
      continue;
    }
    if (!ev || !Number.isFinite(ev.lat) || !Number.isFinite(ev.lon)) continue;
    L.marker([ev.lat, ev.lon], {
      icon: L.divIcon({ className: 'glow-icon', html: '<span class="glow"></span>', iconSize: [90, 90], iconAnchor: [45, 45] }),
      keyboard: false,
    }).bindPopup(glowPopup(s)).addTo(fxLayer);
    // arc to the nearest chokepoint for shipping/oil-flavored signals
    if (s.rule === 'chokepoint-disruption' || s.rule === 'oil-producer-unrest') {
      const cp = nearestChokepoint(ev.lat, ev.lon);
      if (cp) arcLine([ev.lat, ev.lon], [cp.lat, cp.lon]).addTo(fxLayer);
    }
  }
}

// U+2708 points ~45° right of north in most fonts, hence the -45 offset.
function planeIcon(track, mil) {
  return L.divIcon({
    className: 'plane-icon' + (mil ? '' : ' civ'),
    html: `<span style="transform: rotate(${Math.round(track - 45)}deg)">✈</span>`,
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
}

async function refreshFlights() {
  if (!flightsOn) return;
  try {
    let d;
    // Zoomed in: all traffic (civilian + military) around the viewport.
    // Zoomed out: worldwide military only — global civilian would be 10k+ planes.
    if (map.getZoom() >= 5) {
      const c = map.getCenter();
      const ne = map.getBounds().getNorthEast();
      const radiusNm = Math.min(250, Math.max(30, Math.round(c.distanceTo(ne) / 1852)));
      d = await api(`/api/flights?lat=${c.lat.toFixed(2)}&lon=${c.lng.toFixed(2)}&radius=${radiusNm}`);
    } else {
      d = await api('/api/flights');
    }
    if (!flightsOn) return; // toggled off while fetching
    flightLayer.clearLayers();
    let mil = 0;
    for (const f of d.flights) {
      if (f.mil) mil++;
      const m = L.marker([f.lat, f.lon], { icon: planeIcon(f.track, f.mil), keyboard: false });
      m.bindPopup(el('div', {},
        el('div', { style: 'font-weight:600' }, `✈ ${f.callsign}`),
        el('div', { class: 'm' }, [f.type, f.reg, f.alt != null ? `${f.alt.toLocaleString()} ft` : null, f.speed != null ? `${f.speed} kt` : null].filter(Boolean).join(' · ')),
        el('div', { class: 'm' }, `${f.mil ? 'military' : 'civilian'} · live via adsb.lol`),
      ));
      m.addTo(flightLayer);
    }
    const civ = d.flights.length - mil;
    updateFlightsToggle(civ ? `${mil} mil · ${civ} civ` : `${mil} mil`);
  } catch { /* keep last markers; retry next cycle */ }
}

async function refreshShips() {
  if (!shipsOn) return;
  try {
    const d = await api('/api/ships');
    if (!shipsOn) return;
    shipLayer.clearLayers();
    for (const s of d.ships) {
      // heading vector for vessels under way
      if (s.speed > 2 && Number.isFinite(s.course)) {
        const len = 0.03 + s.speed * 0.006;
        const rad = s.course * Math.PI / 180;
        L.polyline([[s.lat, s.lon],
          [s.lat + Math.cos(rad) * len, s.lon + Math.sin(rad) * len / Math.max(0.2, Math.cos(s.lat * Math.PI / 180))]],
          { color: '#c98500', weight: 1, opacity: 0.5, interactive: false }).addTo(shipLayer);
      }
      const m = L.circleMarker([s.lat, s.lon], {
        radius: 2.5, color: '#c98500', weight: 1, fillColor: '#c98500', fillOpacity: 0.75,
      });
      m.bindPopup(el('div', {},
        el('div', { style: 'font-weight:600' }, `⚓ ${s.name}`),
        el('div', { class: 'm' }, [`MMSI ${s.mmsi}`, s.speed != null ? `${s.speed.toFixed(1)} kn` : null, s.course != null ? `course ${Math.round(s.course)}°` : null].filter(Boolean).join(' · ')),
        el('div', { class: 'm' }, timeAgo(s.ts)),
      ));
      m.addTo(shipLayer);
    }
    updateShipsToggle(d.count, d.source);
  } catch { /* keep last markers; retry next cycle */ }
}

let viewportTimer;
map.on('moveend zoomend', () => {
  clearTimeout(viewportTimer);
  viewportTimer = setTimeout(refreshFlights, 600);
});

// Event → signal → trade joins, resolved at popup-open time so the popup
// always answers "what did the engine do about this event?"
let signalsCache = [];
let tradesBySignal = new Map();
function signalForEvent(e) {
  return signalsCache.find((s) => s.event && s.event.id === e.id);
}

function popupContent(e) {
  const wrap = el('div', {},
    el('div', { style: 'font-weight:600' }, e.title),
    el('div', { class: 'm' }, [KIND_LABEL[e.kind] || e.kind, SEV_LABEL[e.severity], e.country, timeAgo(e.ts)].filter(Boolean).join(' · ')),
  );
  if (e.detail) wrap.append(el('div', { class: 'm' }, e.detail.slice(0, 220)));
  const s = signalForEvent(e);
  if (s) {
    wrap.append(el('div', { class: 'm', style: 'border-top: 1px solid var(--grid); margin-top: 4px; padding-top: 4px' },
      `⚡ signal: ${s.rule} · ${s.direction} ${s.tv_symbol} · ${s.status}`));
    for (const t of tradesBySignal.get(s.id) || []) {
      wrap.append(el('div', { class: 'm', style: t.pnl >= 0 ? 'color: var(--up)' : 'color: var(--down)' },
        `↳ trade: ${t.side} ${t.qty} ${t.symbol} @ ${fmtPrice(t.entry_price)} · ${t.status}${Number.isFinite(t.pnl) ? ` · ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}` : ''}`));
    }
    wrap.append(el('div', { class: 'm' }, el('a', { href: `/trades?signal=${encodeURIComponent(s.id)}` }, 'Open in Trades →')));
  }
  const su = safeUrl(e.url);
  if (su) wrap.append(el('div', { class: 'm' }, el('a', { href: su, target: '_blank', rel: 'noopener' }, 'source ↗')));
  return wrap;
}

// Diff-keyed marker updates: existing markers stay put (open popups survive
// the 60s refresh), vanished events are removed, new ones added.
const ringById = new Map();
function renderMarkers(events) {
  const seen = new Set();
  let rings = ringById.size;
  for (const e of events) {
    seen.add(e.id);
    let marker = markerById.get(e.id);
    if (!marker) {
      marker = L.circleMarker([e.lat, e.lon], {
        radius: 3 + e.severity * 2.5,
        color: KIND_COLOR[e.kind] || '#898781',
        weight: 1.5,
        fillColor: KIND_COLOR[e.kind] || '#898781',
        fillOpacity: 0.55,
      });
      marker.bindPopup(() => popupContent(marker.__event)); // resolved at open time
      marker.addTo(markerLayer);
      markerById.set(e.id, marker);
      // severe events get an animated pulse ring (capped — each one is a
      // perpetually-animating DOM node)
      if (e.severity >= 3 && rings < 15) {
        const ring = L.marker([e.lat, e.lon], {
          icon: L.divIcon({ className: 'pulse-icon', html: `<span class="pulse-ring ${e.kind}"></span>`, iconSize: [36, 36], iconAnchor: [18, 18] }),
          interactive: false, keyboard: false,
        }).addTo(markerLayer);
        ringById.set(e.id, ring);
        rings++;
      }
    }
    marker.__event = e;
  }
  for (const [id, m] of markerById) {
    if (seen.has(id)) continue;
    markerLayer.removeLayer(m);
    markerById.delete(id);
    const r = ringById.get(id);
    if (r) { markerLayer.removeLayer(r); ringById.delete(id); }
  }
}

function renderEventList(events) {
  const box = document.getElementById('events');
  box.replaceChildren();
  if (!events.length) { box.append(el('div', { class: 'empty' }, 'No events in window.')); return; }
  for (const e of events.slice(0, 120)) {
    box.append(el('div', {
      class: 'item',
      onclick: () => {
        const m = markerById.get(e.id);
        if (m) { map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 5)); m.openPopup(); }
      },
    },
      el('div', { class: 't' }, el('span', { class: `dot ${e.kind}` }), e.title),
      el('div', { class: 'm' }, [SEV_LABEL[e.severity], e.country, timeAgo(e.ts)].filter(Boolean).join(' · ')),
    ));
  }
}

function renderSignals(signals) {
  const box = document.getElementById('signals');
  box.replaceChildren();
  // Taken signals stay visible — the autopilot executes within a minute, and
  // the map panel going blank right when something happened was the old bug.
  const fresh = signals
    .filter((s) => (s.status === 'new' || s.status === 'taken') && Date.now() - s.created_at < 48 * 3600e3)
    .slice(0, 12);
  if (!fresh.length) { box.append(el('div', { class: 'empty' }, 'No live signals. The engine scans events every 5 minutes.')); return; }
  for (const s of fresh) {
    const canFly = s.event && Number.isFinite(s.event.lat) && Number.isFinite(s.event.lon);
    box.append(el('div', { class: 'sig-card' },
      el('div', { class: 'head' },
        el('h3', {}, s.headline),
        el('span', { class: `chip ${s.direction}` }, s.direction),
        el('span', { class: `chip ${s.confidence}` }, s.confidence),
        s.status === 'taken' ? el('span', { class: 'chip auto' }, '✓ traded') : null,
      ),
      Number.isFinite(s.plan_entry)
        ? el('div', { class: 'plan-meta' }, `${s.tv_symbol}: entry ${fmtPrice(s.plan_entry)} · stop ${fmtPrice(s.plan_stop)} · target ${fmtPrice(s.plan_target)} · size ${s.plan_qty}`)
        : null,
      el('div', { class: 'thesis' }, s.thesis.length > 200 ? s.thesis.slice(0, 200) + '…' : s.thesis),
      el('div', { class: 'actions' },
        el('a', { class: 'btn primary', href: `/trades?signal=${encodeURIComponent(s.id)}` }, 'Open in Trades →'),
        canFly ? el('button', {
          class: 'btn',
          onclick: () => {
            map.flyTo([s.event.lat, s.event.lon], Math.max(map.getZoom(), 5));
            const m = markerById.get(s.event.id);
            if (m) m.openPopup();
          },
        }, 'Fly to event') : null,
      ),
    ));
  }
}

function renderNews(items) {
  const box = document.getElementById('news');
  box.replaceChildren();
  if (!items.length) { box.append(el('div', { class: 'empty' }, 'No news loaded yet.')); return; }
  for (const n of items.slice(0, 80)) {
    box.append(el('div', { class: 'item', onclick: () => { const su = safeUrl(n.url); if (su) window.open(su, '_blank', 'noopener'); } },
      el('div', { class: 't' }, n.title),
      el('div', { class: 'm' },
        el('span', { class: 'news-imp' }, String(n.importance)),
        [n.source, n.threatCategory, n.threatLevel ? n.threatLevel.toLowerCase() : null, timeAgo(n.ts)].filter(Boolean).join(' · '),
        n.tickers?.length ? el('span', { style: 'color: var(--accent)' }, n.tickers.join(' ')) : null,
      ),
    ));
  }
}

const tabEvents = document.getElementById('tab-events');
const tabNews = document.getElementById('tab-news');
function showTab(which) {
  document.getElementById('events').hidden = which !== 'events';
  document.getElementById('news').hidden = which !== 'news';
  tabEvents.classList.toggle('active', which === 'events');
  tabNews.classList.toggle('active', which === 'news');
}
tabEvents.addEventListener('click', () => showTab('events'));
tabNews.addEventListener('click', () => showTab('news'));

// Time-window selector for the events layer (persists).
let eventHours = Number(localStorage.getItem('wt-map-hours')) || 48;
{
  const HOURS = [6, 24, 48, 168];
  const row = el('div', { class: 'tabbtns', id: 'hours-row', style: 'padding: 4px 8px' },
    ...HOURS.map((h) => el('button', {
      class: h === eventHours ? 'active' : '',
      onclick: () => {
        eventHours = h;
        localStorage.setItem('wt-map-hours', String(h));
        document.querySelectorAll('#hours-row button').forEach((b, i) => b.classList.toggle('active', HOURS[i] === h));
        refresh();
      },
    }, h === 168 ? '7d' : `${h}h`)));
  document.getElementById('events')?.before(row);
}

async function refresh() {
  try {
    const [ev, sig, news, tr] = await Promise.all([
      api(`/api/events?hours=${eventHours}`), api('/api/signals'), api('/api/news'),
      api('/api/trades?limit=150').catch(() => null),
    ]);
    signalsCache = sig.signals;
    tradesBySignal = new Map();
    if (tr) {
      for (const t of tr.trades) {
        if (!t.signal_id) continue;
        const arr = tradesBySignal.get(t.signal_id) || [];
        arr.push(t);
        tradesBySignal.set(t.signal_id, arr);
      }
    }
    renderMarkers(ev.events);
    renderEventList(ev.events);
    renderSignals(sig.signals);
    renderAmbience(sig.signals);
    renderNews(news.items);
    document.getElementById('event-count').textContent = `(${ev.events.length})`;
    const status = document.getElementById('status');
    // Native replaceChildren stringifies a bare null into a visible "null" —
    // build through el(), which drops null children.
    status.replaceChildren(el('span', {},
      el('span', { class: 'ok' }, '●'), ` ${ev.events.length} events · updated ${timeAgo(ev.fetchedAt)}`,
      ev.errors?.length ? el('span', { style: 'color: var(--warn)' }, ` (${ev.errors.length} feed issue${ev.errors.length > 1 ? 's' : ''})`) : null,
    ));
  } catch (err) {
    document.getElementById('status').textContent = `error: ${err.message}`;
  }
}

refresh();
refreshFlights();
refreshShips();
setInterval(refresh, 60 * 1000);
setInterval(refreshFlights, 60 * 1000);
setInterval(refreshShips, 60 * 1000);
