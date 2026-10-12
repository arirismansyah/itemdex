// Live viewfinder: camera + AI object detection + auto-snap.
//
// - Motion: every 120ms the frame is shrunk to 32x24 grayscale and diffed with
//   the previous one; low diff = camera/item is steady.
// - Detect: one frame at a time goes to /api/v1/detect (~0.6s on a fast model).
// - Lock: same item twice in a row + steady for LOCK_MS => auto-snap.
// - After a snap the trigger is disarmed until the scene changes.
// - Everything stops while the page is hidden (saves battery on phones).
// Drawing happens on a canvas outside React; React only gets status changes.

import type { DetectResult } from '@itemdex/shared';
import { detect as detectApi } from './api';

const DETECT_SIDE = 512;
const DETECT_GAP_MS = 250;
const MOTION_STEADY = 6; // mean abs diff (0-255) on the 32x24 thumbnail
const LOCK_MS = 1200;
const STALE_MS = 2500;

export type SnapMode = 'auto' | 'manual';
export type Phase = 'off' | 'paused' | 'error' | 'searching' | 'detected' | 'hold' | 'locking' | 'done';
export interface LiveStatus { phase: Phase; name?: string; progress?: number }
export interface Shot { frames: string[]; name: string }

type Detection = DetectResult & { at: number };
type Box = { x: number; y: number; w: number; h: number };

function iou(a: number[] | null, b: number[] | null) {
  if (!a || !b) return 0;
  const y1 = Math.max(a[0], b[0]);
  const x1 = Math.max(a[1], b[1]);
  const y2 = Math.min(a[2], b[2]);
  const x2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, y2 - y1) * Math.max(0, x2 - x1);
  const area = (r: number[]) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / (area(a) + area(b) - inter || 1);
}
const sameItem = (a: Detection | null, b: Detection | null) => !!(a?.has_item && b?.has_item
  && (iou(a.box, b.box) > 0.45 || a.name.toLowerCase() === b.name.toLowerCase()));

export class LiveCam {
  mode: SnapMode = 'auto';
  onStatus: (s: LiveStatus) => void = () => {};
  onAutoSnap: (s: Shot) => void = () => {};

  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private stream: MediaStream | null = null;
  private facing: 'environment' | 'user' = 'environment';
  private paused = false;
  private armed = true;
  private inFlight: AbortController | null = null;
  private nextDetectAt = 0;
  private failures = 0;
  private motionTimer = 0;
  private raf = 0;

  private thumbCtx: CanvasRenderingContext2D;
  private prevGray: Uint8Array | null = null;
  private motion = 0;
  private steadySince = 0;

  private det: Detection | null = null;
  private streak = 0;
  private lockedAt = 0;
  private snapped: Detection | null = null;
  private drawBox: Box | null = null;
  private lastStatus = '';

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    const thumb = document.createElement('canvas');
    thumb.width = 32;
    thumb.height = 24;
    this.thumbCtx = thumb.getContext('2d', { willReadFrequently: true })!;
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  get active() { return !!this.stream; }

