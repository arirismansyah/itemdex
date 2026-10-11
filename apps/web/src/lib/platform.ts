// Small bridge between the web app and the desktop shell (apps/desktop/src/preload.ts).

interface DesktopBridge {
  isDesktop: true;
  platform: string;
  savePng: (dataUrl: string, name: string) => Promise<{ saved: boolean; filePath?: string }>;
}

declare global {
  interface Window { desktop?: DesktopBridge }
}

export const desktop = window.desktop;

// Renders a DOM node (the card) to PNG and saves it: native dialog on desktop, download on web.
export async function exportPng(node: HTMLElement, name: string): Promise<string | null> {
  const { toPng } = await import('html-to-image'); // loaded only when used
  const dataUrl = await toPng(node, { pixelRatio: 2, cacheBust: false });
  const safe = name.replace(/[^\w-]+/g, '_').slice(0, 40) || 'card';
  if (desktop) {
    const res = await desktop.savePng(dataUrl, `itemdex_${safe}.png`);
    return res.saved ? res.filePath ?? '' : null;
  }
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `itemdex_${safe}.png`;
  a.click();
  return a.download;
}
