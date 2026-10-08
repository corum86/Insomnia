// ── Elements ───────────────────────────────────────────────────────────────────
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const manualToggle = document.getElementById('manualToggle');
const startupToggle = document.getElementById('startupToggle');
const reasonText = document.getElementById('reasonText');
const triggerList = document.getElementById('triggerList');
const emptyMessage = document.getElementById('emptyMessage');
const addBtn = document.getElementById('addBtn');
const drawerOverlay = document.getElementById('drawerOverlay');
const drawerClose = document.getElementById('drawerClose');
const searchInput = document.getElementById('searchInput');
const appGrid = document.getElementById('appGrid');
const drawerLoading = document.getElementById('drawerLoading');
const browseBtn = document.getElementById('browseBtn');
const integrationList = document.getElementById('integrationList');
const devcontainerOverlay = document.getElementById('devcontainerOverlay');
const devcontainerClose = document.getElementById('devcontainerClose');
const devcontainerList = document.getElementById('devcontainerList');
const devcontainerMessage = document.getElementById('devcontainerMessage');
const devcontainerAddBtn = document.getElementById('devcontainerAddBtn');

let installedApps = [];

// Integration icon map
const INTEGRATION_ICONS = {
  'claude-code': '\u2728',
  'aider': '\u{1F916}',
  'codex-cli': '\u{1F4BB}',
  'ollama': '\u{1F9E0}',
  'cursor': '\u270F'
};

// Integrations with a settings panel, opened from the cog on their trigger row
const INTEGRATION_SETTINGS = {
  'claude-code': () => openDevcontainerPanel()
};

