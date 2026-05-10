// 番茄钟核心计时逻辑。
// 关键原则：
// 1. 状态是唯一事实来源，全部持久化到 chrome.storage.local。
//    Service Worker 随时会被 Chrome 休眠，不能依赖内存变量。
// 2. 计时靠 chrome.alarms + endTime 时间戳，不用 setInterval。
// 3. Popup 通过 sendMessage 查询/指挥，不直接读写状态。

// ⚠️ 测试模式：专注 15 秒 / 休息 30 秒（加时时长由锁屏传入，此处不写死）
// 正式发布前改回 25 分钟 / 5 分钟
const TEST_MODE = false;
const FOCUS_MS  = TEST_MODE ? 15 * 1000 : 25 * 60 * 1000;
const BREAK_MS  = TEST_MODE ? 30 * 1000 : 5  * 60 * 1000;
// 测试模式下锁屏按钮的分钟数会被当成"秒数"使用（见 lockscreen.js），方便快测
const DAILY_EXTEND_LIMIT = 3;

const ALARM_NAME = 'tomato-phase-end';
const STORAGE_KEY = 'timerState';
const QUOTA_KEY = 'quotaState';
const SETTINGS_KEY = 'settings';
const STATS_KEY = 'stats';
const TASKS_KEY = 'tasksToday';
const ARCHIVE_KEY = 'tasksArchive';
const BADGES_KEY = 'badgesState';
const LOCKSCREEN_FILE = 'content/lockscreen.js';
const CELEBRATION_FILE = 'content/celebration.js';
const STREAK_GOAL = 7;

const DEFAULT_SETTINGS = {
  lockscreenBg: 'transparent',
  autoStartNextFocus: true,  // 休息结束后是否自动启动下一个番茄
  whiteNoiseEnabled: true,   // 休息期间播放白噪音
  chimeEnabled: true,        // 状态转折点（专注/休息结束）播提示音
  longBreakEnabled: true,        // 每 N 个番茄后进入长休息
  longBreakEvery: 4,
  longBreakMinutes: 20,
  theme: 'default'           // 'default' | 'monster'（情绪小怪兽主题）
};

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
}

// —— 音频（通过 offscreen document 播放）——

const OFFSCREEN_URL = 'offscreen/offscreen.html';

async function ensureOffscreen() {
  // hasDocument 在某些 Chrome 版本可能不存在，fallback 用 getContexts
  if (chrome.offscreen.hasDocument) {
    if (await chrome.offscreen.hasDocument()) return;
  } else {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length > 0) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['AUDIO_PLAYBACK'],
      justification: '休息期间播放白噪音、状态转折时播放提示音。'
    });
  } catch (e) {
    // 竞态：另一处刚好也在创建，忽略
    if (!String(e).includes('Only a single offscreen document')) throw e;
  }
}

async function sendToOffscreen(action) {
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: 'offscreen', action });
  } catch (e) {
    console.error('offscreen message failed', action, e);
  }
}

// 以状态为驱动：BREAKING 且启用白噪音 → 播；其他状态 → 停。
async function syncWhiteNoise(state) {
  const settings = await getSettings();
  const shouldPlay = state?.state === 'BREAKING' && settings.whiteNoiseEnabled;
  await sendToOffscreen(shouldPlay ? 'play-white-noise' : 'stop-white-noise');
}

async function playChimeIfEnabled() {
  const settings = await getSettings();
  if (settings.chimeEnabled) await sendToOffscreen('play-chime');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_STATE = {
  state: 'IDLE',           // IDLE | FOCUSING | BREAKING | PAUSED
  phase: null,             // null | 'focus' | 'break'
  breakKind: null,         // null | 'short' | 'long'
  endTime: null,           // 当前阶段结束时的 Date.now() 时间戳
  pausedRemaining: null,   // 暂停时剩余毫秒
  prePauseState: null,     // 暂停前的状态，用于恢复
  focusStartedAt: null     // 本次专注的启动时间戳；启动后 10 秒内的放弃不计入烂番茄（手动/自动/延长 同等待遇）
};

const FOCUS_START_GRACE_MS = 10 * 1000;

async function getState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || { ...DEFAULT_STATE };
}

async function setState(next) {
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state: next }).catch(() => {});
  // 状态一变就同步音频（BREAKING 播白噪音，其他停）。
  // 不 await——音频失败不能阻塞状态机。
  syncWhiteNoise(next).catch(() => {});
}

