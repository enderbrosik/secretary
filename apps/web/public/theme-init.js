// Applies the saved theme before first paint to avoid a flash (kept external for a strict CSP).
try {
  var t = localStorage.getItem('secretary.theme') || 'system';
  var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
} catch (e) {}
