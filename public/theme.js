'use strict';
(() => {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { preference = localStorage.getItem('jtg-theme') || 'system'; } catch {}
  if (!['light', 'dark', 'system'].includes(preference)) preference = 'system';
  function apply() {
    const theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101322' : '#f5f6fb');
    window.dispatchEvent(new CustomEvent('jtg-theme-change', { detail: { preference, theme } }));
  }
  window.JTGTheme = {
    get preference() { return preference; },
    get theme() { return document.documentElement.dataset.theme; },
    set(value) {
      if (!['light', 'dark', 'system'].includes(value)) return;
      preference = value;
      try { localStorage.setItem('jtg-theme', value); } catch {}
      apply();
    }
  };
  media.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => { if (event.key === 'jtg-theme') window.JTGTheme.set(event.newValue || 'system'); });
  apply();
})();