// —— M3: 续杯配额（惰性按日重置） ——

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function getQuota() {
  const data = await chrome.storage.local.get(QUOTA_KEY);
  const raw = data[QUOTA_KEY];
  const t = todayStr();
  if (!raw || raw.date !== t) {
    return { date: t, used: 0, limit: DAILY_EXTEND_LIMIT, remaining: DAILY_EXTEND_LIMIT };
  }
  return {
    date: raw.date,
    used: raw.used,
    limit: DAILY_EXTEND_LIMIT,
    remaining: Math.max(0, DAILY_EXTEND_LIMIT - raw.used)
  };
}

async function consumeQuota() {
  const q = await getQuota();
  if (q.remaining <= 0) return false;
  const today = todayStr();
  await chrome.storage.local.set({
    [QUOTA_KEY]: { date: today, used: q.used + 1 }
  });
  // 今日一旦用过延长，连击清零：记录到 badgesState.lastExtendDate
  await markExtendUsedToday(today);
  return true;
}

// 测试/维护用：清空今日配额
async function resetQuota() {
  await chrome.storage.local.remove(QUOTA_KEY);
  return await getQuota();
}

// 锁屏里"再做一会"：用掉一次配额，把状态切回 FOCUSING，专注 ms 毫秒。
// BREAKING 中调用会中断休息，FOCUSING 中调用会覆盖剩余时长。
async function claimExtraTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    return { ok: false, reason: 'invalid-ms', quota: await getQuota() };
  }
  const s = await getState();
  if (s.state !== 'BREAKING' && s.state !== 'FOCUSING') {
    return { ok: false, reason: 'wrong-state', state: s, quota: await getQuota() };
  }
  const ok = await consumeQuota();
  if (!ok) {
    return { ok: false, reason: 'quota-exhausted', state: s, quota: await getQuota() };
  }
  await chrome.alarms.clear(ALARM_NAME);
  const endTime = Date.now() + ms;
  await setState({
    state: 'FOCUSING',
    phase: 'focus',
    breakKind: null,
    endTime,
    pausedRemaining: null,
    prePauseState: null,
    focusStartedAt: Date.now()
  });
  await chrome.alarms.create(ALARM_NAME, { when: endTime });
  return { ok: true, state: await getState(), quota: await getQuota() };
}

async function startFocus() {
  const endTime = Date.now() + FOCUS_MS;
  await setState({
    state: 'FOCUSING',
    phase: 'focus',
    breakKind: null,
    endTime,
    pausedRemaining: null,
    prePauseState: null,
    focusStartedAt: Date.now()
  });
  await chrome.alarms.create(ALARM_NAME, { when: endTime });
}

async function markPhaseEndHandling(s) {
  if (!s?.endTime) return false;
  const fresh = await getState();
  if (fresh.state !== s.state || fresh.phase !== s.phase || fresh.endTime !== s.endTime) return false;
  if (fresh.handledEndTime === s.endTime) return false;
  await setState({
    ...fresh,
    handledEndTime: fresh.endTime,
    phaseEndHandledAt: Date.now()
  });
  return true;
}

async function handlePhaseEnd() {
  const s = await getState();
  if (s.state !== 'FOCUSING' && s.state !== 'BREAKING') return;
  if (!s.endTime) return;
  const startedHandling = await markPhaseEndHandling(s);
  if (!startedHandling) return;

  try {
    if (s.phase === 'focus') {
      // 专注结束：先响 chime，停 1 秒让它响完，再进入休息（白噪音会跟着起）
      await playChimeIfEnabled();
      await recordFocusCompletion();
      const completedToday = await getTodayCompleted();
      await incrementCurrentTaskUsed();
      await sleep(1000);
      const settings = await getSettings();
      await startBreak(shouldTakeLongBreak(completedToday, settings) ? 'long' : 'short');
      return;
    }

    if (s.phase === 'break') {
      // 休息结束：白噪音正在播，直接响 chime 会被盖住。
      // 先停白噪音 → 等它淡出 → 响 chime → 再切换状态。
      await sendToOffscreen('stop-white-noise');
      await sleep(500);
      await playChimeIfEnabled();
      // 本次休息完整完成，计入连续休息天数。命中 7 天里程碑时返回 true。
      const milestone = await recordBreakCompletion();
      await sleep(1000);
      const settings = await getSettings();
      if (settings.autoStartNextFocus) {
        await notify('break-done', '休息结束', '自动开始下一番茄。');
        await startFocus();
      } else {
        await notify('break-done', '休息结束', '准备好就开始下一番茄。');
        await reset();
      }
      if (milestone) {
        // 庆祝覆盖层在状态切换之后注入，避免被锁屏销毁流程刷掉
        await injectCelebrationIntoAllTabs();
      }
    }
  } catch (e) {
    const fresh = await getState();
    if (fresh.handledEndTime === s.endTime) {
      await setState({
        ...fresh,
        handledEndTime: null,
        phaseEndHandledAt: null
      });
    }
    throw e;
  }
}

