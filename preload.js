const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tb', {
  init: () => ipcRenderer.invoke('init'),
  post: text => ipcRenderer.invoke('post', text),
  refresh: () => ipcRenderer.invoke('refresh'),
  pickWindow: id => ipcRenderer.invoke('chrome:pick', id),
  switchProfile: () => ipcRenderer.invoke('chrome:switch'),
  scanDrafts: () => ipcRenderer.invoke('drafts:scan'),
  postDraft: id => ipcRenderer.invoke('drafts:post', id),
  dismissDraft: id => ipcRenderer.invoke('drafts:dismiss', id),
  listRepos: () => ipcRenderer.invoke('repos:list'),
  addRepo: () => ipcRenderer.invoke('repos:add'),
  removeRepo: repo => ipcRenderer.invoke('repos:remove', repo),
  hideBar: () => ipcRenderer.invoke('bar:hide'),
  setBarHeight: h => ipcRenderer.invoke('bar:height', h),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, data) => fn(data)),
})
