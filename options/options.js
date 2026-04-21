const SETTINGS_KEY = 'settings';
const DEFAULT_SETTINGS = {
  lockscreenBg: 'transparent',
  autoStartNextFocus: true,
  whiteNoiseEnabled: true,
  chimeEnabled: true,
  notificationPersistent: true,
  theme: 'default'
};

const els = {
  chime: document.getElementById('chime'),
  persistent: document.getElementById('persistent'),
  themeSelect: document.getElementById('theme-select'),
  bgSelect: document.getElementById('bg-select'),
  autoStart: document.getElementById('auto-start'),
  whiteNoise: document.getElementById('white-noise'),
  chart: document.getElementById('chart'),
  statCurrent: document.getElementById('stat-current'),
  statLongest: document.getElementById('stat-longest'),
  statTotal: document.getElementById('stat-total'),
  btnClearToday: document.getElementById('btn-clear-today'),
  btnOpenBgSettings: document.getElementById('btn-open-bg-settings')
};

async function loadSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
}

async function patchSettings(patch) {
  const settings = await loadSettings();
  await chrome.storage.local.set({
    [SETTINGS_KEY]: { ...settings, ...patch }
  });
}

function renderSettings(settings) {
  els.chime.checked = !!settings.chimeEnabled;
  els.persistent.checked = !!settings.notificationPersistent;
  els.themeSelect.value = settings.theme;
  els.bgSelect.value = settings.lockscreenBg;
  els.autoStart.checked = !!settings.autoStartNextFocus;
  els.whiteNoise.checked = !!settings.whiteNoiseEnabled;
}

// —— 柱状图 + 连续/累计 ——

function formatDateLabel(isoDate) {
  // '2026-04-20' -> '04-20'
  return isoDate.slice(5);
}

function renderChart(days) {
  const max = Math.max(1, ...days.map((d) => d.count));
  els.chart.innerHTML = '';
  days.forEach((d, idx) => {
    const isToday = idx === days.length - 1;
    const heightPct = (d.count / max) * 100;
    const bar = document.createElement('div');
    bar.className = 'chart-day' + (isToday ? ' is-today' : '');
    bar.innerHTML = `
      <div class="chart-count">${d.count}</div>
      <div class="chart-bar-wrap">
        <div class="chart-bar ${d.count > 0 ? 'has-data' : ''} ${isToday ? 'today' : ''}"
             style="height: ${heightPct}%"></div>
      </div>
      <div class="chart-date">${formatDateLabel(d.date)}</div>
    `;
    els.chart.appendChild(bar);
  });
}

function computeStreaks(days) {
  const total = days.reduce((s, d) => s + d.count, 0);

  // 当前连续：从今天（末尾）往回数非零天
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].count > 0) current++;
    else break;
  }

  // 最长连续：7 天窗口内最长非零段
  let longest = 0;
  let run = 0;
  for (const d of days) {
    if (d.count > 0) {
      run++;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }

  return { current, longest, total };
}

async function refreshStats() {
  try {
    const days = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
    if (!days || days.error) return;
    renderChart(days);
    const { current, longest, total } = computeStreaks(days);
    els.statCurrent.textContent = current;
    els.statLongest.textContent = longest;
    els.statTotal.textContent = total;
  } catch (e) {
    // Service Worker 可能刚被唤醒，重试一次
    setTimeout(refreshStats, 200);
  }
}

// —— 事件绑定 ——

els.chime.addEventListener('change', () =>
  patchSettings({ chimeEnabled: els.chime.checked })
);
els.persistent.addEventListener('change', () =>
  patchSettings({ notificationPersistent: els.persistent.checked })
);
els.themeSelect.addEventListener('change', () =>
  patchSettings({ theme: els.themeSelect.value })
);
els.bgSelect.addEventListener('change', () =>
  patchSettings({ lockscreenBg: els.bgSelect.value })
);
els.autoStart.addEventListener('change', () =>
  patchSettings({ autoStartNextFocus: els.autoStart.checked })
);
els.whiteNoise.addEventListener('change', () =>
  patchSettings({ whiteNoiseEnabled: els.whiteNoise.checked })
);

els.btnOpenBgSettings.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://settings/system' });
});

// —— 清零今日（两步确认，防误触）——

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let clearConfirmTimer = null;

async function performClearToday() {
  const data = await chrome.storage.local.get('stats');
  const stats = data.stats || {};
  delete stats[todayStr()];
  await chrome.storage.local.set({ stats });
  await refreshStats();
}

els.btnClearToday.addEventListener('click', async () => {
  if (els.btnClearToday.classList.contains('confirming')) {
    clearTimeout(clearConfirmTimer);
    els.btnClearToday.classList.remove('confirming');
    els.btnClearToday.textContent = '清零今日';
    await performClearToday();
    return;
  }
  els.btnClearToday.classList.add('confirming');
  els.btnClearToday.textContent = '再点一次确认';
  clearConfirmTimer = setTimeout(() => {
    els.btnClearToday.classList.remove('confirming');
    els.btnClearToday.textContent = '清零今日';
  }, 3000);
});

// 如果番茄在别处完成（锁屏里的延长等也会触发 stats 变化），实时刷新图表
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.stats) refreshStats();
});

(async () => {
  renderSettings(await loadSettings());
  await refreshStats();
})();
