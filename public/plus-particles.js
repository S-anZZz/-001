/**
 * plus-particles.js —— 收尾区块的「粒子十字」
 *
 * 由 9×9 网格中取十字（臂宽 3 格）的 45 个格子组成，
 * 每个格子放入一块方片：散落状态下四散旋转，随滚动汇聚拼成实心「+」。
 */
(function () {
  'use strict';

  const host = document.querySelector('.constellation');
  if (!host) return;

  const SPREAD = 190;          // 初始散落半径（px）
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let points = [];
  let current = 0;

  /** 生成实心十字网格：9×9 取十字，臂宽 3 格，共 45 块 */
  function plusGrid(size) {
    const cells = [];
    const N = 9;
    const unit = size / N;
    const mid = (N - 1) / 2;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (Math.abs(c - mid) > 1 && Math.abs(r - mid) > 1) continue; // 只保留十字
        cells.push({ x: (c - mid) * unit, y: (r - mid) * unit, unit });
      }
    }
    return cells;
  }

  /** 按进度把每块方片放到「散落」与「十字」之间的位置 */
  function setProgress(value) {
    current = value;
    points.forEach((el) => {
      const from = el.__from;
      const to = el.__to;
      const x = from.x + (to.x - from.x) * value;
      const y = from.y + (to.y - from.y) * value;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(90 * (1 - value)).toFixed(1)}deg)`;
      el.style.opacity = String(0.25 + 0.75 * value);
    });
  }

  /** 构建方片 */
  function build() {
    host.querySelectorAll('.constellation-point').forEach((el) => el.remove());
    const rect = host.getBoundingClientRect();
    const size = Math.min(rect.width, rect.height) * 0.74;   // 十字整体尺寸
    const cells = plusGrid(size);

    cells.forEach((cell) => {
      const square = document.createElement('span');
      square.className = 'constellation-point';
      const side = Math.max(4, cell.unit * 0.985);           // 方片几乎填满格子，拼成实心十字
      square.style.width = `${side}px`;
      square.style.height = `${side}px`;
      square.style.borderRadius = '1px';
      square.style.marginLeft = `${-side / 2}px`;
      square.style.marginTop = `${-side / 2}px`;
      square.style.opacity = '0';

      square.__from = {
        x: (Math.random() - 0.5) * SPREAD * 2,
        y: (Math.random() - 0.5) * SPREAD * 1.4,
      };
      // 目标就是格子中心，只保留极小的随机偏移，保证拼出来是实心十字
      square.__to = {
        x: cell.x + (Math.random() - 0.5) * cell.unit * 0.06,
        y: cell.y + (Math.random() - 0.5) * cell.unit * 0.06,
      };
      square.style.transition =
        `transform .9s cubic-bezier(.2,.7,.3,1) ${(Math.random() * 240).toFixed(0)}ms, opacity .5s ease`;

      host.appendChild(square);
    });

    host.classList.add('has-points');
    points = Array.from(host.querySelectorAll('.constellation-point'));
    setProgress(current);
  }

  /** 滚动进度：区块越靠近视口中部越接近 1 */
  function update() {
    if (reduce) { setProgress(1); return; }
    const rect = host.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    const p = Math.min(1, Math.max(0, (vh * 1.15 - rect.top) / (vh * 0.7)));
    setProgress(p);
  }

  build();
  setProgress(0);
  update();

  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', () => { build(); update(); }, { passive: true });

  // 兜底轮询：部分嵌入环境不派发 scroll 事件
  let lastY = window.scrollY;
  setInterval(() => {
    if (document.hidden) return;          // 页面不可见时不计算
    if (window.scrollY === lastY) return;
    lastY = window.scrollY;
    update();
  }, 120);
})();
