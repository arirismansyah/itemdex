// Media helpers: resize images, make thumbnails, pull frames from video,
// read EXIF GPS, and ask the device for its location.

const MAX_SIDE = 1024;
export const THUMB_SIDE = 360;

function drawToJpeg(source: CanvasImageSource, w: number, h: number, maxSide = MAX_SIDE, quality = 0.85): string {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

export async function imageFileToDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    return drawToJpeg(img, img.naturalWidth, img.naturalHeight);
  } catch {
    throw new Error(`Can't read "${file.name}". Use JPG/PNG/WEBP (HEIC is not supported).`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Small JPEG for the collection grid (keeps scrolling smooth on phones).
export async function makeThumb(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  return drawToJpeg(img, img.naturalWidth, img.naturalHeight, THUMB_SIDE, 0.8);
}

function once(el: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    el.addEventListener(event, () => resolve(), { once: true });
    el.addEventListener('error', () => reject(new Error('Video could not be decoded')), { once: true });
  });
}

// Grab `count` evenly spaced frames from a video file.
export async function videoFileToFrames(file: File, count = 4): Promise<string[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await once(video, 'loadeddata');
    const duration = Number.isFinite(video.duration) ? video.duration : 1;
    const frames: string[] = [];
    for (let i = 0; i < count; i++) {
      video.currentTime = duration * ((i + 0.5) / count);
      await once(video, 'seeked');
      frames.push(drawToJpeg(video, video.videoWidth, video.videoHeight));
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Minimal EXIF reader: returns { lat, lng } from a JPEG's GPS IFD, or null.
export async function readExifGps(file: File): Promise<{ lat: number; lng: number } | null> {
  if (!/jpe?g$/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) return null;
  try {
    const view = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (view.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 < view.byteLength) {
      const marker = view.getUint16(off);
      const size = view.getUint16(off + 2);
      if (marker === 0xffe1 && view.getUint32(off + 4) === 0x45786966) return parseTiffGps(view, off + 10); // "Exif"
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + size;
    }
  } catch { /* malformed EXIF */ }
  return null;
}

function parseTiffGps(view: DataView, tiff: number) {
  const le = view.getUint16(tiff) === 0x4949;
  const u16 = (o: number) => view.getUint16(o, le);
  const u32 = (o: number) => view.getUint32(o, le);
  const findTag = (ifd: number, tag: number) => {
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === tag) return e;
    }
    return null;
  };
  const ifd0 = tiff + u32(tiff + 4);
  const gpsPtr = findTag(ifd0, 0x8825);
  if (!gpsPtr) return null;
  const gps = tiff + u32(gpsPtr + 8);
  const rational3 = (tag: number) => {
    const e = findTag(gps, tag);
    if (!e) return null;
    const p = tiff + u32(e + 8);
    const r = (k: number) => u32(p + k * 8) / (u32(p + k * 8 + 4) || 1);
    return r(0) + r(1) / 60 + r(2) / 3600;
  };
  const ref = (tag: number) => {
    const e = findTag(gps, tag);
    return e ? String.fromCharCode(view.getUint8(e + 8)) : '';
  };
  let lat = rational3(0x0002);
  let lng = rational3(0x0004);
  if (lat == null || lng == null) return null;
  if (ref(0x0001) === 'S') lat = -lat;
  if (ref(0x0003) === 'W') lng = -lng;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

export interface DeviceLocation { lat: number; lng: number; accuracy_m: number }

export function deviceLocation(timeout = 8000): Promise<DeviceLocation | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy_m: pos.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 5 * 60 * 1000 },
    );
  });
}
