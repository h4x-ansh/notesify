/** @type {import('electron-builder').Configuration} */
export default {
  appId: "com.hisarchives.notesify",
  productName: "Notesify",
  directories: {
    output: "dist",
  },
  // Disabled so server.js can be spawned via child_process.spawn() as a
  // plain file on disk (app.getAppPath() in electron/main.js), with no
  // asar-transparency edge cases to worry about for a spawned process.
  asar: false,
  files: ["electron/**/*", "server.js", "generate-notes.js", "src/**/*", "package.json"],
  extraResources: [
    { from: "frontend/out", to: "frontend/out" },
    { from: ".env", to: ".env" },
  ],
  win: {
    target: "portable",
  },
};
