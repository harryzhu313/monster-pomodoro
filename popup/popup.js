// Popup：渲染 + 把按钮点击翻译成 message。
// 状态/统计的真相在 Service Worker + chrome.storage。
// 今日任务走 chrome.storage.local 直接读写（SW 只在专注完成时 used++）。

const FOCUS_MS = 25 * 60 * 1000;
const STORAGE_QUOTA_KEY = 'quotaState';
const SETTINGS_KEY = 'settings';
const TASKS_KEY = 'tasksToday';
const ARCHIVE_KEY = 'tasksArchive';

const DEFAULT_SETTINGS = {
  lockscreenBg: 'transparent',
  autoStartNextFocus: true,
  whiteNoiseEnabled: true,
  chimeEnabled: true,
  theme: 'default'
};

const MAX_HARVEST_ICONS = 12;       // 今日收获超过就用 +N 折叠
const MAX_TOMATO_ICONS = 8;         // 单任务计划超过就用 +N 折叠

const MONSTER_BY_STATE = {
  IDLE:     'happy',
  FOCUSING: 'calm',
  BREAKING: 'angry',
  PAUSED:   'calm'
};

const els = {
  phaseLabel: document.getElementById('phase-label'),
  timer: document.getElementById('timer'),
  btnPrimary: document.getElementById('btn-primary'),
  btnAbandon: document.getElementById('btn-abandon'),
  btnReset: document.getElementById('btn-reset'),
  quota: document.getElementById('quota'),
  hint: document.getElementById('hint'),
  btnOptions: document.getElementById('btn-options'),
  btnFloat: document.getElementById('btn-float'),
  monster: document.getElementById('monster'),

  harvestIcons: document.getElementById('harvest-icons'),
  streak: document.getElementById('streak'),

  tasksCount: document.getElementById('tasks-count'),
  taskAddForm: document.getElementById('task-add-form'),
  taskInput: document.getElementById('task-input'),
  taskCategorySelect: document.getElementById('task-category'),
  taskPlannedInput: document.getElementById('task-planned'),
  taskList: document.getElementById('task-list'),
  taskEmpty: document.getElementById('task-empty')
};

let currentTheme = 'default';
let currentState = null;
let currentQuota = null;
let currentTasks = [];
let tickHandle = null;

// —— 通用 ——

