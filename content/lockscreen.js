// 休息锁定覆盖层。由 Service Worker 通过 chrome.scripting.executeScript 注入。
// 关键约束：
// 1. 必须在 Shadow DOM 里渲染，避免被页面 CSS 污染，也避免污染页面。
// 2. 必须通过 chrome.storage.onChanged 自主感知状态切换，不依赖 SW 推送。
// 3. 没有"跳过休息"出口——加时是消耗配额的合规路径，等不了就禁用扩展。
//    给一个无代价的后门会把"强制休息"变成"建议休息"。

(() => {
  if (window.__tomatoLockInjected) return;
  document.getElementById('__tomato-lock-host')?.remove();
  document.querySelectorAll('.__tomato-afraid').forEach((el) => el.remove());
  window.__tomatoLockInjected = true;

  // ⚠️ 与 service-worker.js 的 TEST_MODE 保持一致
  const TEST_MODE = false;

  const STORAGE_KEY = 'timerState';
  const QUOTA_KEY = 'quotaState';
  const SETTINGS_KEY = 'settings';

  const BG_FILES = {
    dawn:  'backgrounds/dawn.svg',
    ocean: 'backgrounds/ocean.svg',
    dusk:  'backgrounds/dusk.svg'
  };

  const MONSTER_URL = (kind) => chrome.runtime.getURL(`themes/monster/${kind}.svg`);

  // 预设按钮的分钟 → 毫秒换算。测试模式下按秒算，方便快测。
  // 自定义输入不走这里（它始终按真·分钟换算）。
  function minutesToMs(min) {
    return TEST_MODE ? min * 1000 : min * 60 * 1000;
  }

  let currentState = null;
  let currentQuota = null;

  // —— DOM 构建 ——
  const host = document.createElement('div');
  host.id = '__tomato-lock-host';
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });

  shadow.innerHTML = `
    <style>
      :host, * { box-sizing: border-box; }
      .backdrop {
        position: fixed; inset: 0;
        background: rgba(18, 18, 18, 0.88);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Helvetica Neue', sans-serif;
        color: #f5f5f2;
        animation: fadeIn 0.3s ease-out;
      }
      /* 图片模式：用一层暗化蒙层保证白文字可读 */
      .backdrop.has-image {
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
      }
      .backdrop.has-image::before {
        content: '';
        position: absolute; inset: 0;
        background: rgba(0, 0, 0, 0.45);
        pointer-events: none;
      }
      .backdrop.has-image .card {
        position: relative;
        z-index: 1;
      }
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .card {
        text-align: center;
        padding: 40px 48px;
        max-width: 520px;
      }
      .phase {
        font-size: 13px;
        letter-spacing: 2px;
        color: #4a8a5c;
        text-transform: uppercase;
        margin-bottom: 14px;
      }
      .timer {
        font-size: 96px;
        font-weight: 200;
        font-variant-numeric: tabular-nums;
        letter-spacing: 2px;
        line-height: 1;
        margin-bottom: 16px;
      }
      .subtitle {
        font-size: 13px;
        color: #9a9a95;
        margin-bottom: 36px;
        line-height: 1.6;
      }

      /* —— 加时区块 —— */
      .extend-title {
        font-size: 13px;
        color: rgba(255,255,255,0.5);
        margin-bottom: 12px;
      }
      .extend-options {
        display: flex;
        gap: 8px;
        justify-content: center;
        flex-wrap: wrap;
      }
      .ext-btn {
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.15);
        color: #e5e5e0;
        padding: 10px 14px;
        font-size: 13px;
        border-radius: 6px;
        cursor: pointer;
        font-family: inherit;
        transition: all 0.15s;
      }
      .ext-btn:hover:not(:disabled) {
        background: rgba(255,255,255,0.12);
        border-color: rgba(255,255,255,0.35);
      }
      .ext-btn:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
      .ext-btn.primary {
        background: rgba(245, 185, 66, 0.85);
        border-color: #f5b942;
        color: #1a1a1a;
      }
      .ext-btn.primary:hover:not(:disabled) {
        background: #f5b942;
      }
      .ext-btn.ghost {
        background: transparent;
        border-color: rgba(255,255,255,0.1);
        color: rgba(255,255,255,0.6);
      }
      .extend-custom {
        display: flex;
        gap: 8px;
        justify-content: center;
        align-items: center;
      }
      .extend-custom input {
        background: rgba(0,0,0,0.35);
        border: 1px solid rgba(255,255,255,0.2);
        color: #fff;
        padding: 9px 12px;
        font-size: 14px;
        border-radius: 6px;
        width: 96px;
        font-family: inherit;
        text-align: center;
      }
      .extend-custom input:focus {
        outline: none;
        border-color: rgba(245,185,66,0.7);
      }
      .extend-custom input::-webkit-inner-spin-button,
      .extend-custom input::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .extend-quota {
        font-size: 11px;
        color: rgba(255,255,255,0.4);
        margin-top: 12px;
      }
      .extend-note {
        font-size: 11px;
        color: #e88a6f;
        min-height: 14px;
        margin-top: 4px;
      }

      /* —— 情绪小怪兽主题 —— */
      .angry-monster {
        width: 160px;
        height: 182px;
        margin: 0 auto 20px;
        display: block;
        animation: angryShake 0.8s ease-in-out infinite alternate;
      }
      @keyframes angryShake {
        0%   { transform: translateX(-4px) rotate(-1.5deg); }
        100% { transform: translateX(4px) rotate(1.5deg); }
      }
      .monster-shout {
        font-size: 22px;
        font-weight: 500;
        color: #ff7a5a;
        letter-spacing: 1px;
        margin-bottom: 8px;
        text-shadow: 0 1px 3px rgba(0,0,0,0.4);
      }

      /* afraid monster 的样式在 JS 里用内联样式，因为它要脱离 shadow DOM */
    </style>

    <div class="backdrop">
      <div class="card">
        <img class="angry-monster" id="angry-monster" alt="" hidden />
        <div class="monster-shout" id="monster-shout" hidden>离开电脑去休息！</div>
        <div class="phase" id="phase-label">休息时间</div>
        <div class="timer" id="timer">--:--</div>
        <div class="subtitle" id="subtitle">站起来，离开屏幕。看看窗外，喝口水。</div>

        <div class="extend">
          <div class="extend-title" id="ext-title">还没做完？用一次配额再专注一会</div>
          <div class="extend-options" id="ext-options">
            <button class="ext-btn" data-min="5">+5 分钟</button>
            <button class="ext-btn" data-min="25">+25 分钟 · 1 🍅</button>
            <button class="ext-btn" id="ext-custom-btn">自定义</button>
          </div>
          <div class="extend-custom" id="ext-custom" hidden>
            <input type="number" id="ext-input" min="0.1" max="120" step="any" placeholder="分钟（可小数）" />
            <button class="ext-btn primary" id="ext-confirm">确认</button>
            <button class="ext-btn ghost" id="ext-cancel">取消</button>
          </div>
          <div class="extend-quota" id="ext-quota">今日剩 --/--</div>
          <div class="extend-note" id="ext-note"></div>
        </div>
      </div>
    </div>
  `;

  const $backdrop = shadow.querySelector('.backdrop');
  const $timer = shadow.getElementById('timer');
  const $angryMonster = shadow.getElementById('angry-monster');
  const $monsterShout = shadow.getElementById('monster-shout');
  const $phaseLabel = shadow.getElementById('phase-label');
  const $subtitle = shadow.getElementById('subtitle');
  const $extTitle = shadow.getElementById('ext-title');
  const $extOptions = shadow.getElementById('ext-options');
  const $extCustom = shadow.getElementById('ext-custom');
  const $extCustomBtn = shadow.getElementById('ext-custom-btn');
  const $extInput = shadow.getElementById('ext-input');
  const $extConfirm = shadow.getElementById('ext-confirm');
  const $extCancel = shadow.getElementById('ext-cancel');
  const $extQuota = shadow.getElementById('ext-quota');
  const $extNote = shadow.getElementById('ext-note');

  document.documentElement.appendChild(host);

  // —— 渲染 ——
  function formatMs(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function renderTimer() {
    if (!currentState || currentState.state !== 'BREAKING') return;
    const remaining = currentState.endTime - Date.now();
    $timer.textContent = formatMs(remaining);
  }

  function renderBreakCopy(theme = null) {
    const isLongBreak = currentState?.breakKind === 'long';
    $phaseLabel.textContent = isLongBreak ? '长休息时间' : '休息时间';
    if (theme === 'monster') {
      $subtitle.textContent = isLongBreak
        ? '这是长休息，真的离开屏幕一会儿。'
        : pickMonsterSubtitle();
      return;
    }
    $subtitle.textContent = isLongBreak
      ? '这是长休息。站起来，走远一点，让眼睛和身体都缓过来。'
      : '站起来，离开屏幕。看看窗外，喝口水。';
  }

  function renderQuota() {
    if (!currentQuota) {
      $extQuota.textContent = '今日剩 --/--';
      return;
    }
    const { remaining, limit } = currentQuota;
    $extQuota.textContent = `今日剩 ${remaining}/${limit}`;
    const exhausted = remaining <= 0;
    $extOptions.querySelectorAll('.ext-btn').forEach((b) => {
      if (b.id !== 'ext-cancel') b.disabled = exhausted;
    });
    $extConfirm.disabled = exhausted;
    if (exhausted) {
      $extTitle.textContent = '今日配额已用完';
    }
  }

  // —— 加时 ——
  // claim 接受的是最终毫秒数，调用方决定怎么换算。
  // 预设按钮走 minutesToMs（TEST_MODE 下按秒算，方便快测）；
  // 自定义输入按真·分钟换算，不受 TEST_MODE 影响（输入 0.5 → 30 秒）。
  async function claim(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
      $extNote.textContent = '无效的时长。';
      return;
    }
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'CLAIM_EXTRA_TIME',
        ms
      });
      if (resp?.quota) {
        currentQuota = resp.quota;
        renderQuota();
      }
      if (!resp?.ok) {
        $extNote.textContent = resp?.reason === 'quota-exhausted'
          ? '今日配额已用完。'
          : '无法加时。';
      }
      // 成功时 SW 会 setState，storage.onChanged 触发 destroy，
      // 这里不需要手动关闭。
    } catch (e) {
      console.error('claim failed', e);
    }
  }

  $extOptions.querySelectorAll('[data-min]').forEach((btn) => {
    bindAfraidHover(btn);
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const min = Number(btn.dataset.min);
      claim(minutesToMs(min));
    });
  });
  bindAfraidHover($extConfirm);

  $extCustomBtn.addEventListener('click', () => {
    if ($extCustomBtn.disabled) return;
    $extOptions.hidden = true;
    $extCustom.hidden = false;
    $extNote.textContent = '';
    $extInput.value = '';
    setTimeout(() => $extInput.focus(), 0);
  });

  $extCancel.addEventListener('click', () => {
    $extOptions.hidden = false;
    $extCustom.hidden = true;
    $extNote.textContent = '';
  });

  $extConfirm.addEventListener('click', () => {
    const min = parseFloat($extInput.value);
    if (!Number.isFinite(min) || min < 0.1 || min > 120) {
      $extNote.textContent = '输入 0.1 到 120 分钟（支持小数，如 0.5 = 30 秒）。';
      $extInput.focus();
      return;
    }
    claim(min * 60 * 1000);
  });

  $extInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $extConfirm.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      $extCancel.click();
    }
  });

  // —— 状态同步 ——
  function handleState(state) {
    currentState = state;
    if (!state || state.state !== 'BREAKING') {
      destroy();
      return;
    }
    renderTimer();
    renderBreakCopy();
  }

  async function fetchQuota() {
    try {
      currentQuota = await chrome.runtime.sendMessage({ type: 'GET_QUOTA' });
      renderQuota();
    } catch (e) { /* SW 刚唤醒可能失败，下次 onChanged 再拿 */ }
  }

  async function applyBackground() {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const bg = data[SETTINGS_KEY]?.lockscreenBg || 'transparent';
    const file = BG_FILES[bg];
    if (!file) {
      $backdrop.classList.remove('has-image');
      $backdrop.style.backgroundImage = '';
      return;
    }
    const url = chrome.runtime.getURL(file);
    $backdrop.style.backgroundImage = `url("${url}")`;
    $backdrop.classList.add('has-image');
  }

  async function applyTheme() {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const theme = data[SETTINGS_KEY]?.theme || 'default';
    if (theme === 'monster') {
      $angryMonster.src = MONSTER_URL('angry');
      $angryMonster.hidden = false;
      $monsterShout.hidden = false;
      $phaseLabel.hidden = true;
      renderBreakCopy(theme);
    } else {
      $angryMonster.hidden = true;
      $monsterShout.hidden = true;
      $phaseLabel.hidden = false;
      renderBreakCopy(theme);
    }
  }

  // Afraid monster：鼠标悬浮加时按钮时跳出来，配一句"确定吗？"气泡，
  // 离开按钮时淡出。不依赖 click，让用户在"还没点"的时候就感到迟疑。
  //
  // 挂在 document.documentElement（不在 shadow DOM 里），这样即使锁屏销毁
  // 它也能完成自己的动画。destroy() 里会扫一遍 .__tomato-afraid 清理残留。

  const AFRAID_PHRASES = ['确定吗？', 'you sure?'];

  // 小怪兽主题下的副标题文案池。每次锁屏弹出时随机挑一句。
  const MONSTER_SUBTITLES = [
    '坐了这么久，你的眼睛和脖子都不高兴了。',
    '屏幕看够了，眼睛在小声求你眨一眨。',
    '你的腰在偷偷抗议，先站起来走两步吧。',
    '肩膀已经硬得像块砖，该活动一下了。',
    '盯这么久，眼睛快要罢工啦。',
    '脖子想回到它本来的角度，让它歇会儿。',
    '站起来，活动一下吧。',
    '你的手腕也需要一点自由时间。'
  ];

  function pickMonsterSubtitle() {
    return MONSTER_SUBTITLES[Math.floor(Math.random() * MONSTER_SUBTITLES.length)];
  }

  function bindAfraidHover(button) {
    let group = null;
    let enterAnim = null;

    async function show() {
      if (button.disabled || group) return;
      const data = await chrome.storage.local.get(SETTINGS_KEY);
      if ((data[SETTINGS_KEY]?.theme || 'default') !== 'monster') return;
      // 如果异步回来按钮已离开鼠标或已 disabled，跳过
      if (button.disabled) return;

      const rect = button.getBoundingClientRect();
      group = document.createElement('div');
      group.className = '__tomato-afraid';
      group.style.cssText = [
        'all: initial',
        'position: fixed',
        `left: ${rect.left + rect.width / 2}px`,
        `top: ${rect.top}px`,
        'width: 0',
        'height: 0',
        'pointer-events: none',
        'z-index: 2147483647',
        'opacity: 0'
      ].join(';');

      // 关键：element 挂在 document 级，会被页面 CSS 污染。
      // 常见元凶是 `img { max-width: 100% }` —— 因为父容器 width: 0，
      // 会把 img 压成 0 宽。先 `all: initial` 重置，再叠必须的属性。
      const img = document.createElement('img');
      img.src = MONSTER_URL('afraid');
      img.alt = '';
      img.style.cssText = [
        'all: initial',
        'position: absolute',
        'left: 0',
        'top: 0',
        'width: 90px',
        'height: 104px',
        'max-width: none',
        'max-height: none',
        'display: block',
        'transform: translate(-50%, -100%)',
        'pointer-events: none'
      ].join(';');

      const bubble = document.createElement('div');
      bubble.textContent = AFRAID_PHRASES[Math.floor(Math.random() * AFRAID_PHRASES.length)];
      bubble.style.cssText = [
        'all: initial',
        'position: absolute',
        'left: 42px',
        'top: -88px',
        'background: #ffffff',
        'color: #2a2520',
        'border: 2.5px solid #2a2520',
        'border-radius: 16px',
        'padding: 7px 14px',
        "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif",
        'font-size: 14px',
        'font-weight: 500',
        'white-space: nowrap',
        'box-shadow: 0 3px 8px rgba(0,0,0,0.25)',
        'display: block'
      ].join(';');

      group.appendChild(img);
      group.appendChild(bubble);
      document.documentElement.appendChild(group);

      enterAnim = group.animate([
        { opacity: 0, transform: 'translateY(14px) scale(0.7)' },
        { opacity: 1, transform: 'translateY(0)    scale(1)' }
      ], {
        duration: 280,
        easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        fill: 'forwards'
      });
    }

    function hide() {
      if (!group) return;
      const el = group;
      group = null;
      if (enterAnim) { try { enterAnim.cancel(); } catch {} enterAnim = null; }
      const exit = el.animate([
        { opacity: 1, transform: 'translateY(0)     scale(1)' },
        { opacity: 0, transform: 'translateY(-12px) scale(0.9)' }
      ], {
        duration: 180,
        fill: 'forwards'
      });
      exit.onfinish = () => el.remove();
    }

    button.addEventListener('mouseenter', show);
    button.addEventListener('mouseleave', hide);
    // 点击后按钮通常会消失（锁屏销毁），mouseleave 可能触发也可能不——
    // 主动调一次 hide 作为兜底
    button.addEventListener('click', hide);
  }

  function destroy() {
    if (tickHandle) clearInterval(tickHandle);
    if (host.isConnected) host.remove();
    // 清理可能残留在 document 级的 afraid monster（hover 未触发 mouseleave 的情况）
    document.querySelectorAll('.__tomato-afraid').forEach((el) => el.remove());
    window.__tomatoLockInjected = false;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEY]) handleState(changes[STORAGE_KEY].newValue);
    if (changes[QUOTA_KEY]) fetchQuota();
    if (changes[SETTINGS_KEY]) {
      applyBackground();
      applyTheme();
    }
  });

  // 初始化：拉一次 state、quota、背景、主题
  chrome.storage.local.get(STORAGE_KEY).then((data) => handleState(data[STORAGE_KEY]));
  fetchQuota();
  applyBackground();
  applyTheme();

  const tickHandle = setInterval(renderTimer, 250);
})();
