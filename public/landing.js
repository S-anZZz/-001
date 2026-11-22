/**
 * landing.js —— 首页滚动粒子背景
 *
 * 作用：
 *   1. 用 Canvas 绘制一层固定的粒子背景，随滚动缓慢漂移；
 *   2. 用户从第一屏滚到第三屏的过程中，粒子逐渐收拢成「加号」方阵；
 *   3. 第二屏切到第三屏时，背景由白渐变为淡绿（#E7EBE2），为后续淡绿交互打底；
 *   4. 鼠标移动带轻微视差，增强交互感。
 *
 * 不依赖任何框架，只在首页（body[data-view="landing"]）运行。
 */
(function () {
  'use strict';

  const SAGE = { r: 231, g: 235, b: 226 };   // 淡绿底色
  const WHITE = { r: 255, g: 255, b: 255 };  // 初始白底
  const DOT = '90, 107, 79';                 // 粒子/方块的橄榄绿
  const GRID = 7;                            // 加号所在网格（7×7）
  const PER_CELL = 4;                        // 每个格子分配 4 个粒子

  const bgEl = document.getElementById('particleBg');
  const canvas = document.getElementById('particleCanvas');
  if (!bgEl || !canvas || !canvas.getContext) return;

  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  let particles = [];
  let cells = [];      // 加号的格子中心
  let progress = 0;    // 0 = 第一屏，1 = 第三屏
  let pointer = { x: 0, y: 0 };
  let rafId = null;

  /** 平滑插值：让滚动的线性进度更有弹性 */
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /** 计算加号网格：横向三格、纵向三格交叉的位置 */
  function buildCells() {
    const unit = Math.min(W, H) * 0.052;      // 单个格子占屏比例
    const gap = unit * 0.22;                  // 格子间隙
    const step = unit + gap;
    const mid = (GRID - 1) / 2;
    cells = [];
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const inCross = Math.abs(c - mid) <= 1 || Math.abs(r - mid) <= 1;
        if (!inCross) continue;
        cells.push({
          x: W / 2 + (c - mid) * step,
          y: H / 2 + (r - mid) * step,
          size: unit,
        });
      }
    }
  }

  /** 初始化粒子：随机分布在屏幕内，并绑定到某个加号格子 */
  function buildParticles() {
    particles = [];
    const total = cells.length * PER_CELL;
    for (let i = 0; i < total; i++) {
      const cell = cells[i % cells.length];
      particles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.28,
        vy: (Math.random() - 0.5) * 0.28,
        r: 2.2 + Math.random() * 2.4,
        cell,
        jitterX: (Math.random() - 0.5) * cell.size * 0.75,
        jitterY: (Math.random() - 0.5) * cell.size * 0.75,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  /** 根据窗口尺寸重建画布与布局 */
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    buildCells();
    buildParticles();
  }

  /** 计算滚动进度：第一屏顶部 → 第三屏顶部 */
  function readScroll() {
    const scenes = document.querySelectorAll('.landing > [data-scroll-scene]');
    if (scenes.length < 3) return;
    const first = scenes[0].getBoundingClientRect().top + window.scrollY;
    const third = scenes[2].getBoundingClientRect().top + window.scrollY;
    const span = Math.max(1, third - first);
    progress = clamp((window.scrollY - first) / span, 0, 1);
  }

  /** 顶部进度条：随首页滚动延伸 */
  const bar = document.getElementById('scrollProgress');
  function paintProgressBar() {
    if (!bar) return;
    const max = Math.max(1, document.body.scrollHeight - window.innerHeight);
    bar.style.transform = `scaleX(${clamp(window.scrollY / max, 0, 1)})`;
  }

  /** 背景色：进度过半后由白渐变为淡绿 */
  function paintBackground() {
    const t = clamp((progress - 0.45) / 0.45, 0, 1);
    const mix = (a, b) => Math.round(a + (b - a) * t);
    bgEl.style.backgroundColor =
      `rgb(${mix(WHITE.r, SAGE.r)}, ${mix(WHITE.g, SAGE.g)}, ${mix(WHITE.b, SAGE.b)})`;
    document.body.classList.toggle('sage-mode', t > 0.5); // 供后续淡绿主题使用
  }

  /** 绘制一帧 */
  function frame(time) {
    ctx.clearRect(0, 0, W, H);
    const p = easeInOut(progress);
    const tileAlpha = clamp((progress - 0.55) / 0.35, 0, 1);   // 方块淡入
    const dotAlpha = 0.55 * (1 - tileAlpha * 0.75);            // 粒子淡出

    // 1) 加号方块
    if (tileAlpha > 0) {
      ctx.save();
      cells.forEach((cell) => {
        const size = cell.size * (0.7 + 0.3 * tileAlpha);
        roundRect(cell.x - size / 2, cell.y - size / 2, size, size, size * 0.22);
        ctx.fillStyle = `rgba(${DOT}, ${0.92 * tileAlpha})`;
        ctx.fill();
      });
      ctx.restore();
    }

    // 2) 粒子：自由漂移 + 向加号收拢
    ctx.save();
    particles.forEach((pt) => {
      pt.x += pt.vx;
      pt.y += pt.vy;
      if (pt.x < -20) pt.x = W + 20;
      if (pt.x > W + 20) pt.x = -20;
      if (pt.y < -20) pt.y = H + 20;
      if (pt.y > H + 20) pt.y = -20;

      const float = Math.sin(time / 1400 + pt.phase) * 6;
      const targetX = pt.cell.x + pt.jitterX + pointer.x * 18;
      const targetY = pt.cell.y + pt.jitterY + float + pointer.y * 18;
      const x = pt.x + (targetX - pt.x) * p;
      const y = pt.y + (targetY - pt.y) * p;

      ctx.beginPath();
      ctx.arc(x, y, pt.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${DOT}, ${dotAlpha})`;
      ctx.fill();
    });
    ctx.restore();

    rafId = requestAnimationFrame(frame);
  }

  /** 圆角矩形路径 */
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** 滚动静止时回收动画循环，省电 */
  let idleTimer = null;
  function schedule() {
    readScroll();
    paintBackground();
    paintProgressBar();
    if (rafId === null) rafId = requestAnimationFrame(frame);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // 页面滚出首页时停止绘制
      if (document.body.dataset.view !== 'landing') stop();
    }, 4000);
  }

  function stop() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  window.addEventListener('resize', () => { resize(); schedule(); }, { passive: true });
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('pointermove', (e) => {
    pointer.x = (e.clientX / window.innerWidth - 0.5) * 2;
    pointer.y = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  resize();
  schedule();
})();
