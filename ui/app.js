// ITEMDEX UI controller.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const { esc } = Card;

  const MAX_FRAMES = 6;
  const SCAN_LINES = [
    'BOOTING GEMMA...', 'SCANNING PIXELS...', 'IDENTIFYING ITEM...', 'MEASURING SIZE...',
    'CHECKING MARKET PRICES...', 'ROLLING RARITY...', 'PRINTING CARD...',
  ];

  const state = {
    items: [],
    frames: [], // data URLs
    source: 'photo', // photo | video | camera
    geo: null, // { lat, lng, accuracy_m, source }
    preview: null, // { card, best_frame }
    scanning: false,
    filterType: 'ALL',
  };

  // ---------------------------------------------------------------- api
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...Auth.headers(), ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('API key required: open this page once with ?key=YOUR_KEY');
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---------------------------------------------------------------- RPG dialog
  let dialogTimer;
  function say(text, { sound = null, hold = 3500 } = {}) {
    const box = $('#dialog');
    const p = $('#dialog-text');
    clearInterval(dialogTimer);
    box.hidden = false;
    p.textContent = '';
    if (sound) Sound.play(sound);
    let i = 0;
    dialogTimer = setInterval(() => {
      p.textContent = text.slice(0, ++i);
      if (i % 2) Sound.play('type');
      if (i >= text.length) {
        clearInterval(dialogTimer);
        dialogTimer = setTimeout(() => { box.hidden = true; }, hold);
      }
    }, 22);
  }
  $('#dialog').addEventListener('click', () => { $('#dialog').hidden = true; });

  // ---------------------------------------------------------------- nav
  function show(view) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    if (view === 'collection') {
      stopCamera();
      renderGrid();
    } else if (!LiveCam.active && !['photo', 'video'].includes(state.source)) {
      startCamera();
    }
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => { Sound.play('select'); show(t.dataset.view); }));
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) { Sound.play('select'); show(go.dataset.goto); }
  });

  $('#sound-toggle').addEventListener('click', (e) => {
    const on = Sound.toggle();
    e.currentTarget.classList.toggle('off', !on);
    Sound.play('click');
  });
  $('#sound-toggle').classList.toggle('off', !Sound.enabled);

  // ---------------------------------------------------------------- HUD
  function updateHud() {
    $('#stat-count').textContent = state.items.length;
    const total = state.items.reduce((s, i) => s + (i.value?.typical || 0), 0);
    $('#stat-value').textContent = Card.money(total);
  }

  async function checkHealth() {
    const led = $('#llm-status');
    try {
      const h = await api('/api/health');
      Card.setCurrency(h.currency);
      led.className = `hud-led ${h.llm ? 'on' : 'off'}`;
      led.querySelector('span').textContent = h.llm ? `GEMMA ONLINE` : 'GEMMA OFFLINE';
      led.title = `Model: ${h.model}`;
    } catch {
      led.className = 'hud-led off';
      led.querySelector('span').textContent = 'SERVICE DOWN';
    }
  }

  // ---------------------------------------------------------------- scan: viewfinder
  const STATUS_TEXT = {
    off: () => 'CAMERA OFF',
    paused: () => (state.scanning ? 'GEMMA IS ANALYZING...' : 'REVIEW YOUR CARD  →'),
    error: () => 'GEMMA NOT RESPONDING... RETRYING',
    searching: () => 'SEARCHING FOR ITEM...',
    detected: (s) => (LiveCam.mode === 'manual'
      ? `DETECTED: ${s.name} · PRESS SNAP`
      : `DETECTED: ${s.name} · HOLD IT THERE`),
    hold: (s) => `${s.name} · HOLD STILL!`,
    locking: (s) => `LOCKING ${s.name} ${'▮'.repeat(Math.round(s.progress * 8))}${'▯'.repeat(8 - Math.round(s.progress * 8))}`,
    done: (s) => `GOT ${s.name}! SHOW A NEW ITEM`,
  };

  function onLiveStatus(s) {
    const el = $('#vf-status');
    el.className = `vf-status phase-${s.phase}`;
    el.querySelector('span').textContent = STATUS_TEXT[s.phase](s).toUpperCase();
    if (s.phase === 'locking' && s.progress > 0) Sound.play('tick');
    $('#btn-snap').disabled = !LiveCam.active || state.scanning;
  }

  function flash() {
    const vf = $('#dropzone');
    vf.classList.remove('flash');
    void vf.offsetWidth;
    vf.classList.add('flash');
  }

  let cameraStarting = false;
  async function startCamera() {
    if (cameraStarting || LiveCam.active) return;
    cameraStarting = true;
    $('#still').hidden = true;
    $('#camera-feed').hidden = false;
    $('#btn-camera').hidden = true;
    $('#dropzone-idle').hidden = true;
    const ok = await LiveCam.start($('#camera-feed'), $('#overlay'), {
      onStatus: onLiveStatus,
      onAutoSnap: (shot) => {
        flash();
        Sound.play('select');
        state.frames = shot.frames;
        state.source = 'camera';
        state.preview = null;
        renderFrames();
        scan();
      },
    });
    if (!ok) {
      $('#camera-feed').hidden = true;
      $('#idle-text').textContent = 'NO CAMERA ACCESS';
      $('#dropzone-idle').hidden = false;
      say('Camera not available. Allow it in System Settings > Privacy & Security > Camera, or upload a photo.', { sound: 'error', hold: 6000 });
    }
    cameraStarting = false;
    renderFrames();
  }

  function stopCamera() {
    LiveCam.stop();
  }

  function snapNow() {
    if (!LiveCam.active || state.scanning) return;
    const shot = LiveCam.snap();
    flash();
    Sound.play('select');
    if (state.source !== 'camera') state.frames = [];
    state.source = 'camera';
    state.preview = null;
    if (LiveCam.mode === 'auto') {
      // Forced snap in auto mode: same as an auto-lock.
      state.frames = shot.frames;
      renderFrames();
      scan();
      return;
    }
    if (state.frames.length >= MAX_FRAMES) {
      say(`Max ${MAX_FRAMES} shots per item.`, { sound: 'error' });
      return;
    }
    // First manual shot keeps the full frame too, for background/location context.
    state.frames.push(shot.frames[0]);
    if (state.frames.length === 1 && shot.frames[1]) state.frames.push(shot.frames[1]);
    say(`Shot ${state.frames.length} saved. Snap more angles or press SCAN.`, { hold: 2000 });
    renderFrames();
  }

  $('#btn-snap').addEventListener('click', snapNow);
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || !$('#view-scan').classList.contains('active')) return;
    if (e.target.closest('input, textarea, select, button') || !$('#modal').hidden) return;
    e.preventDefault();
    snapNow();
  });

  $$('.mode').forEach((b) => b.addEventListener('click', () => {
    $$('.mode').forEach((m) => m.classList.toggle('active', m === b));
    LiveCam.setMode(b.dataset.mode);
    Sound.play('click');
    try { localStorage.setItem('itemdex.mode', b.dataset.mode); } catch { /* ignore */ }
  }));
  try {
    const saved = localStorage.getItem('itemdex.mode');
    if (saved) $(`.mode[data-mode="${saved}"]`)?.click();
  } catch { /* ignore */ }

  // ---------------------------------------------------------------- scan: frames + uploads
  function renderFrames() {
    $('#frames').innerHTML = state.frames.map((f, i) => `
      <div class="frame">
        <img src="${f}" alt="shot ${i + 1}" />
        <button class="frame-x" data-i="${i}" title="Remove">✕</button>
      </div>`).join('');
    const geo = state.geo;
    if (geo) {
      $('#frames').insertAdjacentHTML('beforeend', `
        <div class="geo-chip" title="Accuracy ${geo.accuracy_m ? `±${Math.round(geo.accuracy_m)}m` : 'unknown'}">
          ⌖ ${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)}
          <em>${geo.source === 'exif' ? 'PHOTO' : 'GPS'}</em>
          <button class="geo-x" title="Don't save coordinates">✕</button>
        </div>`);
    }
    $('#btn-scan').disabled = !state.frames.length || state.scanning;
    $('#btn-snap').disabled = !LiveCam.active || state.scanning;
  }

  $('#frames').addEventListener('click', (e) => {
    const x = e.target.closest('.frame-x');
    if (x) {
      state.frames.splice(Number(x.dataset.i), 1);
      Sound.play('click');
      renderFrames();
    }
    if (e.target.closest('.geo-x')) {
      state.geo = null;
      Sound.play('click');
      renderFrames();
    }
  });

  function resetScan() {
    state.frames = [];
    state.preview = null;
    state.geo = null;
    $('#hint').value = '';
    $('#location').value = '';
    showCardBack();
    LiveCam.setPaused(false);
    if (!LiveCam.active && $('#view-scan').classList.contains('active')) startCamera();
    renderFrames();
  }

  function showStill() {
    stopCamera();
    $('#camera-feed').hidden = true;
    $('#dropzone-idle').hidden = true;
    $('#still').src = state.frames[0] || '';
    $('#still').hidden = !state.frames.length;
    $('#btn-camera').hidden = false;
    $('#vf-status').className = 'vf-status phase-upload';
    $('#vf-status span').textContent = `UPLOADED ${state.frames.length} IMAGE(S) · PRESS SCAN`;
  }

  async function addFiles(files) {
    const list = [...files];
    if (!list.length) return;
    const video = list.find((f) => f.type.startsWith('video/'));
    try {
      if (video) {
        say('Extracting frames from video...', { hold: 1500 });
        state.frames = await Media.videoFileToFrames(video, 4);
        state.source = 'video';
      } else {
        const images = list.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(f.name));
        if (state.source !== 'photo') state.frames = [];
        state.source = 'photo';
        for (const f of images.slice(0, MAX_FRAMES - state.frames.length)) {
          state.frames.push(await Media.imageFileToDataUrl(f));
          if (!state.geo) {
            const gps = await Media.readExifGps(f);
            if (gps) state.geo = { ...gps, accuracy_m: null, source: 'exif' };
          }
        }
      }
      state.preview = null;
      showCardBack();
      showStill();
      Sound.play('select');
    } catch (err) {
      say(err.message, { sound: 'error' });
    }
    renderFrames();
  }

  $('#btn-photo').addEventListener('click', () => { Sound.play('click'); $('#file-photo').click(); });
  $('#btn-video').addEventListener('click', () => { Sound.play('click'); $('#file-video').click(); });
  $('#btn-camera').addEventListener('click', () => {
    Sound.play('click');
    state.frames = [];
    state.source = 'camera';
    resetScan();
  });
  $('#file-photo').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('#file-video').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add('hover');
  }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('hover')));
  dz.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });

  // ---------------------------------------------------------------- scan: run
  function showCardBack() {
    $('#card-stage').innerHTML = `<div class="stage-idle">${Card.cardBack()}<p class="blink">INSERT ITEM TO BEGIN</p></div>`;
    $('#result-actions').hidden = true;
  }

  function showScanning() {
    const cover = state.frames[0];
    $('#card-stage').innerHTML = `
      <div class="scanner">
        <div class="scanner-screen">
          <img src="${cover}" alt="" />
          <div class="scanner-grid"></div>
          <div class="scanner-beam"></div>
        </div>
        <p class="scanner-text" id="scanner-text">${SCAN_LINES[0]}</p>
        <div class="scanner-bar"><i></i></div>
        <small id="scanner-time">0.0s</small>
      </div>`;
    $('#result-actions').hidden = true;
    const t0 = performance.now();
    let line = 0;
    const timer = setInterval(() => {
      const el = $('#scanner-text');
      if (!el) return clearInterval(timer);
      const s = (performance.now() - t0) / 1000;
      $('#scanner-time').textContent = `${s.toFixed(1)}s`;
      const next = Math.min(SCAN_LINES.length - 1, Math.floor(s / 1.6));
      if (next !== line) {
        line = next;
        el.textContent = SCAN_LINES[line];
        Sound.play('tick');
      }
    }, 100);
    return () => clearInterval(timer);
  }

  function showPreview() {
    const { card, best_frame: bf } = state.preview;
    const place = $('#location').value.trim();
    const item = {
      ...card,
      imageUrl: state.frames[bf] || state.frames[0],
      location: place ? { place } : null,
    };
    $('#card-stage').innerHTML = `<div class="reveal">${Card.render(item, { preview: true })}</div>`;
    Card.attachTilt($('#card-stage .reveal'));
    $('#result-actions').hidden = false;
  }

  async function scan() {
    if (!state.frames.length || state.scanning) return;
    state.scanning = true;
    LiveCam.setPaused(true);
    renderFrames();
    Sound.play('select');
    const stopAnim = showScanning();

    // Ask for device location in parallel when the photo had no GPS.
    if (!state.geo) {
      const frames = state.frames; // ignore a late fix that arrives after the user moved on
      Media.deviceLocation().then((dev) => {
        if (dev && !state.geo && state.frames === frames) {
          state.geo = { ...dev, source: 'device' };
          renderFrames();
        }
      });
    }

    try {
      const res = await api('/api/scan', {
        method: 'POST',
        body: { images: state.frames, hint: $('#hint').value, source: state.source },
      });
      state.preview = res;
      stopAnim();
      showPreview();
      if (!$('#location').value && res.card.location_guess) $('#location').value = res.card.location_guess;
      const name = res.card.name.toUpperCase();
      if (res.card.is_item) {
        say(`A wild ${name} appeared! (${(res.elapsed_ms / 1000).toFixed(1)}s)`, { sound: 'appear' });
      } else {
        say(`Hmm... Gemma isn't sure this is an item. Best guess: ${name}.`, { sound: 'error' });
      }
    } catch (err) {
      stopAnim();
      showCardBack();
      LiveCam.setPaused(false);
      say(`Scan failed: ${err.message}`, { sound: 'error', hold: 6000 });
    } finally {
      state.scanning = false;
      if (LiveCam.active && state.preview) onLiveStatus({ phase: 'paused' });
      renderFrames();
    }
  }
  $('#location').addEventListener('input', () => {
    const el = $('.reveal .card-stats .trunc');
    if (el) el.textContent = $('#location').value.trim() || state.preview?.card.location_guess || '???';
  });

  $('#btn-scan').addEventListener('click', scan);
  $('#btn-rescan').addEventListener('click', scan);
  $('#btn-discard').addEventListener('click', () => {
    Sound.play('remove');
    resetScan();
    say('The item fled back into the wild.');
  });

  $('#btn-save').addEventListener('click', async () => {
    if (!state.preview) return;
    const btn = $('#btn-save');
    btn.disabled = true;
    const { card, best_frame: bf } = state.preview;
    const place = $('#location').value.trim() || card.location_guess;
    try {
      const { item } = await api('/api/items', {
        method: 'POST',
        body: {
          card,
          image: state.frames[bf] || state.frames[0],
          source: state.source,
          location: { place, ...(state.geo || {}) },
        },
      });
      state.items.unshift(item);
      updateHud();
      $('.reveal .card')?.classList.add('caught');
      say(`Gotcha! ${item.name.toUpperCase()} was registered as NO.${Card.pad(item.number)}!`, { sound: 'get' });
      setTimeout(resetScan, 1400);
    } catch (err) {
      say(`Save failed: ${err.message}`, { sound: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------------------------------------------------------- collection
  const RANK = Card.RARITY_STARS;

  function renderTypeFilter() {
    const counts = state.items.reduce((m, i) => ({ ...m, [i.type]: (m[i.type] || 0) + 1 }), {});
    const types = Object.keys(counts).sort();
    $('#type-filter').innerHTML = ['ALL', ...types].map((t) => `
      <button class="chip ${t === state.filterType ? 'active' : ''} ${t !== 'ALL' ? `type-${t}` : ''}" data-type="${t}">
        ${t === 'ALL' ? 'ALL' : `${Card.TYPE_META[t].icon} ${Card.TYPE_META[t].label}`}
        <small>${t === 'ALL' ? state.items.length : counts[t]}</small>
      </button>`).join('');
  }

  $('#type-filter').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    Sound.play('click');
    state.filterType = chip.dataset.type;
    renderGrid();
  });
  $('#search').addEventListener('input', () => renderGrid());
  $('#sort').addEventListener('change', () => { Sound.play('click'); renderGrid(); });

  function filtered() {
    const q = $('#search').value.trim().toLowerCase();
    let list = state.items.filter((i) => state.filterType === 'ALL' || i.type === state.filterType);
    if (q) {
      list = list.filter((i) => [
        i.name, i.brand, i.model, i.subcategory, i.color, i.material, ...(i.tags || []),
        i.location?.place, i.location?.address,
      ].filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    const sorters = {
      new: (a, b) => b.created_at.localeCompare(a.created_at),
      value: (a, b) => (b.value.typical || 0) - (a.value.typical || 0),
      rarity: (a, b) => RANK[b.rarity] - RANK[a.rarity] || b.value.typical - a.value.typical,
      name: (a, b) => a.name.localeCompare(b.name),
      number: (a, b) => a.number - b.number,
    };
    return list.sort(sorters[$('#sort').value]);
  }

  function renderGrid() {
    if (!state.items.some((i) => i.type === state.filterType)) state.filterType = 'ALL';
    renderTypeFilter();
    const list = filtered();
    $('#empty').hidden = state.items.length > 0;
    $('#grid').innerHTML = list.length || !state.items.length
      ? list.map((i) => `<div class="grid-cell">${Card.render(i, { mini: true })}</div>`).join('')
      : '<p class="no-match">NO ITEMS MATCH YOUR SEARCH.</p>';
    $$('#grid .grid-cell').forEach(Card.attachTilt);
  }

  $('#grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) openDetail(card.dataset.id);
  });

  // ---------------------------------------------------------------- detail modal
  let currentId = null;

  function openDetail(id) {
    const item = state.items.find((i) => i.id === id);
    if (!item) return;
    currentId = id;
    Sound.play('select');
    $('#modal-card').innerHTML = Card.render(item);
    Card.attachTilt($('#modal-card'));
    renderInfo(item);
    $('#modal').hidden = false;
  }

  function closeModal() {
    $('#modal').hidden = true;
    currentId = null;
  }
  $('#modal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

  function locationBlock(item) {
    const loc = item.location;
    const history = (item.location_history || []).slice(1, 6);
    const coords = loc && loc.lat != null
      ? `<p class="coords">⌖ ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}
           ${loc.accuracy_m ? `<em>±${loc.accuracy_m}m</em>` : ''}
           <em>${loc.source === 'exif' ? 'PHOTO EXIF' : 'DEVICE GPS'}</em></p>
         <a class="btn btn-small" href="${esc(Card.mapUrl(loc))}" target="_blank" rel="noopener">⌖ OPEN MAP</a>`
      : '';
    return `
      <section class="info-sec loc-sec">
        <h4>LAST SEEN</h4>
        ${loc ? `
          <p class="place">${esc(Card.placeLabel(loc))} <em>${Card.ago(loc.at)}</em></p>
          ${loc.address ? `<p class="address">${esc(loc.address)}</p>` : ''}
          ${coords}` : '<p class="muted">Location unknown.</p>'}
        <form class="move-form" id="move-form">
          <input name="place" maxlength="80" placeholder="Moved it? Where is it now?" />
          <label class="check"><input type="checkbox" name="gps" checked /> + GPS</label>
          <button class="btn btn-small btn-primary">UPDATE</button>
        </form>
        ${history.length ? `<ul class="history">${history.map((h) => `
          <li><span>${esc(Card.placeLabel(h))}</span><em>${Card.ago(h.at)}</em></li>`).join('')}</ul>` : ''}
      </section>`;
  }

  function renderInfo(item) {
    const v = item.value;
    const row = (k, val) => (val ? `<tr><th>${k}</th><td>${esc(val)}</td></tr>` : '');
    $('#modal-info').innerHTML = `
      <h2>NO.${Card.pad(item.number)} ${esc(item.name)}</h2>
      <section class="info-sec value-sec">
        <h4>MARKET VALUE <em>(AI ESTIMATE · ${esc(v.confidence)} CONFIDENCE)</em></h4>
        <p class="big-value">${esc(Card.money(v.typical, { compact: false }))}</p>
        <p class="range">RANGE ${esc(Card.money(v.min))} – ${esc(Card.money(v.max))}
          ${v.new_price ? ` · NEW ${esc(Card.money(v.new_price))}` : ''}</p>
        ${v.reasoning ? `<p class="muted">${esc(v.reasoning)}</p>` : ''}
      </section>
      ${locationBlock(item)}
      <section class="info-sec">
        <h4>DATA</h4>
        <table class="data">
          ${row('BRAND', item.brand)}${row('MODEL', item.model)}${row('CATEGORY', item.subcategory)}
          ${row('SIZE', `${Card.dims(item.dimensions)} (${item.size_class})`)}
          ${row('WEIGHT', Card.weight(item.weight_g))}
          ${row('COLOR', item.color)}${row('MATERIAL', item.material)}
          ${row('CONDITION', `${item.condition.label} · ${item.condition.score}/100`)}
          ${row('NOTES', item.condition.notes)}
          ${row('ADDED', `${Card.date(item.created_at)} via ${item.source?.toUpperCase()}`)}
          ${row('TAGS', (item.tags || []).map((t) => `#${t}`).join(' '))}
        </table>
      </section>
      <div class="info-actions">
        <button class="btn" id="btn-edit">✎ EDIT</button>
        ${window.desktop?.exportCard ? '<button class="btn" id="btn-export">⇩ EXPORT PNG</button>' : ''}
        <button class="btn btn-danger" id="btn-delete">✕ RELEASE</button>
      </div>`;

    $('#move-form').addEventListener('submit', (e) => moveItem(e, item));
    $('#btn-edit').addEventListener('click', () => renderEdit(item));
    $('#btn-delete').addEventListener('click', () => deleteItem(item));
    $('#btn-export')?.addEventListener('click', () => exportCard(item));
  }

  function replaceItem(item) {
    state.items = state.items.map((i) => (i.id === item.id ? item : i));
    updateHud();
    renderGrid();
    if (currentId === item.id) {
      $('#modal-card').innerHTML = Card.render(item);
      Card.attachTilt($('#modal-card'));
      renderInfo(item);
    }
  }

  async function moveItem(e, item) {
    e.preventDefault();
    const form = e.currentTarget;
    const btn = form.querySelector('button');
    const place = form.place.value.trim();
    btn.disabled = true;
    btn.textContent = '...';
    try {
      const geo = form.gps.checked ? await Media.deviceLocation() : null;
      if (!place && !geo) throw new Error('Type a place (GPS not available).');
      const body = { place, ...(geo ? { ...geo, source: 'device' } : {}) };
      const { item: updated } = await api(`/api/items/${item.id}/location`, { method: 'PUT', body });
      replaceItem(updated);
      say(`${updated.name.toUpperCase()} is now at ${Card.placeLabel(updated.location)}.`, { sound: 'select' });
    } catch (err) {
      say(err.message, { sound: 'error' });
      btn.disabled = false;
      btn.textContent = 'UPDATE';
    }
  }

  async function deleteItem(item) {
    const btn = $('#btn-delete');
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      btn.textContent = 'SURE? CLICK AGAIN';
      Sound.play('error');
      return;
    }
    try {
      await api(`/api/items/${item.id}`, { method: 'DELETE' });
      state.items = state.items.filter((i) => i.id !== item.id);
      updateHud();
      closeModal();
      renderGrid();
      say(`Bye bye, ${item.name.toUpperCase()}!`, { sound: 'remove' });
    } catch (err) {
      say(err.message, { sound: 'error' });
    }
  }

  async function exportCard(item) {
    const card = $('#modal-card .card');
    card.classList.add('no-tilt');
    card.style.transform = '';
    await new Promise((r) => setTimeout(r, 250));
    const r = card.getBoundingClientRect();
    try {
      const res = await window.desktop.exportCard({ x: r.x, y: r.y, width: r.width, height: r.height }, item.name);
      if (res.saved) say(`Card saved to ${res.filePath}`, { sound: 'select' });
    } catch (err) {
      say(`Export failed: ${err.message}`, { sound: 'error' });
    } finally {
      card.classList.remove('no-tilt');
    }
  }

  // ---------------------------------------------------------------- edit form
  function renderEdit(item) {
    Sound.play('click');
    const opt = (list, cur) => list.map((x) => `<option ${x === cur ? 'selected' : ''}>${x}</option>`).join('');
    const d = item.dimensions;
    const v = item.value;
    $('#modal-info').innerHTML = `
      <h2>EDIT NO.${Card.pad(item.number)}</h2>
      <form class="edit-form" id="edit-form">
        <label class="wide">NAME<input name="name" value="${esc(item.name)}" maxlength="40" required /></label>
        <label>BRAND<input name="brand" value="${esc(item.brand)}" /></label>
        <label>MODEL<input name="model" value="${esc(item.model)}" /></label>
        <label>TYPE<select name="type">${opt(Object.keys(Card.TYPE_META), item.type)}</select></label>
        <label>RARITY<select name="rarity">${opt(Object.keys(Card.RARITY_STARS), item.rarity)}</select></label>
        <label>LENGTH cm<input name="length_cm" type="number" step="0.1" min="0" value="${d.length_cm}" /></label>
        <label>WIDTH cm<input name="width_cm" type="number" step="0.1" min="0" value="${d.width_cm}" /></label>
        <label>HEIGHT cm<input name="height_cm" type="number" step="0.1" min="0" value="${d.height_cm}" /></label>
        <label>WEIGHT g<input name="weight_g" type="number" min="0" value="${item.weight_g}" /></label>
        <label>VALUE MIN<input name="min" type="number" min="0" value="${v.min}" /></label>
        <label>VALUE TYPICAL<input name="typical" type="number" min="0" value="${v.typical}" /></label>
        <label>VALUE MAX<input name="max" type="number" min="0" value="${v.max}" /></label>
        <label>CONDITION (HP)<input name="score" type="number" min="0" max="100" value="${item.condition.score}" /></label>
        <label class="wide">DESCRIPTION<textarea name="description" rows="3">${esc(item.description)}</textarea></label>
        <div class="info-actions wide">
          <button class="btn btn-primary">✔ SAVE</button>
          <button type="button" class="btn" id="btn-cancel-edit">CANCEL</button>
        </div>
      </form>`;
    $('#btn-cancel-edit').addEventListener('click', () => renderInfo(item));
    $('#edit-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget));
      const n = (k) => Number(f[k]) || 0;
      const card = {
        ...item,
        name: f.name,
        brand: f.brand,
        model: f.model,
        type: f.type,
        rarity: f.rarity,
        description: f.description,
        dimensions: { length_cm: n('length_cm'), width_cm: n('width_cm'), height_cm: n('height_cm') },
        size_class: '', // recomputed from dimensions by the service
        weight_g: n('weight_g'),
        value: { ...v, min: n('min'), typical: n('typical'), max: n('max') },
        condition: { ...item.condition, score: n('score') },
      };
      try {
        const { item: updated } = await api(`/api/items/${item.id}`, { method: 'PUT', body: { card } });
        replaceItem(updated);
        say('Card updated!', { sound: 'select' });
      } catch (err) {
        say(err.message, { sound: 'error' });
      }
    });
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    showCardBack();
    state.source = 'camera';
    startCamera();
    checkHealth();
    setInterval(checkHealth, 30000);
    try {
      state.items = (await api('/api/items')).items;
    } catch (err) {
      say(`Could not load collection: ${err.message}`, { sound: 'error' });
    }
    updateHud();
    renderGrid();
    say(state.items.length
      ? `Welcome back, trainer! You have ${state.items.length} items in your ITEMDEX.`
      : 'Welcome, trainer! Snap a photo of any item to start your ITEMDEX.');
  }
  boot();
})();