async function reconcileTimerAfterWake() {
  const s = await getState();
  if (s.state !== 'FOCUSING' && s.state !== 'BREAKING') {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  if (!s.endTime) return;

  if (Date.now() >= s.endTime) {
    await chrome.alarms.clear(ALARM_NAME);
    await handlePhaseEnd();
    return;
  }

  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    await chrome.alarms.create(ALARM_NAME, { when: s.endTime });
  }
  if (s.state === 'BREAKING') {
    await injectLockscreenIntoAllTabs();
  }
}

function clampLongBreakMinutes(value) {
  const n = Math.round(Number(value) || 20);
  return Math.max(15, Math.min(30, n));
}

function normalizeLongBreakEvery(value) {
  const n = Math.round(Number(value) || 4);
  return Math.max(2, Math.min(12, n));
}

function getBreakDurationMs(kind, settings) {
  if (kind !== 'long') return BREAK_MS;
  if (TEST_MODE) return BREAK_MS;
  return clampLongBreakMinutes(settings.longBreakMinutes) * 60 * 1000;
}

function shouldTakeLongBreak(completedToday, settings) {
  if (!settings.longBreakEnabled) return false;
  const every = normalizeLongBreakEvery(settings.longBreakEvery);
  return completedToday > 0 && completedToday % every === 0;
}

async function startBreak(kind = 'short') {
  const settings = await getSettings();
  const normalizedKind = kind === 'long' ? 'long' : 'short';
  const duration = getBreakDurationMs(normalizedKind, settings);
  const endTime = Date.now() + duration;
  await setState({
    state: 'BREAKING',
    phase: 'break',
    breakKind: normalizedKind,
    endTime,
    pausedRemaining: null,
    prePauseState: null
  });
  await chrome.alarms.create(ALARM_NAME, { when: endTime });
  // 进入休息：向所有已有标签页注入锁屏。锁屏本身就是最强的"停下来"信号，
  // 不再发"专注结束"的系统通知。仅当没有任何 tab 能被注入（例如用户所有
  // 窗口都停在 chrome:// 等受限页面）时，通知才作为兜底。
  const injected = await injectLockscreenIntoAllTabs();
  if (injected === 0) {
    await notify(
      'break-fallback',
      normalizedKind === 'long' ? '长休息时间到' : '休息时间到',
      '当前页面无法显示锁屏。切到任意普通网页即可看到休息界面。'
    );
  }
}

// —— M2: 强制锁屏注入 ——

const RESTRICTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'chrome-search://',
  'chrome-untrusted://',
  'devtools://',
  // Chrome 商店禁止内容脚本注入
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com'
];

function canInject(url) {
  if (!url) return false;
  return !RESTRICTED_PREFIXES.some((p) => url.startsWith(p));
}

async function injectIntoTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [LOCKSCREEN_FILE]
    });
    return true;
  } catch (e) {
    // 受限页面（chrome://、商店等）会抛错，返回失败
    return false;
  }
}

// 返回成功注入的 tab 数量，供调用方决定是否需要通知兜底
async function injectLockscreenIntoAllTabs() {
  const tabs = await chrome.tabs.query({});
  const targets = tabs.filter((t) => t.id != null && canInject(t.url));
  const results = await Promise.all(targets.map((t) => injectIntoTab(t.id)));
  return results.filter(Boolean).length;
}

async function pause() {
  const s = await getState();
  if (s.state !== 'FOCUSING' && s.state !== 'BREAKING') return s;
  const remaining = Math.max(0, s.endTime - Date.now());
  await chrome.alarms.clear(ALARM_NAME);
  await setState({
    ...s,
    state: 'PAUSED',
    endTime: null,
    pausedRemaining: remaining,
    prePauseState: s.state
  });
}

