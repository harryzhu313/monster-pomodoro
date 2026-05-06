const SETTINGS_KEY = 'settings';
const DEFAULT_SETTINGS = {
  lockscreenBg: 'transparent',
  autoStartNextFocus: true,
  whiteNoiseEnabled: true,
  chimeEnabled: true,
  notificationPersistent: true,
  dailyReminderEnabled: true,
  dailyReminderTime: '21:00',
  longBreakEnabled: true,
  longBreakEvery: 4,
  longBreakMinutes: 20,
  theme: 'default'
};

const els = {
  chime: document.getElementById('chime'),
  persistent: document.getElementById('persistent'),
  dailyReminder: document.getElementById('daily-reminder'),
  dailyReminderTime: document.getElementById('daily-reminder-time'),
  longBreakEnabled: document.getElementById('long-break-enabled'),
  longBreakEvery: document.getElementById('long-break-every'),
  longBreakMinutes: document.getElementById('long-break-minutes'),
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
  historyCard: document.getElementById('history-card'),
  historyPanel: document.getElementById('history-panel'),
  historyMeta: document.getElementById('history-meta'),
  btnToggleHistory: document.getElementById('btn-toggle-history'),
  notionToken: document.getElementById('notion-token'),
  notionTaskDb: document.getElementById('notion-task-db'),
  notionDayDb: document.getElementById('notion-day-db'),
  notionStatus: document.getElementById('notion-status'),
  btnNotionTest: document.getElementById('btn-notion-test'),
  badgesCount: document.getElementById('badges-count'),
  badgesStreak: document.getElementById('badges-streak'),
  badgesSlots: document.getElementById('badges-slots'),
  heatmapGrid: document.getElementById('heatmap-grid'),
  heatmapMonths: document.getElementById('heatmap-months'),
  heatmapMeta: document.getElementById('heatmap-meta')
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
  els.dailyReminder.checked = !!settings.dailyReminderEnabled;
  els.dailyReminderTime.value = settings.dailyReminderTime || '21:00';
  els.dailyReminderTime.disabled = !settings.dailyReminderEnabled;
  els.longBreakEnabled.checked = !!settings.longBreakEnabled;
  els.longBreakEvery.value = String(normalizeLongBreakEvery(settings.longBreakEvery));
  els.longBreakEvery.disabled = !settings.longBreakEnabled;
  els.longBreakMinutes.value = String(normalizeLongBreakMinutes(settings.longBreakMinutes));
  els.longBreakMinutes.disabled = !settings.longBreakEnabled;
  els.themeSelect.value = settings.theme;
  els.bgSelect.value = settings.lockscreenBg;
  els.autoStart.checked = !!settings.autoStartNextFocus;
  els.whiteNoise.checked = !!settings.whiteNoiseEnabled;
}

function normalizeLongBreakEvery(value) {
  const n = Math.round(Number(value) || 4);
  return Math.max(2, Math.min(12, n));
}

