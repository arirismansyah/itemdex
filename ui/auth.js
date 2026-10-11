// Optional API key, for when the service runs with ITEMDEX_API_KEY.
// Open the UI once as http://host:port/?key=YOUR_KEY and it is remembered here.
const Auth = (() => {
  let key = '';
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('key');
    if (fromUrl) {
      localStorage.setItem('itemdex.key', fromUrl);
      window.history.replaceState(null, '', window.location.pathname);
    }
    key = localStorage.getItem('itemdex.key') || '';
  } catch { /* storage blocked: no key */ }
  return { headers: () => (key ? { 'X-API-Key': key } : {}) };
})();
