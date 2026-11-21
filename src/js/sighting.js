'use strict';

(function () {
  const PIN_SVG = '<svg viewBox="0 0 44 52" width="44" height="52" aria-hidden="true" focusable="false"><path d="M22 3c8.6 0 15 6.7 15 15.2C37 30 22 49 22 49S7 30 7 18.2C7 9.7 13.4 3 22 3z" fill="#c65316" stroke="#2a1a12" stroke-width="2"/><circle cx="22" cy="18" r="6.5" fill="#fff9f2"/><circle cx="19.6" cy="17.2" r="1.1" fill="#2a1a12"/><circle cx="24.5" cy="17.2" r="1.1" fill="#2a1a12"/></svg>';

  const form = document.getElementById('sighting-form');
  const thanks = document.getElementById('thank-you');
  const errors = document.getElementById('form-errors');
  const mapEl = document.getElementById('sighting-map');
  const status = document.getElementById('pin-status');
  const latInput = document.getElementById('latitude');
  const lngInput = document.getElementById('longitude');
  const manualLat = document.getElementById('manual-lat');
  const manualLng = document.getElementById('manual-lng');
  const photoInput = document.getElementById('photo');
  const videoInput = document.getElementById('video');
  const storyInput = document.getElementById('story');
  const seenAt = document.getElementById('seen-at');
  const submitBtn = document.getElementById('submit-sighting');
  const useBtn = document.getElementById('use-location');
  const sizeQuiet = document.getElementById('size-quiet');
  const sizeStatus = document.getElementById('size-status');
  const photoMeta = document.getElementById('photo-meta');
  const videoMeta = document.getElementById('video-meta');
  const photoPreview = document.getElementById('photo-preview');
  const videoPreview = document.getElementById('video-preview');

  let map = null;
  let marker = null;
  const previews = { photo: '', video: '' };

  function setStatus(message) {
    status.textContent = message;
  }

  function showErrors(messages) {
    errors.replaceChildren();
    if (!messages.length) return;
    const list = document.createElement('ul');
    messages.forEach((message) => {
      const item = document.createElement('li');
      item.textContent = message;
      list.appendChild(item);
    });
    errors.appendChild(list);
    errors.focus();
  }

  function clearErrors() {
    errors.replaceChildren();
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function kindOf(file) {
    if (!file || !file.size) return '';
    const type = (file.type || '').toLowerCase();
    const name = file.name || '';
    if (type === 'image/svg+xml' || /\.svg$/i.test(name)) return 'svg';
    if (type.startsWith('image/') || /\.(avif|bmp|gif|heic|jpe?g|png|webp)$/i.test(name)) return 'image';
    if (type.startsWith('video/') || /\.(mp4|m4v|mov|webm|ogv|ogg)$/i.test(name)) return 'video';
    return 'other';
  }

  function submissionBytes() {
    let total = 0;
    const data = new FormData(form);
    for (const value of data.values()) {
      if (value instanceof File) total += value.size || 0;
      else total += new TextEncoder().encode(String(value)).length;
    }
    return total;
  }

  function fileSummary(file) {
    if (!file || !file.size) return '';
    return `${file.name} · ${formatBytes(file.size)}`;
  }

  function updateSize(announce) {
    const config = window.ZOOMER_CONFIG;
    const total = submissionBytes();
    photoMeta.textContent = fileSummary(photoInput.files[0]);
    videoMeta.textContent = fileSummary(videoInput.files[0]);
    if (!config) return;
    if (total > config.maxUploadBytes) {
      sizeStatus.textContent = `This sighting is ${formatBytes(total)}. Netlify can take about 8 MB total, so this is too big to send. Try a shorter video or a smaller photo.`;
      sizeQuiet.textContent = '';
    } else if (total >= config.warnUploadBytes) {
      sizeStatus.textContent = `This sighting is ${formatBytes(total)}, close to the 8 MB limit. If sending fails, use a smaller file.`;
      sizeQuiet.textContent = '';
    } else {
      sizeStatus.textContent = '';
      sizeQuiet.textContent = announce && total > 0 ? `Upload size so far: ${formatBytes(total)} of about 8 MB.` : sizeQuiet.textContent;
      if (announce && total === 0) sizeQuiet.textContent = '';
    }
  }

  function showFilePreview(slot, file, imageEl, videoEl) {
    if (previews[slot]) URL.revokeObjectURL(previews[slot]);
    previews[slot] = '';
    imageEl.hidden = true;
    videoEl.hidden = true;
    imageEl.removeAttribute('src');
    videoEl.removeAttribute('src');
    const kind = kindOf(file);
    if (!file || (kind !== 'image' && kind !== 'video')) return;
    const url = URL.createObjectURL(file);
    previews[slot] = url;
    const target = kind === 'image' ? imageEl : videoEl;
    target.src = url;
    target.hidden = false;
  }

  function nowLocalValue() {
    const date = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function setPin(lat, lng, options = {}) {
    lat = Number(lat);
    lng = Number(lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setStatus('Those coordinates are off the map. Latitude is between -90 and 90, longitude between -180 and 180.');
      return;
    }
    latInput.value = lat.toFixed(6);
    lngInput.value = lng.toFixed(6);
    if (document.activeElement !== manualLat) manualLat.value = lat.toFixed(6);
    if (document.activeElement !== manualLng) manualLng.value = lng.toFixed(6);
    if (map && window.L) {
      if (!marker) {
        marker = window.L.marker([lat, lng], {
          icon: window.L.divIcon({
            className: 'pin-wrap',
            html: PIN_SVG,
            iconSize: [44, 52],
            iconAnchor: [22, 48]
          }),
          draggable: true,
          autoPan: true,
          keyboard: true,
          alt: 'Zoomer sighting pin'
        }).addTo(map);
        marker.on('drag', () => {
          const point = marker.getLatLng();
          latInput.value = point.lat.toFixed(6);
          lngInput.value = point.lng.toFixed(6);
        });
        marker.on('dragend', () => {
          const point = marker.getLatLng();
          setPin(point.lat, point.lng, { fromDrag: true });
        });
      } else if (!options.fromDrag) {
        marker.setLatLng([lat, lng]);
      }
      if (options.zoom) map.setView([lat, lng], Math.max(map.getZoom(), 17));
    }
    mapEl.removeAttribute('aria-invalid');
    setStatus(`Pin placed at ${lat.toFixed(5)}, ${lng.toFixed(5)}.`);
  }

  function validate() {
    const config = window.ZOOMER_CONFIG;
    const messages = [];
    if (!latInput.value.trim() || !lngInput.value.trim()) {
      messages.push('Drop a pin on the map so we know where you saw Zoomer.');
    }
    const photo = photoInput.files[0];
    const video = videoInput.files[0];
    const story = storyInput.value.trim();
    const photoKind = kindOf(photo);
    const videoKind = kindOf(video);
    if (photo && photoKind === 'svg') messages.push('SVG drawings can’t be used. Please choose a JPEG, PNG, GIF, or WebP photo.');
    else if (photo && photoKind !== 'image') messages.push('The photo needs to be an image file.');
    if (video && videoKind !== 'video') messages.push('The video needs to be a video file.');
    const hasPhoto = photoKind === 'image';
    const hasVideo = videoKind === 'video';
    if (!story && !hasPhoto && !hasVideo) messages.push('Add a photo, a video, or a short story — at least one.');
    if (!seenAt.value) messages.push('When did you see Zoomer?');
    if (config && submissionBytes() > config.maxUploadBytes) {
      messages.push('That’s too big to send. Netlify accepts about 8 MB for the whole sighting, photo and video included. Please use a shorter video or a smaller photo.');
    }
    return messages;
  }

  function showThanks() {
    form.hidden = true;
    const lead = document.querySelector('.form-lead');
    if (lead) lead.hidden = true;
    thanks.hidden = false;
    const heading = thanks.querySelector('h2');
    if (heading) heading.focus();
  }

  function geoMessage(err) {
    if (err && err.code === 1) return 'Location is blocked in this browser. Tap the map, or type coordinates.';
    if (err && err.code === 3) return 'Finding your location took too long. Tap the map instead.';
    return 'Could not read your location. Tap the map, or type coordinates.';
  }

  const config = window.ZOOMER_CONFIG;
  if (!seenAt.value) seenAt.value = nowLocalValue();

  photoInput.addEventListener('change', () => {
    showFilePreview('photo', photoInput.files[0], photoPreview, photoPreview);
    updateSize(true);
  });
  videoInput.addEventListener('change', () => {
    showFilePreview('video', videoInput.files[0], videoPreview, videoPreview);
    updateSize(true);
  });
  storyInput.addEventListener('input', () => updateSize(false));

  manualLat.addEventListener('change', () => setPin(manualLat.value, manualLng.value, { zoom: true }));
  manualLng.addEventListener('change', () => setPin(manualLat.value, manualLng.value, { zoom: true }));

  useBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      setStatus('This browser cannot share location. Tap the map or type coordinates.');
      return;
    }
    useBtn.disabled = true;
    useBtn.textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition((position) => {
      setPin(position.coords.latitude, position.coords.longitude, { zoom: true });
      useBtn.disabled = false;
      useBtn.textContent = 'Use my location';
    }, (err) => {
      setStatus(geoMessage(err));
      useBtn.disabled = false;
      useBtn.textContent = 'Use my location';
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });

  mapEl.addEventListener('keydown', (event) => {
    if (!marker || event.target !== mapEl) return;
    const step = event.shiftKey ? 0.0004 : 0.00008;
    const deltas = { ArrowUp: [step, 0], ArrowDown: [-step, 0], ArrowLeft: [0, -step], ArrowRight: [0, step] };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    const point = marker.getLatLng();
    setPin(point.lat + delta[0], point.lng + delta[1]);
  });

  if (!config || !config.map) {
    showErrors(['This page is missing its settings. Please reload.']);
  } else if (!window.L) {
    setStatus('The map library did not load. Type coordinates below, or refresh the page.');
    document.getElementById('coord-details').open = true;
  } else {
    map = window.L.map(mapEl, { scrollWheelZoom: true, zoomControl: true });
    map.setView([config.map.lat, config.map.lng], config.map.zoom);
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    map.on('click', (event) => setPin(event.latlng.lat, event.latlng.lng));
    window.setTimeout(() => map.invalidateSize(), 150);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const messages = validate();
    if (messages.length) {
      if (!latInput.value.trim() || !lngInput.value.trim()) mapEl.setAttribute('aria-invalid', 'true');
      showErrors(messages);
      return;
    }
    clearErrors();
    const body = new FormData(form);
    if (!photoInput.files.length) body.delete('photo');
    if (!videoInput.files.length) body.delete('video');
    const original = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    try {
      const response = await fetch('/', { method: 'POST', body });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      showThanks();
    } catch (err) {
      showErrors(['Couldn’t send that sighting. Check your connection and try again.']);
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  });
}());
