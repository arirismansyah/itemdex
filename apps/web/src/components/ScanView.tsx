// SCAN tab: live viewfinder (auto/manual snap) or uploads -> Gemma -> card preview -> save.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanResult, Source } from '@itemdex/shared';
import { scan as scanApi, useCreateItem } from '../lib/api';
import { say } from '../lib/dialog';
import { pad } from '../lib/format';
import { LiveCam, type LiveStatus, type Shot, type SnapMode } from '../lib/livecam';
import * as Media from '../lib/media';
import { Sound } from '../lib/sound';
import { CardBack, TradingCard } from './TradingCard';

const MAX_FRAMES = 6;
const SCAN_LINES = [
  'BOOTING GEMMA...', 'SCANNING PIXELS...', 'IDENTIFYING ITEM...', 'MEASURING SIZE...',
  'CHECKING MARKET PRICES...', 'ROLLING RARITY...', 'PRINTING CARD...',
];

type Geo = { lat: number; lng: number; accuracy_m: number | null; source: 'exif' | 'device' };

function readMode(): SnapMode {
  try { return localStorage.getItem('itemdex.mode') === 'manual' ? 'manual' : 'auto'; } catch { return 'auto'; }
}

function statusText(s: LiveStatus, mode: SnapMode, scanning: boolean): string {
  const name = s.name || '';
  const p = Math.round((s.progress || 0) * 8);
  switch (s.phase) {
    case 'paused': return scanning ? 'GEMMA IS ANALYZING...' : 'REVIEW YOUR CARD';
    case 'error': return 'GEMMA NOT RESPONDING... RETRYING';
    case 'searching': return 'SEARCHING FOR ITEM...';
    case 'detected': return mode === 'manual' ? `DETECTED: ${name} · PRESS SNAP` : `DETECTED: ${name} · HOLD IT THERE`;
    case 'hold': return `${name} · HOLD STILL!`;
    case 'locking': return `LOCKING ${name} ${'▮'.repeat(p)}${'▯'.repeat(8 - p)}`;
    case 'done': return `GOT ${name}! SHOW A NEW ITEM`;
    default: return 'CAMERA OFF';
  }
}

function Scanner({ cover }: { cover: string }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const t0 = performance.now();
    const id = window.setInterval(() => setT((performance.now() - t0) / 1000), 100);
    return () => clearInterval(id);
  }, []);
  const line = Math.min(SCAN_LINES.length - 1, Math.floor(t / 1.6));
  useEffect(() => { if (line) Sound.play('tick'); }, [line]);
  return (
    <div className="scanner">
      <div className="scanner-screen">
        <img src={cover} alt="" />
        <div className="scanner-grid" />
        <div className="scanner-beam" />
      </div>
      <p className="scanner-text">{SCAN_LINES[line]}</p>
      <div className="scanner-bar"><i /></div>
      <small>{t.toFixed(1)}s</small>
    </div>
  );
}

