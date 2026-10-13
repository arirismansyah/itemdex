// Card rendering + formatting helpers shared by the scan and collection views.
const Card = (() => {
  const TYPE_META = {
    ELECTRONIC: { icon: '⚡', label: 'ELECTRIC' },
    FASHION: { icon: '✿', label: 'FASHION' },
    BOOK: { icon: '✎', label: 'BOOK' },
    TOY: { icon: '♣', label: 'TOY' },
    HOME: { icon: '⌂', label: 'HOME' },
    KITCHEN: { icon: '♨', label: 'KITCHEN' },
    SPORT: { icon: '✊', label: 'SPORT' },
    TOOL: { icon: '⚒', label: 'TOOL' },
    COLLECTIBLE: { icon: '♛', label: 'COLLECT' },
    BEAUTY: { icon: '❀', label: 'BEAUTY' },
    VEHICLE: { icon: '➤', label: 'VEHICLE' },
    MUSIC: { icon: '♫', label: 'MUSIC' },
    OFFICE: { icon: '✉', label: 'OFFICE' },
    OTHER: { icon: '✦', label: 'NORMAL' },
  };
  const RARITY_STARS = { COMMON: 1, UNCOMMON: 2, RARE: 3, EPIC: 4, LEGENDARY: 5 };

  let currency = 'IDR';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function money(n, { compact = true } = {}) {
    if (!n) return '-';
    const locale = currency === 'IDR' ? 'id-ID' : 'en-US';
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      notation: compact ? 'compact' : 'standard',
      maximumFractionDigits: compact ? 1 : 0,
    }).format(n);
  }

  const date = (iso) => new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  }).toUpperCase();

  function ago(iso) {
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return date(iso);
  }

  function dims(d) {
    if (!d || !(d.length_cm || d.width_cm || d.height_cm)) return '?';
    const f = (n) => (n >= 100 ? Math.round(n) : +n.toFixed(1));
    return `${f(d.length_cm)}×${f(d.width_cm)}×${f(d.height_cm)}cm`;
  }

  function weight(g) {
    if (!g) return '?';
    return g >= 1000 ? `${+(g / 1000).toFixed(1)}kg` : `${g}g`;
  }

  function placeLabel(loc) {
    if (!loc) return '';
    return loc.place || loc.address || (loc.lat != null ? `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}` : '');
  }

  const mapUrl = (loc) =>
    `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=18/${loc.lat}/${loc.lng}`;

  const pad = (n) => (n ? String(n).padStart(3, '0') : '???');

  // item: saved item, or a scan preview ({ ...card, image: dataUrl }).
  function render(item, { mini = false, preview = false } = {}) {
    const t = TYPE_META[item.type] || TYPE_META.OTHER;
    const stars = RARITY_STARS[item.rarity] || 1;
    const img = item.imageUrl || (item.image ? `/media/${encodeURIComponent(item.image)}` : '');
    const holo = stars >= 3 ? ' holo' : '';
    const sub = [item.brand, item.subcategory].filter(Boolean).join(' · ');
    const place = placeLabel(item.location) || (preview ? item.location_guess : '');
    const cost = (n) => `<span class="energy">${t.icon}</span>`.repeat(n);

    const moves = item.abilities.map((a, i) => `
      <div class="move">
        <div class="move-cost">${cost(i + 1)}</div>
        <div class="move-body">
          <b>${esc(a.name)}</b>
          ${mini ? '' : `<p>${esc(a.text)}</p>`}
        </div>
        <div class="move-dmg">${esc(a.power)}</div>
      </div>`).join('');

    return `
      <article class="card type-${esc(item.type)} rarity-${esc(item.rarity)}${holo}${mini ? ' mini' : ''}"
               data-id="${esc(item.id || '')}">
        <div class="card-frame">
          <div class="card-top">
            <span class="card-sub">${esc(sub || 'BASIC ITEM')}</span>
          </div>
          <div class="card-title">
            <h3>${esc(item.name)}</h3>
            <span class="card-hp"><small>HP</small>${esc(item.condition.score)}</span>
            <span class="type-orb" title="${esc(t.label)}">${t.icon}</span>
          </div>
          <div class="card-art">
            ${img ? `<img src="${esc(img)}" alt="" draggable="false" />` : '<div class="no-art">?</div>'}
            <span class="art-badge">${esc(item.size_class)}</span>
          </div>
          <div class="card-strip">
            NO.${pad(item.number)} · ${esc(dims(item.dimensions))} · ${esc(weight(item.weight_g))}
            · ${item.created_at ? date(item.created_at) : 'NEW!'}
          </div>
          <div class="card-moves">${moves}</div>
          <div class="card-stats">
            <div><span>VALUE</span><b>${esc(money(item.value.typical))}</b></div>
            <div><span>COND.</span><b>${esc(item.condition.label)}</b></div>
            <div><span>LAST SEEN</span><b class="trunc">${esc(place || '???')}</b></div>
          </div>
          ${mini ? '' : `<p class="card-flavor">${esc(item.description)}</p>`}
          <div class="card-foot">
            <span>ITEMDEX · ${esc(t.label)}</span>
            <span class="stars">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</span>
            <span>${esc(item.rarity)}</span>
          </div>
        </div>
        <div class="card-shine" aria-hidden="true"></div>
      </article>`;
  }

  function cardBack() {
    return `
      <article class="card card-back">
        <div class="back-ring"><div class="back-mark"></div></div>
        <p>ITEMDEX</p>
      </article>`;
  }

  // 3D tilt + holo glare that follows the mouse.
  function attachTilt(el) {
    const card = el.querySelector('.card') || el;
    const move = (e) => {
      if (card.classList.contains('no-tilt')) return;
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      card.style.setProperty('--mx', `${x * 100}%`);
      card.style.setProperty('--my', `${y * 100}%`);
      card.style.transform = `rotateY(${(x - 0.5) * 16}deg) rotateX(${(0.5 - y) * 16}deg)`;
    };
    const leave = () => { card.style.transform = ''; };
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerleave', leave);
  }

  return {
    TYPE_META, RARITY_STARS, render, cardBack, attachTilt,
    esc, money, date, ago, dims, weight, placeLabel, mapUrl, pad,
    setCurrency: (c) => { currency = c || 'IDR'; },
  };
})();
