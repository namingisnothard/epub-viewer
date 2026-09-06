/* Native, on-device translation. Results never alter EPUB annotation offsets. */
(() => {
  'use strict';
  function chunks(text, limit = 1200) {
    const result = [];
    for (const paragraph of text.split(/\n\s*\n/)) {
      let rest = paragraph.trim();
      while (rest) {
        let end = Math.min(limit, rest.length);
        if (end < rest.length) {
          const prefix = rest.slice(0, end);
          const boundaries = [...prefix.matchAll(/[.!?。！？\s]/gu)];
          const boundary = boundaries.at(-1)?.index;
          if (boundary > limit / 2) end = boundary + 1;
          // Do not split a Unicode surrogate pair.
          if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
        }
        result.push(rest.slice(0, end)); rest = rest.slice(end).trimStart();
      }
    }
    return result;
  }
  function chapterText(content) {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const runs = []; let node, lastBlock;
    while ((node = walker.nextNode())) {
      const block = node.parentElement.closest('p, div, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, pre') || content;
      if (block !== lastBlock || !runs.length) runs.push('');
      runs[runs.length - 1] += node.textContent; lastBlock = block;
    }
    return runs.join('\n\n');
  }
  function inlineView(content, changed) {
    let spread, source, target, shadow, pending;
    function clear() {
      changed(false);
      if (spread) spread.replaceWith(...source.childNodes);
      spread = source = target = shadow = pending = null;
    }
    function prepare(selected) {
      clear();
      const parts = chunks(typeof selected === 'string' ? selected : chapterText(content));
      if (!parts.length) return parts;
      changed(true);
      spread = document.createElement('div'); spread.className = 'bilingual-spread';
      source = document.createElement('div'); source.className = 'bilingual-source';
      target = document.createElement('div'); target.className = 'bilingual-target';
      source.append(...content.childNodes);
      // Keep a complete source column. Shadow text stays outside annotation coordinates.
      shadow = target.attachShadow({mode:'open'});
      const style = document.createElement('style');
      style.textContent = ':host{display:block;min-width:0}p{margin:0 0 1em;white-space:pre-wrap}p:last-child{margin-bottom:0}.pending{opacity:.45;font-size:.8em}';
      pending = document.createElement('p'); pending.className = 'pending'; pending.textContent = '等待翻译…';
      shadow.append(style, pending);
      spread.append(source, target); content.append(spread);
      direction(document.getElementById('translationDirection').value.split('-')[0]);
      return parts;
    }
    function direction(language) {
      source.lang = language; target.lang = language === 'en' ? 'zh' : 'en';
      source.dataset.language = language === 'en' ? 'ENGLISH' : '中文';
      target.dataset.language = language === 'en' ? '中文' : 'ENGLISH';
      spread.dataset.source = language;
    }
    function pair(text, translated, index, sourceLanguage, targetLanguage) {
      if (!spread) return;
      changed(true); pending.remove(); direction(sourceLanguage);
      const paragraph = document.createElement('p'); paragraph.textContent = translated; paragraph.lang = targetLanguage;
      shadow.append(paragraph);
    }
    return {clear, prepare, pair};
  }
  function create({content, preferences, save, view}) {
    const $ = id => document.getElementById(id);
    const api = window.Translator;
    const supported = window.isSecureContext && typeof api?.create === 'function';
    let epoch = 0, translator = null;
    const status = text => { $('translationStatus').textContent = text; };
    function busy(value) {
      $('translateChapter').disabled = value || !supported;
      $('translationDirection').disabled = value;
      $('translationStop').disabled = !value;
      content.setAttribute?.('aria-busy', String(value));
    }
    function stop() {
      ++epoch;
      translator?.destroy(); translator = null;
      busy(false);
    }
    function reset() {
      stop(); view?.clear();
      status(supported ? '点击“翻译本章”开始，或选中文字后选择“翻译选区”。' : '此浏览器未提供内置翻译。请使用支持 Translator API 的桌面版 Chrome，并通过 localhost 或 HTTPS 打开书架。');
    }
    function load() {
      reset();
      const direction = preferences().direction;
      $('translationDirection').value = ['en-zh', 'zh-en'].includes(direction) ? direction : content.lang.startsWith('zh') ? 'zh-en' : 'en-zh';
      if (supported && !/^(en|zh)(-|$)/.test(content.lang)) status('本书不是中文或英文。此功能仅支持中英互译；请仅选择中文或英文段落。');
    }
    async function translate(selected, anchor) {
      stop();
      if (!supported) { reset(); return; }
      const parts = view ? view.prepare(selected, anchor) : chunks(typeof selected === 'string' ? selected : chapterText(content));
      if (!parts.length) { status('没有可翻译的文字。'); return; }
      const current = epoch;
      const [sourceLanguage, targetLanguage] = $('translationDirection').value.split('-');
      busy(true);
      status('正在准备翻译，首次使用可能需要下载语言包…');
      let session;
      try {
        // Invoke create directly in the click handler, preserving transient user activation.
        session = await api.create({sourceLanguage, targetLanguage, monitor(monitor) {
          monitor.addEventListener('downloadprogress', event => {
            if (current === epoch) status(`正在下载语言包… ${Math.round(event.loaded * 100)}%`);
          });
        }});
        if (current !== epoch) { session.destroy(); return; }
        translator = session;
        for (let i = 0; i < parts.length; i++) {
          status(`正在翻译 ${i + 1} / ${parts.length} 段…`);
          const translated = await session.translate(parts[i]);
          if (current !== epoch) return;
          view?.pair(parts[i], translated, i, sourceLanguage, targetLanguage);
        }
        status(`翻译完成 · ${parts.length} 段 · ${typeof selected === 'string' ? '选区' : '本章'}`);
      } catch (error) {
        if (current === epoch) status(`翻译未完成，已完成段落保留。请重试，并检查浏览器语言包与网络是否可用。${error.message ? ` (${error.message})` : ''}`);
      } finally {
        if (current === epoch) { translator = null; session?.destroy(); busy(false); }
      }
    }
    $('translateChapter').addEventListener('click', () => translate());
    $('translationStop').addEventListener('click', () => { stop(); status('已停止，已完成的译文保留。点击“翻译本章”可重新开始。'); });
    $('translationDirection').addEventListener('change', () => {
      stop(); preferences().direction = $('translationDirection').value; save();
      view?.clear(); status('翻译方向已更新，点击“翻译本章”开始。');
    });
    reset();
    return {reset, load, translate};
  }
  if (typeof module !== 'undefined') module.exports = {chunks, chapterText, create, inlineView};
  if (typeof window !== 'undefined') window.ShelfTranslation = {create, inlineView};
})();