function formatMs(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function computeRemaining(state) {
  if (!state) return FOCUS_MS;
  if (state.state === 'FOCUSING' || state.state === 'BREAKING') {
    return Math.max(0, state.endTime - Date.now());
  }
  if (state.state === 'PAUSED') {
    return state.pausedRemaining ?? 0;
  }
  return FOCUS_MS;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// —— 主题 ——

function renderMonster() {
  if (currentTheme !== 'monster' || !currentState) {
    els.monster.removeAttribute('src');
    return;
  }
  const kind = MONSTER_BY_STATE[currentState.state] || 'happy';
  els.monster.src = chrome.runtime.getURL(`themes/monster/${kind}.svg`);
}

function applyTheme(theme) {
  currentTheme = theme;
  document.body.classList.toggle('theme-monster', theme === 'monster');
  renderMonster();
}

// —— 计时器 + 配额 ——

function renderQuota() {
  if (!currentQuota) {
    els.quota.textContent = '今日剩 -/-';
    return;
  }
  const { remaining, limit } = currentQuota;
  els.quota.textContent = `今日剩 ${remaining}/${limit}`;
  els.quota.classList.toggle('exhausted', remaining <= 0);
}

function renderTimer() {
  if (!currentState) return;
  const { state, phase } = currentState;

  els.timer.textContent = formatMs(computeRemaining(currentState));
  els.phaseLabel.className = 'phase-label';

  const isBreakPhase = state === 'BREAKING' || (state === 'PAUSED' && phase === 'break');

  if (state === 'IDLE') {
    els.phaseLabel.textContent = '准备开始';
    els.btnPrimary.textContent = '开始专注';
    els.btnPrimary.dataset.action = 'start';
    els.btnAbandon.disabled = true;
    els.hint.textContent = '按时停下来，比多做一轮重要。';
  } else if (state === 'FOCUSING') {
    els.phaseLabel.textContent = '专注中';
    els.phaseLabel.classList.add('focusing');
    els.btnPrimary.textContent = '暂停';
    els.btnPrimary.dataset.action = 'pause';
    els.btnAbandon.disabled = false;
    const inGrace = currentState.focusStartedAt
      && (Date.now() - currentState.focusStartedAt) < 10 * 1000;
    els.hint.textContent = inGrace
      ? '前 10 秒可反悔：放弃不计入烂番茄。'
      : '一次只做一件事。';
  } else if (state === 'BREAKING') {
    els.phaseLabel.textContent = '休息中';
    els.phaseLabel.classList.add('breaking');
    els.btnPrimary.textContent = '暂停';
    els.btnPrimary.dataset.action = 'pause';
    els.btnAbandon.disabled = true;
    els.hint.textContent = '切到任意网页，在锁屏上加时或等休息结束。';
  } else if (state === 'PAUSED') {
    els.phaseLabel.textContent = phase === 'focus' ? '专注已暂停' : '休息已暂停';
    els.phaseLabel.classList.add('paused');
    els.btnPrimary.textContent = '继续';
    els.btnPrimary.dataset.action = 'resume';
    els.btnAbandon.disabled = isBreakPhase;
    els.hint.textContent = '暂停时间不计入计时。';
  }

  renderQuota();
  renderMonster();
}

// —— 今日收获 + 连续天数 ——

function renderHarvestAndStreak(days) {
  const todayEntry = days[days.length - 1] || {};
  const completed = todayEntry.completed ?? todayEntry.count ?? 0;
  const rotten = todayEntry.rotten || 0;

  els.harvestIcons.innerHTML = '';
  if (completed === 0 && rotten === 0) {
    const empty = document.createElement('span');
    empty.className = 'harvest-empty';
    empty.textContent = '还没收获，先来一个吧。';
    els.harvestIcons.appendChild(empty);
  } else {
    const showCompleted = Math.min(completed, MAX_HARVEST_ICONS);
    for (let i = 0; i < showCompleted; i++) {
      const span = document.createElement('span');
      span.textContent = '🍅';
      els.harvestIcons.appendChild(span);
    }
    if (completed > MAX_HARVEST_ICONS) {
      const more = document.createElement('span');
      more.className = 'harvest-empty';
      more.style.marginLeft = '4px';
      more.textContent = `+${completed - MAX_HARVEST_ICONS}`;
      els.harvestIcons.appendChild(more);
    }
    if (rotten > 0) {
      const showRotten = Math.min(rotten, MAX_HARVEST_ICONS);
      for (let i = 0; i < showRotten; i++) {
        const span = document.createElement('span');
        span.className = 'rotten';
        span.title = '烂番茄（放弃的专注）';
        span.textContent = '🍅';
        els.harvestIcons.appendChild(span);
      }
      if (rotten > MAX_HARVEST_ICONS) {
        const more = document.createElement('span');
        more.className = 'harvest-empty';
        more.style.marginLeft = '4px';
        more.textContent = `+${rotten - MAX_HARVEST_ICONS}`;
        els.harvestIcons.appendChild(more);
      }
    }
  }

  // 连续天数只算"有完成"的天，放弃不维持连击
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const c = days[i].completed ?? days[i].count ?? 0;
    if (c > 0) current++;
    else break;
  }
  els.streak.textContent = `🔥 已连续 ${current} 天`;
}

async function refreshStats() {
  try {
    const days = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
    if (!days || days.error) return;
    renderHarvestAndStreak(days);
  } catch (e) {
    setTimeout(refreshStats, 200);
  }
}

// —— 今日任务 ——

function makeId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

async function loadTasks() {
  const today = todayStr();
  const data = await chrome.storage.local.get([TASKS_KEY, ARCHIVE_KEY]);
  const stored = data[TASKS_KEY];
  if (stored && stored.date === today) {
    return stored.tasks || [];
  }
  // 跨天：归档旧的 → 重置今日
  if (stored && Array.isArray(stored.tasks) && stored.tasks.length > 0) {
    const archive = data[ARCHIVE_KEY] || {};
    archive[stored.date] = stored.tasks;
    await chrome.storage.local.set({ [ARCHIVE_KEY]: archive });
  }
  await chrome.storage.local.set({ [TASKS_KEY]: { date: today, tasks: [] } });
  return [];
}

async function saveTasks(tasks) {
  await chrome.storage.local.set({
    [TASKS_KEY]: { date: todayStr(), tasks }
  });
}

function renderTaskTomatoes(task) {
  const wrap = document.createElement('div');
  wrap.className = 'task-tomatoes';
  const plannedDisplay = Math.min(task.planned, MAX_TOMATO_ICONS);
  for (let i = 0; i < plannedDisplay; i++) {
    const s = document.createElement('span');
    s.className = 'tomato' + (i < task.used ? ' used' : '');
    s.textContent = '🍅';
    wrap.appendChild(s);
  }
  if (task.planned > MAX_TOMATO_ICONS) {
    const more = document.createElement('span');
    more.className = 'tomato overflow';
    more.textContent = `+${task.planned - MAX_TOMATO_ICONS}`;
    wrap.appendChild(more);
  }
  // 实际使用超出计划：追加「+N」提示
  if (task.used > task.planned) {
    const over = document.createElement('span');
    over.className = 'tomato overflow';
    over.textContent = `超${task.used - task.planned}`;
    wrap.appendChild(over);
  }
  return wrap;
}

function renderTasks() {
  const tasks = currentTasks;
  els.taskList.innerHTML = '';

  const done = tasks.filter((t) => t.done).length;
  els.tasksCount.textContent = `${done} 个完成`;
  els.taskEmpty.classList.toggle('is-hidden', tasks.length > 0);

  for (const t of tasks) {
    const li = document.createElement('li');
    li.className = 'task-item';
    if (t.isCurrent && !t.done) li.classList.add('is-current');
    if (t.done) li.classList.add('is-done');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'task-checkbox';
    cb.checked = !!t.done;
    cb.addEventListener('change', () => toggleTaskDone(t.id, cb.checked));

    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = t.title;

    const cat = normalizeCategory(t.category);
    const badge = document.createElement('span');
    const catClass =
      cat === '工作' ? 'cat-work' :
      cat === '学习' ? 'cat-study' :
      cat === '生活' ? 'cat-life' :
      'cat-hobby';
    badge.className = `task-category-badge ${catClass}`;
    badge.textContent = cat;
    title.appendChild(badge);

    const tomatoes = renderTaskTomatoes(t);

    const current = document.createElement('button');
    current.type = 'button';
    current.className = 'task-btn-current';
    current.textContent = t.isCurrent && !t.done ? '当前任务' : '设为当前';
    current.disabled = !!t.done;
    if (!(t.isCurrent && !t.done)) {
      current.addEventListener('click', () => setCurrentTask(t.id));
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-btn-del';
    del.textContent = '×';
    del.title = '删除';
    del.addEventListener('click', () => deleteTask(t.id));

    li.append(cb, title, tomatoes, current, del);
    els.taskList.appendChild(li);
  }
}

const CATEGORY_VALUES = ['工作', '学习', '生活', '兴趣爱好'];
const CATEGORY_DEFAULT = '工作';
const LAST_CATEGORY_KEY = 'lastTaskCategory';

function normalizeCategory(c) {
  return CATEGORY_VALUES.includes(c) ? c : CATEGORY_DEFAULT;
}

async function addTask(title, planned, category) {
  const trimmed = title.trim();
  if (!trimmed) return;
  const safePlanned = Math.max(1, Math.min(20, Math.floor(Number(planned) || 1)));
  const safeCategory = normalizeCategory(category);
  const task = {
    id: makeId(),
    title: trimmed,
    category: safeCategory,
    planned: safePlanned,
    used: 0,
    done: false,
    isCurrent: currentTasks.every((t) => !t.isCurrent || t.done)
  };
  currentTasks = [...currentTasks, task];
  await saveTasks(currentTasks);
  await chrome.storage.local.set({ [LAST_CATEGORY_KEY]: safeCategory });
  renderTasks();
}

async function toggleTaskDone(id, done) {
  // 同步 doneOverride，保证设置页历史明细里的圆圈状态与此处一致：
  // 勾选 -> 实心绿圆；取消勾选 -> 空心红边（压制"自动推断完成"）
  currentTasks = currentTasks.map((t) => {
    if (t.id !== id) return t;
    return { ...t, done, doneOverride: done, isCurrent: done ? false : t.isCurrent };
  });
  await saveTasks(currentTasks);
  renderTasks();
}

async function setCurrentTask(id) {
  currentTasks = currentTasks.map((t) => ({
    ...t,
    isCurrent: t.id === id && !t.done
  }));
  await saveTasks(currentTasks);
  renderTasks();
}

async function deleteTask(id) {
  currentTasks = currentTasks.filter((t) => t.id !== id);
  await saveTasks(currentTasks);
  renderTasks();
}

// —— Service Worker 通信 ——

async function send(type) {
  try {
    const next = await chrome.runtime.sendMessage({ type });
    if (next && !next.error) {
      currentState = next;
      renderTimer();
    }
  } catch (e) {
    console.error('send failed', type, e);
  }
}

async function refresh() {
  try {
    const [state, quota] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_STATE' }),
      chrome.runtime.sendMessage({ type: 'GET_QUOTA' })
    ]);
    currentState = state;
    currentQuota = quota;
    renderTimer();
  } catch (e) {
    setTimeout(refresh, 100);
  }
}