async function resume() {
  const s = await getState();
  if (s.state !== 'PAUSED') return s;
  const endTime = Date.now() + s.pausedRemaining;
  await setState({
    ...s,
    state: s.prePauseState,
    endTime,
    pausedRemaining: null,
    prePauseState: null
  });
  await chrome.alarms.create(ALARM_NAME, { when: endTime });
}

async function reset() {
  await chrome.alarms.clear(ALARM_NAME);
  await setState({ ...DEFAULT_STATE });
}

async function abandon() {
  const s = await getState();
  // 只对"正在进行的专注"生效：FOCUSING 或 PAUSED-focus。
  // break 阶段、IDLE 都无视，防御性兜底——UI 会禁用按钮。
  if (s.phase !== 'focus') return;
  await chrome.alarms.clear(ALARM_NAME);
  // 专注启动后 10 秒内的放弃 = 误点/没赶上自动启动，不算真放弃，不污染统计。
  const inGrace = s.focusStartedAt
    && (Date.now() - s.focusStartedAt) < FOCUS_START_GRACE_MS;
  if (!inGrace) {
    await recordFocusAbandoned();
    await incrementCurrentTaskRotten();
  }
  await setState({ ...DEFAULT_STATE });
}

async function notify(id, title, message) {
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
      priority: 2
    });
  } catch (e) {
    console.error('notify failed', e);
  }
}

// —— 统计：每日完成番茄数，只保留最近 30 天 ——

function dateNDaysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 旧数据 stats[date] 是数字（只有 completed 计数）。读时归一化为 {completed, rotten}。
function normalizeStatEntry(v) {
  if (typeof v === 'number') return { completed: v, rotten: 0 };
  if (v && typeof v === 'object') {
    return {
      completed: Number(v.completed) || 0,
      rotten: Number(v.rotten) || 0
    };
  }
  return { completed: 0, rotten: 0 };
}

async function mutateTodayStats(mutate) {
  const data = await chrome.storage.local.get(STATS_KEY);
  const stats = data[STATS_KEY] || {};
  const t = todayStr();
  const entry = normalizeStatEntry(stats[t]);
  mutate(entry);
  stats[t] = entry;
  // 保留 366 天，供热力图展示整年
  const cutoff = dateNDaysAgoStr(366);
  for (const k of Object.keys(stats)) {
    if (k < cutoff) delete stats[k];
  }
  await chrome.storage.local.set({ [STATS_KEY]: stats });
}

async function recordFocusCompletion() {
  await mutateTodayStats((e) => { e.completed += 1; });
}

async function recordFocusAbandoned() {
  await mutateTodayStats((e) => { e.rotten += 1; });
}

// 返回从 6 天前到今天的 [{date, completed, rotten, count}]，共 7 项。
// count 等于 completed，保留给旧调用方（options.js 图表）。
async function getLast7DaysStats() {
  const data = await chrome.storage.local.get(STATS_KEY);
  const stats = data[STATS_KEY] || {};
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const date = dateNDaysAgoStr(i);
    const { completed, rotten } = normalizeStatEntry(stats[date]);
    out.push({ date, completed, rotten, count: completed });
  }
  return out;
}

// —— 今日任务：跨天自动归档，SW 在专注结束时给当前任务 used++ ——
// 结构：tasksToday = { date, tasks: [{ id, title, planned, used, done, isCurrent }] }
// 归档：tasksArchive = { 'YYYY-MM-DD': [tasks...] } —— 供将来 Notion 导出

async function rollOverTasksIfNeeded() {
  const today = todayStr();
  const data = await chrome.storage.local.get([TASKS_KEY, ARCHIVE_KEY]);
  const stored = data[TASKS_KEY];
  if (stored && stored.date === today) return;
  if (stored && Array.isArray(stored.tasks) && stored.tasks.length > 0) {
    const archive = data[ARCHIVE_KEY] || {};
    archive[stored.date] = mergeArchivedTasks(archive[stored.date], stored.tasks);
    await chrome.storage.local.set({ [ARCHIVE_KEY]: archive });
  }
  await chrome.storage.local.set({ [TASKS_KEY]: { date: today, tasks: [] } });
}

