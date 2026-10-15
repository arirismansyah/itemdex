// SCAN tab: live viewfinder (auto/manual snap) or uploads -> AI -> card preview -> save.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Card, InvoiceResult, PriceCheck, RoomResult, ScanResult, Source } from '@itemdex/shared';
import { priceCheck, scan as scanApi, scanPdf, scanRoom, useCreateItem, useMeta } from '../lib/api';
import { say } from '../lib/dialog';
import { money, pad } from '../lib/format';
import { LiveCam, type LiveStatus, type Shot, type SnapMode } from '../lib/livecam';
import * as Media from '../lib/media';
import { Sound } from '../lib/sound';
import { CardBack, TradingCard } from './TradingCard';

const MAX_FRAMES = 6;
const SCAN_LINES = [
  'BOOTING AI...', 'SCANNING PIXELS...', 'IDENTIFYING ITEM...', 'MEASURING SIZE...',
  'CHECKING MARKET PRICES...', 'ROLLING RARITY...', 'PRINTING CARD...',
];

// Room scan result with each item already cropped out of the photo.
interface RoomView {
  currency: string;
  items: { card: Card; crop: string; on: boolean; purchase?: { store: string; date: string | null; price: number } }[];
}

// Which picture is "the room": a camera snap holds the detector crop first and the full frame second,
// a video uses its middle frame, and an uploaded photo is used as is (the first one if there are several).
const roomImage = (imgs: string[], src: Source) =>
  src === 'camera' && imgs.length > 1 ? imgs[1] : src === 'video' ? imgs[Math.floor(imgs.length / 2)] : imgs[0];

const parseTags = (text: string) => text.split(',').map((t) => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean);

type Pricing = { phase: 'idle' | 'checking' } | { phase: 'done'; check: PriceCheck };

function pricingText(p: Pricing): string {
  if (p.phase === 'checking') return '⟳ CHECKING MARKET PRICES...';
  if (p.phase !== 'done') return '';
  const c = p.check;
  if (c.status === 'grounded') return `✓ PRICE FROM ${c.used} MATCHING LISTING${c.used === 1 ? '' : 'S'}`;
  if (c.status === 'no_match' || c.status === 'no_results') return 'AI ESTIMATE · NO MATCHING LISTINGS FOUND';
  if (c.status === 'error') return 'AI ESTIMATE · PRICE SEARCH FAILED';
  return '';
}

type Geo = { lat: number; lng: number; accuracy_m: number | null; source: 'exif' | 'device' };

function readMode(): SnapMode {
  try { return localStorage.getItem('itemdex.mode') === 'manual' ? 'manual' : 'auto'; } catch { return 'auto'; }
}

