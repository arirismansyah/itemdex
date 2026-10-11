// Tiny JSON-file store: <dataDir>/items.json + <dataDir>/media/<id>.<ext>

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.mediaDir = path.join(dataDir, 'media');
    this.file = path.join(dataDir, 'items.json');
    fs.mkdirSync(this.mediaDir, { recursive: true });
    this.items = this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(data.items) ? data.items : [];
    } catch {
      return [];
    }
  }

  persist() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return [...this.items].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(id) {
    return this.items.find((i) => i.id === id);
  }

  nextNumber() {
    return this.items.reduce((m, i) => Math.max(m, i.number || 0), 0) + 1;
  }

  // dataUrl: "data:image/jpeg;base64,...."
  saveImage(id, dataUrl) {
    const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/s.exec(dataUrl || '');
    if (!m) return null;
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const name = `${id}.${ext}`;
    fs.writeFileSync(path.join(this.mediaDir, name), Buffer.from(m[2], 'base64'));
    return name;
  }

  create(card, { imageDataUrl, source, location }) {
    const id = crypto.randomUUID();
    const image = this.saveImage(id, imageDataUrl);
    const now = new Date().toISOString();
    const item = {
      id,
      number: this.nextNumber(),
      ...card,
      image,
      source,
      location: location ? { ...location, at: now } : null,
      location_history: location ? [{ ...location, at: now }] : [],
      created_at: now,
      updated_at: now,
    };
    this.items.push(item);
    this.persist();
    return item;
  }

  update(id, card) {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx < 0) return null;
    const prev = this.items[idx];
    this.items[idx] = {
      ...prev,
      ...card,
      id: prev.id,
      number: prev.number,
      image: prev.image,
      source: prev.source,
      location: prev.location,
      location_history: prev.location_history,
      created_at: prev.created_at,
      updated_at: new Date().toISOString(),
    };
    this.persist();
    return this.items[idx];
  }

  // Records where the item was last seen; keeps the 20 most recent moves.
  // location: { place, lat, lng, accuracy_m, source, address }
  move(id, location) {
    const item = this.get(id);
    if (!item) return null;
    const now = new Date().toISOString();
    item.location = { ...location, at: now };
    item.location_history = [item.location, ...(item.location_history || [])].slice(0, 20);
    item.updated_at = now;
    this.persist();
    return item;
  }

  remove(id) {
    const item = this.get(id);
    if (!item) return false;
    this.items = this.items.filter((i) => i.id !== id);
    this.persist();
    if (item.image) fs.rm(path.join(this.mediaDir, item.image), { force: true }, () => {});
    return true;
  }
}

module.exports = { Store };
