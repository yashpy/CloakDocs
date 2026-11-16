// Optional Chrome extension shell: clicking the toolbar icon opens CloakDocs
// in the browser side panel. Load the built `dist/` folder via
// chrome://extensions → Developer mode → "Load unpacked".
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('CloakDocs side panel setup failed:', error));
