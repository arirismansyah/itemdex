// Header menu: point ITEMDEX at an OpenAI-compatible AI server (URL, API key, model).

import { useEffect, useState, type FormEvent } from 'react';
import { useMenu } from '../lib/menu';
import { testAi, useAiConfig, useSaveAi } from '../lib/api';
import { say } from '../lib/dialog';

// Starting points. The URL and model stay editable; the hint says where the key comes from and what to watch for.
const PRESETS = [
  { id: 'custom', label: 'Other (OpenAI-compatible)', url: '', model: '', hint: 'Gemma on vLLM, LM Studio, OpenRouter, ... Any server with /chat/completions and image input.' },
  { id: '9router', label: '9router (Homelab)', url: 'http://host.containers.internal:20128/v1', model: 'ag/gemini-3-flash',
    hint: 'Homelab 9router proxy on port 20128. Uses Antigravity Gemini Flash or gemini-combo.' },
  { id: 'anthropic', label: 'Claude (Anthropic API)', url: 'https://api.anthropic.com', model: 'claude-sonnet-5-5',
    hint: 'Needs an API key from console.anthropic.com (pay per use). A Claude Pro/Max subscription cannot be used: Anthropic does not allow it in other apps. claude-haiku-5-5 is faster and cheaper.' },
  { id: 'deepseek', label: 'DeepSeek', url: 'https://api.deepseek.com', model: '',
    hint: 'API key from platform.deepseek.com. deepseek-chat cannot read images: press TEST and pick the vision model it lists.' },
  { id: 'gemini', label: 'Google Gemini (AI Studio)', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '',
    hint: 'Free API key from aistudio.google.com. Google Antigravity is an IDE with no API, but it uses these same Gemini models. Press TEST and pick one.' },
  { id: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hint: 'API key from platform.openai.com.' },
  { id: 'ollama', label: 'Ollama (local)', url: 'http://localhost:11434', model: '', hint: 'No key needed. Use a vision model such as llava, gemma3 or qwen2.5vl; run `ollama pull <name>` first.' },
];
const presetFor = (url: string) =>
  PRESETS.find((p) => p.url && url.replace(/\/+$/, '').startsWith(p.url.replace(/\/v1$/, ''))) ?? PRESETS[0];

export function AiSettings() {
  const [open, setOpen] = useMenu('ai');
  const { data: cfg } = useAiConfig();
  const save = useSaveAi();
  const [url, setUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // Fill the form with what the server currently uses (the key is never sent back).
  useEffect(() => {
    if (cfg && open) { setUrl(cfg.base_url); setModel(cfg.model); setKey(''); setResult(null); }
  }, [cfg, open]);

  const body = { base_url: url.trim(), model: model.trim(), ...(key.trim() ? { api_key: key.trim() } : {}) };

  const test = async () => {
    setTesting(true);
    try {
      const r = await testAi(body);
      setResult(r);
      if (r.models.length) setModels(r.models);
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await save.mutateAsync(body);
      setKey('');
      say('AI server saved!', { sound: 'select' });
      setOpen(false);
    } catch (err) {
      say((err as Error).message, { sound: 'error', hold: 6000 });
    }
  };

  const clearKey = () => save.mutate({ ...body, clear_key: true }, { onSuccess: () => say('API key removed.', { sound: 'select' }) });
  const editable = cfg?.editable !== false;
  const preset = presetFor(url);
  const pick = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)!;
    setUrl(p.url);
    setModel(p.model);
    setResult(null);
  };

  return (
    <span className="account">
      <button className="icon-btn" onClick={() => setOpen((o) => !o)} title="AI server settings" aria-label="AI server settings" aria-expanded={open}>⚙</button>
      {open && (
        <form className="panel account-panel ai-panel" onSubmit={submit}>
          <b>AI SERVER</b>
          <p className="muted small">
            Needs a model that can read images.
            {cfg?.source === 'env' && ' Currently set by the server environment; saving here overrides it.'}
            {cfg?.source === 'none' && ' Not configured yet.'}
          </p>
          {!editable && <p className="overdue small">Only the first account can change this.</p>}
          <label className="field"><span>PROVIDER</span>
            <select value={preset.id} onChange={(e) => pick(e.target.value)} disabled={!editable} title="Pick a provider to fill in its URL; you can still edit it">
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <p className="muted small">{preset.hint}</p>
          <label className="field"><span>URL</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} title="Address of the AI server. A bare host gets /v1 added" placeholder="https://your-ai-server" disabled={!editable} required />
          </label>
          <label className="field"><span>MODEL</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} title="Model name. It must be able to read images. Press TEST to list what the server offers" list="ai-models" placeholder="model name" disabled={!editable} required />
            <datalist id="ai-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
          </label>
          <label className="field"><span>API KEY {cfg?.has_key && <em>(saved: leave empty to keep)</em>}</span>
            <input type="password" title="API key from your provider. Stored on the server and never shown again" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" placeholder={cfg?.has_key ? '••••••••' : 'optional'} disabled={!editable} />
          </label>
          {result && <p className={result.ok ? 'ok small' : 'overdue small'} role="status">{result.message}</p>}
          {editable && (
            <div className="move-form">
              <button type="button" className="btn btn-small" onClick={test} disabled={testing || !url.trim()} title="Check the server, the key and that the model accepts images (does not save)">{testing ? '...' : '⚡ TEST'}</button>
              <button className="btn btn-small btn-primary" disabled={save.isPending || !url.trim() || !model.trim()} title="Use this AI server from now on (no restart needed)">✔ SAVE</button>
              {cfg?.has_key && <button type="button" className="btn btn-small btn-danger" onClick={clearKey} disabled={save.isPending} title="Remove the saved API key">✕ KEY</button>}
            </div>
          )}
          <p className="muted small">The key is stored in this service&apos;s database and never shown again.</p>
        </form>
      )}
    </span>
  );
}
