### 调试
我没法直接改你浏览器里的 storage，给你一行现成可跑的：

操作：打开设置页 → 右键 → 检查 → Console → 粘贴回车

chrome.storage.local.get('stats').then(d => {
  const s = d.stats || {};
  delete s['2026-04-20'];
  chrome.storage.local.set({ stats: s }).then(() => location.reload());
});
跑完页面会自动刷新，04-20 那一列就是 0。