function statusText(s: LiveStatus, mode: SnapMode, scanning: boolean): string {
  const name = s.name || '';
  const p = Math.round((s.progress || 0) * 8);
  switch (s.phase) {
    case 'paused': return scanning ? 'AI IS ANALYZING...' : 'REVIEW YOUR CARD';
    case 'error': return 'AI NOT RESPONDING... RETRYING';
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
  const pdfInput = useRef<HTMLInputElement>(null);

  const [mode, setModeState] = useState<SnapMode>(readMode);
  const [status, setStatus] = useState<LiveStatus>({ phase: 'off' });
  const [camOk, setCamOk] = useState(true);
  const [frames, setFrames] = useState<string[]>([]);
  const [source, setSource] = useState<Source>('camera');
  const [geo, setGeo] = useState<Geo | null>(null);
  const [preview, setPreview] = useState<ScanResult | null>(null);
  const [pricing, setPricing] = useState<Pricing>({ phase: 'idle' });
  const previewRef = useRef<ScanResult | null>(null);
  const priceOn = !!useMeta().data?.features?.price_check;
  const [scanning, setScanning] = useState(false);
  const [caught, setCaught] = useState(false);
  const [hint, setHint] = useState('');
  const [place, setPlace] = useState('');
  const [category, setCategory] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [flash, setFlash] = useState(0);
  const [hover, setHover] = useState(false);
  const [roomMode, setRoomMode] = useState(false);
  const [room, setRoom] = useState<RoomView | null>(null);
  const create = useCreateItem();

  // Latest values for callbacks fired by LiveCam.
  // The user's own category / tags win over the AI's; their tags come first.
  const withUser = (c: Card): Card => ({
    ...c,
    subcategory: category.trim() || c.subcategory,
    tags: [...new Set([...parseTags(tagsText), ...c.tags])].slice(0, 6),
  });

  const live = useRef({ frames, source, scanning, geo, hint, roomMode, priceOn });
  live.current = { frames, source, scanning, geo, hint, roomMode, priceOn };

  // All preview changes go through here so async price checks can tell if they are stale.
  const showPreview = useCallback((p: ScanResult | null) => {
    previewRef.current = p;
    setPreview(p);
    if (!p) setPricing({ phase: 'idle' });
  }, []);

  // Runs after the card is shown: grounds the value in web listings (~4s).
  const checkMarket = useCallback(async (res: ScanResult) => {
    setPricing({ phase: 'checking' });
    try {
      const { value, price_check: check } = await priceCheck(res.card);
      if (previewRef.current !== res) return; // rescanned or discarded meanwhile
      if (check.status === 'grounded') {
        showPreview({ ...res, card: { ...res.card, value } });
        say(`Market check: ${check.used} matching listing(s). Typical ${money(value.typical, { currency: res.currency })}.`, { sound: 'select' });
      }
      setPricing({ phase: 'done', check });
    } catch (err) {
      if (previewRef.current !== res) return;
      setPricing({ phase: 'done', check: { status: 'error', query: '', listings: 0, used: 0, elapsed_ms: 0, error: (err as Error).message } });
    }
  }, [showPreview]);

  const usingCamera = source === 'camera';
  const camActive = status.phase !== 'off';

  // ------------------------------------------------------------- scan
  const runScan = useCallback(async (imgs: string[], src: Source) => {
    if (!imgs.length || live.current.scanning) return;
    setScanning(true);
    showPreview(null);
    setRoom(null);
    camRef.current?.setPaused(true);
    Sound.play('select');

    // Ask for device location in parallel when the photo had no GPS.
    if (!live.current.geo) {
      Media.deviceLocation().then((dev) => {
        if (dev && !live.current.geo && live.current.frames === imgs) setGeo({ ...dev, source: 'device' });
      });
    }
    try {
      if (live.current.roomMode) {
        const photo = roomImage(imgs, src);
        const res: RoomResult = await scanRoom(photo, live.current.hint);
        if (!res.items.length) throw new Error('No items found. Try a closer, brighter photo.');
        const crops = await Promise.all(res.items.map((it) => Media.cropBox(photo, it.box).catch(() => photo)));
        setRoom({ currency: res.currency, items: res.items.map((it, i) => ({ card: it.card, crop: crops[i], on: true })) });
        const extra = src === 'photo' && imgs.length > 1 ? ` Room mode reads one photo: used the first of ${imgs.length}.` : '';
        say(`Found ${res.items.length} items! (${(res.elapsed_ms / 1000).toFixed(1)}s)${extra}`, { sound: 'appear', hold: extra ? 5000 : 3500 });
        return;
      }
      const res = await scanApi({ images: imgs, hint: live.current.hint, source: src });
      showPreview(res);
      if (live.current.priceOn && res.card.is_item) void checkMarket(res);
      setPlace((p) => p || res.card.location_guess);
      const name = res.card.name.toUpperCase();
      if (res.card.is_item) say(`A wild ${name} appeared! (${(res.elapsed_ms / 1000).toFixed(1)}s)`, { sound: 'appear' });
      else say(`Hmm... the AI isn't sure this is an item. Best guess: ${name}.`, { sound: 'error' });
      if (window.matchMedia('(max-width: 900px)').matches) {
        requestAnimationFrame(() => stageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    } catch (err) {
      camRef.current?.setPaused(false);
      say(`Scan failed: ${(err as Error).message}`, { sound: 'error', hold: 6000 });
    } finally {
      setScanning(false);
    }
  }, [showPreview, checkMarket]);

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
    showPreview(null);
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
    const pdf = list.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const video = list.find((f) => f.type.startsWith('video/'));
    try {
      if (pdf) {
        say('Reading PDF invoice text...', { hold: 2000 });
        setScanning(true);
        camRef.current?.setPaused(true);
        showPreview(null);
        setRoom(null);
        const dataUrl = await Media.fileToDataUrl(pdf);
        const res = await scanPdf(dataUrl, live.current.hint);
        if (!res.items.length) {
          throw new Error('No items identified in invoice.');
        }
        setRoom({
          currency: res.currency,
          items: res.items.map((it) => ({
            card: it.card,
            crop: Media.makePlaceholderCardImage(it.card.name),
            on: true,
            purchase: { store: it.store, date: it.date, price: it.price },
          })),
        });
        setSource('photo');
        setScanning(false);
        Sound.play('fanfare');
        say(`Invoice read! Found ${res.items.length} item(s) from ${res.store || 'store'}.`, { sound: 'select', hold: 4000 });
        stageRef.current?.scrollIntoView({ behavior: 'smooth' });
        return;
      }
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
      showPreview(null);
      Sound.play('select');
    } catch (err) {
      say((err as Error).message, { sound: 'error' });
    }
  };

  const reset = useCallback(() => {
    setFrames([]);
    showPreview(null);
    setRoom(null);
    setGeo(null);
    setHint('');
    setPlace('');
    setCategory('');
    setTagsText('');
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
    const { card: aiCard, best_frame: bf } = preview;
    const card = withUser(aiCard);
    const image = frames[bf] || frames[0];
    try {
      const thumb = await Media.makeThumb(image).catch(() => image);
      const { item } = await create.mutateAsync({
        card,
        image,
        thumb,
        source,
        currency: preview.currency,
        location: { place: place.trim() || card.location_guess, ...(geo || {}) },
      });
      setCaught(true);
      say(`Gotcha! ${item.name.toUpperCase()} was registered as NO.${pad(item.number)}!`, { sound: 'get' });
      setTimeout(reset, 1400);
    } catch (err) {
      say(`Save failed: ${(err as Error).message}`, { sound: 'error' });
    }
  };

  const saveRoom = async () => {
    if (!room) return;
    const picked = room.items.filter((i) => i.on);
    let saved = 0;
    try {
      for (const it of picked) { // one at a time so card numbers follow the order on screen
        const thumb = await Media.makeThumb(it.crop).catch(() => it.crop);
        await create.mutateAsync({
          card: withUser(it.card), image: it.crop, thumb, source, currency: room.currency,
          location: { place: place.trim() || it.card.location_guess, ...(geo || {}) },
          purchase: it.purchase,
        });
        saved++;
      }
      setCaught(true);
      say(`Gotcha! ${saved} items registered!`, { sound: 'get' });
      setTimeout(reset, 1400);
    } catch (err) {
      say(`Saved ${saved} of ${picked.length}. ${(err as Error).message}`, { sound: 'error', hold: 6000 });
    }
  };

  const toggleRoom = () => {
    Sound.play('click');
    setRoomMode((r) => !r);
    showPreview(null);
    setRoom(null);
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
          <div className="head-modes">
            <div className="mode-toggle" role="group" aria-label="Snap mode" title="How the camera takes the picture">
              <button className={`mode${mode === 'auto' ? ' active' : ''}`} onClick={() => setMode('auto')} title="AUTO SNAP: hold an item steady and the camera takes the picture and scans it by itself">AUTO SNAP</button>
              <button className={`mode${mode === 'manual' ? ' active' : ''}`} onClick={() => setMode('manual')} title="MANUAL: you press SNAP for each angle (up to 6), then SCAN">MANUAL</button>
            </div>
            <div className="mode-toggle" role="group" aria-label="Room mode">
              <button className={`mode${roomMode ? ' active' : ''}`} onClick={toggleRoom} aria-pressed={roomMode} title="ROOM: scan one photo of a shelf, drawer or table and get a card for every item in it (use MANUAL or upload a photo). Off = one item per scan">ROOM</button>
            </div>
          </div>
        </div>

        <div
          className={`viewfinder${hover ? ' hover' : ''}`}
          title="Live camera. Show an item to scan it, or drop a photo, video or PDF invoice here"
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
          <div className={`vf-status ${vfStatus.cls}`} title="What the camera is doing right now"><i /><span>{vfStatus.text}</span></div>
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
          <button className="btn btn-accent snap-btn" onClick={snapNow} disabled={!camActive || scanning || !usingCamera} title="Take the picture now (Space). In MANUAL mode, snap several angles of the same item, then press SCAN">● SNAP</button>
          <div className="frames" title="Pictures that will be scanned (click ✕ on one to remove it)">
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
            <button className="btn btn-small" onClick={() => { Sound.play('click'); photoInput.current?.click(); }} title="Upload one or more photos of the item (JPG, PNG, WEBP)">⇪ PHOTO</button>
            <button className="btn btn-small" onClick={() => { Sound.play('click'); videoInput.current?.click(); }} title="Upload a short video; the app takes 4 frames from it">⇪ VIDEO</button>
            <button className="btn btn-small btn-accent" onClick={() => { Sound.play('click'); pdfInput.current?.click(); }} title="Upload an e-commerce PDF invoice (Tokopedia, Shopee, etc.) to catalogue purchased items" style={{ marginLeft: 6 }}>⇪ INVOICE</button>
            {!usingCamera && <button className="btn btn-small" onClick={backToCamera} title="Drop the uploaded pictures and use the live camera">◉ CAMERA</button>}
          </div>
        </div>
        <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={(e) => { void addFiles(e.target.files || []); e.target.value = ''; }} />
        <input ref={videoInput} type="file" accept="video/*" hidden onChange={(e) => { void addFiles(e.target.files || []); e.target.value = ''; }} />
        <input ref={pdfInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { void addFiles(e.target.files || []); e.target.value = ''; }} />

        <div className="field-row">
          <label className="field" title="Anything the picture cannot show (age, flaws, accessories). The AI reads it with the photo">
            <span>NOTE FOR THE AI <em>(optional)</em></span>
            <input value={hint} onChange={(e) => setHint(e.target.value)} maxLength={300} placeholder="e.g. bought 2022, minor scratch" />
          </label>
          <label className="field" title="Saved as the item's last seen place. Leave empty and the AI guesses from the background">
            <span>WHERE IS IT NOW? <em>(the AI will guess)</em></span>
            <input value={place} onChange={(e) => setPlace(e.target.value)} maxLength={80} placeholder="e.g. lemari kamar, rak 2" />
          </label>
        </div>

        <div className="field-row two">
          <label className="field" title="Optional. Your own category for the card, e.g. Laptop or Power tool. It replaces the AI's guess (in room mode it applies to every item)">
            <span>CATEGORY <em>(optional)</em></span>
            <input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} placeholder="e.g. Laptop, Power tool" />
          </label>
          <label className="field" title="Optional. Comma-separated tags, e.g. work, garage. They are added to the AI's tags (max 6) and are searchable">
            <span>TAGS <em>(optional, comma separated)</em></span>
            <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} maxLength={120} placeholder="e.g. work, garage" />
          </label>
          <button className="btn btn-primary scan-btn" disabled={!frames.length || scanning} onClick={() => runScan(frames, source)} title="Send the pictures to the AI and make the card">▶ SCAN</button>
        </div>
      </div>

      <div className="panel scan-output" ref={stageRef}>
        <div className="panel-head">
          <h2 className="panel-title">2. CARD</h2>
          {preview && !scanning && pricing.phase !== 'idle' && (
            <span className={`price-status ${pricing.phase === 'done' ? `ps-${pricing.check.status}` : 'ps-checking'}`}>
              {pricingText(pricing)}
            </span>
          )}
        </div>
        <div className="card-stage" title="Your scanned card appears here. Nothing is saved until you press SAVE">
          {scanning ? (
            <Scanner cover={frames[0]} />
          ) : room ? (
            <div className="room-grid">
              {room.items.map((it, i) => (
                <label className={`room-pick${it.on ? ' on' : ''}`} key={i}>
                  <input
                    type="checkbox"
                    title="Tick to save this item"
                    checked={it.on}
                    onChange={() => setRoom({ ...room, items: room.items.map((x, k) => (k === i ? { ...x, on: !x.on } : x)) })}
                  />
                  <TradingCard item={{ ...withUser(it.card), currency: room.currency }} image={it.crop} mini />
                </label>
              ))}
            </div>
          ) : preview ? (
            <div className="reveal" key={preview.elapsed_ms}>
              <TradingCard
                item={{ ...withUser(preview.card), currency: preview.currency }}
                image={frames[preview.best_frame] || frames[0] || null}
                place={place.trim() || preview.card.location_guess}
                className={caught ? 'caught' : ''}
              />
            </div>
          ) : (
            <div className="stage-idle"><CardBack /><p className="blink">INSERT ITEM TO BEGIN</p></div>
          )}
        </div>
        {room && !scanning && (
          <div className="result-actions">
            <button className="btn btn-primary" onClick={saveRoom} disabled={create.isPending || caught || !room.items.some((i) => i.on)} title="Save the ticked cards to your collection, each with its own cropped picture">
              ★ SAVE {room.items.filter((i) => i.on).length} TO DEX
            </button>
            <button className="btn" onClick={() => runScan(frames, source)} title="Ask the AI again with the same pictures">↻ RESCAN</button>
            <button className="btn btn-danger" onClick={discard} title="Throw this result away">✕ DISCARD</button>
          </div>
        )}
        {preview && !scanning && (
          <div className="result-actions">
            <button className="btn btn-primary" onClick={save} disabled={create.isPending || caught} title="Add this card to your collection">★ SAVE TO DEX</button>
            <button className="btn" onClick={() => runScan(frames, source)} title="Ask the AI again with the same pictures">↻ RESCAN</button>
            <button className="btn btn-danger" onClick={discard} title="Throw this card away">✕ DISCARD</button>
          </div>
        )}
      </div>
    </section>
  );
}