function normalizeLongBreakMinutes(value) {
  const n = Math.round(Number(value) || 20);
  return Math.max(15, Math.min(30, n));
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
      ? `<div class="chart-rotten" title="烂番茄（放弃的专注）">🤪${rotten}</div>`
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

  // 当前连续：从今天（末尾）往回数非零天；今天若还空着则跳过，按"截至昨天"展示
  let current = 0;
  let startIdx = days.length - 1;
  if (startIdx >= 0 && days[startIdx].count === 0) startIdx--;
  for (let i = startIdx; i >= 0; i--) {
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

// —— 一年热力图 ——
// 布局：53 周 × 7 天，每列一周，从一年前的周日开始到今天。
// 颜色：0 白；1-6 浅绿；7-12 绿；13+ 深绿。
// 数据：直接读 chrome.storage.local 的 stats（SW 已保留 366 天）。

function heatmapLevel(count) {
  if (count <= 0) return 0;
  if (count <= 6) return 1;
  if (count <= 12) return 2;
  return 3;
}

function isoDateOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function refreshHeatmap() {
  const data = await chrome.storage.local.get(STATS_KEY);
  const stats = data[STATS_KEY] || {};

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 网格终点 = 本周周六（补齐当前列），起点 = 52 周前的周日
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay())); // 周六
  const start = new Date(end);
  start.setDate(start.getDate() - (53 * 7 - 1)); // 53 列 × 7 天

  const cells = [];
  const monthMarks = []; // { col, label } 每月第一列打一个月份
  let lastMonth = -1;
  let totalPomodoros = 0;
  let activeDays = 0;

  for (let col = 0; col < 53; col++) {
    for (let row = 0; row < 7; row++) {
      const d = new Date(start);
      d.setDate(start.getDate() + col * 7 + row);
      const iso = isoDateOf(d);
      const entry = stats[iso];
      const count = typeof entry === 'number'
        ? entry
        : (entry && typeof entry === 'object' ? Number(entry.completed) || 0 : 0);
      const future = d > today;
      cells.push({ col, row, date: iso, count, future });
      if (!future && count > 0) {
        totalPomodoros += count;
        activeDays += 1;
      }
    }
    // 这一列的周日作为月份判定
    const colStart = new Date(start);
    colStart.setDate(start.getDate() + col * 7);
    const m = colStart.getMonth();
    if (m !== lastMonth) {
      monthMarks.push({ col, label: `${m + 1}月` });
      lastMonth = m;
    }
  }

  // —— 渲染格子 ——
  els.heatmapGrid.innerHTML = cells.map((c) => {
    if (c.future) {
      return `<i class="heatmap-cell is-future" style="grid-column:${c.col + 1};grid-row:${c.row + 1};"></i>`;
    }
    const lv = heatmapLevel(c.count);
    const title = c.count === 0 ? `${c.date}：没有番茄` : `${c.date}：${c.count} 🍅`;
    return `<i class="heatmap-cell lv-${lv}" style="grid-column:${c.col + 1};grid-row:${c.row + 1};" title="${title}"></i>`;
  }).join('');

  // —— 渲染月份标签 ——
  els.heatmapMonths.innerHTML = monthMarks
    .map((m) => `<span style="grid-column:${m.col + 1};">${m.label}</span>`)
    .join('');

  els.heatmapMeta.textContent = `累计 ${totalPomodoros} 颗 · ${activeDays} 个活跃日`;
}

// 52 个 love monster 轮廓，对应一年 52 周里可能解锁的徽章。
// 过去 365 天内每完成一次 7 天连击，就点亮一个；超过 52 的不展示但计数保留。
const BADGES_SLOT_TOTAL = 52;
const LOVE_MONSTER_URL = '../themes/monster/love.svg';

function countUnlockedThisYear(unlockedDates) {
  if (!Array.isArray(unlockedDates)) return 0;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 365);
  const cutoffIso = isoDateOf(cutoff);
  let n = 0;
  for (const d of unlockedDates) if (d >= cutoffIso) n++;
  return n;
}

function renderBadgeSlots(unlockedThisYear) {
  const filled = Math.min(BADGES_SLOT_TOTAL, unlockedThisYear);
  const parts = [];
  for (let i = 0; i < BADGES_SLOT_TOTAL; i++) {
    const on = i < filled;
    const cls = 'badge-slot' + (on ? ' is-on' : '');
    const title = on ? `第 ${i + 1} 枚 · 已解锁` : `第 ${i + 1} 枚 · 未解锁`;
    parts.push(`<span class="${cls}" title="${title}"><img src="${LOVE_MONSTER_URL}" alt="" /></span>`);
  }
  els.badgesSlots.innerHTML = parts.join('');
}

