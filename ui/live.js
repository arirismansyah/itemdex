// Live viewfinder: camera + Gemma object detection + auto-snap.
//
// - Motion: every 120ms the frame is shrunk to 32x24 grayscale and diffed with
//   the previous one; low diff = camera/item is steady.
// - Detect: one frame at a time goes to /api/detect (~0.6s on Gemma).
// - Lock: same item twice in a row + steady for LOCK_MS => auto-snap.
// - After a snap the trigger is disarmed until the scene changes.
const LiveCam = (() => {
  const DETECT_SIDE = 512;
  const DETECT_GAP_MS = 250;
  const MOTION_STEADY = 6; // mean abs diff (0-255) on the 32x24 thumbnail
  const LOCK_MS = 1200;
  const STALE_MS = 2500;

  let video;
  let canvas;
  let ctx;
  let stream = null;
  let handlers = {};
  let mode = 'auto';
  let paused = false;
  let armed = true;
  let inFlight = false;
  let nextDetectAt = 0;
  let failures = 0;
  let motionTimer = null;
  let raf = null;

  const thumb = document.createElement('canvas');
  thumb.width = 32;
  thumb.height = 24;
  const thumbCtx = thumb.getContext('2d', { willReadFrequently: true });
  let prevGray = null;
  let motion = 0;
  let steadySince = 0;

  let det = null; // { has_item, name, box:[ymin,xmin,ymax,xmax] 0-1000, at }
  let streak = 0;
  let lockedAt = 0; // when the same item was seen twice in a row
  let snapped = null; // detection at the time of the last auto-snap
  let drawBox = null; // smoothed box in element pixels
  let lastStatus = '';

  // ------------------------------------------------------------ helpers
  const iou = (a, b) => {
    if (!a || !b) return 0;
    const y1 = Math.max(a[0], b[0]);
    const x1 = Math.max(a[1], b[1]);
    const y2 = Math.min(a[2], b[2]);
    const x2 = Math.min(a[3], b[3]);
    const inter = Math.max(0, y2 - y1) * Math.max(0, x2 - x1);
    const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
    return inter / (area(a) + area(b) - inter || 1);
  };
  const sameItem = (a, b) => !!(a?.has_item && b?.has_item
    && (iou(a.box, b.box) > 0.45 || a.name.toLowerCase() === b.name.toLowerCase()));

  // Where the video frame is drawn inside the element (object-fit: contain).
  function videoRect() {
    const W = video.clientWidth;
    const H = video.clientHeight;
    const vw = video.videoWidth || 4;
    const vh = video.videoHeight || 3;
    const scale = Math.min(W / vw, H / vh);
    const w = vw * scale;
    const h = vh * scale;
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  function frameJpeg(maxSide, quality, crop) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const src = crop || { x: 0, y: 0, w: vw, h: vh };
    const scale = Math.min(1, maxSide / Math.max(src.w, src.h));
    const c = document.createElement('canvas');
    c.width = Math.round(src.w * scale);
    c.height = Math.round(src.h * scale);
    c.getContext('2d').drawImage(video, src.x, src.y, src.w, src.h, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }

  // ------------------------------------------------------------ motion
  function sampleMotion() {
    if (!video.videoWidth) return;
    thumbCtx.drawImage(video, 0, 0, 32, 24);
    const px = thumbCtx.getImageData(0, 0, 32, 24).data;
    const gray = new Uint8Array(32 * 24);
    let diff = 0;
    for (let i = 0; i < gray.length; i++) {
      gray[i] = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8;
      if (prevGray) diff += Math.abs(gray[i] - prevGray[i]);
    }
    motion = prevGray ? diff / gray.length : 0;
    prevGray = gray;
    const now = performance.now();
    if (motion > MOTION_STEADY) steadySince = now;
  }

  // ------------------------------------------------------------ detect
  async function detect() {
    if (inFlight || paused || !stream || !video.videoWidth) return;
    if (performance.now() < nextDetectAt) return;
    inFlight = true;
    try {
      const res = await fetch('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...Auth.headers() },
        body: JSON.stringify({ image: frameJpeg(DETECT_SIDE, 0.7) }),
      });
      if (!res.ok) throw new Error(`detect ${res.status}`);
      const d = await res.json();
      d.at = performance.now();
      streak = sameItem(d, det) ? streak + 1 : d.has_item ? 1 : 0;
      if (streak === 2) lockedAt = d.at;
      det = d;
      if (!armed && (!d.has_item || !sameItem(d, snapped))) armed = true;
      failures = 0;
      nextDetectAt = performance.now() + DETECT_GAP_MS;
    } catch {
      failures++;
      nextDetectAt = performance.now() + Math.min(8000, 1000 * failures);
    } finally {
      inFlight = false;
    }
  }

  // ------------------------------------------------------------ status + draw
  function computeStatus(now) {
    if (!stream) return { phase: 'off' };
    if (paused) return { phase: 'paused' };
    if (failures >= 3) return { phase: 'error' };
    const fresh = det && now - det.at < STALE_MS;
    if (!fresh || !det.has_item) return { phase: 'searching' };
    if (mode === 'manual') return { phase: 'detected', name: det.name };
    if (!armed) return { phase: 'done', name: det.name };
    if (streak < 2) return { phase: 'detected', name: det.name, progress: 0 };
    if (motion > MOTION_STEADY) return { phase: 'hold', name: det.name, progress: 0 };
    return { phase: 'locking', name: det.name, progress: Math.min(1, (now - Math.max(steadySince, lockedAt)) / LOCK_MS) };
  }

  function draw(status) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const show = det?.has_item && ['detected', 'hold', 'locking', 'done'].includes(status.phase);
    if (!show) {
      drawBox = null;
      return;
    }
    const r = videoRect();
    const [y1, x1, y2, x2] = det.box;
    const target = {
      x: r.x + (x1 / 1000) * r.w,
      y: r.y + (y1 / 1000) * r.h,
      w: ((x2 - x1) / 1000) * r.w,
      h: ((y2 - y1) / 1000) * r.h,
    };
    drawBox = drawBox
      ? Object.fromEntries(Object.entries(drawBox).map(([k, v]) => [k, v + (target[k] - v) * 0.25]))
      : target;
    const b = drawBox;
    const color = status.phase === 'locking' ? (status.progress >= 1 ? '#3ddc84' : '#ffcc00')
      : status.phase === 'done' ? '#3ddc84' : '#5ef1ff';

    // chunky pixel corner brackets
    const len = Math.max(14, Math.min(b.w, b.h) * 0.22);
    const t = 5;
    ctx.fillStyle = '#05030c';
    ctx.globalAlpha = 0.6;
    corners(b.x + 2, b.y + 2, b.w, b.h, len, t);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    corners(b.x, b.y, b.w, b.h, len, t);

    // label tag
    const label = status.name.toUpperCase();
    ctx.font = '10px "Press Start 2P", monospace';
    const tw = ctx.measureText(label).width + 16;
    const ty = b.y - 26 < 0 ? b.y + b.h + 4 : b.y - 26;
    ctx.fillStyle = color;
    ctx.fillRect(b.x, ty, tw, 22);
    ctx.fillStyle = '#05030c';
    ctx.fillText(label, b.x + 8, ty + 15);

    // lock progress bar under the label
    if (status.phase === 'locking') {
      ctx.fillStyle = '#05030c';
      ctx.fillRect(b.x, ty + 22, tw, 6);
      ctx.fillStyle = color;
      ctx.fillRect(b.x, ty + 22, tw * status.progress, 6);
    }
  }

  function corners(x, y, w, h, len, t) {
    ctx.fillRect(x, y, len, t); ctx.fillRect(x, y, t, len);
    ctx.fillRect(x + w - len, y, len, t); ctx.fillRect(x + w - t, y, t, len);
    ctx.fillRect(x, y + h - t, len, t); ctx.fillRect(x, y + h - len, t, len);
    ctx.fillRect(x + w - len, y + h - t, len, t); ctx.fillRect(x + w - t, y + h - len, t, len);
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    const now = performance.now();
    detect();
    const status = computeStatus(now);
    draw(status);
    const key = `${status.phase}|${status.name || ''}|${Math.round((status.progress || 0) * 10)}`;
    if (key !== lastStatus) {
      lastStatus = key;
      handlers.onStatus?.(status);
    }
    if (status.phase === 'locking' && status.progress >= 1) {
      armed = false;
      snapped = det;
      handlers.onAutoSnap?.(snap());
    }
  }

  // ------------------------------------------------------------ public
  // Returns { frames: [crop?, full], name } for the current frame.
  function snap() {
    const full = frameJpeg(1024, 0.85);
    const fresh = det?.has_item && performance.now() - det.at < STALE_MS;
    if (!fresh) return { frames: [full], name: '' };
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const [y1, x1, y2, x2] = det.box;
    const pad = 0.15;
    const bw = ((x2 - x1) / 1000) * vw;
    const bh = ((y2 - y1) / 1000) * vh;
    const x = Math.max(0, (x1 / 1000) * vw - bw * pad);
    const y = Math.max(0, (y1 / 1000) * vh - bh * pad);
    const w = Math.min(vw - x, bw * (1 + 2 * pad));
    const h = Math.min(vh - y, bh * (1 + 2 * pad));
    if (w < 64 || h < 64) return { frames: [full], name: det.name };
    return { frames: [frameJpeg(1024, 0.88, { x, y, w, h }), full], name: det.name };
  }

  async function start(videoEl, canvasEl, opts = {}) {
    video = videoEl;
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    handlers = opts;
    if (stream) return true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
    } catch {
      stream = null;
      handlers.onStatus?.({ phase: 'off' });
      return false;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    det = null;
    streak = 0;
    armed = true;
    prevGray = null;
    steadySince = performance.now();
    motionTimer = setInterval(sampleMotion, 120);
    cancelAnimationFrame(raf);
    tick();
    return true;
  }

  function stop() {
    clearInterval(motionTimer);
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) video.srcObject = null;
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    lastStatus = '';
    handlers.onStatus?.({ phase: 'off' });
  }

  return {
    start,
    stop,
    snap,
    get active() { return !!stream; },
    get mode() { return mode; },
    setMode(m) { mode = m; armed = true; },
    // Pause detection while a card is being scanned or reviewed.
    setPaused(p) {
      paused = p;
      if (!p) { det = null; streak = 0; }
    },
  };
})();
