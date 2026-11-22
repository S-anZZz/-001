/**
 * plus-particles.js —— 收尾区块的「粒子加号」
 *
 * 做法：用 DOM 小方块做粒子（样式见 .constellation-point），
 * 其 --from-* 为散落位置、--to-* 为加号内的目标位置，
 * 滚动到该区块时把 --progress 从 0 推到 1，粒子即从散落汇聚成加号（+）。
 */
(function () {
  'use strict';

  const host = document.querySelector('.constellation');
  if (!host) return;

  const TOTAL = 110;          // 粒子数量
  const SPREAD = 210;         // 初始散落半径（px）
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let points = [];
  let current = 0;

  /** 直接写 transform：0 = 散落位置，1 = 加号位置（由 CSS transition 过渡） */
  function setProgress(value) {
    current = value;
    points.forEach((el) => {
      const from = el.__from;
      const to = el.__to;
      const x = from.x + (to.x - from.x) * value;
      const y = from.y + (to.y - from.y) * value;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(90 * (1 - value)).toFixed(1)}deg)`;
      el.style.opacity = String(0.35 + 0.65 * value);
    });
  }

  /** 生成加号网格：7×7 取十字，共 33 个格子 */
  function plusGrid(size) {
    const cells = [];
    const unit = size / 7;
    const mid = 3;
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        if (Math.abs(c - mid) > 1 && Math.abs(r - mid) > 1) continue; // 只保留十字
        cells.push({ x: (c - mid) * unit, y: (r - mid) * unit, unit });
      }
    }
    return cells;
  }

  function build() {
    host.querySelectorAll('.constellation-point').forEach((el) => el.remove());
    const rect = host.getBoundingClientRect();
    const size = Math.min(rect.width, rect.height) * 0.62;  // 加号整体尺寸
    const cells = plusGrid(size);                            // 十字网格

    for (let i = 0; i < TOTAL; i++) {
      const point = document.createElement('span');
      point.className = 'constellation-point';
      point.__from = { x: (Math.random() - 0.5) * SPREAD * 2, y: (Math.random() - 0.5) * SPREAD * 1.4 };
      const cell = cells[i % cells.length];
      point.__to = {
        x: cell.x + (Math.random() - 0.5) * cell.unit * 0.35,
        y: cell.y + (Math.random() - 0.5) * cell.unit * 0.35,
      };
      point.style.transition = `transform .95s cubic-bezier(.2,.7,.3,1) ${(i % 12) * 40}ms, opacity .6s ease`;
      point.style.transform = `translate(${point.__from.x}px, ${point.__from.y}px) rotate(90deg)`;
      point.style.opacity = '0.35';
      host.appendChild(point);
    }
    host.classList.add('has-points');   // 隐藏静态加号
    host.classList.add('has-canvas');
    points = Array.from(host.querySelectorAll('.constellation-point'));
    setProgress(current);               // 新增粒子沿用当前进度
  }

  /** 随滚动计算汇聚程度：区块越接近视口中部，越接近完整加号 */
  function update() {
    if (reduce) { setProgress(1); return; }
    const rect = host.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    const p = Math.min(1, Math.max(0, (vh * 1.05 - rect.top) / (vh * 0.8)));
    setProgress(p);
  }

  build();
  setProgress(reduce ? 1 : 0);
  update();

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; update(); });
  }, { passive: true });
  window.addEventListener('resize', () => { build(); update(); }, { passive: true });
})();
