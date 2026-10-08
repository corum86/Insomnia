const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('insomnia', {
  // Status
  getStatus: () => ipcRenderer.invoke('get-status'),
  toggleAwake: () => ipcRenderer.invoke('toggle-awake'),
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_, status) => callback(status));
  },

  // Apps
  addApp: (appData) => ipcRenderer.invoke('add-app', appData),
  removeApp: (exe) => ipcRenderer.invoke('remove-app', exe),
  toggleApp: (exe) => ipcRenderer.invoke('toggle-app', exe),
  getInstalledApps: () => ipcRenderer.invoke('get-installed-apps'),
  browseExe: () => ipcRenderer.invoke('browse-exe'),

  // Integrations
  getAvailableIntegrations: () => ipcRenderer.invoke('get-available-integrations'),
  addIntegration: (id) => ipcRenderer.invoke('add-integration', id),
  removeIntegration: (id) => ipcRenderer.invoke('remove-integration', id),
  toggleIntegration: (id) => ipcRenderer.invoke('toggle-integration', id),

  // Dev container projects (Claude Code)
  getDevcontainerProjects: () => ipcRenderer.invoke('get-devcontainer-projects'),
  addDevcontainerProject: () => ipcRenderer.invoke('add-devcontainer-project'),
  updateDevcontainerProject: (configPath) => ipcRenderer.invoke('update-devcontainer-project', configPath),
  removeDevcontainerProject: (configPath) => ipcRenderer.invoke('remove-devcontainer-project', configPath),

  // Startup
  getStartup: () => ipcRenderer.invoke('get-startup'),
  toggleStartup: () => ipcRenderer.invoke('toggle-startup')
});
