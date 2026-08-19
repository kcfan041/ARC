/**
 * 注入頁面的 Action 收集腳本
 *
 * 對應 MVP1-PLAN.md 2.4 的決定：不碰框架 handler。
 *
 * 為何用 capture phase：
 *   React 17+ 把事件委派到 root container，
 *   button 上沒有 listener，對 root 查詢又對所有按鈕回傳同一答案。
 *   掛在 document 的 capture phase 則不論框架如何委派都收得到，
 *   且早於任何應用程式的 handler 執行。
 *
 * 為何用 Date.now()：
 *   performance.now() 每次導航歸零，無法與 CDP 的 wallTime 對齊。
 *   見 core-model/time.ts。
 *
 * 本檔會被序列化後注入頁面，因此不得 import 任何東西，
 * 也不得依賴外部作用域的變數。
 */

export const ACTION_BINDING = '__arcAction';

export function buildInjectScript(bindingName: string): string {
  return `(() => {
  if (window.__arcInjected) return;
  window.__arcInjected = true;

  const send = (payload) => {
    try {
      if (typeof window[${JSON.stringify(bindingName)}] === 'function') {
        window[${JSON.stringify(bindingName)}](payload);
      }
    } catch (_) {}
  };

  const selectorOf = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 5) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + cur.id); break; }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(
          (c) => c.tagName === cur.tagName
        );
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = cur.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  };

  const describe = (el) => {
    if (!el || el.nodeType !== 1) return { selector: '', tag: 'unknown' };
    const text = (el.innerText || el.textContent || '').trim().slice(0, 60);
    const out = { selector: selectorOf(el), tag: el.tagName.toLowerCase() };
    if (text) out.text = text;
    if (el.id) out.id = el.id;
    const name = el.getAttribute && el.getAttribute('name');
    if (name) out.name = name;
    const role = el.getAttribute && el.getAttribute('role');
    if (role) out.role = role;
    const type = el.getAttribute && el.getAttribute('type');
    if (type) out.type = type;
    return out;
  };

  const record = (kind) => (ev) => {
    send({
      kind: kind,
      at: Date.now(),
      pageUrl: location.href,
      target: describe(ev.target),
    });
  };

  // capture phase：早於應用程式 handler，且不受框架委派影響
  document.addEventListener('click', record('click'), true);
  document.addEventListener('change', record('change'), true);
  document.addEventListener('submit', record('submit'), true);
  document.addEventListener('keydown', (ev) => {
    // 只記錄有語意的按鍵，避免每個字元都產生一筆 action
    if (ev.key === 'Enter' || ev.key === 'Escape' || ev.key === 'Tab') {
      record('keydown')(ev);
    }
  }, true);
})();`;
}