export function ScanView({ active, keysEnabled }: { active: boolean; keysEnabled: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef<LiveCam | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);

  const [mode, setModeState] = useState<SnapMode>(readMode);
  const [status, setStatus] = useState<LiveStatus>({ phase: 'off' });
  const [camOk, setCamOk] = useState(true);
  const [frames, setFrames] = useState<string[]>([]);
  const [source, setSource] = useState<Source>('camera');
  const [geo, setGeo] = useState<Geo | null>(null);
  const [preview, setPreview] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [caught, setCaught] = useState(false);
  const [hint, setHint] = useState('');
  const [place, setPlace] = useState('');
  const [flash, setFlash] = useState(0);
  const [hover, setHover] = useState(false);
  const create = useCreateItem();

  // Latest values for callbacks fired by LiveCam.
  const live = useRef({ frames, source, scanning, geo, hint });
  live.current = { frames, source, scanning, geo, hint };

  const usingCamera = source === 'camera';
  const camActive = status.phase !== 'off';

  // ------------------------------------------------------------- scan
  const runScan = useCallback(async (imgs: string[], src: Source) => {
    if (!imgs.length || live.current.scanning) return;
    setScanning(true);
    setPreview(null);
    camRef.current?.setPaused(true);
    Sound.play('select');

    // Ask for device location in parallel when the photo had no GPS.
    if (!live.current.geo) {
      Media.deviceLocation().then((dev) => {
        if (dev && !live.current.geo && live.current.frames === imgs) setGeo({ ...dev, source: 'device' });
      });
    }
    try {
      const res = await scanApi({ images: imgs, hint: live.current.hint, source: src });
      setPreview(res);
      setPlace((p) => p || res.card.location_guess);
      const name = res.card.name.toUpperCase();
      if (res.card.is_item) say(`A wild ${name} appeared! (${(res.elapsed_ms / 1000).toFixed(1)}s)`, { sound: 'appear' });
      else say(`Hmm... Gemma isn't sure this is an item. Best guess: ${name}.`, { sound: 'error' });
      if (window.matchMedia('(max-width: 900px)').matches) {
        requestAnimationFrame(() => stageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    } catch (err) {
      camRef.current?.setPaused(false);
      say(`Scan failed: ${(err as Error).message}`, { sound: 'error', hold: 6000 });
    } finally {
      setScanning(false);
    }
  }, []);

  // ------------------------------------------------------------- camera
  const startCamera = useCallback(async () => {
    const cam = camRef.current;
    if (!cam || cam.active) return;
    const ok = await cam.start();
    setCamOk(ok);
    if (!ok) {
      say('Camera not available. Allow camera access (browser/system settings), or upload a photo.', { sound: 'error', hold: 6000 });
    }
  }, []);

  useEffect(() => {
    const cam = new LiveCam(videoRef.current!, overlayRef.current!);
    cam.mode = readMode();
    cam.onStatus = setStatus;
    cam.onAutoSnap = (shot: Shot) => {
      setFlash((f) => f + 1);
      Sound.play('select');
      setFrames(shot.frames);
      live.current.frames = shot.frames;
      setSource('camera');
      void runScan(shot.frames, 'camera');
    };
    camRef.current = cam;
    return () => cam.destroy();
  }, [runScan]);

  // Camera runs only while the SCAN tab is visible and we're not showing uploads.
  useEffect(() => {
    if (active && usingCamera) void startCamera();
    else camRef.current?.stop();
  }, [active, usingCamera, startCamera]);

  const setMode = (m: SnapMode) => {
    setModeState(m);
    camRef.current?.setMode(m);
    Sound.play('click');
    try { localStorage.setItem('itemdex.mode', m); } catch { /* ignore */ }
  };

  const snapNow = useCallback(() => {
    const cam = camRef.current;
    if (!cam?.active || live.current.scanning) return;
    const shot = cam.snap();
    setFlash((f) => f + 1);
    Sound.play('select');
    setPreview(null);
    const prev = live.current.source === 'camera' ? live.current.frames : [];
    setSource('camera');
    if (cam.mode === 'auto') {
      // Forced snap in auto mode: same as an auto-lock.
      setFrames(shot.frames);
      live.current.frames = shot.frames;
      void runScan(shot.frames, 'camera');
      return;
    }
    if (prev.length >= MAX_FRAMES) {
      say(`Max ${MAX_FRAMES} shots per item.`, { sound: 'error' });
      return;
    }
    // First manual shot keeps the full frame too, for background/location context.
    const next = [...prev, shot.frames[0]];
    if (!prev.length && shot.frames[1]) next.push(shot.frames[1]);
    setFrames(next.slice(0, MAX_FRAMES));
    say(`Shot ${next.length} saved. Snap more angles or press SCAN.`, { hold: 2000 });
  }, [runScan]);

  useEffect(() => {
    if (!active || !keysEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      if ((e.target as HTMLElement).closest('input, textarea, select, button, [role=button]')) return;
      e.preventDefault();
      snapNow();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, keysEnabled, snapNow]);

  // ------------------------------------------------------------- uploads
  const addFiles = async (fileList: FileList | File[]) => {
    const list = [...fileList];
    if (!list.length) return;
    const video = list.find((f) => f.type.startsWith('video/'));
    try {
      let next: string[];
      let nextGeo = live.current.geo;
      if (video) {
        say('Extracting frames from video...', { hold: 1500 });
        next = await Media.videoFileToFrames(video, 4);
        setSource('video');
      } else {
        const images = list.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(f.name));
        next = live.current.source === 'photo' ? [...live.current.frames] : [];
        if (live.current.source !== 'photo') nextGeo = null;
        for (const f of images.slice(0, MAX_FRAMES - next.length)) {
          next.push(await Media.imageFileToDataUrl(f));
          if (!nextGeo) {
            const gps = await Media.readExifGps(f);
            if (gps) nextGeo = { ...gps, accuracy_m: null, source: 'exif' };
          }
        }
        setSource('photo');
      }
      setGeo(nextGeo);
      setFrames(next);
      setPreview(null);
      Sound.play('select');
    } catch (err) {
      say((err as Error).message, { sound: 'error' });
    }
  };

  const reset = useCallback(() => {
    setFrames([]);
    setPreview(null);
    setGeo(null);
    setHint('');
    setPlace('');
    setCaught(false);
    setSource('camera');
    camRef.current?.setPaused(false);
  }, []);

  const backToCamera = () => {
    Sound.play('click');
    reset();
  };

  // ------------------------------------------------------------- save
  const save = async () => {
    if (!preview) return;
    const { card, best_frame: bf } = preview;
    const image = frames[bf] || frames[0];
    try {
      const thumb = await Media.makeThumb(image).catch(() => image);
      const { item } = await create.mutateAsync({
        card,
        image,
        thumb,
        source,
        location: { place: place.trim() || card.location_guess, ...(geo || {}) },
      });
      setCaught(true);
      say(`Gotcha! ${item.name.toUpperCase()} was registered as NO.${pad(item.number)}!`, { sound: 'get' });
      setTimeout(reset, 1400);
    } catch (err) {
      say(`Save failed: ${(err as Error).message}`, { sound: 'error' });
    }
  };

  const discard = () => {
    Sound.play('remove');
    reset();
    say('The item fled back into the wild.');
  };

  // ------------------------------------------------------------- render
  const vfStatus = !usingCamera
    ? { cls: 'phase-upload', text: `UPLOADED ${frames.length} IMAGE(S) · PRESS SCAN` }
    : { cls: `phase-${status.phase}`, text: statusText(status, mode, scanning) };

  return (
    <section className={`view view-scan${active ? ' active' : ''}`} aria-hidden={!active}>
      <div className="panel scan-input">
        <div className="panel-head">
          <h2 className="panel-title">1. VIEWFINDER</h2>
          <div className="mode-toggle" role="group" aria-label="Snap mode">
            <button className={`mode${mode === 'auto' ? ' active' : ''}`} onClick={() => setMode('auto')} title="Snap automatically when an item is locked">AUTO SNAP</button>
            <button className={`mode${mode === 'manual' ? ' active' : ''}`} onClick={() => setMode('manual')} title="Take shots yourself (multiple angles)">MANUAL</button>
          </div>
        </div>

        <div
          className={`viewfinder${hover ? ' hover' : ''}`}
          onDragEnter={(e) => { e.preventDefault(); setHover(true); }}
          onDragOver={(e) => { e.preventDefault(); setHover(true); }}
          onDragLeave={() => setHover(false)}
          onDrop={(e) => { e.preventDefault(); setHover(false); void addFiles(e.dataTransfer.files); }}
        >
          <video ref={videoRef} autoPlay playsInline muted hidden={!usingCamera || !camOk} />
          {!usingCamera && frames[0] && <img className="still" src={frames[0]} alt="" />}
          <canvas ref={overlayRef} className="overlay" />
          <div className="vf-frame" aria-hidden="true" />
          {flash > 0 && <div className="vf-flash" key={flash} />}
          <div className={`vf-status ${vfStatus.cls}`}><i /><span>{vfStatus.text}</span></div>
          {usingCamera && !camOk && (
            <div className="dropzone-idle">
              <div className="pixel-arrow" aria-hidden="true">▼</div>
              <p>NO CAMERA ACCESS</p>
              <small>drop a photo / video here, or use upload below</small>
            </div>
          )}
          {usingCamera && camOk && camActive && (
            <button className="icon-btn vf-flip" onClick={() => camRef.current?.flip()} title="Switch camera" aria-label="Switch camera">⟲</button>
          )}
        </div>

        <div className="control-row">
          <button className="btn btn-accent snap-btn" onClick={snapNow} disabled={!camActive || scanning || !usingCamera} title="Space">● SNAP</button>
          <div className="frames">
            {frames.map((f, i) => (
              <div className="frame" key={`${i}-${f.length}`}>
                <img src={f} alt={`shot ${i + 1}`} />
                <button className="frame-x" title="Remove" aria-label={`Remove shot ${i + 1}`} onClick={() => { Sound.play('click'); setFrames(frames.filter((_, k) => k !== i)); }}>✕</button>
              </div>
            ))}
            {geo && (
              <div className="geo-chip" title={`Accuracy ${geo.accuracy_m ? `±${Math.round(geo.accuracy_m)}m` : 'unknown'}`}>
                ⌖ {geo.lat.toFixed(4)}, {geo.lng.toFixed(4)}
                <em>{geo.source === 'exif' ? 'PHOTO' : 'GPS'}</em>
                <button className="geo-x" title="Don't save coordinates" aria-label="Remove coordinates" onClick={() => { Sound.play('click'); setGeo(null); }}>✕</button>
              </div>
            )}
          </div>
          <div className="upload-group">
            <button className="btn btn-small" onClick={() => { Sound.play('click'); photoInput.current?.click(); }}>⇪ PHOTO</button>
            <button className="btn btn-small" onClick={() => { Sound.play('click'); videoInput.current?.click(); }}>⇪ VIDEO</button>
            {!usingCamera && <button className="btn btn-small" onClick={backToCamera}>◉ CAMERA</button>}
          </div>
        </div>
        <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={(e) => { void addFiles(e.target.files || []); e.target.value = ''; }} />
        <input ref={videoInput} type="file" accept="video/*" hidden onChange={(e) => { void addFiles(e.target.files || []); e.target.value = ''; }} />

        <div className="field-row">
          <label className="field">
            <span>NOTE FOR GEMMA <em>(optional)</em></span>
            <input value={hint} onChange={(e) => setHint(e.target.value)} maxLength={300} placeholder="e.g. bought 2022, minor scratch" />
          </label>
          <label className="field">
            <span>WHERE IS IT NOW? <em>(Gemma will guess)</em></span>
            <input value={place} onChange={(e) => setPlace(e.target.value)} maxLength={80} placeholder="e.g. lemari kamar, rak 2" />
          </label>
          <button className="btn btn-primary scan-btn" disabled={!frames.length || scanning} onClick={() => runScan(frames, source)}>▶ SCAN</button>
        </div>
      </div>

      <div className="panel scan-output" ref={stageRef}>
        <h2 className="panel-title">2. CARD</h2>
        <div className="card-stage">
          {scanning ? (
            <Scanner cover={frames[0]} />
          ) : preview ? (
            <div className="reveal" key={preview.elapsed_ms}>
              <TradingCard
                item={preview.card}
                image={frames[preview.best_frame] || frames[0] || null}
                place={place.trim() || preview.card.location_guess}
                className={caught ? 'caught' : ''}
              />
            </div>
          ) : (
            <div className="stage-idle"><CardBack /><p className="blink">INSERT ITEM TO BEGIN</p></div>
          )}
        </div>
        {preview && !scanning && (
          <div className="result-actions">
            <button className="btn btn-primary" onClick={save} disabled={create.isPending || caught}>★ SAVE TO DEX</button>
            <button className="btn" onClick={() => runScan(frames, source)}>↻ RESCAN</button>
            <button className="btn btn-danger" onClick={discard}>✕ DISCARD</button>
          </div>
        )}
      </div>
    </section>
  );
}