function startTicking() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(() => {
    if (!currentState) return;
    if (currentState.state === 'FOCUSING' || currentState.state === 'BREAKING') {
      els.timer.textContent = formatMs(computeRemaining(currentState));
    }
    // 缓冲期 hint 在 10 秒后过期，靠 tick 自然刷新文案。
    if (currentState.state === 'FOCUSING' && currentState.focusStartedAt) {
      const inGrace = (Date.now() - currentState.focusStartedAt) < 10 * 1000;
      els.hint.textContent = inGrace
        ? '前 10 秒可反悔：放弃不计入烂番茄。'
        : '一次只做一件事。';
    }
  }, 250);
}

// —— 事件绑定 ——

els.btnPrimary.addEventListener('click', () => {
  const action = els.btnPrimary.dataset.action;
  const map = { start: 'START', pause: 'PAUSE', resume: 'RESUME' };
  if (map[action]) send(map[action]);
});

els.btnAbandon.addEventListener('click', () => send('ABANDON'));
els.btnReset.addEventListener('click', () => send('RESET'));

els.btnOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

// —— 悬浮小窗：单例，重复点击聚焦已有窗口 ——
const FLOAT_WINDOW_KEY = 'floatWindowId';

els.btnFloat.addEventListener('click', async () => {
  const data = await chrome.storage.local.get(FLOAT_WINDOW_KEY);
  const existing = data[FLOAT_WINDOW_KEY];
  if (existing != null) {
    try {
      await chrome.windows.update(existing, { focused: true, drawAttention: true });
      return;
    } catch {
      // 窗口已被关闭，继续创建新的
    }
  }
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL('float/float.html'),
    type: 'popup',
    width: 240,
    height: 160,
    focused: true
  });
  await chrome.storage.local.set({ [FLOAT_WINDOW_KEY]: w.id });
});