  async start(): Promise<boolean> {
    if (this.stream) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.emit({ phase: 'off' });
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: this.facing }, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
    } catch {
      this.stream = null;
      this.emit({ phase: 'off' });
      return false;
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.det = null;
    this.streak = 0;
    this.armed = true;
    this.prevGray = null;
    this.steadySince = performance.now();
    this.resume();
    return true;
  }

  stop() {
    this.halt();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.lastStatus = '';
    this.emit({ phase: 'off' });
  }

  async flip(): Promise<boolean> {
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    this.stop();
    return this.start();
  }

  destroy() {
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  setMode(m: SnapMode) { this.mode = m; this.armed = true; }

  // Pause detection while a card is being scanned or reviewed.
  setPaused(p: boolean) {
    this.paused = p;
    if (!p) { this.det = null; this.streak = 0; }
  }

  // Returns { frames: [crop?, full], name } for the current frame.
  snap(): Shot {
    const full = this.frameJpeg(1024, 0.85);
    const det = this.det;
    const fresh = det?.has_item && det.box && performance.now() - det.at < STALE_MS;
    if (!fresh || !det.box) return { frames: [full], name: '' };
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const [y1, x1, y2, x2] = det.box;
    const pad = 0.15;
    const bw = ((x2 - x1) / 1000) * vw;
    const bh = ((y2 - y1) / 1000) * vh;
    const x = Math.max(0, (x1 / 1000) * vw - bw * pad);
    const y = Math.max(0, (y1 / 1000) * vh - bh * pad);
    const w = Math.min(vw - x, bw * (1 + 2 * pad));
    const h = Math.min(vh - y, bh * (1 + 2 * pad));
    if (w < 64 || h < 64) return { frames: [full], name: det.name };
    return { frames: [this.frameJpeg(1024, 0.88, { x, y, w, h }), full], name: det.name };
  }

  // ------------------------------------------------------------ loop control
  private resume() {
    this.halt();
    this.motionTimer = window.setInterval(() => this.sampleMotion(), 120);
    this.tick();
  }

  private halt() {
    clearInterval(this.motionTimer);
    cancelAnimationFrame(this.raf);
    this.inFlight?.abort();
    this.inFlight = null;
  }

  private onVisibility = () => {
    if (!this.stream) return;
    if (document.hidden) this.halt();
    else this.resume();
  };

  private emit(s: LiveStatus) { this.onStatus(s); }

  // ------------------------------------------------------------ frames
  private frameJpeg(maxSide: number, quality: number, crop?: Box): string {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const src = crop || { x: 0, y: 0, w: vw, h: vh };
    const scale = Math.min(1, maxSide / Math.max(src.w, src.h));
    const c = document.createElement('canvas');
    c.width = Math.round(src.w * scale);
    c.height = Math.round(src.h * scale);
    c.getContext('2d')!.drawImage(this.video, src.x, src.y, src.w, src.h, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }

  // Where the video frame is drawn inside the element (object-fit: contain).
  private videoRect(): Box {
    const W = this.video.clientWidth;
    const H = this.video.clientHeight;
    const vw = this.video.videoWidth || 4;
    const vh = this.video.videoHeight || 3;
    const scale = Math.min(W / vw, H / vh);
    const w = vw * scale;
    const h = vh * scale;
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  private sampleMotion() {
    if (!this.video.videoWidth) return;
    this.thumbCtx.drawImage(this.video, 0, 0, 32, 24);
    const px = this.thumbCtx.getImageData(0, 0, 32, 24).data;
    const gray = new Uint8Array(32 * 24);
    let diff = 0;
    for (let i = 0; i < gray.length; i++) {
      gray[i] = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8;
      if (this.prevGray) diff += Math.abs(gray[i] - this.prevGray[i]);
    }
    this.motion = this.prevGray ? diff / gray.length : 0;
    this.prevGray = gray;
    if (this.motion > MOTION_STEADY) this.steadySince = performance.now();
  }

  private async detect() {
    if (this.inFlight || this.paused || !this.stream || !this.video.videoWidth) return;
    if (performance.now() < this.nextDetectAt) return;
    const ctrl = new AbortController();
    this.inFlight = ctrl;
    try {
      const d = { ...(await detectApi(this.frameJpeg(DETECT_SIDE, 0.7), ctrl.signal)), at: performance.now() };
      if (ctrl.signal.aborted || this.paused) return;
      this.streak = sameItem(d, this.det) ? this.streak + 1 : d.has_item ? 1 : 0;
      if (this.streak === 2) this.lockedAt = d.at;
      this.det = d;
      if (!this.armed && (!d.has_item || !sameItem(d, this.snapped))) this.armed = true;
      this.failures = 0;
      this.nextDetectAt = performance.now() + DETECT_GAP_MS;
    } catch {
      if (ctrl.signal.aborted) return;
      this.failures++;
      this.nextDetectAt = performance.now() + Math.min(8000, 1000 * this.failures);
    } finally {
      if (this.inFlight === ctrl) this.inFlight = null;
    }
  }

  // ------------------------------------------------------------ status + draw
  private computeStatus(now: number): LiveStatus {
    const det = this.det;
    if (!this.stream) return { phase: 'off' };
    if (this.paused) return { phase: 'paused' };
    if (this.failures >= 3) return { phase: 'error' };
    if (!det || now - det.at >= STALE_MS || !det.has_item) return { phase: 'searching' };
    if (this.mode === 'manual') return { phase: 'detected', name: det.name };
    if (!this.armed) return { phase: 'done', name: det.name };
    if (this.streak < 2) return { phase: 'detected', name: det.name, progress: 0 };
    if (this.motion > MOTION_STEADY) return { phase: 'hold', name: det.name, progress: 0 };
    return {
      phase: 'locking',
      name: det.name,
      progress: Math.min(1, (now - Math.max(this.steadySince, this.lockedAt)) / LOCK_MS),
    };
  }

  private draw(status: LiveStatus) {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const det = this.det;
    const show = det?.has_item && det.box && ['detected', 'hold', 'locking', 'done'].includes(status.phase);
    if (!show || !det.box) {
      this.drawBox = null;
      return;
    }
    const r = this.videoRect();
    const [y1, x1, y2, x2] = det.box;
    const target: Box = {
      x: r.x + (x1 / 1000) * r.w,
      y: r.y + (y1 / 1000) * r.h,
      w: ((x2 - x1) / 1000) * r.w,
      h: ((y2 - y1) / 1000) * r.h,
    };
    const prev = this.drawBox;
    const b: Box = prev
      ? { x: prev.x + (target.x - prev.x) * 0.25, y: prev.y + (target.y - prev.y) * 0.25, w: prev.w + (target.w - prev.w) * 0.25, h: prev.h + (target.h - prev.h) * 0.25 }
      : target;
    this.drawBox = b;
    const progress = status.progress ?? 0;
    const color = status.phase === 'locking' ? (progress >= 1 ? '#3ddc84' : '#ffcc00')
      : status.phase === 'done' ? '#3ddc84' : '#5ef1ff';

    // chunky pixel corner brackets
    const len = Math.max(14, Math.min(b.w, b.h) * 0.22);
    ctx.fillStyle = '#05030c';
    ctx.globalAlpha = 0.6;
    this.corners(b.x + 2, b.y + 2, b.w, b.h, len, 5);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    this.corners(b.x, b.y, b.w, b.h, len, 5);

    // label tag
    const label = (status.name || '').toUpperCase();
    ctx.font = '10px "Press Start 2P", monospace';
    const tw = Math.min(W - b.x, ctx.measureText(label).width + 16);
    const ty = b.y - 26 < 0 ? b.y + b.h + 4 : b.y - 26;
    ctx.fillStyle = color;
    ctx.fillRect(b.x, ty, tw, 22);
    ctx.fillStyle = '#05030c';
    ctx.fillText(label, b.x + 8, ty + 15, tw - 16);

    if (status.phase === 'locking') {
      ctx.fillStyle = '#05030c';
      ctx.fillRect(b.x, ty + 22, tw, 6);
      ctx.fillStyle = color;
      ctx.fillRect(b.x, ty + 22, tw * progress, 6);
    }
  }

  private corners(x: number, y: number, w: number, h: number, len: number, t: number) {
    const c = this.ctx;
    c.fillRect(x, y, len, t); c.fillRect(x, y, t, len);
    c.fillRect(x + w - len, y, len, t); c.fillRect(x + w - t, y, t, len);
    c.fillRect(x, y + h - t, len, t); c.fillRect(x, y + h - len, t, len);
    c.fillRect(x + w - len, y + h - t, len, t); c.fillRect(x + w - t, y + h - len, t, len);
  }

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    const now = performance.now();
    void this.detect();
    const status = this.computeStatus(now);
    this.draw(status);
    const key = `${status.phase}|${status.name || ''}|${Math.round((status.progress || 0) * 8)}`;
    if (key !== this.lastStatus) {
      this.lastStatus = key;
      this.emit(status);
    }
    if (status.phase === 'locking' && (status.progress ?? 0) >= 1) {
      this.armed = false;
      this.snapped = this.det;
      this.onAutoSnap(this.snap());
    }
  };
}
