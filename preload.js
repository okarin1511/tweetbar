const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tb', {
  init: () => ipcRenderer.invoke('init'),
  post: text => ipcRenderer.invoke('post', text),
  refresh: () => ipcRenderer.invoke('refresh'),
  pickWindow: id => ipcRenderer.invoke('chrome:pick', id),
  switchProfile: () => ipcRenderer.invoke('chrome:switch'),
  hideBar: () => ipcRenderer.invoke('bar:hide'),
  setBarHeight: h => ipcRenderer.invoke('bar:height', h),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, data) => fn(data)),
})