function mergeArchivedTasks(archivedTasks, currentTasks) {
  if (!Array.isArray(archivedTasks) || archivedTasks.length === 0) return currentTasks;
  const seen = new Set(archivedTasks.map((t) => String(t.id)));
  const merged = archivedTasks.slice();
  for (const task of currentTasks) {
    const id = String(task.id);
    if (!seen.has(id)) {
      merged.push(task);
      seen.add(id);
    }
  }
  return merged;
}

async function incrementCurrentTaskUsed() {
  await rollOverTasksIfNeeded();
  const data = await chrome.storage.local.get(TASKS_KEY);
  const stored = data[TASKS_KEY];
  if (!stored) return;
  const tasks = stored.tasks || [];
  const current = tasks.find((t) => t.isCurrent && !t.done);
  if (!current) return;
  current.used = (current.used || 0) + 1;
  await chrome.storage.local.set({ [TASKS_KEY]: stored });
}

// 放弃时记到当前任务。如果没有当前任务，忽略（选项 a）——
// 全天 stats.rotten 仍由 recordFocusAbandoned 维护，用于设置页图表。
async function incrementCurrentTaskRotten() {
  await rollOverTasksIfNeeded();
  const data = await chrome.storage.local.get(TASKS_KEY);
  const stored = data[TASKS_KEY];
  if (!stored) return;
  const tasks = stored.tasks || [];
  const current = tasks.find((t) => t.isCurrent && !t.done);
  if (!current) return;
  current.rotten = (current.rotten || 0) + 1;
  await chrome.storage.local.set({ [TASKS_KEY]: stored });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await handlePhaseEnd();
});

// —— 徽章：连续 7 天没碰过"延长时间"解锁一枚 ——
// badgesState = { badges, unlockedDates, lastExtendDate, anchorDate }
// 干净日 = 当天 quotaState.used === 0（一次延长都没用）。
// 连击 = 从起算日（anchor）或最近一次延长日/解锁日之后，到今天的连续干净天数。

