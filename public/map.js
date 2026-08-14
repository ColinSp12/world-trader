import { el, api, timeAgo, safeUrl, fmtPrice, KIND_LABEL, SEV_LABEL } from '/shared.js';

const KIND_COLOR = { quake: '#3987e5', unrest: '#d95926', conflict: '#d95926', natural: '#199e70' };

// preferCanvas keeps 1000+ ship markers cheap to render
const map = L.map('map', { worldCopyJump: true, zoomControl: true, preferCanvas: true }).setView([25, 15], 2);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: 'abcd', maxZoom: 12,
}).addTo(map);

let flightsOn = true;
let shipsOn = true;
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
      if (!flightsOn) flightLayer.clearLayers();
      else refreshFlights();
      updateFlightsToggle(null);
    },
  }, '✈ aircraft'));
  div.append(el('button', {
    class: 'legend-toggle ships', id: 'ships-toggle',
    onclick: () => {
      shipsOn = !shipsOn;
      if (!shipsOn) shipLayer.clearLayers();
      else refreshShips();
      updateShipsToggle(null);
    },
  }, '⚓ ships'));
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

function updateShipsToggle(count, source) {
  const btn = document.getElementById('ships-toggle');
  if (!btn) return;
  btn.classList.toggle('off', !shipsOn);
  if (source) btn.title = source;
  btn.textContent = shipsOn ? `⚓ ships${count != null ? ` (${count})` : ''}` : '⚓ ships — off';
}

const markerLayer = L.layerGroup().addTo(map);
const markerById = new Map();
const flightLayer = L.layerGroup().addTo(map);

const shipLayer = L.layerGroup().addTo(map);

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

function popupContent(e) {
  const wrap = el('div', {},
    el('div', { style: 'font-weight:600' }, e.title),
    el('div', { class: 'm' }, [KIND_LABEL[e.kind] || e.kind, SEV_LABEL[e.severity], e.country, timeAgo(e.ts)].filter(Boolean).join(' · ')),
  );
  if (e.detail) wrap.append(el('div', { class: 'm' }, e.detail.slice(0, 220)));
  const su = safeUrl(e.url);
  if (su) wrap.append(el('div', { class: 'm' }, el('a', { href: su, target: '_blank', rel: 'noopener' }, 'source ↗')));
  return wrap;
}

function renderMarkers(events) {
  markerLayer.clearLayers();
  markerById.clear();
  for (const e of events) {
    const marker = L.circleMarker([e.lat, e.lon], {
      radius: 3 + e.severity * 2.5,
      color: KIND_COLOR[e.kind] || '#898781',
      weight: 1.5,
      fillColor: KIND_COLOR[e.kind] || '#898781',
      fillOpacity: 0.55,
    });
    marker.bindPopup(popupContent(e));
    marker.addTo(markerLayer);
    markerById.set(e.id, marker);
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
  const fresh = signals.filter((s) => s.status === 'new').slice(0, 12);
  if (!fresh.length) { box.append(el('div', { class: 'empty' }, 'No new signals. The engine scans events every 5 minutes.')); return; }
  for (const s of fresh) {
    box.append(el('div', { class: 'sig-card' },
      el('div', { class: 'head' },
        el('h3', {}, s.headline),
        el('span', { class: `chip ${s.direction}` }, s.direction),
        el('span', { class: `chip ${s.confidence}` }, s.confidence),
      ),
      Number.isFinite(s.plan_entry)
        ? el('div', { class: 'plan-meta' }, `${s.tv_symbol}: entry ${fmtPrice(s.plan_entry)} · stop ${fmtPrice(s.plan_stop)} · target ${fmtPrice(s.plan_target)} · size ${s.plan_qty}`)
        : null,
      el('div', { class: 'thesis' }, s.thesis.length > 200 ? s.thesis.slice(0, 200) + '…' : s.thesis),
      el('div', { class: 'actions' },
        el('a', { class: 'btn primary', href: `/trades?signal=${encodeURIComponent(s.id)}` }, 'Open in Trades →'),
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

async function refresh() {
  try {
    const [ev, sig, news] = await Promise.all([api('/api/events?hours=48'), api('/api/signals'), api('/api/news')]);
    renderMarkers(ev.events);
    renderEventList(ev.events);
    renderSignals(sig.signals);
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
