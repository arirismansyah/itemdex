// Item detail: big card, market value, LAST SEEN (+ move), data table, edit, export, release.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RARITIES, TYPES, type Item } from '@itemdex/shared';
import { useDeleteItem, useItem, useMoveItem, useUpdateItem } from '../lib/api';
import { say } from '../lib/dialog';
import { ago, date, dims, mapUrl, money, pad, placeLabel, weight } from '../lib/format';
import { deviceLocation } from '../lib/media';
import { exportPng } from '../lib/platform';
import { Sound } from '../lib/sound';
import { TradingCard } from './TradingCard';

function LocationBlock({ item }: { item: Item }) {
  const move = useMoveItem();
  const [place, setPlace] = useState('');
  const [gps, setGps] = useState(true);
  const loc = item.location;
  const history = (item.location_history || []).slice(1, 6);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const geo = gps ? await deviceLocation() : null;
      if (!place.trim() && !geo) throw new Error('Type a place (GPS not available).');
      const { item: updated } = await move.mutateAsync({
        id: item.id,
        location: { place: place.trim(), ...(geo ? { ...geo, source: 'device' } : {}) },
      });
      setPlace('');
      say(`${updated.name.toUpperCase()} is now at ${placeLabel(updated.location)}.`, { sound: 'select' });
    } catch (err) {
      say((err as Error).message, { sound: 'error' });
    }
  };

  return (
    <section className="info-sec loc-sec">
      <h4>LAST SEEN</h4>
      {loc ? (
        <>
          <p className="place">{placeLabel(loc)} <em>{ago(loc.at)}</em></p>
          {loc.address && <p className="address">{loc.address}</p>}
          {loc.lat != null && loc.lng != null && (
            <>
              <p className="coords">
                ⌖ {loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}
                {loc.accuracy_m ? <em>±{loc.accuracy_m}m</em> : null}
                <em>{loc.source === 'exif' ? 'PHOTO EXIF' : 'DEVICE GPS'}</em>
              </p>
              <a className="btn btn-small" href={mapUrl(loc)} target="_blank" rel="noopener noreferrer">⌖ OPEN MAP</a>
            </>
          )}
        </>
      ) : <p className="muted">Location unknown.</p>}
      <form className="move-form" onSubmit={submit}>
        <input value={place} onChange={(e) => setPlace(e.target.value)} maxLength={80} placeholder="Moved it? Where is it now?" aria-label="New location" />
        <label className="check"><input type="checkbox" checked={gps} onChange={(e) => setGps(e.target.checked)} /> + GPS</label>
        <button className="btn btn-small btn-primary" disabled={move.isPending}>{move.isPending ? '...' : 'UPDATE'}</button>
      </form>
      {history.length > 0 && (
        <ul className="history">
          {history.map((h, i) => <li key={i}><span>{placeLabel(h)}</span><em>{ago(h.at)}</em></li>)}
        </ul>
      )}
    </section>
  );
}

function EditForm({ item, onDone }: { item: Item; onDone: () => void }) {
  const update = useUpdateItem();
  const d = item.dimensions;
  const v = item.value;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const n = (k: string) => Number(f[k]) || 0;
    try {
      await update.mutateAsync({
        id: item.id,
        card: {
          name: f.name,
          brand: f.brand,
          model: f.model,
          type: f.type as Item['type'],
          rarity: f.rarity as Item['rarity'],
          description: f.description,
          dimensions: { length_cm: n('length_cm'), width_cm: n('width_cm'), height_cm: n('height_cm') },
          weight_g: n('weight_g'),
          value: { ...v, min: n('min'), typical: n('typical'), max: n('max') },
          condition: { ...item.condition, score: n('score') },
        },
      });
      say('Card updated!', { sound: 'select' });
      onDone();
    } catch (err) {
      say((err as Error).message, { sound: 'error' });
    }
  };

  return (
    <>
      <h2>EDIT NO.{pad(item.number)}</h2>
      <form className="edit-form" onSubmit={submit}>
        <label className="wide">NAME<input name="name" defaultValue={item.name} maxLength={40} required /></label>
        <label>BRAND<input name="brand" defaultValue={item.brand} /></label>
        <label>MODEL<input name="model" defaultValue={item.model} /></label>
        <label>TYPE<select name="type" defaultValue={item.type}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
        <label>RARITY<select name="rarity" defaultValue={item.rarity}>{RARITIES.map((r) => <option key={r}>{r}</option>)}</select></label>
        <label>LENGTH cm<input name="length_cm" type="number" inputMode="decimal" step="0.1" min="0" defaultValue={d.length_cm} /></label>
        <label>WIDTH cm<input name="width_cm" type="number" inputMode="decimal" step="0.1" min="0" defaultValue={d.width_cm} /></label>
        <label>HEIGHT cm<input name="height_cm" type="number" inputMode="decimal" step="0.1" min="0" defaultValue={d.height_cm} /></label>
        <label>WEIGHT g<input name="weight_g" type="number" inputMode="numeric" min="0" defaultValue={item.weight_g} /></label>
        <label>VALUE MIN<input name="min" type="number" inputMode="numeric" min="0" defaultValue={v.min} /></label>
        <label>VALUE TYPICAL<input name="typical" type="number" inputMode="numeric" min="0" defaultValue={v.typical} /></label>
        <label>VALUE MAX<input name="max" type="number" inputMode="numeric" min="0" defaultValue={v.max} /></label>
        <label>CONDITION (HP)<input name="score" type="number" inputMode="numeric" min="0" max="100" defaultValue={item.condition.score} /></label>
        <label className="wide">DESCRIPTION<textarea name="description" rows={3} defaultValue={item.description} /></label>
        <div className="info-actions wide">
          <button className="btn btn-primary" disabled={update.isPending}>✔ SAVE</button>
          <button type="button" className="btn" onClick={onDone}>CANCEL</button>
        </div>
      </form>
    </>
  );
}

