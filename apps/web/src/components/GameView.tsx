// Trainer card, daily quest, dex progress, quality quests, badges, leaderboard and Guess the Price.

import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Item } from '@itemdex/shared';
import { api, nextGuess, sendGuess, useGame, type GuessItem, type GuessResult } from '../lib/api';
import { say } from '../lib/dialog';
import { money } from '../lib/format';
import { usePlayer } from '../lib/player';

const TITLES = ['Rookie', 'Collector', 'Archivist', 'Curator', 'Expert', 'Master', 'Legend'];

const Bar = ({ n, of, label }: { n: number; of: number; label: string }) => (
  <div className="bar-row" title={`${label}: ${n} of ${of} to the next milestone`}>
    <span>{label}</span>
    <div className="bar"><i style={{ width: `${Math.min(100, (n / of) * 100)}%` }} /></div>
    <b>{n}/{of}</b>
  </div>
);

export function GameView({ active, onOpen }: { active: boolean; onOpen: (i: Item) => void }) {
  const player = usePlayer();
  const { data: g, isError, error } = useGame(active);
  const cls = `view view-game${active ? ' active' : ''}`;
  if (isError) return <section className={cls}><p className="auth-error">{(error as Error).message}</p></section>;
  if (!g) return <section className={cls} aria-hidden={!active}><p className="muted">...</p></section>;
  const { me } = g;
  return (
    <section className={cls} aria-hidden={!active}>
      <div className="game">
      <div className="panel game-me">
        <h2 className="panel-title">{(player || 'Trainer').toUpperCase()} · LV {me.level} {TITLES[Math.min(TITLES.length - 1, Math.floor((me.level - 1) / 2))].toUpperCase()}</h2>
        <div className="bar big" title={`${me.xp} XP, next level at ${me.to}`}><i style={{ width: `${((me.xp - me.from) / (me.to - me.from)) * 100}%` }} /></div>
        <p className="small">{me.xp} / {me.to} XP · 🔥 {me.streak}-day streak · ♥ {me.karma} lend karma</p>
        <p className="small muted">Earn XP by cataloguing items (+10), adding receipts (+5), completing cards (+10), returning lent items on time (+10) and guessing prices.</p>
      </div>

      <div className="panel">
        <h2 className="panel-title">DAILY QUEST {g.quest.done && '✔'}</h2>
        <p>{g.quest.text}</p>
        <Bar n={g.quest.progress} of={g.quest.goal} label={`+${g.quest.reward} XP`} />
      </div>

      <div className="panel">
        <h2 className="panel-title">DEX PROGRESS</h2>
        {g.dex.types.map((t) => <Bar key={t.name} {...t} label={t.name} />)}
        {g.dex.rooms.length > 0 && <h3 className="small">ROOMS</h3>}
        {g.dex.rooms.map((t) => <Bar key={t.name} {...t} label={t.name} />)}
        {!g.dex.types.length && <p className="muted">Scan something to fill your dex.</p>}
      </div>

      <div className="panel">
        <h2 className="panel-title">CARD QUALITY · {g.quality.average}%</h2>
        {g.quality.todo.length ? g.quality.todo.map((t) => (
          <button key={t.id} className="btn btn-small quest-item" title={`Open it and add: ${t.missing.join(', ')}`}
            onClick={() => api<{ item: Item }>(`/items/${t.id}`).then((r) => onOpen(r.item))}>
            {t.name} · {t.score}% · needs {t.missing.join(', ')}
          </button>
        )) : <p className="muted">Every card is 100% complete.</p>}
      </div>

      <div className="panel">
        <h2 className="panel-title">BADGES</h2>
        <div className="badges">
          {g.badges.map((b) => <span key={b.id} className={`badge${b.got ? ' got' : ''}`} title={b.how}>{b.got ? '★' : '🔒'} {b.name}</span>)}
        </div>
      </div>

      <div className="panel">
        <h2 className="panel-title">LEADERBOARD</h2>
        <table className="board">
          <thead><tr><th>#</th><th>PLAYER</th><th>XP</th><th title="XP since Monday">WEEK</th><th>ADDED</th><th>KARMA</th></tr></thead>
          <tbody>
            {g.board.map((r, i) => (
              <tr key={r.player} className={r.player === (player || 'Trainer') ? 'me' : ''}>
                <td>{i + 1}</td><td>{r.player}</td><td>{r.xp}</td><td>{r.week}</td><td>{r.added}</td><td>{r.karma}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <GuessGame />
      </div>
    </section>
  );
}

function GuessGame() {
  const qc = useQueryClient();
  const [item, setItem] = useState<GuessItem | null | undefined>(undefined); // undefined = not started
  const [result, setResult] = useState<GuessResult | null>(null);
  const [busy, setBusy] = useState(false);

  const next = async () => {
    setBusy(true);
    setResult(null);
    try {
      setItem(await nextGuess());
    } catch (err) {
      say((err as Error).message, { sound: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const guess = Number(new FormData(e.currentTarget).get('guess'));
    if (!item || !guess) return;
    setBusy(true);
    try {
      const r = await sendGuess(item.id, guess);
      setResult(r);
      qc.invalidateQueries({ queryKey: ['game'] });
      say(r.repeat ? 'Already scored this one today!' : r.points ? `+${r.points} XP!` : 'Not close, try the next one.', { sound: r.points ? 'select' : 'error' });
    } catch (err) {
      say((err as Error).message, { sound: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel guess">
      <h2 className="panel-title">GUESS THE PRICE</h2>
      {item === undefined && <button className="btn btn-primary" onClick={next} disabled={busy} title="Pick a random item from your collection">▶ PLAY</button>}
      {item === null && <p className="muted">Needs an item with a photo and a price.</p>}
      {item && (
        <form onSubmit={submit} key={item.id}>
          {item.thumb_url && <img src={item.thumb_url} alt="" className="guess-img" />}
          <p>{item.name}</p>
          {result ? (
            <>
              <p>Actual: <b>{money(result.actual, { currency: item.currency })}</b> · off by {result.off_pct}% · +{result.points} XP</p>
              <button type="button" className="btn btn-primary" onClick={next} disabled={busy}>▶ NEXT</button>
            </>
          ) : (
            <label className="field">
              <span>YOUR GUESS ({item.currency})</span>
              <input name="guess" type="number" min={1} required autoFocus title="Within 10% scores 10 XP, 25% scores 5, 50% scores 2" />
              <button className="btn btn-primary" disabled={busy}>▶ GUESS</button>
            </label>
          )}
        </form>
      )}
    </div>
  );
}
