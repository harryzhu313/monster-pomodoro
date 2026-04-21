// 悬浮小窗：复用 SW 的状态 + 消息。极简 UI，不做设置、不做统计。

const FOCUS_MS = 25 * 60 * 1000;
const TASKS_KEY = 'tasksToday';

const els = {
  phaseLabel: document.getElementById('phase-label'),
  taskName: document.getElementById('task-name'),
  timer: document.getElementById('timer'),
  btnPrimary: document.getElementById('btn-primary'),
  btnSkip: document.getElementById('btn-skip'),
  btnPip: document.getElementById('btn-pip')
};

let currentState = null;
let currentTask = null;
let tickHandle = null;

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

function renderTaskName() {
  if (!currentTask) {
    els.taskName.textContent = '';
    return;
  }
  els.taskName.textContent = currentTask.title;
  els.taskName.title = currentTask.title;
}

function render() {
  if (!currentState) return;
  const { state, phase } = currentState;

  els.timer.textContent = formatMs(computeRemaining(currentState));
  els.phaseLabel.className = 'phase-label';

  if (state === 'IDLE') {
    els.phaseLabel.textContent = '准备开始';
    els.btnPrimary.textContent = '开始';
    els.btnPrimary.dataset.action = 'start';
    els.btnSkip.disabled = true;
  } else if (state === 'FOCUSING') {
    els.phaseLabel.textContent = '专注中';
    els.phaseLabel.classList.add('focusing');
    els.btnPrimary.textContent = '暂停';
    els.btnPrimary.dataset.action = 'pause';
    els.btnSkip.disabled = false;
  } else if (state === 'BREAKING') {
    els.phaseLabel.textContent = '休息中';
    els.phaseLabel.classList.add('breaking');
    els.btnPrimary.textContent = '暂停';
    els.btnPrimary.dataset.action = 'pause';
    els.btnSkip.disabled = true;
  } else if (state === 'PAUSED') {
    els.phaseLabel.textContent = phase === 'focus' ? '专注已暂停' : '休息已暂停';
    els.phaseLabel.classList.add('paused');
    els.btnPrimary.textContent = '继续';
    els.btnPrimary.dataset.action = 'resume';
    els.btnSkip.disabled = phase !== 'focus';
  }

  renderTaskName();
}

async function send(type) {
  try {
    const next = await chrome.runtime.sendMessage({ type });
    if (next && !next.error) {
      currentState = next;
      render();
    }
  } catch (e) {
    console.error('send failed', type, e);
  }
}

async function loadCurrentTask() {
  const data = await chrome.storage.local.get(TASKS_KEY);
  const stored = data[TASKS_KEY];
  if (!stored || stored.date !== todayStr()) {
    currentTask = null;
    return;
  }
  currentTask = (stored.tasks || []).find((t) => t.isCurrent && !t.done) || null;
}

async function refresh() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    currentState = state;
    await loadCurrentTask();
    render();
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
  }, 250);
}

els.btnPrimary.addEventListener('click', () => {
  const action = els.btnPrimary.dataset.action;
  const map = { start: 'START', pause: 'PAUSE', resume: 'RESUME' };
  if (map[action]) send(map[action]);
});

els.btnSkip.addEventListener('click', () => send('SKIP'));

// —— 置顶悬浮：Document Picture-in-Picture（Chrome 116+，OS 级置顶）——

let pipWindow = null;
let ownWindowId = null;

async function rememberOwnWindow() {
  try {
    const w = await chrome.windows.getCurrent();
    ownWindowId = w.id;
  } catch {}
}

function showPlaceholder() {
  let ph = document.getElementById('pip-placeholder');
  if (ph) return;
  ph = document.createElement('div');
  ph.id = 'pip-placeholder';
  ph.className = 'pip-placeholder';
  ph.innerHTML = '已置顶到独立小窗。<br>关掉它即可取消置顶。<br><span class="muted">请勿关闭本窗口，否则置顶会一起消失。</span>';
  document.body.appendChild(ph);
}

function hidePlaceholder() {
  const ph = document.getElementById('pip-placeholder');
  if (ph) ph.remove();
}

async function enterPiP() {
  if (!('documentPictureInPicture' in window)) {
    alert('当前 Chrome 版本不支持 Document PiP 置顶，请升级到 Chrome 116+。');
    return;
  }
  if (pipWindow) {
    pipWindow.focus?.();
    return;
  }

  pipWindow = await documentPictureInPicture.requestWindow({
    width: 240,
    height: 160,
    disallowReturnToOpener: false
  });

  // 样式表搬过去：同源（chrome-extension://<id>）资源可直接用 href 引用
  document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
    const clone = pipWindow.document.createElement('link');
    clone.rel = 'stylesheet';
    clone.href = link.href;
    pipWindow.document.head.appendChild(clone);
  });
  pipWindow.document.title = document.title;

  // 把 .float 整块搬进 PiP，事件监听器随元素迁移，不会失效
  const floatEl = document.querySelector('.float');
  pipWindow.document.body.appendChild(floatEl);
  showPlaceholder();

  // 父窗口最小化，视觉上只剩 PiP
  if (ownWindowId != null) {
    try { await chrome.windows.update(ownWindowId, { state: 'minimized' }); } catch {}
  }

  pipWindow.addEventListener('pagehide', async () => {
    document.body.appendChild(floatEl);
    hidePlaceholder();
    pipWindow = null;
    if (ownWindowId != null) {
      try { await chrome.windows.update(ownWindowId, { state: 'normal', focused: true }); } catch {}
    }
  });
}

els.btnPip.addEventListener('click', enterPiP);
rememberOwnWindow();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'STATE_UPDATE') {
    currentState = msg.state;
    render();
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes[TASKS_KEY]) {
    await loadCurrentTask();
    render();
  }
});

refresh();
startTicking();