export function DetailModal({ initial, onClose }: { initial: Item; onClose: () => void }) {
  const { data: item = initial } = useItem(initial.id, initial);
  const del = useDeleteItem();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exporting, setExporting] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    bodyRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
    };
  }, [onClose]);

  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      Sound.play('error');
      return;
    }
    try {
      await del.mutateAsync(item.id);
      onClose();
      say(`Bye bye, ${item.name.toUpperCase()}!`, { sound: 'remove' });
    } catch (err) {
      say((err as Error).message, { sound: 'error' });
    }
  };

  const doExport = async () => {
    const card = cardRef.current;
    if (!card) return;
    setExporting(true);
    card.classList.add('no-tilt');
    card.style.transform = '';
    try {
      const saved = await exportPng(card, item.name);
      if (saved) say(`Card saved: ${saved}`, { sound: 'select' });
    } catch (err) {
      say(`Export failed: ${(err as Error).message}`, { sound: 'error' });
    } finally {
      card.classList.remove('no-tilt');
      setExporting(false);
    }
  };

  const v = item.value;
  const row = (k: string, val: string | number | undefined) => (val ? <tr><th>{k}</th><td>{val}</td></tr> : null);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={item.name}>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-body panel" ref={bodyRef} tabIndex={-1}>
        <button className="icon-btn modal-x" onClick={onClose} title="Close" aria-label="Close">✕</button>
        <div className="modal-card">
          <TradingCard ref={cardRef} item={item} image={item.image_url} />
        </div>
        <div className="modal-info">
          {editing ? <EditForm item={item} onDone={() => setEditing(false)} /> : (
            <>
              <h2>NO.{pad(item.number)} {item.name}</h2>
              <section className="info-sec value-sec">
                <h4>MARKET VALUE <em>(AI ESTIMATE · {v.confidence} CONFIDENCE)</em></h4>
                <p className="big-value">{money(v.typical, { compact: false })}</p>
                <p className="range">
                  RANGE {money(v.min)} – {money(v.max)}{v.new_price ? ` · NEW ${money(v.new_price)}` : ''}
                </p>
                {v.reasoning && <p className="muted">{v.reasoning}</p>}
              </section>
              <LocationBlock item={item} />
              <section className="info-sec">
                <h4>DATA</h4>
                <table className="data">
                  <tbody>
                    {row('BRAND', item.brand)}{row('MODEL', item.model)}{row('CATEGORY', item.subcategory)}
                    {row('SIZE', `${dims(item.dimensions)} (${item.size_class})`)}
                    {row('WEIGHT', weight(item.weight_g))}
                    {row('COLOR', item.color)}{row('MATERIAL', item.material)}
                    {row('CONDITION', `${item.condition.label} · ${item.condition.score}/100`)}
                    {row('NOTES', item.condition.notes)}
                    {row('ADDED', `${date(item.created_at)} via ${item.source?.toUpperCase()}`)}
                    {row('TAGS', item.tags.map((t) => `#${t}`).join(' '))}
                  </tbody>
                </table>
              </section>
              <div className="info-actions">
                <button className="btn" onClick={() => { Sound.play('click'); setEditing(true); }}>✎ EDIT</button>
                <button className="btn" onClick={doExport} disabled={exporting}>⇩ EXPORT PNG</button>
                <button className={`btn btn-danger${confirmDelete ? ' confirm' : ''}`} onClick={remove} disabled={del.isPending}>
                  {confirmDelete ? 'SURE? CLICK AGAIN' : '✕ RELEASE'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
