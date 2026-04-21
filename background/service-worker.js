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
const LOCKSCREEN_FILE = 'content/lockscreen.js';

const DEFAULT_SETTINGS = {
  lockscreenBg: 'transparent',
  autoStartNextFocus: true,  // 休息结束后是否自动启动下一个番茄
  whiteNoiseEnabled: true,   // 休息期间播放白噪音
  chimeEnabled: true,        // 状态转折点（专注/休息结束）播提示音
  notificationPersistent: true, // 系统通知常驻直到用户点掉（requireInteraction）
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
  await ensureOffscreen();
  try {
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
  endTime: null,           // 当前阶段结束时的 Date.now() 时间戳
  pausedRemaining: null,   // 暂停时剩余毫秒
  prePauseState: null      // 暂停前的状态，用于恢复
};

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
  await chrome.storage.local.set({
    [QUOTA_KEY]: { date: todayStr(), used: q.used + 1 }
  });
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
    endTime,
    pausedRemaining: null,
    prePauseState: null
  });
  await chrome.alarms.create(ALARM_NAME, { when: endTime });
  return { ok: true, state: await getState(), quota: await getQuota() };
}

async function startFocus() {
  const endTime = Date.now() + FOCUS_MS;
  await setState({
    state: 'FOCUSING',
    phase: 'focus',
    endTime,
    pausedRemaining: null,
    prePauseState: null
  });
  await chrome.alarms.create(ALARM_NAME, { when: endTime });
}

async function startBreak() {
  const endTime = Date.now() + BREAK_MS;
  await setState({
    state: 'BREAKING',
    phase: 'break',
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
      '休息时间到',
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

async function skip() {
  const s = await getState();
  // 强制休息是产品核心：break 阶段的 SKIP 直接无视，alarm 不动。
  // 防御性兜底——UI 已在 popup 禁用，锁屏里也没有跳过按钮。
  if (s.phase !== 'focus') return;
  await chrome.alarms.clear(ALARM_NAME);
  await startBreak();
}

async function notify(id, title, message) {
  try {
    const settings = await getSettings();
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
      priority: 2,
      requireInteraction: settings.notificationPersistent
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

async function recordFocusCompletion() {
  const data = await chrome.storage.local.get(STATS_KEY);
  const stats = data[STATS_KEY] || {};
  const t = todayStr();
  stats[t] = (stats[t] || 0) + 1;
  const cutoff = dateNDaysAgoStr(30);
  for (const k of Object.keys(stats)) {
    if (k < cutoff) delete stats[k];
  }
  await chrome.storage.local.set({ [STATS_KEY]: stats });
}

// 返回从 6 天前到今天的 [{date, count}]，共 7 项，空日补 0
async function getLast7DaysStats() {
  const data = await chrome.storage.local.get(STATS_KEY);
  const stats = data[STATS_KEY] || {};
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const date = dateNDaysAgoStr(i);
    out.push({ date, count: stats[date] || 0 });
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
    archive[stored.date] = stored.tasks;
    await chrome.storage.local.set({ [ARCHIVE_KEY]: archive });
  }
  await chrome.storage.local.set({ [TASKS_KEY]: { date: today, tasks: [] } });
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

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const s = await getState();
  if (s.phase === 'focus') {
    // 专注结束：先响 chime，停 1 秒让它响完，再进入休息（白噪音会跟着起）
    await playChimeIfEnabled();
    await recordFocusCompletion();
    await incrementCurrentTaskUsed();
    await sleep(1000);
    await startBreak();
  } else if (s.phase === 'break') {
    // 休息结束：白噪音正在播，直接响 chime 会被盖住。
    // 先停白噪音 → 等它淡出 → 响 chime → 再切换状态。
    await sendToOffscreen('stop-white-noise');
    await sleep(500);
    await playChimeIfEnabled();
    await sleep(1000);
    const settings = await getSettings();
    if (settings.autoStartNextFocus) {
      await notify('break-done', '休息结束', '自动开始下一番茄。');
      await startFocus();
    } else {
      await notify('break-done', '休息结束', '准备好就开始下一番茄。');
      await reset();
    }
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 目标是 offscreen 的消息由 offscreen document 自己处理，SW 不要抢着回应
  if (msg?.target === 'offscreen') return;
  (async () => {
    try {
      switch (msg?.type) {
        case 'GET_STATE':
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
        case 'SKIP':
          await skip();
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
  const s = await getState();
  if ((s.state === 'FOCUSING' || s.state === 'BREAKING') && s.endTime && Date.now() >= s.endTime) {
    if (s.phase === 'focus') {
      // 设备恢复后直接进入休息锁定
      await startBreak();
    } else {
      const settings = await getSettings();
      if (settings.autoStartNextFocus) {
        await notify('break-done-late', '休息已结束', '检测到设备休眠，自动开始下一番茄。');
        await startFocus();
      } else {
        await notify('break-done-late', '休息已结束', '检测到设备休眠，补一次提示。');
        await reset();
      }
    }
  }
});
