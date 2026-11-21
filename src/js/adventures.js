'use strict';

(function () {
  const PIN_SVG = '<svg viewBox="0 0 44 52" width="44" height="52" aria-hidden="true" focusable="false"><path d="M22 3c8.6 0 15 6.7 15 15.2C37 30 22 49 22 49S7 30 7 18.2C7 9.7 13.4 3 22 3z" fill="#d4a72c" stroke="#2b2f36" stroke-width="2"/><circle cx="22" cy="18" r="7" fill="#5f6b78"/><ellipse cx="19.4" cy="17.4" rx="1.5" ry="1.8" fill="#e8c547"/><ellipse cx="24.6" cy="17.4" rx="1.5" ry="1.8" fill="#e8c547"/><circle cx="19.5" cy="17.6" r="0.6" fill="#2b2f36"/><circle cx="24.7" cy="17.6" r="0.6" fill="#2b2f36"/></svg>';

  const status = document.getElementById('adventures-status');
  const banner = document.getElementById('sample-banner');
  const empty = document.getElementById('empty-state');
  const loadError = document.getElementById('load-error');
  const mapSection = document.getElementById('map-section');
  const mapEl = document.getElementById('adventures-map');
  const gallerySection = document.getElementById('gallery-section');
  const gallery = document.getElementById('gallery');

  const markers = new Map();
  let map = null;

  function domId(id) {
    const cleaned = String(id).replace(/[^A-Za-z0-9_-]/g, '');
    return cleaned || 'sighting';
  }

  function safeUrl(value) {
    if (typeof value !== 'string') return '';
    if ((value.startsWith('/assets/') || value.startsWith('/media/')) && !value.includes('..') && !value.includes('\\')) {
      return value;
    }
    return '';
  }

  function formatWhen(value) {
    if (!value) return 'Time not recorded';
    const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function usable(sighting) {
    return sighting
      && Number.isFinite(Number(sighting.lat))
      && Number.isFinite(Number(sighting.lng))
      && Number(sighting.lat) >= -90 && Number(sighting.lat) <= 90
      && Number(sighting.lng) >= -180 && Number(sighting.lng) <= 180;
  }

  function withDisplayPoints(sightings) {
    const seen = new Map();
    return sightings.map((sighting) => {
      const lat = Number(sighting.lat);
      const lng = Number(sighting.lng);
      const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
      const count = seen.get(key) || 0;
      seen.set(key, count + 1);
      if (count === 0) return { ...sighting, lat, lng, displayLat: lat, displayLng: lng };
      const angle = count * 0.85;
      const radius = 0.00015 * count;
      return {
        ...sighting,
        lat,
        lng,
        displayLat: lat + Math.sin(angle) * radius,
        displayLng: lng + Math.cos(angle) * radius
      };
    });
  }

  function addMedia(parent, sighting, options = {}) {
    const photo = safeUrl(sighting.photo);
    const video = safeUrl(sighting.video);
    const showPhoto = Boolean(photo) && !(options.gallery && video);
    if (video) {
      const el = document.createElement('video');
      el.controls = true;
      el.playsInline = true;
      el.preload = 'metadata';
      el.src = video;
      el.setAttribute('aria-label', 'Video from this Zoomer sighting');
      if (photo) el.poster = photo;
      parent.appendChild(el);
    }
    if (showPhoto) {
      const img = document.createElement('img');
      img.src = photo;
      img.alt = sighting.photoAlt || 'Photo from this Zoomer sighting';
      parent.appendChild(img);
    }
    if (!photo && !video) {
      const placeholder = document.createElement('div');
      placeholder.className = 'no-media';
      placeholder.textContent = 'Story only';
      parent.appendChild(placeholder);
    }
  }

  function popupElement(sighting) {
    const wrap = document.createElement('div');
    wrap.className = 'popup-card';
    addMedia(wrap, sighting);
    if (sighting.story) {
      const story = document.createElement('p');
      story.className = 'story';
      story.textContent = sighting.story;
      wrap.appendChild(story);
    }
    const meta = document.createElement('p');
    meta.className = 'popup-meta';
    const time = document.createElement('time');
    if (sighting.seenAt) time.dateTime = sighting.seenAt;
    time.textContent = formatWhen(sighting.seenAt || sighting.createdAt);
    const who = sighting.finderName ? `Seen by ${sighting.finderName}` : 'Seen by a neighbor';
    meta.append(time, document.createTextNode(` · ${who}`));
    wrap.appendChild(meta);
    if (sighting.sample) {
      const note = document.createElement('p');
      note.className = 'popup-sample';
      note.textContent = 'Sample sighting for local preview';
      wrap.appendChild(note);
    }
    return wrap;
  }

  function focusSighting(id) {
    const marker = markers.get(id);
    if (!marker || !map) return;
    mapEl.scrollIntoView({ block: 'start' });
    map.invalidateSize();
    const point = marker.getLatLng();
    map.setView(point, Math.max(map.getZoom(), 16));
    marker.openPopup();
    const hash = `#s-${domId(id)}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function escapeAttr(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
  }

  function renderMap(sightings) {
    mapSection.hidden = false;
    map = window.L.map(mapEl, { scrollWheelZoom: true, zoomControl: true });
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    const bounds = [];
    sightings.forEach((sighting) => {
      const when = formatWhen(sighting.seenAt || sighting.createdAt);
      const who = sighting.finderName ? `Seen by ${sighting.finderName}` : 'Seen by a neighbor';
      const label = escapeAttr(`Zoomer sighting on ${when}. ${who}.`);
      const button = `<button type="button" class="pin-button" aria-label="${label}">${PIN_SVG}</button>`;
      const markerIcon = window.L.divIcon({
        className: 'pin-wrap',
        html: button,
        iconSize: [44, 52],
        iconAnchor: [22, 48],
        popupAnchor: [0, -40]
      });
      const marker = window.L.marker([sighting.displayLat, sighting.displayLng], {
        icon: markerIcon,
        keyboard: true,
        title: `Sighting on ${when}`
      }).addTo(map);
      marker.bindPopup(popupElement(sighting), { maxWidth: 280, autoPanPadding: [16, 16] });
      markers.set(sighting.id, marker);
      bounds.push([sighting.displayLat, sighting.displayLng]);
    });
    if (bounds.length === 1) map.setView(bounds[0], 16);
    else map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
    window.setTimeout(() => map.invalidateSize(), 150);
  }

  function renderGallery(sightings) {
    gallerySection.hidden = false;
    gallery.replaceChildren();
    sightings.forEach((sighting) => {
      const item = document.createElement('li');
      item.className = 'sighting-card';
      item.id = `card-${domId(sighting.id)}`;
      if (sighting.sample) {
        const badge = document.createElement('p');
        badge.className = 'badge';
        badge.textContent = 'SAMPLE';
        item.appendChild(badge);
      }
      addMedia(item, sighting, { gallery: true });
      const heading = document.createElement('h3');
      const time = document.createElement('time');
      if (sighting.seenAt) time.dateTime = sighting.seenAt;
      time.textContent = formatWhen(sighting.seenAt || sighting.createdAt);
      heading.appendChild(time);
      item.appendChild(heading);
      if (sighting.story) {
        const story = document.createElement('p');
        story.className = 'story';
        story.textContent = sighting.story;
        item.appendChild(story);
      }
      const who = document.createElement('p');
      who.className = 'fine';
      who.textContent = sighting.finderName ? `Seen by ${sighting.finderName}` : 'Seen by a neighbor';
      item.appendChild(who);
      const link = document.createElement('a');
      link.href = `#s-${domId(sighting.id)}`;
      link.textContent = 'Show on map';
      link.addEventListener('click', (event) => {
        event.preventDefault();
        focusSighting(sighting.id);
      });
      item.appendChild(link);
      gallery.appendChild(item);
    });
  }

  function showEmpty() {
    status.hidden = true;
    empty.hidden = false;
    mapSection.hidden = true;
    gallerySection.hidden = true;
  }

  async function init() {
    let payload;
    try {
      const response = await fetch('/data/sightings.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error('status');
      payload = await response.json();
    } catch (err) {
      status.hidden = true;
      loadError.hidden = false;
      return;
    }

    const sightings = withDisplayPoints((payload.sightings || []).filter(usable));
    status.hidden = true;
    if (payload.source === 'sample') banner.hidden = false;
    if (!sightings.length) {
      showEmpty();
      return;
    }
    if (!window.L) {
      loadError.hidden = false;
      loadError.textContent = 'The map library did not load. The list below still has every sighting.';
    } else {
      renderMap(sightings);
    }
    renderGallery(sightings);
    const hash = location.hash.replace(/^#s-/, '');
    if (hash) {
      const match = sightings.find((sighting) => domId(sighting.id) === hash);
      if (match) focusSighting(match.id);
    }
  }

  init();
}());