const COG_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="3"/>
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
</svg>`;

// ── UI Updates ─────────────────────────────────────────────────────────────────
function updateUI(status) {
  statusDot.className = 'status-dot' + (status.isAwake ? ' active' : '');
  statusText.className = 'status-text' + (status.isAwake ? ' active' : '');
  statusText.textContent = status.isAwake ? 'Staying Awake' : 'Inactive';

  manualToggle.checked = status.manualAwake;

  if (status.isAwake) {
    const reasons = [];
    if (status.manualAwake) reasons.push('Manual mode');

    const runningAppNames = status.watchedApps
      .filter(a => status.runningWatchedApps.some(r => r.toLowerCase() === a.exe.toLowerCase()))
      .map(a => a.name);
    if (runningAppNames.length > 0) reasons.push(runningAppNames.join(', '));

    const activeIntNames = (status.watchedIntegrations || [])
      .filter(i => (status.activeIntegrations || []).includes(i.id))
      .map(i => i.name);
    if (activeIntNames.length > 0) reasons.push(activeIntNames.join(', '));

    reasonText.textContent = reasons.join(' + ') || 'Staying awake';
  } else {
    reasonText.textContent = 'Manually prevent sleep';
  }

  renderTriggerList(status);
}

function renderTriggerList(status) {
  const apps = status.watchedApps || [];
  const integrations = status.watchedIntegrations || [];
  const total = apps.length + integrations.length;

  // Remove existing items
  triggerList.querySelectorAll('.watch-item').forEach(i => i.remove());

  if (total === 0) {
    emptyMessage.style.display = 'block';
    return;
  }

  emptyMessage.style.display = 'none';

  // Render integrations first
  integrations.forEach(int => {
    const isActive = (status.activeIntegrations || []).includes(int.id);
    const el = document.createElement('div');
    el.className = 'watch-item';
    el.innerHTML = `
      <div class="watch-item-running ${isActive ? 'active' : ''}"></div>
      <div class="watch-item-info">
        <div class="watch-item-name">${escapeHtml(int.name)}</div>
        <div class="watch-item-exe">Integration</div>
      </div>
      ${INTEGRATION_SETTINGS[int.id] ? `<button class="btn-settings" title="Settings">${COG_SVG}</button>` : ''}
      <label class="switch" style="transform: scale(0.75);">
        <input type="checkbox" ${int.enabled ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
      <button class="btn-remove">&times;</button>
    `;

    el.querySelector('input[type="checkbox"]').addEventListener('change', () => {
      window.insomnia.toggleIntegration(int.id);
    });
    if (INTEGRATION_SETTINGS[int.id]) {
      el.querySelector('.btn-settings').addEventListener('click', INTEGRATION_SETTINGS[int.id]);
    }
    el.querySelector('.btn-remove').addEventListener('click', () => {
      window.insomnia.removeIntegration(int.id);
    });

    triggerList.appendChild(el);
  });

  // Render apps
  apps.forEach(app => {
    const isRunning = status.runningWatchedApps.some(r => r.toLowerCase() === app.exe.toLowerCase());
    const el = document.createElement('div');
    el.className = 'watch-item';
    el.innerHTML = `
      <div class="watch-item-running ${isRunning ? 'active' : ''}"></div>
      <div class="watch-item-info">
        <div class="watch-item-name">${escapeHtml(app.name)}</div>
        <div class="watch-item-exe">${escapeHtml(app.exe)}</div>
      </div>
      <label class="switch" style="transform: scale(0.75);">
        <input type="checkbox" ${app.enabled ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
      <button class="btn-remove">&times;</button>
    `;

    el.querySelector('input[type="checkbox"]').addEventListener('change', () => {
      window.insomnia.toggleApp(app.exe);
    });
    el.querySelector('.btn-remove').addEventListener('click', () => {
      window.insomnia.removeApp(app.exe);
    });

    triggerList.appendChild(el);
  });
}

// ── Manual Toggle ──────────────────────────────────────────────────────────────
manualToggle.addEventListener('change', () => {
  window.insomnia.toggleAwake();
});

// ── Startup Toggle ─────────────────────────────────────────────────────────────
window.insomnia.getStartup().then(val => { startupToggle.checked = val; });

startupToggle.addEventListener('change', async () => {
  const val = await window.insomnia.toggleStartup();
  startupToggle.checked = val;
});

// ── Drawer Tabs ────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab' + capitalize(tab.dataset.tab)).classList.add('active');
  });
});

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── App Drawer ─────────────────────────────────────────────────────────────────
addBtn.addEventListener('click', openDrawer);
drawerClose.addEventListener('click', closeDrawer);
drawerOverlay.addEventListener('click', (e) => {
  if (e.target === drawerOverlay) closeDrawer();
});

async function openDrawer() {
  drawerOverlay.classList.add('open');
  // Reset to Integrations tab
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('[data-tab="integrations"]').classList.add('active');
  document.getElementById('tabIntegrations').classList.add('active');

  searchInput.value = '';
  appGrid.innerHTML = '';
  drawerLoading.style.display = 'flex';

  // Load integrations
  loadIntegrations();

  // Load apps
  try {
    installedApps = await window.insomnia.getInstalledApps();
    drawerLoading.style.display = 'none';
    renderAppGrid(installedApps);
    searchInput.focus();
  } catch {
    drawerLoading.innerHTML = '<span>Failed to load apps</span>';
  }
}

function closeDrawer() {
  drawerOverlay.classList.remove('open');
}

async function loadIntegrations() {
  const integrations = await window.insomnia.getAvailableIntegrations();
  integrationList.innerHTML = '';

  integrations.forEach(int => {
    const el = document.createElement('div');
    el.className = 'integration-item' + (int.added ? ' added' : '');

    const icon = INTEGRATION_ICONS[int.id] || '\u26A1';
    const badgeClass = int.added ? 'added-badge' : (int.hookBased ? 'hook' : 'process');
    const badgeText = int.added ? 'Added' : (int.hookBased ? 'Smart' : 'Process');

    el.innerHTML = `
      <div class="integration-icon">${icon}</div>
      <div class="integration-info">
        <div class="integration-name">${escapeHtml(int.name)}</div>
        <div class="integration-desc">${escapeHtml(int.description)}</div>
      </div>
      <span class="integration-badge ${badgeClass}">${badgeText}</span>
    `;

    if (!int.added) {
      el.addEventListener('click', async () => {
        await window.insomnia.addIntegration(int.id);
        closeDrawer();
      });
    }

    integrationList.appendChild(el);
  });
}

function renderAppGrid(apps) {
  appGrid.innerHTML = '';
  apps.forEach(app => {
    const el = document.createElement('div');
    el.className = 'app-grid-item';

    const iconHtml = app.icon
      ? `<img src="${app.icon}" alt="">`
      : `<div class="app-placeholder-icon">${app.name.charAt(0).toUpperCase()}</div>`;

    const exeName = app.exeName || (app.exe ? app.exe.split('\\').pop().split('/').pop() : '');

    el.innerHTML = `
      ${iconHtml}
      <div class="app-item-info">
        <div class="app-item-name">${escapeHtml(app.name)}</div>
        <div class="app-item-exe">${escapeHtml(exeName)}</div>
      </div>
    `;

    el.addEventListener('click', async () => {
      await window.insomnia.addApp({ name: app.name, exe: app.exeName || exeName });
      closeDrawer();
    });

    appGrid.appendChild(el);
  });
}

// Search filter
searchInput.addEventListener('input', () => {
  const query = searchInput.value.toLowerCase();
  const filtered = installedApps.filter(a =>
    a.name.toLowerCase().includes(query) ||
    a.exe.toLowerCase().includes(query)
  );
  renderAppGrid(filtered);
});

// Browse manually
browseBtn.addEventListener('click', async () => {
  const result = await window.insomnia.browseExe();
  if (result) {
    await window.insomnia.addApp({ name: result.name, exe: result.exe });
    closeDrawer();
  }
});

// ── Dev Containers (Claude Code settings) ─────────────────────────────────────
const DEVCONTAINER_STATUS = {
  ok: { badge: 'hook', text: 'Set up' },
  published: { badge: 'added-badge', text: 'Published' }
};

async function openDevcontainerPanel() {
  devcontainerMessage.innerHTML = '';
  devcontainerOverlay.classList.add('open');
  renderDevcontainerProjects(await window.insomnia.getDevcontainerProjects());
}

function closeDevcontainerPanel() {
  devcontainerOverlay.classList.remove('open');
}

devcontainerClose.addEventListener('click', closeDevcontainerPanel);
devcontainerOverlay.addEventListener('click', (e) => {
  if (e.target === devcontainerOverlay) closeDevcontainerPanel();
});

devcontainerAddBtn.addEventListener('click', async () => {
  devcontainerAddBtn.disabled = true;
  try {
    showDevcontainerResult(await window.insomnia.addDevcontainerProject());
  } finally {
    devcontainerAddBtn.disabled = false;
  }
});

function showDevcontainerResult(result) {
  renderDevcontainerProjects(result.projects);
  devcontainerMessage.innerHTML = '';
  if (result.message) devcontainerMessage.append(result.message);
  for (const w of result.warnings || []) addMessageLine('warning', w);
  if (result.error) addMessageLine('error', result.error);
}

function addMessageLine(className, text) {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = text;
  devcontainerMessage.appendChild(div);
}

function renderDevcontainerProjects(projects) {
  devcontainerList.innerHTML = '';
  if (projects.length === 0) {
    devcontainerList.innerHTML = '<div class="devcontainer-empty">No projects yet.</div>';
    return;
  }

  projects.forEach(project => {
    // Outdated (older Insomnia) or missing (removed by hand): offer to redo it.
    const status = DEVCONTAINER_STATUS[project.status];
    const el = document.createElement('div');
    el.className = 'integration-item devcontainer-item';
    el.innerHTML = `
      <div class="integration-info">
        <div class="integration-name">${escapeHtml(project.name)}</div>
        <div class="integration-desc" title="${escapeHtml(project.configPath)}">${escapeHtml(project.detail)}</div>
      </div>
      ${status
        ? `<span class="integration-badge ${status.badge}">${status.text}</span>`
        : `<button class="btn-small">${project.status === 'outdated' ? 'Update' : 'Add again'}</button>`}
      <button class="btn-remove" title="Remove">&times;</button>
    `;

    if (!status) {
      el.querySelector('.btn-small').addEventListener('click', async () => {
        showDevcontainerResult(await window.insomnia.updateDevcontainerProject(project.configPath));
      });
    }
    el.querySelector('.btn-remove').addEventListener('click', async () => {
      showDevcontainerResult(await window.insomnia.removeDevcontainerProject(project.configPath));
    });

    devcontainerList.appendChild(el);
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Listen for Updates ─────────────────────────────────────────────────────────
window.insomnia.onStatusUpdate(updateUI);
window.insomnia.getStatus().then(updateUI);