function priorDayStr(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetweenStr(from, to) {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  return Math.round((b - a) / 86400000);
}

// 规整 badgesState：补默认值；首次访问时用 stats 最早一天做 anchor
async function loadBadgesRaw() {
  const data = await chrome.storage.local.get([BADGES_KEY, STATS_KEY]);
  const raw = data[BADGES_KEY] || {};
  const badges = Number(raw.badges) || 0;
  const unlockedDates = Array.isArray(raw.unlockedDates) ? raw.unlockedDates.slice() : [];
  const lastExtendDate = raw.lastExtendDate || null;
  let anchorDate = raw.anchorDate || null;
  let anchorInitialized = false;
  if (!anchorDate) {
    const stats = data[STATS_KEY] || {};
    const keys = Object.keys(stats).sort();
    anchorDate = keys[0] || todayStr();
    anchorInitialized = true;
  }
  return { badges, unlockedDates, lastExtendDate, anchorDate, anchorInitialized };
}

async function saveBadgesRaw(raw) {
  await chrome.storage.local.set({
    [BADGES_KEY]: {
      badges: raw.badges,
      unlockedDates: raw.unlockedDates,
      lastExtendDate: raw.lastExtendDate,
      anchorDate: raw.anchorDate
    }
  });
}

// 中间空档不强求活动，但要求"今天"至少完成过 1 个番茄，避免完全不开 App 也算干净日
async function getTodayCompleted() {
  const data = await chrome.storage.local.get(STATS_KEY);
  const stats = data[STATS_KEY] || {};
  const entry = normalizeStatEntry(stats[todayStr()]);
  return entry.completed;
}

function computeStreak(raw, today, quotaUsed, todayCompleted) {
  if (quotaUsed > 0) return 0;
  const candidates = [priorDayStr(raw.anchorDate)];
  if (raw.lastExtendDate) candidates.push(raw.lastExtendDate);
  if (raw.unlockedDates.length) candidates.push(raw.unlockedDates[raw.unlockedDates.length - 1]);
  candidates.sort();
  const base = candidates[candidates.length - 1];
  // 今天若还没做番茄，按"截至昨天"计；做了今天才算上
  const endpoint = todayCompleted > 0 ? today : priorDayStr(today);
  const diff = daysBetweenStr(base, endpoint);
  return Math.max(0, Math.min(diff, STREAK_GOAL));
}

// 达标则颁发徽章：mutate raw 并返回 true
function maybeAward(raw, today, quotaUsed, todayCompleted) {
  const streak = computeStreak(raw, today, quotaUsed, todayCompleted);
  if (streak >= STREAK_GOAL && quotaUsed === 0 && !raw.unlockedDates.includes(today)) {
    raw.badges += 1;
    raw.unlockedDates.push(today);
    return true;
  }
  return false;
}

async function getBadgesState() {
  const raw = await loadBadgesRaw();
  const today = todayStr();
  const quota = await getQuota();
  const todayCompleted = await getTodayCompleted();
  const awarded = maybeAward(raw, today, quota.used, todayCompleted);
  if (awarded || raw.anchorInitialized) await saveBadgesRaw(raw);
  if (awarded) {
    // 满 7 天即解锁：往所有标签注入庆祝动画 + 系统通知，保证用户看到
    injectCelebrationIntoAllTabs().catch((e) => console.error('celebrate inject failed', e));
    notify('badge-unlock', '🎉 解锁一枚 Love Monster', '7 天没碰过延长，给自己点个赞。').catch(() => {});
  }
  const streak = computeStreak(raw, today, quota.used, todayCompleted);
  return {
    badges: raw.badges,
    currentStreak: streak,
    lastExtendDate: raw.lastExtendDate,
    unlockedDates: raw.unlockedDates,
    goal: STREAK_GOAL
  };
}

// 锁屏按下延长后：把今天标记为 dirty（连击清零）
async function markExtendUsedToday(today) {
  const raw = await loadBadgesRaw();
  if (raw.lastExtendDate === today) {
    if (raw.anchorInitialized) await saveBadgesRaw(raw);
    return;
  }
  raw.lastExtendDate = today;
  await saveBadgesRaw(raw);
}

// 返回是否触发里程碑（满 7 干净天，刚发了一枚新徽章）
async function recordBreakCompletion() {
  const raw = await loadBadgesRaw();
  const today = todayStr();
  const quota = await getQuota();
  const todayCompleted = await getTodayCompleted();
  const awarded = maybeAward(raw, today, quota.used, todayCompleted);
  if (awarded || raw.anchorInitialized) await saveBadgesRaw(raw);
  return awarded;
}

async function injectCelebrationIntoAllTabs() {
  const tabs = await chrome.tabs.query({});
  const targets = tabs.filter((t) => t.id != null && canInject(t.url));
  await Promise.all(targets.map(async (t) => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: t.id, allFrames: false },
        files: [CELEBRATION_FILE]
      });
    } catch { /* 受限页面忽略 */ }
  }));
}

// —— Notion 导出 ——
//
// 配置存 notionConfig = { token, taskDbId, dayDbId }
// 约定：每个任务创建一行 row 到 taskDbId；若配了 dayDbId，查当天的"日页面"
// id 做 relation。分类取 task.category，默认"工作"。
//
// MV3 service worker 里 fetch 需要 host_permissions 覆盖目标域名。
// 当前 manifest.json 是 <all_urls>，已覆盖 api.notion.com，无需改动。

const NOTION_CONFIG_KEY = 'notionConfig';
const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1';

async function getNotionConfig() {
  const data = await chrome.storage.local.get(NOTION_CONFIG_KEY);
  return data[NOTION_CONFIG_KEY] || { token: '', taskDbId: '', dayDbId: '' };
}

async function setNotionConfig(patch) {
  const cur = await getNotionConfig();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [NOTION_CONFIG_KEY]: next });
  return next;
}

function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  };
}

async function notionFetch(path, init = {}) {
  const cfg = await getNotionConfig();
  if (!cfg.token) throw new Error('尚未配置 Notion token');
  const res = await fetch(NOTION_API + path, {
    ...init,
    headers: { ...notionHeaders(cfg.token), ...(init.headers || {}) }
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.message || body?.raw || `HTTP ${res.status}`;
    const err = new Error(`Notion API ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// 测试连接：读 taskDbId 拿 schema；若 dayDbId 有值也顺便读一下
async function notionTestConnection() {
  const cfg = await getNotionConfig();
  if (!cfg.token) return { ok: false, error: '请先填入 token' };
  if (!cfg.taskDbId) return { ok: false, error: '请先填入任务 DB ID' };
  try {
    const task = await notionFetch(`/databases/${cfg.taskDbId}`);
    const taskTitle = task?.title?.[0]?.plain_text || '(无标题)';
    let dayInfo = '';
    if (cfg.dayDbId) {
      const day = await notionFetch(`/databases/${cfg.dayDbId}`);
      const dayTitle = day?.title?.[0]?.plain_text || '(无标题)';
      dayInfo = `｜日页面 DB：「${dayTitle}」`;
    }
    return { ok: true, message: `任务 DB：「${taskTitle}」${dayInfo}` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function findDayPageId(dayDbId, isoDate) {
  // isoDate 形如 '2026-04-22'；日页面 DB 的属性名叫"日期"，type=date
  const resp = await notionFetch(`/databases/${dayDbId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: '日期', date: { equals: isoDate } },
      page_size: 1
    })
  });
  return resp?.results?.[0]?.id || null;
}