async function refreshBadges() {
  try {
    const b = await chrome.runtime.sendMessage({ type: 'GET_BADGES' });
    if (!b || b.error) return;
    const goal = Number(b.goal) || 7;
    const cur = Math.max(0, Math.min(goal, Number(b.currentStreak) || 0));
    const unlockedThisYear = countUnlockedThisYear(b.unlockedDates);
    els.badgesCount.textContent = unlockedThisYear;
    els.badgesStreak.textContent = cur;
    renderBadgeSlots(unlockedThisYear);
  } catch (e) {
    setTimeout(refreshBadges, 200);
  }
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
els.dailyReminder.addEventListener('change', async () => {
  els.dailyReminderTime.disabled = !els.dailyReminder.checked;
  await patchSettings({ dailyReminderEnabled: els.dailyReminder.checked });
});
els.dailyReminderTime.addEventListener('change', () =>
  patchSettings({ dailyReminderTime: els.dailyReminderTime.value || '21:00' })
);
els.longBreakEnabled.addEventListener('change', async () => {
  els.longBreakEvery.disabled = !els.longBreakEnabled.checked;
  els.longBreakMinutes.disabled = !els.longBreakEnabled.checked;
  await patchSettings({ longBreakEnabled: els.longBreakEnabled.checked });
});
els.longBreakEvery.addEventListener('change', async () => {
  const value = normalizeLongBreakEvery(els.longBreakEvery.value);
  els.longBreakEvery.value = String(value);
  await patchSettings({ longBreakEvery: value });
});
els.longBreakMinutes.addEventListener('change', () =>
  patchSettings({ longBreakMinutes: normalizeLongBreakMinutes(els.longBreakMinutes.value) })
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
const HISTORY_COLLAPSED_KEY = 'historyCollapsed';

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
    ? '自动推断为完成（实际 ≥ 计划）'
    : done
    ? '已完成'
    : '未完成';
  const taskClass = 'history-task' + (done ? ' is-done' : '');
  const numsHtml = over
    ? `计划 ${planned} · 实际 <span class="used over">${used}</span>（超 ${used - planned}）`
    : `计划 ${planned} · 实际 <span class="used">${used}</span>`;
  const title = escapeHtml(task.title || '(未命名)');
  const idAttr = escapeHtml(task.id);
  // "完成"按钮仅在用户明确勾选时高亮；自动推断不高亮按钮（圆圈本身已经用虚线浅绿表达）
  const doneActive = done && !isAuto;
  const undoneActive = !done;
  const doneBtnClass = 'history-task-btn' + (doneActive ? ' is-active done' : '');
  const undoneBtnClass = 'history-task-btn' + (undoneActive ? ' is-active undone' : '');
  return `
    <div class="${taskClass}">
      <span class="${statusClass}" aria-hidden="true" title="${statusTitle}">${statusChar}</span>
      <span class="history-task-title">${title}</span>
      <span class="history-task-nums">${numsHtml}</span>
      <div class="history-task-actions">
        <button type="button" class="${doneBtnClass}"
                data-date="${date}" data-task-id="${idAttr}" data-action="done">完成</button>
        <button type="button" class="${undoneBtnClass}"
                data-date="${date}" data-task-id="${idAttr}" data-action="undone">未完成</button>
      </div>
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
  const exportLog = exportLogCache[date];
  const exportedClass = exportLog && exportLog.ok ? ' is-exported' : '';
  const exportLabel = exportLog && exportLog.ok
    ? `已导入 ${exportLog.created}`
    : '导入到 Notion';
  const exportBtnHtml = taskCount > 0
    ? `<button type="button" class="history-day-export${exportedClass}" data-date="${date}">${exportLabel}</button>`
    : '';
  return `
    <div class="${dayClass}" data-date="${date}">
      <div class="history-day-header">
        <div class="history-day-date">${date}${todayTag}</div>
        <div class="history-day-summary">
          <span>${doneCount}/${taskCount} 完成</span>
          <span class="sep">·</span>
          <span>计划 ${plannedTotal} · 实际 <span class="${overMark}">${usedTotal}</span></span>
          ${exportBtnHtml}
        </div>
      </div>
      <div class="history-day-body">
        ${tasksHtml}
        ${extraHtml}
      </div>
    </div>
  `;
}

let exportLogCache = {};

async function refreshHistory() {
  const data = await chrome.storage.local.get([TASKS_KEY, ARCHIVE_KEY, STATS_KEY, 'notionExportLog']);
  exportLogCache = data.notionExportLog || {};
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

function setHistoryCollapsed(collapsed) {
  els.historyCard.classList.toggle('is-collapsed', collapsed);
  els.historyPanel.hidden = collapsed;
  els.btnToggleHistory.textContent = collapsed ? '展开' : '收起';
  els.btnToggleHistory.setAttribute('aria-expanded', String(!collapsed));
  localStorage.setItem(HISTORY_COLLAPSED_KEY, collapsed ? '1' : '0');
}

async function setTaskDone(date, taskId, done) {
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

  // 同步 done 与 doneOverride：前者驱动 popup 勾选框，后者压制"自动推断完成"
  task.done = !!done;
  task.doneOverride = !!done;
  if (done) task.isCurrent = false;

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

async function exportDayToNotion(date, btn) {
  if (!btn || btn.disabled) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '导入中…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'NOTION_EXPORT_DAY', date });
    if (!result || result.error) {
      alert(`导入失败：${result?.error || '未知错误'}`);
      btn.disabled = false;
      btn.textContent = originalText;
      return;
    }
    const rowMsg = `创建 ${result.created || 0} / 更新 ${result.updated || 0} / 总计 ${result.total || 0} 行`;
    const linkMsg = result.dayPageLinked ? '· 已关联所属日' : '· 未关联所属日（日页面 DB ID 未配置或当天页面不存在）';
    const duplicateMsg = result.existingDuplicates > 0
      ? `\nNotion 中已有 ${result.existingDuplicates} 条同日同名重复行，本次只更新每组第一条。`
      : '';
    if (result.ok) {
      alert(`导入成功：${rowMsg} ${linkMsg}${duplicateMsg}`);
    } else if ((result.created || 0) + (result.updated || 0) > 0) {
      const firstErr = result.errors?.[0];
      const errMsg = firstErr ? `\n首个错误：${firstErr.task} - ${firstErr.error}` : '';
      alert(`部分成功：${rowMsg}（失败 ${result.failed || 0}） ${linkMsg}${duplicateMsg}${errMsg}`);
    } else {
      const firstErr = result.errors?.[0];
      alert(`导入失败：${firstErr ? firstErr.task + ' - ' + firstErr.error : '全部失败'}`);
    }
    await refreshHistory();
  } catch (e) {
    alert('导入失败：' + String(e.message || e));
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

els.historyList.addEventListener('click', (e) => {
  const exportBtn = e.target.closest('.history-day-export');
  if (exportBtn) {
    e.stopPropagation();
    const { date } = exportBtn.dataset;
    if (date) exportDayToNotion(date, exportBtn);
    return;
  }
  const btn = e.target.closest('.history-task-btn');
  if (btn) {
    e.stopPropagation();
    const { date, taskId, action } = btn.dataset;
    if (date && taskId && action) setTaskDone(date, taskId, action === 'done');
    return;
  }
  const header = e.target.closest('.history-day-header');
  if (!header) return;
  const day = header.parentElement;
  if (day) day.classList.toggle('is-open');
});

els.btnToggleHistory.addEventListener('click', () => {
  setHistoryCollapsed(!els.historyCard.classList.contains('is-collapsed'));
});

// —— Notion 配置：加载、保存（失焦/回车）、测试 ——

async function loadNotionConfig() {
  const cfg = await chrome.runtime.sendMessage({ type: 'GET_NOTION_CONFIG' });
  if (!cfg || cfg.error) return;
  els.notionToken.value = cfg.token || '';
  els.notionTaskDb.value = cfg.taskDbId || '';
  els.notionDayDb.value = cfg.dayDbId || '';
}

async function saveNotionConfig() {
  await chrome.runtime.sendMessage({
    type: 'SET_NOTION_CONFIG',
    patch: {
      token: els.notionToken.value.trim(),
      taskDbId: els.notionTaskDb.value.trim(),
      dayDbId: els.notionDayDb.value.trim()
    }
  });
}

function setNotionStatus(kind, text) {
  els.notionStatus.className = 'notion-status is-' + kind;
  els.notionStatus.textContent = text;
}

async function testNotionConnection() {
  await saveNotionConfig();
  setNotionStatus('loading', '正在连接 Notion…');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'NOTION_TEST' });
    if (r && r.ok) setNotionStatus('ok', '✓ ' + r.message);
    else setNotionStatus('error', '✗ ' + (r?.error || '未知错误'));
  } catch (e) {
    setNotionStatus('error', '✗ ' + String(e.message || e));
  }
}

for (const el of [els.notionToken, els.notionTaskDb, els.notionDayDb]) {
  el.addEventListener('blur', saveNotionConfig);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.blur();
  });
}
els.btnNotionTest.addEventListener('click', testNotionConnection);

// 如果番茄在别处完成（锁屏里的延长等也会触发 stats 变化），实时刷新图表
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.stats) {
    refreshStats();
    refreshHeatmap();
  }
  if (changes[TASKS_KEY] || changes[ARCHIVE_KEY] || changes.stats || changes.notionExportLog) refreshHistory();
  if (changes.badgesState) refreshBadges();
});

(async () => {
  renderSettings(await loadSettings());
  setHistoryCollapsed(localStorage.getItem(HISTORY_COLLAPSED_KEY) !== '0');
  await loadNotionConfig();
  await refreshHeatmap();
  await refreshStats();
  await refreshBadges();
  await refreshHistory();
})();
