const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('muesli', {
  startRecording: (meetingId) => ipcRenderer.invoke('rec:start', meetingId),
  sendChunk: (meetingId, track, int16) => ipcRenderer.send('rec:chunk', meetingId, track, int16),
  stopRecording: (meetingId) => ipcRenderer.invoke('rec:stop', meetingId),
  transcribe: (wavFile) => ipcRenderer.invoke('whisper:transcribe', wavFile),
  modelInventory: () => ipcRenderer.invoke('models:inventory'),
  info: () => ipcRenderer.invoke('app:info'),
  autotest: !!process.env.MUESLI_AUTOTEST,
  autotestPlay: () => ipcRenderer.invoke('autotest:play'),
  autotestDone: (text) => ipcRenderer.send('autotest:done', text),
});