els.taskAddForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = els.taskInput.value;
  const planned = els.taskPlannedInput.value;
  const category = els.taskCategorySelect.value;
  if (!title.trim()) return;
  addTask(title, planned, category);
  els.taskInput.value = '';
  els.taskPlannedInput.value = '1';
  // 分类保持不变，方便连续添加同类任务
  els.taskInput.focus();
});

els.quota.addEventListener('dblclick', async () => {
  try {
    const q = await chrome.runtime.sendMessage({ type: 'RESET_QUOTA' });
    if (q) {
      currentQuota = q;
      renderQuota();
      els.hint.textContent = '今日配额已重置。';
    }
  } catch (e) {
    console.error('reset quota failed', e);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'STATE_UPDATE') {
    currentState = msg.state;
    renderTimer();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_QUOTA_KEY]) {
    chrome.runtime.sendMessage({ type: 'GET_QUOTA' }).then((q) => {
      currentQuota = q;
      renderQuota();
    }).catch(() => {});
  }
  if (changes[SETTINGS_KEY]) {
    const next = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
    applyTheme(next.theme);
  }
  if (changes[TASKS_KEY]) {
    // SW 在专注完成时给 used++，popup 如果开着需要实时刷新
    const stored = changes[TASKS_KEY].newValue;
    if (stored && stored.date === todayStr()) {
      currentTasks = stored.tasks || [];
      renderTasks();
    }
  }
  if (changes.stats) {
    refreshStats();
  }
});

// —— 启动 ——

(async () => {
  const data = await chrome.storage.local.get([SETTINGS_KEY, LAST_CATEGORY_KEY]);
  const settings = { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
  applyTheme(settings.theme);

  els.taskCategorySelect.value = normalizeCategory(data[LAST_CATEGORY_KEY]);

  currentTasks = await loadTasks();
  renderTasks();

  await refreshStats();
})();

refresh();
startTicking();
