// RPG-style dialog box: `say("...")` from anywhere, <Dialog /> renders it.

import { useSyncExternalStore } from 'react';
import { Sound, type SoundName } from './sound';

export interface DialogState { id: number; text: string; hold: number }

let state: DialogState | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function say(text: string, { sound, hold = 3500 }: { sound?: SoundName; hold?: number } = {}) {
  if (sound) Sound.play(sound);
  state = { id: ++seq, text, hold };
  emit();
}

export function closeDialog() {
  state = null;
  emit();
}

export const useDialog = () => useSyncExternalStore(
  (l) => { listeners.add(l); return () => listeners.delete(l); },
  () => state,
);
