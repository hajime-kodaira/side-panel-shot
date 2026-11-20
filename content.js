// Side Panel Shot - content script
// 1) 要素ピッカーで撮りたい領域を選ぶ
// 2) その領域をスクロールしながら captureVisibleTab で撮影する
// 3) 1枚の PNG に結合して保存する（クリップボードにもコピー）
(() => {
  'use strict';

  const NS = '__sidePanelShot';
  // 2回目のクリックは「キャンセル」として扱う
  if (window[NS]) {
    window[NS].cancel();
    return;
  }

  const CONFIG = {
    settleMs: 150, // スクロール後、描画が落ち着くまで待つ時間
    captureIntervalMs: 600, // captureVisibleTab は1秒に2回までしか呼べない
    overlapPx: 8, // 継ぎ目に隙間ができないよう少し重ねて撮る
    maxFrames: 400, // 無限スクロール対策の上限
    maxImageHeight: 30000, // 1枚の画像の高さ上限（デバイスピクセル）。超えたら分割する
    kbdHoldPx: 16, // キーボードで候補を調整した後、この距離未満のマウス移動では候補を変えない
  };

  const root = document.scrollingElement || document.documentElement;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () =>
    new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      requestAnimationFrame(fin);
      setTimeout(fin, 120); // タブが裏に回ると rAF が止まるので保険
    });
  const settle = async () => {
    await nextFrame();
    await nextFrame();
    await sleep(CONFIG.settleMs);
  };

  class Cancelled extends Error {}
  let cancelled = false;
  let phase = 'pick'; // pick -> capture -> done
  const checkCancel = () => {
    if (cancelled) throw new Cancelled();
  };

  // ---------------------------------------------------------------- UI
  // ページの CSP に引っかからないよう、スタイルはすべて CSSOM 経由で設定する
  const css = (el, props) => {
    for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, 'important');
    return el;
  };
  const FONT = '12px/1.5 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Segoe UI", sans-serif';

  const host = document.createElement('div');
  host.setAttribute('data-side-panel-shot', '');
  host.style.setProperty('all', 'initial');
  css(host, {
    display: 'block',
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    margin: '0',
    padding: '0',
    border: '0',
    background: 'transparent',
    overflow: 'visible',
    'pointer-events': 'none',
    'z-index': '2147483647',
  });
  const shadow = host.attachShadow({ mode: 'closed' });
  const mk = (props) => {
    const el = document.createElement('div');
    css(el, { position: 'fixed', 'box-sizing': 'border-box', font: FONT, ...props });
    shadow.appendChild(el);
    return el;
  };
  const box = mk({
    border: '2px solid #1a73e8',
    background: 'rgba(26, 115, 232, 0.12)',
    'border-radius': '2px',
    display: 'none',
  });
  const innerBox = mk({
    border: '2px dashed #1a73e8',
    display: 'none',
  });
  const hoverBox = mk({
    border: '2px dashed #188038',
    background: 'rgba(24, 128, 56, 0.10)',
    'border-radius': '2px',
    display: 'none',
  });
  const memberBoxes = [];
  const label = mk({
    background: '#1a73e8',
    color: '#fff',
    padding: '2px 8px',
    'border-radius': '4px',
    'white-space': 'nowrap',
    'max-width': '90vw',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    display: 'none',
  });
  const hoverLabel = mk({
    background: '#188038',
    color: '#fff',
    padding: '2px 8px',
    'border-radius': '4px',
    'white-space': 'nowrap',
    'max-width': '90vw',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    display: 'none',
  });
  const bar = mk({
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    'align-items': 'center',
    gap: '8px',
    background: 'rgba(32, 33, 36, 0.94)',
    color: '#fff',
    padding: '8px 14px',
    'border-radius': '8px',
    'box-shadow': '0 2px 10px rgba(0,0,0,0.3)',
    'white-space': 'nowrap',
    'max-width': 'calc(100vw - 24px)',
    'pointer-events': 'auto',
    'user-select': 'none',
  });
  const barText = document.createElement('span');
  css(barText, {
    font: FONT,
    color: '#fff',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
  });
  bar.appendChild(barText);

  const mkBtn = (text, bg, border) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    css(btn, {
      font: FONT,
      'font-weight': '600',
      color: '#fff',
      background: bg,
      border: border || 'none',
      'border-radius': '5px',
      padding: '3px 10px',
      cursor: 'pointer',
      'flex-shrink': '0',
      display: 'none',
    });
    bar.appendChild(btn);
    return btn;
  };
  const captureBtn = mkBtn('撮影する (Enter)', '#1a73e8');
  const clearBtn = mkBtn('クリア', 'rgba(255, 255, 255, 0.14)', '1px solid rgba(255, 255, 255, 0.3)');

  function getMemberBox(index) {
    while (memberBoxes.length <= index) {
      const el = document.createElement('div');
      css(el, {
        position: 'fixed',
        'box-sizing': 'border-box',
        border: '1px dashed rgba(26, 115, 232, 0.7)',
        background: 'rgba(26, 115, 232, 0.04)',
        'border-radius': '2px',
        display: 'none',
      });
      shadow.insertBefore(el, box);
      memberBoxes.push(el);
    }
    return memberBoxes[index];
  }

  function hideMemberBoxes(fromIndex = 0) {
    for (let i = fromIndex; i < memberBoxes.length; i++) {
      memberBoxes[i].style.setProperty('display', 'none', 'important');
    }
  }

  function hideOverlays() {
    for (const el of [box, innerBox, hoverBox, label, hoverLabel]) {
      el.style.setProperty('display', 'none', 'important');
    }
    hideMemberBoxes(0);
  }

  function mount() {
    document.documentElement.appendChild(host);
    // モーダルダイアログ（top layer）より手前に出すため、使えるなら Popover API に載せる
    try {
      host.popover = 'manual';
      host.showPopover();
    } catch (_) {
      /* 非対応でも z-index で表示される */
    }
  }
  function unmount() {
    try {
      host.hidePopover();
    } catch (_) {}
    host.remove();
  }

  function toast(text, isError) {
    hideOverlays();
    captureBtn.style.setProperty('display', 'none', 'important');
    clearBtn.style.setProperty('display', 'none', 'important');
    css(bar, {
      display: 'flex',
      background: isError ? 'rgba(197, 34, 31, 0.96)' : 'rgba(32, 33, 36, 0.94)',
      'white-space': 'normal',
      'max-width': '80vw',
      'pointer-events': 'none',
    });
    barText.textContent = text;
  }

  const badge = (text) => {
    try {
      chrome.runtime.sendMessage({ type: 'sps-badge', text }).catch(() => {});
    } catch (_) {}
  };

  // ---------------------------------------------------------- 対象の決定
  const parentOf = (el) => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  const isRootish = (el) => el === document.documentElement || el === document.body;

  function isScrollableY(el) {
    if (!(el instanceof Element)) return false;
    if (el.scrollHeight - el.clientHeight <= 1) return false;
    return /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);
  }

  function isVisibleElement(el) {
    if (!(el instanceof Element) || el === host || isRootish(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function containsOrEqual(ancestor, descendant) {
    for (let cur = descendant; cur; cur = parentOf(cur)) {
      if (cur === ancestor) return true;
    }
    return false;
  }

  function unionRect(frames) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const el of frames) {
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) continue;
      if (r.left < left) left = r.left;
      if (r.top < top) top = r.top;
      if (r.right > right) right = r.right;
      if (r.bottom > bottom) bottom = r.bottom;
    }
    if (!Number.isFinite(left)) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  // マウス位置の要素から見て、一番近いスクロール領域。無ければその要素自体。
  function defaultTarget(el) {
    for (let cur = el; cur && !isRootish(cur); cur = parentOf(cur)) {
      if (isScrollableY(cur)) return cur;
    }
    return el;
  }

  // 同じ階層の可視兄弟要素一覧を取得する。
  // 自身がほぼ同サイズの単一子ラッパーに包まれている場合のみ、親へ昇格して兄弟を探す。
  function siblingContextOf(el) {
    let cur = el;
    for (let depth = 0; depth < 6 && cur && !isRootish(cur); depth++) {
      const container = cur.parentElement || (cur.getRootNode && cur.getRootNode());
      const raw = container && container.children ? Array.from(container.children) : [];
      const siblings = raw.filter((c) => c === cur || isVisibleElement(c));
      if (siblings.length > 1) return { target: cur, siblings, index: siblings.indexOf(cur) };

      const p = cur.parentElement;
      if (!p || isRootish(p)) break;
      const cr = cur.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      const sameSize =
        Math.abs(pr.left - cr.left) <= 4 &&
        Math.abs(pr.right - cr.right) <= 4 &&
        Math.abs(pr.top - cr.top) <= 4 &&
        Math.abs(pr.bottom - cr.bottom) <= 4;
      if (!sameSize) break;
      cur = p;
    }
    return { target: el, siblings: [el], index: 0 };
  }

  // 選択された要素群の中に「幅のほとんどを占めるスクロール領域」があれば、それを中身として扱う
  // （ヘッダー + スクロールするリスト、のようなパネルを丸ごと撮るため）
  function findInnerScroller(frames, fr) {
    if (!fr || fr.width <= 0 || fr.height <= 0) return null;
    let bestDirect = null;
    let bestDirectArea = 0;
    let bestInner = null;
    let bestInnerArea = 0;

    for (const el of frames) {
      if (!el || !el.isConnected) continue;
      if (!isRootish(el) && isScrollableY(el)) {
        const r = el.getBoundingClientRect();
        if (r.width >= fr.width * 0.8) {
          const area = r.width * r.height;
          if (area > bestDirectArea) {
            bestDirect = el;
            bestDirectArea = area;
          }
        }
        continue;
      }
      const all = el.querySelectorAll('*');
      if (all.length > 30000) continue;
      for (const c of all) {
        if (!isScrollableY(c)) continue;
        const r = c.getBoundingClientRect();
        if (r.width < fr.width * 0.8) continue;
        const area = r.width * r.height;
        if (area > bestInnerArea) {
          bestInner = c;
          bestInnerArea = area;
        }
      }
    }
    const minArea = fr.width * fr.height * 0.3;
    if (bestDirect && bestDirectArea >= minArea) return bestDirect;
    return bestInner && bestInnerArea >= minArea ? bestInner : null;
  }

  function scrollAncestors(el) {
    const list = [];
    for (let cur = parentOf(el); cur && !isRootish(cur); cur = parentOf(cur)) {
      if (isScrollableY(cur)) list.push(cur);
    }
    list.push(root);
    return list;
  }

  function commonScrollParent(frames) {
    if (!frames.length) return root;
    const first = scrollAncestors(frames[0]);
    if (frames.length === 1) return first[0];
    const others = frames.slice(1).map((el) => new Set(scrollAncestors(el)));
    for (const s of first) {
      if (others.every((set) => set.has(s))) return s;
    }
    return root;
  }

  function buildPlan(frames) {
    const connected = frames.filter((el) => el && el.isConnected);
    if (!connected.length) return null;
    if (connected.length === 1 && !isRootish(connected[0]) && isScrollableY(connected[0])) {
      return { kind: 'scroll', frames: connected, scroller: connected[0] };
    }
    const fr = unionRect(connected);
    const inner = findInnerScroller(connected, fr);
    if (inner) return { kind: 'scroll', frames: connected, scroller: inner };
    return { kind: 'element', frames: connected, scroller: commonScrollParent(connected) };
  }

  // ------------------------------------------------------------ ピッカー
  let chain = []; // ↑ キーで広げた履歴（末尾が現在のフォーカス要素）
  let rangeAnchor = null; // Shift+←/→ での兄弟範囲選択の起点
  let rangeEnd = null; // Shift+←/→ での兄弟範囲選択の終点
  let pinned = []; // Shift+Click で複数選択モードに入った際の選択要素一覧
  let plan = null;
  let lastPointer = { x: -1, y: -1 };
  let lastHoverEl = null; // 最後にマウスが乗っていたページ側の要素（操作バー上は含まない）
  let kbdHold = null; // キーボードで候補を調整した直後の保持情報 { x, y, el }

  function holdKeyboardChoice(el = null) {
    kbdHold = { x: lastPointer.x, y: lastPointer.y, el };
  }

  function clearSiblingRange() {
    rangeAnchor = null;
    rangeEnd = null;
  }

  function currentFocusFrames() {
    if (rangeAnchor && rangeEnd && rangeAnchor.isConnected && rangeEnd.isConnected) {
      const ctx = siblingContextOf(rangeAnchor);
      const a = ctx.siblings.indexOf(rangeAnchor);
      const b = ctx.siblings.indexOf(rangeEnd);
      if (a !== -1 && b !== -1) {
        const from = Math.min(a, b);
        const to = Math.max(a, b);
        return ctx.siblings.slice(from, to + 1);
      }
      clearSiblingRange();
    }
    const target = chain[chain.length - 1];
    return target && target.isConnected ? [target] : [];
  }

  function activeFrames() {
    pinned = pinned.filter((el) => el && el.isConnected);
    if (pinned.length > 0) return pinned;
    return currentFocusFrames();
  }

  function isContainedInPinned(el) {
    return pinned.some((p) => containsOrEqual(p, el));
  }

  function togglePinnedElements(targets) {
    const valid = targets.filter((el) => el && el.isConnected);
    if (!valid.length) return;

    const allAlreadyIn = valid.every((el) => isContainedInPinned(el));
    if (allAlreadyIn) {
      // 既に選択済み（または選択済み要素の内部）なら解除する
      const toRemove = new Set();
      for (const el of valid) {
        for (const p of pinned) {
          if (containsOrEqual(p, el)) toRemove.add(p);
        }
      }
      pinned = pinned.filter((p) => !toRemove.has(p));
    } else {
      for (const el of valid) {
        if (isContainedInPinned(el)) continue;
        // これから追加する要素の子孫が既にピン留めされていれば、親側へ統合する
        pinned = pinned.filter((p) => !containsOrEqual(el, p));
        pinned.push(el);
      }
    }
    clearSiblingRange();
  }

  function place(el, r) {
    css(el, {
      display: 'block',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }

  function placeLabel(el, r, text, preferBottom = false) {
    el.textContent = text;
    let top;
    if (!preferBottom && r.top >= 26) {
      top = r.top - 24;
    } else if (r.bottom + 26 <= window.innerHeight) {
      top = r.bottom + 4;
    } else {
      top = Math.max(4, Math.min(r.top + 4, window.innerHeight - 24));
    }
    css(el, {
      display: 'block',
      left: `${Math.max(4, Math.min(r.left, window.innerWidth - 40))}px`,
      top: `${Math.max(4, top)}px`,
    });
  }

  function updateBar(frames) {
    const isMulti = pinned.length > 0;
    const isSiblingRange = !isMulti && frames.length > 1;
    if (isMulti) {
      barText.textContent = `複数選択中（${pinned.length} 要素）　｜　クリック：追加・解除　｜　↑↓←→：候補調整　｜　Backspace：戻す`;
      captureBtn.style.setProperty('display', 'inline-block', 'important');
      clearBtn.style.setProperty('display', 'inline-block', 'important');
    } else if (isSiblingRange) {
      barText.textContent = `隣接 ${frames.length} 要素を選択中　｜　クリック / Enter：撮影　｜　Shift+←→：増減　｜　Shift+クリック：複数選択へ`;
      captureBtn.style.setProperty('display', 'inline-block', 'important');
      clearBtn.style.setProperty('display', 'inline-block', 'important');
    } else {
      barText.textContent =
        'クリック：撮影　｜　↑↓：広げる・戻す　｜　←→：隣へ（Shiftで追加）　｜　Shift+クリック：複数選択　｜　Esc：キャンセル';
      captureBtn.style.setProperty('display', 'none', 'important');
      clearBtn.style.setProperty('display', 'none', 'important');
    }
  }

  function refresh() {
    const frames = activeFrames();
    updateBar(frames);

    if (!frames.length) {
      plan = null;
      hideOverlays();
      return;
    }

    plan = buildPlan(frames);
    const fr = plan && unionRect(plan.frames);
    if (!plan || !fr) {
      plan = null;
      hideOverlays();
      return;
    }

    place(box, fr);

    // 複数要素選択時は、構成要素ごとの境界も薄い破線で表示する
    if (plan.frames.length > 1) {
      plan.frames.forEach((el, i) => {
        place(getMemberBox(i), el.getBoundingClientRect());
      });
      hideMemberBoxes(plan.frames.length);
    } else {
      hideMemberBoxes(0);
    }

    let text;
    const countPrefix = plan.frames.length > 1 ? `${plan.frames.length}要素  ` : '';
    if (plan.kind === 'scroll') {
      const S = plan.scroller;
      const total = Math.round(fr.height - S.clientHeight + S.scrollHeight);
      text = `${countPrefix}スクロール領域  ${Math.round(fr.width)} × ${total}px（表示中 ${Math.round(fr.height)}px）`;
      if (plan.frames.length !== 1 || S !== plan.frames[0]) {
        place(innerBox, S.getBoundingClientRect());
      } else {
        innerBox.style.setProperty('display', 'none', 'important');
      }
    } else {
      text = `${countPrefix}要素  ${Math.round(fr.width)} × ${Math.round(fr.height)}px`;
      innerBox.style.setProperty('display', 'none', 'important');
    }
    placeLabel(label, fr, text, false);

    // 複数選択モード中は、マウス下の候補要素を緑（追加）／赤（解除）でプレビュー表示
    if (pinned.length > 0) {
      const hoverFrames = currentFocusFrames();
      const hr = unionRect(hoverFrames);
      if (hr) {
        const willRemove = hoverFrames.every((el) => isContainedInPinned(el));
        const color = willRemove ? '#d93025' : '#188038';
        const bg = willRemove ? 'rgba(217, 48, 37, 0.10)' : 'rgba(24, 128, 56, 0.10)';
        css(hoverBox, { border: `2px dashed ${color}`, background: bg });
        place(hoverBox, hr);
        css(hoverLabel, { background: color });
        const hint = willRemove
          ? 'クリックで解除'
          : hoverFrames.length > 1
            ? `クリックで ${hoverFrames.length} 要素を追加`
            : 'クリックで追加';
        const nearMainLabel = Math.abs(hr.top - fr.top) < 28 && Math.abs(hr.left - fr.left) < 220;
        placeLabel(hoverLabel, hr, `${hint}  ${Math.round(hr.width)} × ${Math.round(hr.height)}px`, nearMainLabel);
      } else {
        hoverBox.style.setProperty('display', 'none', 'important');
        hoverLabel.style.setProperty('display', 'none', 'important');
      }
    } else {
      hoverBox.style.setProperty('display', 'none', 'important');
      hoverLabel.style.setProperty('display', 'none', 'important');
    }
  }

  function moveSibling(delta, extend) {
    const cur = rangeEnd || chain[chain.length - 1];
    if (!cur || !cur.isConnected) return;
    const ctx = siblingContextOf(cur);
    const nextIdx = ctx.index + delta;
    if (nextIdx < 0 || nextIdx >= ctx.siblings.length) return;
    const nextEl = ctx.siblings[nextIdx];

    if (extend) {
      if (!rangeAnchor || !rangeAnchor.isConnected) {
        rangeAnchor = ctx.target;
      } else if (ctx.siblings.indexOf(rangeAnchor) === -1) {
        rangeAnchor = ctx.target;
      }
      rangeEnd = nextEl;
      if (rangeAnchor === rangeEnd) {
        clearSiblingRange();
        chain = [nextEl];
      } else {
        // 範囲を解除したら起点に戻る
        chain = [rangeAnchor];
      }
      holdKeyboardChoice();
    } else {
      clearSiblingRange();
      chain = [nextEl];
      holdKeyboardChoice(nextEl);
    }
    refresh();
  }

  const swallow = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  function isPointInRect(x, y, r) {
    return r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function onMove(e) {
    lastPointer = { x: e.clientX, y: e.clientY };
    const path = e.composedPath ? e.composedPath() : [];
    const el = path[0] instanceof Element ? path[0] : e.target;
    if (!(el instanceof Element) || el === host) return;
    lastHoverEl = el;

    // キーボードで候補を調整した直後は、マウスの微動や、選んだ兄弟要素の上での移動では候補を変えない
    if (kbdHold) {
      const near = Math.hypot(e.clientX - kbdHold.x, e.clientY - kbdHold.y) < CONFIG.kbdHoldPx;
      const onChosen = kbdHold.el && kbdHold.el.isConnected && containsOrEqual(kbdHold.el, el);
      if (near || onChosen) return;
      kbdHold = null;
    }

    // 兄弟範囲選択中は、選択範囲内でのマウス微動で解除されないようにする
    if (pinned.length === 0 && rangeAnchor && rangeEnd) {
      const r = unionRect(currentFocusFrames());
      if (isPointInRect(e.clientX, e.clientY, r)) return;
      clearSiblingRange();
    }

    const t = defaultTarget(el);
    // ↑ で広げたあとは、元のターゲットの内側にいる間は広げた状態を保つ
    if (chain.length > 1 && chain[0].isConnected && containsOrEqual(chain[0], el)) {
      return;
    }
    if (!rangeAnchor && chain[0] === t && chain.length === 1) return;
    if (chain[0] !== t) {
      clearSiblingRange();
      chain = [t];
    }
    refresh();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      swallow(e);
      cancel();
      return;
    }
    if (phase !== 'pick') return;
    if (e.key === 'ArrowUp') {
      swallow(e);
      clearSiblingRange();
      const cur = chain[chain.length - 1];
      const p = cur && parentOf(cur);
      if (p && p !== document.documentElement) {
        chain.push(p);
        holdKeyboardChoice();
        refresh();
      }
    } else if (e.key === 'ArrowDown') {
      swallow(e);
      if (rangeAnchor) {
        clearSiblingRange();
        holdKeyboardChoice();
        refresh();
      } else if (chain.length > 1) {
        chain.pop();
        holdKeyboardChoice();
        refresh();
      }
    } else if (e.key === 'ArrowLeft') {
      swallow(e);
      moveSibling(-1, e.shiftKey);
    } else if (e.key === 'ArrowRight') {
      swallow(e);
      moveSibling(1, e.shiftKey);
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && (pinned.length > 0 || rangeAnchor)) {
      swallow(e);
      if (pinned.length > 0) {
        pinned.pop();
      } else {
        clearSiblingRange();
      }
      refresh();
    } else if (e.key === 'Enter') {
      swallow(e);
      if (plan) start();
    }
  }

  function onClick(e) {
    // バー上のイベントもページ側へ流さない（外側クリックで閉じるダイアログ対策）
    swallow(e);
    if (e.type !== 'click') return;

    // バー上のクリックは、ボタンの矩形でヒットテストして処理する
    if (e.target === host) {
      const hit = (btn) => {
        const r = btn.getBoundingClientRect();
        return r.width > 0 && isPointInRect(e.clientX, e.clientY, r);
      };
      if (hit(captureBtn)) {
        if (plan) start();
      } else if (hit(clearBtn)) {
        clearSelection();
      }
      return;
    }

    const focus = currentFocusFrames();
    if (pinned.length > 0) {
      if (focus.length) {
        togglePinnedElements(focus);
        refresh();
      }
      return;
    }

    if (e.shiftKey) {
      if (focus.length) {
        togglePinnedElements(focus);
        refresh();
      }
      return;
    }

    if (plan) start();
  }

  function clearSelection() {
    if (phase !== 'pick') return;
    pinned = [];
    clearSiblingRange();
    kbdHold = null;
    // 操作バーに入る直前にマウスが乗っていたページ側の要素を候補に戻す
    if (lastHoverEl && lastHoverEl.isConnected) chain = [defaultTarget(lastHoverEl)];
    refresh();
  }

  const onWheelBlock = (e) => {
    if (phase === 'capture') e.preventDefault();
  };

  const BLOCKED = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'dblclick', 'auxclick'];
  function addPickListeners() {
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('scroll', refresh, true);
    window.addEventListener('keydown', onKey, true);
    for (const t of BLOCKED) {
      window.addEventListener(t, onClick, true);
    }
    updateBar([]);
  }
  function removePickListeners() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('scroll', refresh, true);
    for (const t of BLOCKED) {
      window.removeEventListener(t, onClick, true);
    }
  }

  function cleanup() {
    removePickListeners();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('wheel', onWheelBlock, { capture: true });
    unmount();
    badge('');
    delete window[NS];
  }

  function cancel() {
    if (phase === 'pick') {
      cleanup();
    } else if (phase === 'capture') {
      cancelled = true; // 撮影ループ側で検知して後片付けする
    } else {
      cleanup();
    }
  }

  // ---------------------------------------------------------------- 撮影
  let lastShot = 0;

  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  // 表示中のタブを撮影し、rect（ビューポート座標・CSSピクセル）の部分だけ切り出して返す
  async function grab(rect) {
    checkCancel();
    const wait = lastShot + CONFIG.captureIntervalMs - performance.now();
    if (wait > 0) await sleep(wait);
    checkCancel();
    if (document.visibilityState !== 'visible') {
      throw new Error('タブが裏に回ったため中断しました。撮影中はこのタブを表示したままにしてください。');
    }
    let res;
    for (let k = 0; k < 4; k++) {
      res = await chrome.runtime.sendMessage({ type: 'sps-capture' });
      lastShot = performance.now();
      if (res?.ok) break;
      if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS/.test(res?.error || '')) break;
      await sleep(700);
    }
    if (!res?.ok) {
      if (res?.error === 'TAB_NOT_ACTIVE') {
        throw new Error('タブが切り替わったため中断しました。撮影中はこのタブを表示したままにしてください。');
      }
      throw new Error(`撮影に失敗しました: ${res?.error || '不明なエラー'}`);
    }
    const full = await createImageBitmap(dataUrlToBlob(res.dataUrl));
    const scale = full.width / window.innerWidth;
    const sx = Math.max(0, Math.round(rect.left * scale));
    const sy = Math.max(0, Math.round(rect.top * scale));
    const sw = Math.min(full.width, Math.round(rect.right * scale)) - sx;
    const sh = Math.min(full.height, Math.round(rect.bottom * scale)) - sy;
    if (sw < 1 || sh < 1) {
      full.close();
      return null;
    }
    const bitmap = await createImageBitmap(full, sx, sy, sw, sh);
    full.close();
    return { bitmap, scale, sy };
  }

  // 後片付け用: スタイルやスクロール位置を一時的に変え、最後に元へ戻す
  function makeRestorer() {
    const undo = [];
    return {
      style(el, prop, value) {
        const hadAttr = el.hasAttribute('style');
        const old = el.style.getPropertyValue(prop);
        const pri = el.style.getPropertyPriority(prop);
        el.style.setProperty(prop, value, 'important');
        undo.push(() => {
          if (old) el.style.setProperty(prop, old, pri);
          else el.style.removeProperty(prop);
          if (!hadAttr && !el.getAttribute('style')) el.removeAttribute('style');
        });
      },
      scrollOf(el) {
        const top = el.scrollTop;
        const left = el.scrollLeft;
        undo.push(() => {
          el.scrollTop = top;
          el.scrollLeft = left;
        });
      },
      ancestorsOf(el) {
        for (let cur = parentOf(el); cur; cur = parentOf(cur)) this.scrollOf(cur);
        this.scrollOf(root);
      },
      run() {
        while (undo.length) {
          try {
            undo.pop()();
          } catch (_) {}
        }
      },
    };
  }

  // スクロールしても貼り付いたままの要素（position: sticky のヘッダー等）の高さを調べる。
  // 2枚目以降でこれを含めると、ヘッダーが何度も写り込んでしまうため。
  function stickyInsets(S, b) {
    let top = 0;
    let bottom = 0;
    const all = S.querySelectorAll('*');
    if (all.length > 20000) return { top, bottom };
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.height > b.height * 0.6) continue;
      const t = parseFloat(cs.top);
      const bt = parseFloat(cs.bottom);
      if (!Number.isNaN(t) && Math.abs(r.top - b.top - t) <= 1.5) {
        top = Math.max(top, r.bottom - b.top);
      } else if (!Number.isNaN(bt) && Math.abs(b.bottom - r.bottom - bt) <= 1.5) {
        bottom = Math.max(bottom, b.bottom - r.top);
      }
    }
    if (top + bottom > b.height * 0.6) return { top: 0, bottom: 0 };
    return { top, bottom };
  }

  // スクロール領域（frames の中の scroller）を上から下まで撮る
  async function captureScroll(frames, S, restorer) {
    const vw = () => window.innerWidth;
    const vh = () => window.innerHeight;

    const fr0 = unionRect(frames);
    if (!fr0) return { parts: [], truncated: false };
    if (fr0.top < 0 || fr0.bottom > vh() || fr0.left < 0 || fr0.right > vw()) {
      for (const el of frames) restorer.ancestorsOf(el);
      // 内側スクローラではなく選択要素そのものを画面内へ寄せる。
      // 下にある要素から順に寄せ、最後に最上部の要素を寄せることで、収まりきらない場合は上端側を優先する
      const tops = new Map();
      for (const el of frames) {
        if (el && el.isConnected) tops.set(el, el.getBoundingClientRect().top);
      }
      const ordered = [...tops.keys()].sort((a, b) => tops.get(b) - tops.get(a));
      for (const el of ordered) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    restorer.style(S, 'scroll-behavior', 'auto');
    restorer.style(S, 'scroll-snap-type', 'none');
    restorer.style(S, 'scrollbar-width', 'none'); // スクロールバーが写り込まないように
    restorer.scrollOf(S);

    // column-reverse のチャット欄などは scrollTop が負の範囲になるので、最小値を基準にする
    S.scrollTop = -1e7;
    const base = S.scrollTop;

    const measure = () => {
      const fr = unionRect(frames);
      if (!fr) return null;
      const sr = S.getBoundingClientRect();
      const b = { top: sr.top + S.clientTop, height: S.clientHeight };
      b.bottom = b.top + b.height;
      const pos = S.scrollTop - base;
      const atEnd = pos >= S.scrollHeight - S.clientHeight - 1;
      const clipped = b.top < -0.5 || b.bottom > vh() + 0.5;
      const inset = clipped ? { top: 0, bottom: 0 } : stickyInsets(S, b);
      return { fr, b, pos, atEnd, inset };
    };

    const parts = [];
    let covered = 0; // スクロール内容のうち、どこまで撮れたか（CSSピクセル）
    let est = { top: 0, bottom: 0 };
    let truncated = false;

    for (let i = 0; i < CONFIG.maxFrames; i++) {
      checkCancel();
      let m;
      let target = i === 0 ? 0 : covered - est.top - CONFIG.overlapPx;
      for (let attempt = 0; attempt < 3; attempt++) {
        S.scrollTop = base + Math.max(0, target);
        await settle();
        m = measure();
        if (!m || i === 0 || m.pos + m.inset.top <= covered + 0.5) break;
        target = covered - m.inset.top - CONFIG.overlapPx; // 貼り付きヘッダーの分だけ戻す
      }
      if (!m) {
        truncated = true; // 撮影中に要素が消えた
        break;
      }
      if (i > 0) m.inset.top = Math.max(0, Math.min(m.inset.top, covered - m.pos));

      const isFirst = i === 0;
      const isLast = m.atEnd;
      const winTop = Math.max(m.b.top, 0);
      const winBottom = Math.min(m.b.bottom, vh());
      const srcTop = isFirst ? Math.max(m.fr.top, 0) : winTop + m.inset.top;
      const srcBottom = isLast ? Math.min(m.fr.bottom, vh()) : winBottom - m.inset.bottom;
      if (srcBottom - srcTop < 1) break;

      const coverEnd = m.pos + (srcBottom - m.b.top);
      if (!isFirst && !isLast && coverEnd <= covered + 0.5) {
        truncated = true; // これ以上進めない
        break;
      }

      const shot = await grab({
        left: Math.max(m.fr.left, 0),
        right: Math.min(m.fr.right, vw()),
        top: srcTop,
        bottom: srcBottom,
      });
      if (shot) {
        // 出力画像上の位置 = スクロール量 + ビューポート内の位置 - 枠の上端
        const y = Math.round(m.pos * shot.scale) + shot.sy - Math.round(m.fr.top * shot.scale);
        parts.push({ bitmap: shot.bitmap, y, scale: shot.scale });
      }
      covered = coverEnd;
      est = m.inset;
      const total = S.scrollHeight;
      badge(`${Math.min(99, Math.round((Math.min(covered, total) / total) * 100))}%`);
      if (isLast) break;
      if (i === CONFIG.maxFrames - 1) truncated = true;
    }
    return { parts, truncated };
  }

  // スクロール領域を持たない要素（複数可）を撮る。画面に収まらない場合は親（またはページ）をスクロールする
  async function captureElement(frames, A, restorer) {
    const isRoot = A === root;
    const win = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (isRoot) return { top: 0, bottom: h, left: 0, right: w };
      const r = A.getBoundingClientRect();
      const top = r.top + A.clientTop;
      const left = r.left + A.clientLeft;
      return {
        top: Math.max(0, top),
        bottom: Math.min(h, top + A.clientHeight),
        left: Math.max(0, left),
        right: Math.min(w, left + A.clientWidth),
      };
    };

    let fr = unionRect(frames);
    if (!fr) return { parts: [], truncated: false };
    let w = win();
    const fits =
      fr.top >= w.top - 0.5 && fr.bottom <= w.bottom + 0.5 && fr.left >= w.left - 0.5 && fr.right <= w.right + 0.5;
    if (!fits) {
      for (const el of frames) restorer.ancestorsOf(el);
      restorer.style(A, 'scroll-behavior', 'auto');
      if (isRoot) restorer.style(document.documentElement, 'scroll-behavior', 'auto');
      // 最も上端にある要素を基準にビューポート先頭へ寄せる
      let topMost = frames[0];
      let minTop = Infinity;
      for (const el of frames) {
        if (!el || !el.isConnected) continue;
        const t = el.getBoundingClientRect().top;
        if (t < minTop) {
          minTop = t;
          topMost = el;
        }
      }
      topMost.scrollIntoView({ block: 'start', inline: 'nearest' });
      await settle();
    } else {
      await settle();
    }

    const parts = [];
    let covered = 0;
    let truncated = false;
    let note;
    for (let i = 0; i < CONFIG.maxFrames; i++) {
      checkCancel();
      fr = unionRect(frames);
      if (!fr) {
        truncated = true; // 撮影中に要素が消えた
        break;
      }
      w = win();
      const srcTop = Math.max(fr.top, w.top);
      const srcBottom = Math.min(fr.bottom, w.bottom);
      if (srcBottom - srcTop < 1) break;
      const end = srcBottom - fr.top;
      if (i > 0 && end <= covered + 0.5) break;

      const shot = await grab({
        left: Math.max(fr.left, w.left),
        right: Math.min(fr.right, w.right),
        top: srcTop,
        bottom: srcBottom,
      });
      if (shot) {
        parts.push({ bitmap: shot.bitmap, y: shot.sy - Math.round(fr.top * shot.scale), scale: shot.scale });
      }
      covered = end;
      badge(`${Math.min(99, Math.round((covered / fr.height) * 100))}%`);
      if (covered >= fr.height - 0.5) break;

      // スクロール前の各要素の上端を記録する（未接続なら null）
      const tops = frames.map((el) => (el && el.isConnected ? el.getBoundingClientRect().top : null));
      const before = A.scrollTop;
      A.scrollTop = before + (srcBottom - srcTop) - CONFIG.overlapPx;
      await settle();
      if (Math.abs(A.scrollTop - before) < 1) {
        truncated = true;
        break;
      }
      if (frames.length > 1) {
        // 要素同士で動いた量が食い違う（固定表示などが混在）場合は、位置がずれるので打ち切る
        let firstDelta = null;
        let mismatch = false;
        for (let k = 0; k < frames.length; k++) {
          const el = frames[k];
          if (tops[k] === null || !el || !el.isConnected) continue;
          const delta = el.getBoundingClientRect().top - tops[k];
          if (firstDelta === null) firstDelta = delta;
          else if (Math.abs(delta - firstDelta) > 2) {
            mismatch = true;
            break;
          }
        }
        if (mismatch) {
          truncated = true;
          note = '固定表示の要素とスクロールする要素が混在しているため、途中までしか撮れていません';
          break;
        }
      }
      if (i === CONFIG.maxFrames - 1) truncated = true;
    }
    return { parts, truncated, note };
  }

  // ---------------------------------------------------------------- 結合
  async function stitch(parts) {
    const width = Math.max(...parts.map((p) => p.bitmap.width));
    const minY = Math.min(...parts.map((p) => p.y));
    const height = Math.max(...parts.map((p) => p.y + p.bitmap.height)) - minY;
    const blobs = [];
    for (let off = 0; off < height; off += CONFIG.maxImageHeight) {
      const h = Math.min(CONFIG.maxImageHeight, height - off);
      const canvas = new OffscreenCanvas(width, h);
      const ctx = canvas.getContext('2d');
      for (const p of parts) {
        const y = p.y - minY - off;
        if (y + p.bitmap.height <= 0 || y >= h) continue;
        ctx.drawImage(p.bitmap, 0, y);
      }
      blobs.push(await canvas.convertToBlob({ type: 'image/png' }));
    }
    for (const p of parts) p.bitmap.close();
    return { blobs, width, height };
  }

  function fileBaseName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const hostName = (location.hostname || 'page').replace(/[^a-zA-Z0-9.-]/g, '_');
    return `sidepanel_${hostName}_${stamp}`;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---------------------------------------------------------------- 実行
  async function start() {
    if (phase !== 'pick' || !plan) return;
    phase = 'capture';
    removePickListeners();
    const { kind, frames, scroller } = plan;

    // 撮影中は UI を消し、透明な幕でマウス操作とホバー表示を止める
    hideOverlays();
    bar.style.setProperty('display', 'none', 'important');
    css(host, { 'pointer-events': 'auto', cursor: 'progress' });
    window.addEventListener('wheel', onWheelBlock, { capture: true, passive: false });
    badge('0%');

    const restorer = makeRestorer();
    let result = null;
    let error = null;
    try {
      await settle();
      result =
        kind === 'scroll'
          ? await captureScroll(frames, scroller, restorer)
          : await captureElement(frames, scroller, restorer);
    } catch (e) {
      error = e;
    } finally {
      restorer.run();
      window.removeEventListener('wheel', onWheelBlock, { capture: true });
      css(host, { 'pointer-events': 'none', cursor: 'auto' });
      badge('');
    }

    phase = 'done';
    if (error instanceof Cancelled) {
      cleanup();
      return;
    }

    let message;
    let isError = false;
    try {
      if (error) throw error;
      if (!result.parts.length) throw new Error('撮影できる範囲がありませんでした。');
      const { blobs, width, height } = await stitch(result.parts);
      const baseName = fileBaseName();
      if (blobs.length === 1) {
        download(blobs[0], `${baseName}.png`);
      } else {
        blobs.forEach((b, i) => download(b, `${baseName}_${i + 1}of${blobs.length}.png`));
      }
      let copied = false;
      if (blobs.length === 1) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobs[0] })]);
          copied = true;
        } catch (_) {
          /* フォーカスが無い等でコピーできなくても、保存はできている */
        }
      }
      message = `保存しました（${width} × ${height}px${blobs.length > 1 ? `、長いため ${blobs.length} 枚に分割` : ''}）`;
      if (copied) message += '。クリップボードにもコピーしました';
      if (result.note) message += `。※${result.note}`;
      else if (result.truncated) message += '。※途中までしか撮れていない可能性があります';
    } catch (e) {
      isError = true;
      message = e?.message || String(e);
    }

    toast(message, isError);
    setTimeout(cleanup, isError ? 6000 : 3500);
  }

  // ---------------------------------------------------------------- 起動
  window[NS] = { cancel };
  mount();
  addPickListeners();
})();
