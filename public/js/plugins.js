const Plugins = (() => {
  const DEFS = [
    { id: 'voiceTimer', name: 'Durée du vocal', desc: "Affiche depuis combien de temps tu es dans un salon vocal, dans la barre d'appel.", hasSettings: false },
    { id: 'customTheme', name: 'Thème personnalisé', desc: "Importe un thème (fichier .css) depuis ton PC pour recolorer toute l'interface.", hasSettings: true },
    { id: 'cursorCat', name: 'Chat de bureau', desc: "Un petit chat qui suit ta souris partout sur l'écran.", hasSettings: false },
    { id: 'customFont', name: 'Police personnalisée', desc: "Choisis la police d'écriture de toute l'interface.", hasSettings: true },
  ];

  const FONTS = [
    { id: 'default', label: 'Par défaut', family: null, google: null },
    { id: 'inter', label: 'Inter', family: "'Inter', sans-serif", google: 'Inter:wght@400;600;700' },
    { id: 'poppins', label: 'Poppins', family: "'Poppins', sans-serif", google: 'Poppins:wght@400;600;700' },
    { id: 'nunito', label: 'Nunito', family: "'Nunito', sans-serif", google: 'Nunito:wght@400;700;800' },
    { id: 'quicksand', label: 'Quicksand', family: "'Quicksand', sans-serif", google: 'Quicksand:wght@400;600;700' },
    { id: 'space-grotesk', label: 'Space Grotesk', family: "'Space Grotesk', sans-serif", google: 'Space+Grotesk:wght@400;600;700' },
    { id: 'jetbrains', label: 'JetBrains Mono', family: "'JetBrains Mono', monospace", google: 'JetBrains+Mono:wght@400;600;700' },
    { id: 'comic-neue', label: 'Comic Neue', family: "'Comic Neue', cursive", google: 'Comic+Neue:wght@400;700' },
  ];

  const DEFAULT_ENABLED = { voiceTimer: true, customTheme: false, cursorCat: false, customFont: false };

  function loadState() {
    try { return JSON.parse(localStorage.getItem('webchat_plugins') || '{}'); }
    catch { return {}; }
  }
  const state = { enabled: { ...DEFAULT_ENABLED }, fontId: 'default', ...loadState() };
  state.enabled = { ...DEFAULT_ENABLED, ...(state.enabled || {}) };

  function save() { localStorage.setItem('webchat_plugins', JSON.stringify(state)); }
  function isEnabled(id) { return !!state.enabled[id]; }

  function setEnabled(id, on) {
    state.enabled[id] = on;
    save();
    if (id === 'cursorCat') (on ? startCat() : stopCat());
    if (id === 'customTheme') (on ? applyStoredTheme() : removeTheme());
    if (id === 'customFont') (on ? applyFont(state.fontId) : removeFont());
  }

  /* ---- Cursor cat ---- */
  let catEl = null, mouseX = 0, mouseY = 0, catX = 0, catY = 0, rafId = null;
  function onMouseMove(e) { mouseX = e.clientX; mouseY = e.clientY; }
  function tick() {
    const dx = mouseX - catX;
    catX += dx * 0.12;
    catY += (mouseY - catY) * 0.12;
    if (catEl) catEl.style.transform = `translate(${catX - 16}px, ${catY - 16}px) scaleX(${dx < -0.5 ? -1 : 1})`;
    rafId = requestAnimationFrame(tick);
  }
  function startCat() {
    if (catEl) return;
    catEl = document.createElement('div');
    catEl.id = 'deskCat';
    catEl.textContent = '🐱';
    document.body.appendChild(catEl);
    catX = mouseX = window.innerWidth / 2;
    catY = mouseY = window.innerHeight / 2;
    document.addEventListener('mousemove', onMouseMove);
    tick();
  }
  function stopCat() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    document.removeEventListener('mousemove', onMouseMove);
    catEl?.remove();
    catEl = null;
  }

  /* ---- Custom CSS theme ---- */
  function applyStoredTheme() {
    const css = localStorage.getItem('webchat_custom_theme_css');
    if (!css) return;
    let styleEl = document.getElementById('customThemeStyle');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'customThemeStyle';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = css;
  }
  function removeTheme() {
    document.getElementById('customThemeStyle')?.remove();
  }
  function setThemeFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      localStorage.setItem('webchat_custom_theme_css', reader.result);
      setEnabled('customTheme', true);
    };
    reader.readAsText(file);
  }
  function clearThemeFile() {
    localStorage.removeItem('webchat_custom_theme_css');
    removeTheme();
  }
  function getThemeInfo() {
    const css = localStorage.getItem('webchat_custom_theme_css');
    return css ? { sizeKb: Math.round(css.length / 1024) } : null;
  }

  /* ---- Custom font ---- */
  function applyFont(fontId) {
    const font = FONTS.find((f) => f.id === fontId) || FONTS[0];
    let linkEl = document.getElementById('customFontLink');
    if (font.google) {
      if (!linkEl) {
        linkEl = document.createElement('link');
        linkEl.id = 'customFontLink';
        linkEl.rel = 'stylesheet';
        document.head.appendChild(linkEl);
      }
      linkEl.href = `https://fonts.googleapis.com/css2?family=${font.google}&display=swap`;
      document.documentElement.style.setProperty('--font-family', `${font.family}, -apple-system, sans-serif`);
    } else {
      linkEl?.remove();
      document.documentElement.style.removeProperty('--font-family');
    }
  }
  function removeFont() {
    document.getElementById('customFontLink')?.remove();
    document.documentElement.style.removeProperty('--font-family');
  }
  function setFont(fontId) {
    state.fontId = fontId;
    save();
    if (isEnabled('customFont')) applyFont(fontId);
  }

  function initOnLoad() {
    if (isEnabled('cursorCat')) startCat();
    if (isEnabled('customTheme')) applyStoredTheme();
    if (isEnabled('customFont')) applyFont(state.fontId);
  }

  return {
    DEFS,
    FONTS,
    isEnabled,
    setEnabled,
    setThemeFile,
    clearThemeFile,
    getThemeInfo,
    setFont,
    getFontId: () => state.fontId,
    initOnLoad,
  };
})();

Plugins.initOnLoad();
