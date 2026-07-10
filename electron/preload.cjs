// CommonJS (.cjs) rather than following the rest of this project's ESM -
// Electron preload scripts run in a special sandboxed context where ESM
// support has historically been unreliable; .cjs sidesteps that regardless
// of the root package.json's "type": "module" affecting how a plain .js
// file here would otherwise be interpreted.
const { contextBridge, ipcRenderer } = require("electron");

// Exposes a minimal, specific bridge rather than raw ipcRenderer access -
// contextIsolation:true (see main.js's BrowserWindow config) means the
// renderer can't reach Node/Electron APIs at all without something like
// this deliberately punching one function through. Matched by
// frontend/lib/transcript.ts's window.notesifyBridge usage.
contextBridge.exposeInMainWorld("notesifyBridge", {
  fetchTranscript: (youtubeUrl) => ipcRenderer.invoke("fetch-transcript", youtubeUrl),
});
