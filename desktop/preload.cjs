/**
 * The one bridge the renderer gets. Synchronous on load (the game hydrates
 * storage before its first system boots), fire-and-forget on save (the main
 * process owns atomicity). Nothing else crosses: no fs, no ipc pass-through.
 */
const { contextBridge, ipcRenderer } = require('electron');

// { ok, raw }: raw is the file text, or null. ok:false means the file exists
// and could not be read -- the renderer must not treat that as a first boot.
const initial = ipcRenderer.sendSync('store:load');   // once, at boot

contextBridge.exposeInMainWorld('__DESKTOP__', {
  loadStore: () => initial,
  saveStore: (json) => { ipcRenderer.send('store:save', String(json)); },
});
