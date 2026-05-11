// Offscreen document：MV3 的 Service Worker 里没有 DOM/Audio，
// 所有音频播放必须在 offscreen document 里完成。
// SW 通过 chrome.runtime.sendMessage({ target: 'offscreen', ... }) 指挥。

let audioCtx = null;
let whiteNoiseSource = null;
let whiteNoiseGain = null;

function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') {
    // offscreen document 创建的 AudioContext 通常可以直接播放。
    // 万一被挂起就主动 resume，失败也不会抛——只是第一次可能没声。
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playWhiteNoise() {
  stopWhiteNoise();
  const ctx = getCtx();

  // 2 秒 buffer，循环播放。加一个低通滤波让它更像"粉/棕噪音"，减少高频刺耳感。
  const bufferSize = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let lastOut = 0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    // 简易棕噪音：每个样本对上一样本做低通，高频能量衰减
    lastOut = (lastOut + 0.02 * white) / 1.02;
    data[i] = lastOut * 3.5; // 补偿低通后的音量
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;

  const gain = ctx.createGain();
  // 起播时 0 → 0.25 做 800ms 淡入，避免突兀
  const now = ctx.currentTime;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.25, now + 0.8);

  source.connect(gain).connect(ctx.destination);
  source.start();

  whiteNoiseSource = source;
  whiteNoiseGain = gain;
}

function stopWhiteNoise() {
  if (!whiteNoiseSource) return Promise.resolve();
  const ctx = getCtx();
  const now = ctx.currentTime;
  const source = whiteNoiseSource;
  const gain = whiteNoiseGain;
  whiteNoiseSource = null;
  whiteNoiseGain = null;
  return new Promise((resolve) => {
    try {
      // 400ms 淡出再停，避免"啪"一声。消息等淡出完成后再回应，
      // 这样 SW 播 chime 时不会和白噪音尾巴叠在一起。
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.4);
      source.stop(now + 0.45);
      setTimeout(resolve, 500);
    } catch {
      try { source.stop(); } catch {}
      resolve();
    }
  });
}

// 双音 chime：E5 → B5，短促、带指数衰减
function playChime() {
  const ctx = getCtx();
  const now = ctx.currentTime;

  const tone = (freq, start, dur, peak = 0.28) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peak, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, start + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  };

  tone(659.25, now,        0.55);       // E5
  tone(987.77, now + 0.12, 0.65, 0.22); // B5 略弱
}

// 临近结束的轻提示：两声短音，比状态切换 chime 更短但足够听见。
function playSoftNudge() {
  const ctx = getCtx();
  const now = ctx.currentTime;
  const tone = (freq, start, dur, peak = 0.2) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peak, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, start + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.04);
  };

  tone(783.99, now,        0.42);       // G5
  tone(1046.5, now + 0.24, 0.48, 0.18); // C6 略弱
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  (async () => {
    try {
      switch (msg.action) {
        case 'play-white-noise': playWhiteNoise(); break;
        case 'stop-white-noise': await stopWhiteNoise(); break;
        case 'play-chime':       playChime();      break;
        case 'play-soft-nudge':  playSoftNudge();  break;
      }
      sendResponse({ ok: true });
    } catch (e) {
      console.error('offscreen action failed', msg.action, e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});
