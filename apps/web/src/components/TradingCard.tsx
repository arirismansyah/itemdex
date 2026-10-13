// The collectible card itself, plus the card back and the 3D tilt effect.

import { forwardRef, memo, useEffect, useRef, type Ref } from 'react';
import { RARITY_RANK, type Card, type ItemLocation, type Lent } from '@itemdex/shared';
import { TYPE_META, date, dims, money, pad, placeLabel, weight } from '../lib/format';

export type CardData = Card & {
  id?: string;
  number?: number;
  created_at?: string;
  location?: Partial<ItemLocation> | null;
  currency?: string;
  lent?: Lent | null;
  sell_now?: boolean;
};

interface Props {
  item: CardData;
  image: string | null;
  mini?: boolean;
  place?: string; // overrides the LAST SEEN text (scan preview)
  className?: string;
  onClick?: () => void;
}

const finePointer = typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

// 3D tilt + holo glare that follows the mouse (desktop pointers only; rAF-throttled).
export function useTilt(ref: { current: HTMLElement | null }) {
  useEffect(() => {
    const card = ref.current;
    if (!card || !finePointer) return;
    let frame = 0;
    const move = (e: PointerEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (card.classList.contains('no-tilt')) return;
        const r = card.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width;
        const y = (e.clientY - r.top) / r.height;
        card.style.setProperty('--mx', `${x * 100}%`);
        card.style.setProperty('--my', `${y * 100}%`);
        card.style.transform = `rotateY(${(x - 0.5) * 16}deg) rotateX(${(0.5 - y) * 16}deg)`;
      });
    };
    const leave = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      card.style.transform = '';
    };
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerleave', leave);
    return () => {
      leave();
      card.removeEventListener('pointermove', move);
      card.removeEventListener('pointerleave', leave);
    };
  }, [ref]);
}

function TradingCardInner({ item, image, mini = false, place, className = '', onClick }: Props, outerRef: Ref<HTMLElement>) {
  const ref = useRef<HTMLElement | null>(null);
  useTilt(ref);
  const t = TYPE_META[item.type] || TYPE_META.OTHER;
  const stars = RARITY_RANK[item.rarity] || 1;
  const sub = [item.brand, item.subcategory].filter(Boolean).join(' · ');
  const seen = place ?? placeLabel(item.location);
  const setRef = (el: HTMLElement | null) => {
    ref.current = el;
    if (typeof outerRef === 'function') outerRef(el);
    else if (outerRef) outerRef.current = el;
  };

  return (
    <article
      ref={setRef}
      className={`card type-${item.type} rarity-${item.rarity}${stars >= 3 ? ' holo' : ''}${mini ? ' mini' : ''} ${className}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      aria-label={onClick ? `${item.name}, ${item.rarity}` : undefined}
    >
      <div className="card-frame">
        <div className="card-top"><span className="card-sub">{sub || 'BASIC ITEM'}</span></div>
        <div className="card-title">
          <h3>{item.name}</h3>
          <span className="card-hp" title="Condition score, 0 to 100"><small>HP</small>{item.condition.score}</span>
          <span className="type-orb" title={t.label}>{t.icon}</span>
        </div>
        <div className="card-art">
          {image
            ? <img src={image} alt="" draggable={false} loading={mini ? 'lazy' : 'eager'} decoding="async" />
            : <div className="no-art">?</div>}
          <span className="art-badge" title="Size class, from the longest side">{item.size_class}</span>
          {(item.sell_now || item.lent) && (
            <span className="art-flags">
              {item.sell_now && <b className="flag-sell">SELL NOW</b>}
              {item.lent && <b className="flag-lent">LENT</b>}
            </span>
          )}
        </div>
        <div className="card-strip" title="Collection number, size, weight and date added">
          NO.{pad(item.number)} · {dims(item.dimensions)} · {weight(item.weight_g)} · {item.created_at ? date(item.created_at) : 'NEW!'}
        </div>
        <div className="card-moves">
          {item.abilities.map((a, i) => (
            <div className="move" key={i} title={`${a.name}: a playful move based on what the item does (damage ${a.power})`}>
              <div className="move-cost">
                {Array.from({ length: i + 1 }, (_, k) => <span className="energy" key={k}>{t.icon}</span>)}
              </div>
              <div className="move-body">
                <b>{a.name}</b>
                {!mini && <p>{a.text}</p>}
              </div>
              <div className="move-dmg">{a.power}</div>
            </div>
          ))}
        </div>
        <div className="card-stats">
          <div title="Estimated second-hand resale value"><span>VALUE</span><b>{money(item.value.typical, { currency: item.currency })}</b></div>
          <div title="Condition of the item"><span>COND.</span><b>{item.condition.label}</b></div>
          <div title="Where the item was last seen"><span>LAST SEEN</span><b className="trunc">{seen || '???'}</b></div>
        </div>
        {!mini && <p className="card-flavor">{item.description}</p>}
        <div className="card-foot">
          <span>ITEMDEX · {t.label}</span>
          <span className="stars" title="Rarity: 1 to 5 stars">{'★'.repeat(stars)}{'☆'.repeat(5 - stars)}</span>
          <span>{item.rarity}</span>
        </div>
      </div>
      <div className="card-shine" aria-hidden="true" />
    </article>
  );
}

export const TradingCard = memo(forwardRef(TradingCardInner));

export function CardBack() {
  return (
    <article className="card card-back" aria-hidden="true">
      <div className="back-ring"><div className="back-mark" /></div>
      <p>ITEMDEX</p>
    </article>
  );
}
