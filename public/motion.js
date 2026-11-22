/**
 * motion.js —— 首页文字动效（逐字浮现 + 打字机）
 *
 * 背景：样式表里已有 .text-ready / .motion-char / .typewriter-* 等规则，
 * 但页面改版后缺少驱动脚本，标题的字效与打字机失效。本文件补上这部分：
 *
 *   1. 把 [data-motion-text] 的内容拆成「可读副本 + 逐字动画层」，保证无障碍与复制；
 *   2. 普通标题：进入视口后逐字上浮浮现（--char-delay 控制错峰）；
 *   3. 带 [data-typewriter] 的标题：逐字打出，结束加 typewriter-complete；
 *   4. .reveal 元素：进入视口淡入上移。
 *
 * 尊重 prefers-reduced-motion：系统关闭动效时直接保持静态文本。
 */
(function () {
  'use strict';

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce.matches) return; // 关闭动效时不做任何改写

  const TYPE_SPEED = 62;   // 打字机每个字的间隔（毫秒）

  /** 把文本节点拆成 motio 字符 span，并按词保留换行 */
  function splitChars(visual) {
    const walker = document.createTreeWalker(visual, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    const chars = [];
    nodes.forEach((node) => {
      const text = node.textContent;
      if (!text) return;
      const frag = document.createDocumentFragment();
      // 英文/数字按词成组，中文逐字，空白保留
      const tokens = text.match(/[A-Za-z0-9]+|\s+|[^\s]/gu) || [];
      tokens.forEach((token) => {
        if (/^\s+$/.test(token)) {
          frag.appendChild(document.createTextNode(token));
          return;
        }
        const word = document.createElement('span');
        word.className = 'motion-word';
        for (const ch of Array.from(token)) {
          const span = document.createElement('span');
          span.className = 'motion-char';
          span.textContent = ch;
          word.appendChild(span);
          chars.push(span);
        }
        frag.appendChild(word);
      });
      node.parentNode.replaceChild(frag, node);
    });
    return chars;
  }

  /** 初始化单个文本节点 */
  function setupText(element) {
    const readable = document.createElement('span');
    readable.className = 'motion-readable';
    const copy = element.cloneNode(true);
    copy.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    readable.textContent = copy.textContent;
    readable.setAttribute('aria-hidden', 'true');

    const visual = document.createElement('span');
    visual.className = 'motion-visual';
    visual.append(...element.childNodes);

    const chars = splitChars(visual);
    element.append(readable, visual);
    element.classList.add('text-ready');

    const isTypewriter = element.hasAttribute('data-typewriter');
    let cursor = null;
    if (isTypewriter) {
      element.classList.add('typewriter-ready');
      cursor = document.createElement('span');
      cursor.className = 'typewriter-cursor';
      cursor.setAttribute('aria-hidden', 'true');
      element.appendChild(cursor);
    } else {
      chars.forEach((c, i) => c.style.setProperty('--char-delay', `${Math.min(i * 22, 700)}ms`));
    }

    return {
      element,
      chars,
      isTypewriter,
      started: false,
      index: 0,
      timer: null,
    };
  }

  /** 打字机：逐字显示 */
  function typeNext(state) {
    if (state.index >= state.chars.length) {
      state.element.classList.remove('is-typing');
      state.element.classList.add('typewriter-complete');
      return;
    }
    state.chars[state.index].classList.add('is-typed');
    state.index += 1;
    state.timer = setTimeout(() => typeNext(state), TYPE_SPEED);
  }

  function start(state) {
    if (state.started) return;
    state.started = true;
    state.element.classList.add('is-visible');
    if (state.isTypewriter) {
      state.element.classList.add('is-typing');
      typeNext(state);
    }
  }

  // 1) 逐字文本 + 打字机
  // 收集状态并统一观察，支持在切换视图后重新扫描新出现的元素
  const states = [];
  /** 播放：逐字浮现或打字机 */
  function play(state) {
    if (state.started) return;
    start(state);
  }

  /** 回退：清空已打的字，恢复初始状态，向上滚动时线条与文字一起收回 */
  function reset(state) {
    if (!state.started) return;
    state.started = false;
    state.index = 0;
    clearTimeout(state.timer);
    state.element.classList.remove('is-visible', 'is-typing', 'typewriter-complete');
    state.chars.forEach((c) => c.classList.remove('is-typed'));
  }

  const lineEls = [];
  let rafPending = false;

  /** 统一的可见性判断：进入视口下部即播放，离开（向上滚出）即回退 */
  function evaluate() {
    rafPending = false;
    try {
    const vh = window.innerHeight || 800;

    states.forEach((state) => {
      const rect = state.element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;      // 隐藏视图内的元素跳过
      const on = rect.top < vh * 0.88 && rect.bottom > vh * 0.08;
      const shown = state.element.classList.contains('is-visible');
      if (on && !shown) {
        state.element.classList.add('is-visible');
        play(state);
      } else if (!on && shown) {
        state.element.classList.remove('is-visible');
        reset(state);
      }
    });

    lineEls.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const on = rect.top < vh * 0.9 && rect.bottom > vh * 0.05;
      el.classList.toggle('is-visible', on);
    });

    document.querySelectorAll('.reveal').forEach((el) => {
      const rect = el.getBoundingClientRect();
      el.classList.toggle('is-visible', rect.top < vh * 0.9 && rect.bottom > 0);
    });
    } catch (err) { /* 单个元素异常不影响其它元素 */ }
  }

  let lastRun = 0;
  function schedule() {
    const now = performance.now();
    if (now - lastRun < 40) return;   // 轻量节流，避免滚动时频繁重排
    lastRun = now;
    evaluate();
  }

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });

  // 兜底轮询：某些嵌入环境（iframe / 无头浏览器）不派发 scroll，靠位置变化补上
  let lastY = window.scrollY;
  let lastH = window.innerHeight;
  let pollTimer = setInterval(() => {
    if (document.hidden) return;                       // 页面不可见时不计算
    if (window.scrollY === lastY && window.innerHeight === lastH) return;
    lastY = window.scrollY;
    lastH = window.innerHeight;
    evaluate();
    if (typeof window.__paintRule === 'function') window.__paintRule();  // 顺带推进顶部滚动线
  }, 120);

  // 真实浏览器会派发 scroll，收到后即可停掉轮询
  window.addEventListener('scroll', () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }, { passive: true, once: true });

  // 首屏评估放在线条注册之后，保证首屏的分隔线也能立刻展开
  evaluate();

  /** 扫描指定范围内的动效元素（幂等：已处理过的会跳过） */
  function setupScope(root) {
    (root || document).querySelectorAll('[data-motion-text]').forEach((el) => {
      if (el.dataset.motionReady === '1') {   // 已初始化过：仍在观察中则跳过
        const existed = states.find((s) => s.element === el);
        if (!existed) states.push(setupText(el));
        return;
      }
      try {
        el.dataset.motionReady = '1';
        states.push(setupText(el));
      } catch (e) {
        /* 结构异常时保持原样 */
      }
    });

    (root || document).querySelectorAll('.reveal').forEach((el) => {
      if (el.dataset.revealReady === '1') return;
      el.dataset.revealReady = '1';
      el.classList.add('reveal-ready');
    });
  }

  setupScope(document);

  // 供视图切换（登录/工作台）后调用：重新扫描并立即点亮可见内容
  window.__motionRefresh = function refreshMotion() {
    setupScope(document);
    schedule();
  };


  // 5) 滚动指示线：下滑自左向右延展；上滑自右向左收拢并消散
  const rule = document.getElementById('scrollRule');
  const ghost = document.getElementById('scrollRuleGhost');
  if (rule) {
    let lastY = window.scrollY;
    let ticking = false;
    let ghostAt = 0;

    const paintRule = () => {
      ticking = false;
      const max = Math.max(1, document.body.scrollHeight - window.innerHeight);
      const p = Math.min(1, Math.max(0, window.scrollY / max));
      rule.style.transform = `scaleX(${p})`;

      const goingUp = window.scrollY < lastY - 1;   // 向上滚动
      if (goingUp && ghost && performance.now() - ghostAt > 420) {
        ghostAt = performance.now();
        ghost.animate(
          [
            { transform: `scaleX(${p})`, opacity: .75 },
            { transform: 'scaleX(0)', opacity: 0 },
          ],
          { duration: 620, easing: 'cubic-bezier(.25,.7,.3,1)', fill: 'forwards' }
        );
      }
      lastY = window.scrollY;
    };

    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(paintRule);
    }, { passive: true });

    window.__paintRule = paintRule;
    paintRule();
  }

  // 6) 介绍页所有分隔线：进入视图自左向右展开，向上滚出时自右向左收回
  const lineSelector = [
    '.landing-explore', '.closing-link', '.landing-footer',
    '.journey-card .journey-foot', '.connection-note', '.paper-rule',
    '.landing-section-head .rule', '.audience-switch',
    '.auth-letter-line', 'hr',
  ].join(', ');
  document.querySelectorAll(lineSelector).forEach((el) => {
    el.classList.add('line-draw');
    // 本身带下边框的元素：隐藏原生边框，只保留动画绘制的那条线，避免叠成两根
    const style = window.getComputedStyle(el);
    if (parseFloat(style.borderBottomWidth) > 0) el.classList.add('line-draw--border');
    lineEls.push(el);
  });

  // 首屏立即可见的内容直接播放（线条此时已注册完毕）
  evaluate();
})();
