// Normalizes raw model output (or user edits) into a safe, complete card record.

const { TYPES, RARITIES, CONDITIONS, SIZE_CLASSES } = require('./gemma');

const str = (v, max = 200, fallback = '') =>
  (typeof v === 'string' ? v.trim() : v == null ? fallback : String(v)).slice(0, max) || fallback;
const num = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const int = (v, min, max, fallback) => Math.round(num(v, min, max, fallback));
const oneOf = (v, list, fallback) => {
  const up = String(v || '').toUpperCase().trim();
  return list.includes(up) ? up : fallback;
};

function sizeClassFor({ length_cm, width_cm, height_cm }) {
  const longest = Math.max(length_cm, width_cm, height_cm);
  if (longest < 8) return 'TINY';
  if (longest < 25) return 'SMALL';
  if (longest < 70) return 'MEDIUM';
  if (longest < 150) return 'LARGE';
  return 'HUGE';
}

function normalizeCard(raw = {}) {
  const dims = raw.dimensions || {};
  const dimensions = {
    length_cm: +num(dims.length_cm, 0, 10000, 0).toFixed(1),
    width_cm: +num(dims.width_cm, 0, 10000, 0).toFixed(1),
    height_cm: +num(dims.height_cm, 0, 10000, 0).toFixed(1),
  };

  const v = raw.value || {};
  let min = int(v.min, 0, 1e13, 0);
  let max = int(v.max, 0, 1e13, 0);
  if (max < min) [min, max] = [max, min];
  const typical = int(v.typical, min, Math.max(min, max), Math.round((min + max) / 2));

  const c = raw.condition || {};
  const score = int(c.score, 0, 100, 75);

  const abilities = (Array.isArray(raw.abilities) ? raw.abilities : [])
    .slice(0, 2)
    .map((a) => ({
      name: str(a?.name, 24, 'Mystery Move'),
      power: int(a?.power, 0, 999, 30),
      text: str(a?.text, 160),
    }));
  while (abilities.length < 2) abilities.push({ name: 'Mystery Move', power: 10, text: '' });

  return {
    is_item: raw.is_item !== false,
    name: str(raw.name, 40, 'Unknown Item'),
    brand: str(raw.brand, 60),
    model: str(raw.model, 80),
    type: oneOf(raw.type, TYPES, 'OTHER'),
    subcategory: str(raw.subcategory, 60),
    description: str(raw.description, 400),
    color: str(raw.color, 60),
    material: str(raw.material, 60),
    dimensions,
    // Derived from dimensions when known so the label always matches the numbers.
    size_class: dimensions.length_cm || dimensions.width_cm || dimensions.height_cm
      ? sizeClassFor(dimensions)
      : oneOf(raw.size_class, SIZE_CLASSES, 'SMALL'),
    weight_g: Math.round(num(raw.weight_g, 0, 1e8, 0)),
    condition: {
      score,
      label: oneOf(c.label, CONDITIONS, 'GOOD'),
      notes: str(c.notes, 300),
    },
    value: {
      min,
      max,
      typical,
      new_price: int(v.new_price, 0, 1e13, 0),
      confidence: oneOf(v.confidence, ['LOW', 'MEDIUM', 'HIGH'], 'LOW'),
      reasoning: str(v.reasoning, 300),
    },
    rarity: oneOf(raw.rarity, RARITIES, 'COMMON'),
    abilities,
    tags: (Array.isArray(raw.tags) ? raw.tags : [])
      .map((t) => str(t, 24).toLowerCase())
      .filter(Boolean)
      .slice(0, 6),
    location_guess: str(raw.location_guess, 60),
  };
}

module.exports = { normalizeCard };
