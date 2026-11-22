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
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const state = states.find((s) => s.element === entry.target);
      if (state) start(state);
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.18, rootMargin: '0px 0px -8% 0px' });

  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      revealObserver.unobserve(entry.target);
    });
  }, { threshold: 0.15 });

  /** 扫描指定范围内的动效元素（幂等：已处理过的会跳过） */
  function setupScope(root) {
    (root || document).querySelectorAll('[data-motion-text]').forEach((el) => {
      if (el.dataset.motionReady === '1') {   // 已初始化过，仅重新观察
        const existed = states.find((s) => s.element === el);
        if (existed && !existed.started) observer.observe(el);
        return;
      }
      try {
        el.dataset.motionReady = '1';
        states.push(setupText(el));
        observer.observe(el);
      } catch (e) {
        /* 结构异常时保持原样 */
      }
    });

    (root || document).querySelectorAll('.reveal').forEach((el) => {
      if (el.dataset.revealReady === '1') return;
      el.dataset.revealReady = '1';
      el.classList.add('reveal-ready');
      revealObserver.observe(el);
    });
  }

  setupScope(document);

  // 供视图切换（登录/工作台）后调用：重新扫描并立即点亮可见内容
  window.__motionRefresh = function refreshMotion() {
    setupScope(document);
    requestAnimationFrame(() => {
      states.forEach((s) => {
        if (s.started) return;
        const rect = s.element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight * 0.95) start(s);
      });
    });
  };

  // 首屏立即可见的内容直接播放（避免等待观察器）
  requestAnimationFrame(() => {
    states.forEach((s) => {
      const rect = s.element.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.9) start(s);
    });
  });
})();