async function findTaskPagesByDate(taskDbId, isoDate) {
  const pages = [];
  let cursor = null;
  do {
    const body = {
      filter: { property: '日期', date: { equals: isoDate } },
      page_size: 100
    };
    if (cursor) body.start_cursor = cursor;
    const resp = await notionFetch(`/databases/${taskDbId}/query`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    pages.push(...(resp?.results || []));
    cursor = resp?.has_more ? resp.next_cursor : null;
  } while (cursor);
  return pages;
}

function taskExportTitle(task) {
  return String(task.title || '(未命名)').slice(0, 200);
}

function notionPageTaskTitle(page) {
  const title = page?.properties?.任务名?.title || [];
  return title.map((part) => part.plain_text || part.text?.content || '').join('');
}

function buildTaskPageIndex(pages) {
  const byTitle = new Map();
  let existingDuplicates = 0;
  for (const page of pages) {
    const title = notionPageTaskTitle(page);
    const entry = byTitle.get(title);
    if (entry) {
      entry.duplicates.push(page);
      existingDuplicates++;
    } else {
      byTitle.set(title, { page, duplicates: [] });
    }
  }
  return { byTitle, existingDuplicates };
}

function buildTaskPageProps(task, isoDate, dayPageId) {
  const category = ['工作', '学习', '生活', '兴趣爱好'].includes(task.category) ? task.category : '工作';
  const used = Number(task.used) || 0;
  const planned = Number(task.planned) || 0;
  const overflow = Math.max(0, used - planned);
  const rotten = Number(task.rotten) || 0;
  const props = {
    任务名: {
      title: [{ type: 'text', text: { content: taskExportTitle(task) } }]
    },
    日期: { date: { start: isoDate } },
    计划番茄: { number: planned },
    实际番茄: { number: used },
    超额番茄: { number: overflow },
    放弃番茄: { number: rotten },
    分类: { select: { name: category } }
  };
  if (dayPageId) {
    props['所属日'] = { relation: [{ id: dayPageId }] };
  }
  return props;
}

// 把某一天的任务批量导入 Notion，返回 { ok, created, updated, failed, errors }
async function notionExportDay(date) {
  const cfg = await getNotionConfig();
  if (!cfg.token || !cfg.taskDbId) {
    return { ok: false, error: '请先在设置页填入 Notion token 和任务 DB ID' };
  }

  await rollOverTasksIfNeeded();

  const today = todayStr();
  let tasks = [];
  if (date === today) {
    const data = await chrome.storage.local.get(TASKS_KEY);
    const stored = data[TASKS_KEY];
    if (stored && stored.date === today) tasks = stored.tasks || [];
  } else {
    const data = await chrome.storage.local.get(ARCHIVE_KEY);
    tasks = (data[ARCHIVE_KEY] || {})[date] || [];
  }

  if (tasks.length === 0) {
    return { ok: false, error: '这一天没有任务可导入' };
  }

  let dayPageId = null;
  if (cfg.dayDbId) {
    try {
      dayPageId = await findDayPageId(cfg.dayDbId, date);
    } catch (e) {
      return { ok: false, error: `查询日页面失败：${e.message || e}` };
    }
  }

  let taskPageIndex = null;
  try {
    const existingPages = await findTaskPagesByDate(cfg.taskDbId, date);
    taskPageIndex = buildTaskPageIndex(existingPages);
  } catch (e) {
    return { ok: false, error: `查询已导入任务失败：${e.message || e}` };
  }

  const errors = [];
  let created = 0;
  let updated = 0;
  for (const t of tasks) {
    const properties = buildTaskPageProps(t, date, dayPageId);
    const existing = taskPageIndex.byTitle.get(taskExportTitle(t));
    try {
      if (existing?.page?.id) {
        await notionFetch(`/pages/${existing.page.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ properties })
        });
        updated++;
      } else {
        const createdPage = await notionFetch('/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: { database_id: cfg.taskDbId },
            properties
          })
        });
        taskPageIndex.byTitle.set(taskExportTitle(t), { page: createdPage, duplicates: [] });
        created++;
      }
    } catch (e) {
      errors.push({ task: t.title, error: String(e.message || e) });
    }
  }

  const summary = {
    ok: errors.length === 0,
    created,
    updated,
    failed: errors.length,
    total: tasks.length,
    existingDuplicates: taskPageIndex.existingDuplicates,
    dayPageLinked: !!dayPageId,
    errors
  };

  // 记一笔导入历史，方便以后"已导入"的展示
  const exportKey = 'notionExportLog';
  const prev = (await chrome.storage.local.get(exportKey))[exportKey] || {};
  prev[date] = { at: new Date().toISOString(), ...summary };
  await chrome.storage.local.set({ [exportKey]: prev });

  return summary;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 目标是 offscreen 的消息由 offscreen document 自己处理，SW 不要抢着回应
  if (msg?.target === 'offscreen') return;
  (async () => {
    try {
      switch (msg?.type) {
        case 'GET_STATE':
          await reconcileTimerAfterWake();
          sendResponse(await getState());
          return;
        case 'START':
          await startFocus();
          sendResponse(await getState());
          return;
        case 'PAUSE':
          await pause();
          sendResponse(await getState());
          return;
        case 'RESUME':
          await resume();
          sendResponse(await getState());
          return;
        case 'RESET':
          await reset();
          sendResponse(await getState());
          return;
        case 'ABANDON':
          await abandon();
          sendResponse(await getState());
          return;
        case 'GET_QUOTA':
          sendResponse(await getQuota());
          return;
        case 'CLAIM_EXTRA_TIME':
          sendResponse(await claimExtraTime(msg.ms));
          return;
        case 'RESET_QUOTA':
          sendResponse(await resetQuota());
          return;
        case 'GET_STATS':
          sendResponse(await getLast7DaysStats());
          return;
        case 'GET_BADGES':
          sendResponse(await getBadgesState());
          return;
        case 'GET_NOTION_CONFIG':
          sendResponse(await getNotionConfig());
          return;
        case 'SET_NOTION_CONFIG':
          sendResponse(await setNotionConfig(msg.patch || {}));
          return;
        case 'NOTION_TEST':
          sendResponse(await notionTestConnection());
          return;
        case 'NOTION_EXPORT_DAY':
          sendResponse(await notionExportDay(msg.date));
          return;
        default:
          sendResponse({ error: 'unknown message type' });
      }
    } catch (e) {
      console.error(e);
      sendResponse({ error: String(e) });
    }
  })();
  return true; // 保持通道开启以返回异步响应
});

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  if (!data[STORAGE_KEY]) {
    await chrome.storage.local.set({ [STORAGE_KEY]: { ...DEFAULT_STATE } });
  }
  // TEST_MODE：每次"重新加载扩展"都清零配额，方便反复测试
  if (TEST_MODE) {
    await chrome.storage.local.remove(QUOTA_KEY);
  }
  await reconcileTimerAfterWake();
});

// 休息期间：任何新建或导航的 tab 都要被注入
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
  const s = await getState();
  if (s.state !== 'BREAKING') return;
  if (!canInject(tab.url)) return;
  injectIntoTab(tabId);
});

// 悬浮窗被关闭时清理 window id，防止下次点击「悬浮」时 update 报错
chrome.windows.onRemoved.addListener(async (windowId) => {
  const data = await chrome.storage.local.get('floatWindowId');
  if (data.floatWindowId === windowId) {
    await chrome.storage.local.remove('floatWindowId');
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const s = await getState();
  if (s.state !== 'BREAKING') return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (canInject(tab.url)) injectIntoTab(tabId);
  } catch {
    // tab 可能已关闭
  }
});

// SW 被唤醒时做一次"时间校验"：如果 endTime 已过但 alarm 没触发
// （比如电脑休眠后恢复），补触发一次。
chrome.runtime.onStartup.addListener(async () => {
  await reconcileTimerAfterWake();
});
