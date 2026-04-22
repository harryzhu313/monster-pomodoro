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
  btnOpenBgSettings: document.getElementById('btn-open-bg-settings'),
  historyList: document.getElementById('history-list'),
  historyMeta: document.getElementById('history-meta')
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
    const rotten = d.rotten || 0;
    const rottenHtml = rotten > 0
      ? `<div class="chart-rotten" title="烂番茄（放弃的专注）">🥀${rotten}</div>`
      : '';
    const bar = document.createElement('div');
    bar.className = 'chart-day' + (isToday ? ' is-today' : '');
    bar.innerHTML = `
      <div class="chart-count">${d.count}</div>
      <div class="chart-bar-wrap">
        <div class="chart-bar ${d.count > 0 ? 'has-data' : ''} ${isToday ? 'today' : ''}"
             style="height: ${heightPct}%"></div>
      </div>
      <div class="chart-date">${formatDateLabel(d.date)}</div>
      ${rottenHtml}
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

// —— 历史明细 ——

const TASKS_KEY = 'tasksToday';
const ARCHIVE_KEY = 'tasksArchive';
const STATS_KEY = 'stats';
const HISTORY_MAX_DAYS = 30;

// stats[date] 可能是旧的数字格式或新的 {completed, rotten} 对象
function statsCompletedCount(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') return Number(v.completed) || 0;
  return 0;
}

function sumUsed(tasks) {
  return tasks.reduce((s, t) => s + (t.used || 0), 0);
}

function sumPlanned(tasks) {
  return tasks.reduce((s, t) => s + (t.planned || 0), 0);
}

function countDone(tasks) {
  return tasks.filter((t) => effectiveDoneState(t).done).length;
}

// 完成状态：doneOverride（history 手动点击）> done（popup 勾选）> 自动推断（used>=planned）
function effectiveDoneState(task) {
  const planned = Number(task.planned) || 0;
  const used = Number(task.used) || 0;
  if (typeof task.doneOverride === 'boolean') {
    return { done: task.doneOverride, isAuto: false, isManual: true };
  }
  if (task.done === true) {
    return { done: true, isAuto: false, isManual: true };
  }
  if (planned > 0 && used >= planned) {
    return { done: true, isAuto: true, isManual: false };
  }
  return { done: false, isAuto: false, isManual: false };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderHistoryTask(task, date) {
  const planned = Number(task.planned) || 0;
  const used = Number(task.used) || 0;
  const over = used > planned;
  const { done, isAuto } = effectiveDoneState(task);
  const statusClass =
    'history-task-status ' +
    (done ? 'done' : 'undone') +
    (isAuto ? ' is-auto' : '');
  const statusChar = done ? '✓' : '✗';
  const statusTitle = isAuto
    ? '自动推断为完成（实际 ≥ 计划）。点击切换为未完成。'
    : done
    ? '已完成。点击切换为未完成。'
    : '未完成。点击标记为已完成。';
  const taskClass = 'history-task' + (done ? ' is-done' : '');
  const numsHtml = over
    ? `计划 ${planned} · 实际 <span class="used over">${used}</span>（超 ${used - planned}）`
    : `计划 ${planned} · 实际 <span class="used">${used}</span>`;
  const title = escapeHtml(task.title || '(未命名)');
  return `
    <div class="${taskClass}">
      <span class="${statusClass}" role="button" tabindex="0"
            data-date="${date}" data-task-id="${escapeHtml(task.id)}"
            title="${statusTitle}">${statusChar}</span>
      <span class="history-task-title">${title}</span>
      <span class="history-task-nums">${numsHtml}</span>
    </div>
  `;
}

function renderHistoryDay(date, tasks, totalToday, isToday) {
  const plannedTotal = sumPlanned(tasks);
  const usedTotal = sumUsed(tasks);
  const doneCount = countDone(tasks);
  const taskCount = tasks.length;
  const extra = Math.max(0, (totalToday || 0) - usedTotal);
  const dayClass = 'history-day' + (isToday ? ' is-open' : '');
  const todayTag = isToday ? '<span class="today-tag">今天</span>' : '';
  const overMark = usedTotal > plannedTotal ? ' overflow' : '';
  const tasksHtml = tasks.length
    ? tasks.map((t) => renderHistoryTask(t, date)).join('')
    : '<div class="history-empty" style="padding:6px 0;">这一天没有记录任务。</div>';
  const extraHtml = extra > 0
    ? `<div class="history-extra">计划外番茄 ${extra} 个（未归到任何任务）</div>`
    : '';
  return `
    <div class="${dayClass}" data-date="${date}">
      <div class="history-day-header">
        <div class="history-day-date">${date}${todayTag}</div>
        <div class="history-day-summary">
          <span>${doneCount}/${taskCount} 完成</span>
          <span class="sep">·</span>
          <span>计划 ${plannedTotal} · 实际 <span class="${overMark}">${usedTotal}</span></span>
        </div>
      </div>
      <div class="history-day-body">
        ${tasksHtml}
        ${extraHtml}
      </div>
    </div>
  `;
}

async function refreshHistory() {
  const data = await chrome.storage.local.get([TASKS_KEY, ARCHIVE_KEY, STATS_KEY]);
  const today = todayStr();
  const todayStored = data[TASKS_KEY];
  const archive = data[ARCHIVE_KEY] || {};
  const stats = data[STATS_KEY] || {};

  const byDate = { ...archive };
  if (todayStored && todayStored.date === today) {
    byDate[today] = todayStored.tasks || [];
  } else if (!byDate[today]) {
    byDate[today] = [];
  }

  const dates = Object.keys(byDate).sort().reverse().slice(0, HISTORY_MAX_DAYS);

  if (dates.length === 0 || dates.every((d) => (byDate[d] || []).length === 0 && !stats[d])) {
    els.historyList.innerHTML = '<div class="history-empty">还没有数据，规划一下今天的三件事，开始第一个番茄吧。</div>';
    els.historyMeta.textContent = '';
    return;
  }

  els.historyMeta.textContent = `共 ${dates.length} 天`;
  els.historyList.innerHTML = dates
    .map((d) => renderHistoryDay(d, byDate[d] || [], statsCompletedCount(stats[d]), d === today))
    .join('');
}

async function toggleTaskDone(date, taskId) {
  const data = await chrome.storage.local.get([TASKS_KEY, ARCHIVE_KEY]);
  const today = todayStr();
  let writeToday = false;
  let writeArchive = false;
  let tasks = null;

  if (date === today && data[TASKS_KEY] && data[TASKS_KEY].date === today) {
    tasks = data[TASKS_KEY].tasks || [];
    writeToday = true;
  } else {
    const archive = data[ARCHIVE_KEY] || {};
    if (archive[date]) {
      tasks = archive[date];
      writeArchive = true;
    }
  }
  if (!tasks) return;

  const task = tasks.find((t) => String(t.id) === String(taskId));
  if (!task) return;

  const current = effectiveDoneState(task).done;
  task.doneOverride = !current;

  if (writeToday) {
    await chrome.storage.local.set({
      [TASKS_KEY]: { date: today, tasks }
    });
  } else if (writeArchive) {
    const archive = data[ARCHIVE_KEY] || {};
    archive[date] = tasks;
    await chrome.storage.local.set({ [ARCHIVE_KEY]: archive });
  }
}

els.historyList.addEventListener('click', (e) => {
  const status = e.target.closest('.history-task-status');
  if (status) {
    e.stopPropagation();
    const { date, taskId } = status.dataset;
    if (date && taskId) toggleTaskDone(date, taskId);
    return;
  }
  const header = e.target.closest('.history-day-header');
  if (!header) return;
  const day = header.parentElement;
  if (day) day.classList.toggle('is-open');
});

els.historyList.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const status = e.target.closest('.history-task-status');
  if (!status) return;
  e.preventDefault();
  const { date, taskId } = status.dataset;
  if (date && taskId) toggleTaskDone(date, taskId);
});

// 如果番茄在别处完成（锁屏里的延长等也会触发 stats 变化），实时刷新图表
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.stats) refreshStats();
  if (changes[TASKS_KEY] || changes[ARCHIVE_KEY] || changes.stats) refreshHistory();
});

(async () => {
  renderSettings(await loadSettings());
  await refreshStats();
  await refreshHistory();
})();
