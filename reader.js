/* Shelf's dependency-free reading room. All personal data stays in this browser. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const reader = $('#reader'), viewport = $('#readingViewport'), content = $('#readingContent');
  const defaults = {theme: 'paper', paper: 'smooth', texture: 55, font: 'literary', size: 20, line: 1.8, width: 680, canvasWidth: 960, canvasFull: false, paragraph: 1, spacing: 0, align: 'left', columns: 1, experience: 'quiet', flow: 'scroll', motion: true};
  const fonts = {literary: 'Georgia, serif', classic: 'Palatino, "Book Antiqua", serif', clean: 'Arial, sans-serif', mono: 'ui-monospace, monospace'};
  const pageWindow = $('#pageWindow');
  let pageIndex = 0, pageTotal = 1, effectiveColumns = 1, pageStride = 1, layoutVersion = 0, layoutPlace = null, resizeFrame;
  const scenes = {
    quiet: {...defaults},
    newspaper: {...defaults, experience: 'newspaper', columns: 3, flow: 'pages', font: 'classic', size: 18, line: 1.6, width: 1440, canvasWidth: 1440, paragraph: .8, align: 'justify'},
    leather: {...defaults, experience: 'leather', columns: 2, flow: 'pages', theme: 'sepia', font: 'classic', size: 21, width: 1280, canvasWidth: 1280},
    kindle: {...defaults, experience: 'kindle', flow: 'pages', theme: 'white', width: 760, canvasWidth: 760, size: 20, line: 1.7}
  };
  let bilingual = false;
  const isPaged = () => !bilingual && personal?.preferences.flow === 'pages';
  let activeMark = null;
  const markLabels = {highlight: "Highlight", underline: "Underline", wavy: "Wavy underline", strikethrough: "Strikethrough"};
  const markStyle = note => Object.hasOwn(markLabels, note.markStyle) ? note.markStyle : Object.hasOwn(markLabels, note.kind) ? note.kind : "highlight";
  let book, chapters = [], chapter = 0, personal, selection, strokes = [], drawing = null, request = 0, saveTimer, statusTimer, restoring = false, ready = false, opener;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const key = item => `shelf-reader-v1:${item.id}`;
  function stored(item) {
    try { const data = JSON.parse(localStorage.getItem(key(item)) || '{}'); return data && typeof data === 'object' ? data : {}; } catch { return {}; }
  }
  function progress(item) {
    const data = stored(item);
    return {percent: Number(data.percent) || 0, updatedAt: Number(data.updatedAt) || 0};
  }
  function status(message, sticky = false) {
    clearTimeout(statusTimer); $('#readerStatus').textContent = message;
    if (!sticky) statusTimer = setTimeout(() => { $('#readerStatus').textContent = ''; }, 4500);
  }
  function textAnchor() {
    if (!ready || !content.firstChild) return null;
    const clip = (isPaged() ? pageWindow : viewport).getBoundingClientRect();
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let node, offset = 0;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim()) {
        const range = document.createRange(); range.selectNodeContents(node);
        if ([...range.getClientRects()].some(r => r.right > clip.left + 1 && r.left < clip.right - 1 && r.bottom > clip.top + 1 && r.top < clip.bottom - 1)) {
          let low = 0, high = Math.max(0, node.length - 1);
          while (low < high) {
            const mid = Math.floor((low + high) / 2); range.setStart(node, mid); range.setEnd(node, mid + 1);
            const r = range.getBoundingClientRect();
            if (isPaged() ? r.right <= clip.left + 1 : r.bottom <= clip.top + 1) low = mid + 1; else high = mid;
          }
          return offset + low;
        }
      }
      offset += node.length;
    }
    return null;
  }
  function anchorRange(anchor) {
    if (!Number.isInteger(anchor) || anchor < 0) return null;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT); let node, offset = 0;
    while ((node = walker.nextNode())) {
      if (node.length && anchor < offset + node.length) {
        const range = document.createRange(); range.setStart(node, anchor - offset); range.setEnd(node, Math.min(node.length, anchor - offset + 1)); return range;
      }
      offset += node.length;
    }
    return null;
  }
  function location(withAnchor = false) {
    const ratio = isPaged() ? (pageTotal <= 1 ? 0 : pageIndex / (pageTotal - 1)) : Math.min(1, Math.max(0, viewport.scrollTop / Math.max(1, viewport.scrollHeight - viewport.clientHeight)));
    return {chapter, ratio, ...(withAnchor ? {anchor: textAnchor()} : {})};
  }
  function renderPagePosition() {
    if (!ready) return;
    pageIndex = Math.max(0, Math.min(pageTotal - 1, pageIndex));
    content.style.transform = isPaged() ? `translateX(${-pageIndex * pageStride}px)` : '';
    $('#pageIndicator').textContent = `第 ${pageIndex + 1} / ${pageTotal} 页 · ${effectiveColumns} 栏`;
    $('#previousPage').disabled = pageIndex === 0 && chapter === 0;
    $('#nextPage').disabled = pageIndex === pageTotal - 1 && chapter === chapters.length - 1;
  }
  function layoutReading(place = layoutPlace || personal?.location || {ratio: 0}) {
    if (!ready) return;
    const requested = bilingual ? 1 : Math.max(1, Math.min(3, Number(personal.preferences.columns) || 1));
    reader.dataset.flow = isPaged() ? 'pages' : 'scroll';
    $('#pageNavigation').hidden = !isPaged();
    const width = pageWindow.clientWidth;
    content.style.setProperty('--page-height', `${pageWindow.clientHeight}px`);
    effectiveColumns = Math.max(1, Math.min(requested, Math.floor((width + 36) / 276)));
    reader.dataset.effectiveColumns = effectiveColumns;
    const gap = personal.preferences.experience === 'leather' ? 56 : 36;
    content.style.columnCount = effectiveColumns;
    content.style.columnGap = `${gap}px`;
    content.style.transform = '';
    pageStride = Math.max(1, width + gap);
    pageTotal = isPaged() ? Math.max(1, Math.ceil((content.scrollWidth + gap - 2) / pageStride)) : 1;
    pageIndex = Math.round(Math.max(0, Math.min(1, place.ratio || 0)) * (pageTotal - 1));
    if (isPaged()) viewport.scrollTop = 0;
    else viewport.scrollTop = (place.ratio || 0) * Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const range = anchorRange(place.anchor);
    if (range) {
      const rect = range.getBoundingClientRect(), clip = pageWindow.getBoundingClientRect();
      if (isPaged()) pageIndex = Math.floor(Math.max(0, rect.left - clip.left + 2) / pageStride);
      else viewport.scrollTop += rect.top - viewport.getBoundingClientRect().top - 24;
    }
    renderPagePosition();
    $('#columnHint').textContent = requested !== effectiveColumns ? `当前空间使用 ${effectiveColumns} 栏；加宽阅读区域后恢复 ${requested} 栏。` : (isPaged() ? '左右翻页，也可用方向键或触屏轻扫。' : '从每栏顶部向下读，再移至右侧一栏。');
    updateProgress();
  }
  function scheduleLayout(place) {
    if (!ready) return;
    const version = ++layoutVersion;
    restoring = true;
    requestAnimationFrame(() => {
      if (version !== layoutVersion || !ready) return;
      layoutReading(place); restoring = false; save();
    });
  }
  function turnPage(direction) {
    if (!ready || !isPaged()) return;
    const next = pageIndex + direction;
    if (next < 0) { if (chapter > 0) showChapter(chapter - 1, 1); return; }
    if (next >= pageTotal) { if (chapter < chapters.length - 1) showChapter(chapter + 1); return; }
    pageIndex = next; dismissMarkToolbar(); window.getSelection()?.removeAllRanges();
    renderPagePosition(); updateProgress(); save();
    if (personal.preferences.motion && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      pageWindow.getAnimations().forEach(animation => animation.cancel());
      if (personal.preferences.experience === 'leather') {
        pageWindow.animate([{transform: `perspective(1600px) rotateY(${direction * 7}deg)`, filter:'brightness(.88)'}, {transform:'perspective(1600px) rotateY(0deg)', filter:'brightness(1)'}], {duration:420, easing:'cubic-bezier(.22,.7,.25,1)'});
        pageWindow.classList.remove('leaf-forward', 'leaf-back'); void pageWindow.offsetWidth;
        pageWindow.classList.add(direction > 0 ? 'leaf-forward' : 'leaf-back');
      } else if (personal.preferences.experience === 'kindle') {
        pageWindow.animate([{opacity:.38},{opacity:1}], {duration:180});
      } else pageWindow.animate([{opacity:.5, transform:`translateX(${direction*12}px)`},{opacity:1,transform:'translateX(0)'}], {duration:200});
    }
  }
  function percentAt(place = location()) {
    const weights = chapters.map(c => Math.max(30, c.words));
    return 100 * (weights.slice(0, place.chapter).reduce((a,b) => a+b, 0) + (weights[place.chapter] || 0) * place.ratio) / Math.max(1, weights.reduce((a,b) => a+b, 0));
  }
  function save(updateLocation = true) {
    if (!book || !personal) return;
    if (updateLocation && ready && !restoring) { personal.location = location(true); layoutPlace = personal.location; personal.percent = Math.round(percentAt()); personal.updatedAt = Date.now(); }
    personal.draft = {text: $('#noteText').value, selection, strokes};
    try { localStorage.setItem(key(book), JSON.stringify(personal)); }
    catch { status('Browser storage is full or unavailable. Export your EPUB to keep your notes.', true); }
  }
  function setSidebar(name) {
    const place = ready ? location(true) : null;
    const ids = {contents: '#contentsPanel', appearance: '#appearancePanel', notebook: '#notebookPanel', speech: '#speechPanel'};
    for (const [key, id] of Object.entries(ids)) {
      $(id).hidden = key !== name;
      $(`#${key}Toggle`).setAttribute('aria-expanded', String(key === name));
    }
    reader.dataset.sidebar = name || '';
    if (place) scheduleLayout(place);
  }
  function toggleSidebar(name) {
    if (!ready) return;
    setSidebar(reader.dataset.sidebar === name ? '' : name);
  }
  function setFocus(enabled) {
    const place = location(true);
    reader.classList.toggle('is-focused', enabled); $('#exitFocus').hidden = !enabled;
    if (enabled) { setSidebar(''); $('#exitFocus').focus(); }
    else $('#focusToggle').focus();
    scheduleLayout(place);
  }
  function applyPreferences(preserve = true, savedPlace = null) {
    const place = savedPlace || location(true), p = personal.preferences;
    reader.dataset.theme = p.theme;
    reader.dataset.paper = p.paper;
    reader.style.setProperty('--paper-strength', p.texture / 100);
    $('#textureOutput').textContent = `${p.texture}%`;
    $('#textureSetting').disabled = p.paper === 'smooth';
    document.querySelectorAll('button[data-paper]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.paper === p.paper)));
    reader.dataset.experience = p.experience;
    reader.dataset.flow = p.flow;
    reader.style.setProperty('--canvas-width', p.canvasFull ? '100%' : `${p.canvasWidth}px`);
    $('#canvasWidthOutput').textContent = p.canvasFull ? '铺满可用空间' : `${p.canvasWidth} px`;
    $('#canvasWidthSetting').value = p.canvasWidth;
    $('#canvasFullSetting').checked = p.canvasFull;
    reader.style.setProperty('--reading-columns', p.columns);
    $('#pageNavigation').hidden = p.flow !== 'pages';
    $('#motionSetting').checked = p.motion !== false;
    document.querySelectorAll('[data-experience]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.experience === p.experience)));
    document.querySelectorAll('[data-columns]').forEach(el => el.setAttribute('aria-pressed', String(Number(el.dataset.columns) === Number(p.columns))));
    reader.style.setProperty('--reading-font', fonts[p.font] || fonts.literary);
    for (const [key, unit] of Object.entries({size: 'px', line: '', width: 'px', paragraph: 'em', spacing: 'px'})) {
      reader.style.setProperty(`--reading-${key}`, p[key] + unit);
      $(`#${key}Output`).textContent = p[key] + (key === 'size' || key === 'width' || key === 'spacing' ? ' px' : '');
    }
    reader.style.setProperty('--reading-align', p.align);
    document.querySelectorAll('[data-pref]').forEach(el => { el.value = p[el.dataset.pref]; });
    document.querySelectorAll('[data-reader-theme]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.readerTheme === p.theme)));
    if (preserve && ready) scheduleLayout(place);
    save(false);
  }
  async function open(item) {
    if (!item) return;
    narration.stop();
    translation.reset();
    opener = document.activeElement; book = item; chapters = []; ready = false; chapter = 0;
    const current = ++request; activeMark = null; restoring = true; layoutPlace = null; pageIndex = 0; pageTotal = 1; ++layoutVersion; clearTimeout(saveTimer);
    delete $('#saveNote').dataset.editing; $('#saveNote').textContent = 'Save note'; $('#cancelEdit').hidden = true; composeTab(false);
    const old = stored(book);
    personal = {...old, preferences: {...defaults, ...old.preferences}, annotations: Array.isArray(old.annotations) ? old.annotations : []};
    // Existing editions used text width for the outer frame as well.
    if (old.preferences && old.preferences.canvasWidth == null) personal.preferences.canvasWidth = Math.max(480, Math.min(2400, Number(old.preferences.width) || defaults.canvasWidth));
    selection = old.draft?.selection || null; strokes = old.draft?.strokes || []; drawing = null;
    $('#noteText').value = old.draft?.text || ''; renderQuote(); redraw();
    $('#readerTitle').textContent = book.title; $('#readerAuthor').textContent = book.author;
    $('#chapterEyebrow').textContent = 'A moment to settle in'; $('#chapterLabel').textContent = 'Opening your book…';
    content.replaceChildren(); $('#chapterList').replaceChildren(); $('#progressLabel').textContent = 'Preparing your reading room';
    $('#bookProgress').value = 0; $('#readerStatus').textContent = ''; $('#selectionToolbar').hidden = true;
    $('#nextChapterInline').hidden = true; reader.classList.remove('is-focused'); $('#exitFocus').hidden = true;
    setSidebar(''); applyPreferences(false); setDisabled(true);
    reader.showModal(); document.body.style.overflow = 'hidden'; $('#leaveReader').focus();
    try {
      const data = await window.ShelfBooks.read(book.id);
      if (current !== request) return;
      chapters = data.chapters;
      if (!chapters?.length) throw new Error('No readable chapters were found.');
      ready = true; setDisabled(false);
      $('#chapterList').innerHTML = chapters.map((c, i) => `<button type="button" data-chapter="${i}"><span>${String(i+1).padStart(2, '0')}</span>${escape(c.title)}</button>`).join('');
      const place = personal.location || {chapter: 0, ratio: 0};
      showChapter(Math.max(0, Math.min(chapters.length - 1, Number(place.chapter) || 0)), Number(place.ratio) || 0, "", place.anchor);
      renderAnnotations();
    } catch (error) {
      if (current !== request) return;
      $('#chapterEyebrow').textContent = 'Unable to open book'; $('#chapterLabel').textContent = 'Let’s reconnect your shelf.';
      content.innerHTML = `<p class="reader-error">${escape(error.message)}</p><p class="reader-error">Close the reader and choose your EPUB again. Files stay in this browser tab and must be reopened after a refresh.</p>`;
    }
  }
  function setDisabled(disabled) {
    document.querySelectorAll('.reader-tools button, .reader-bottom button, #bookProgress').forEach(el => { el.disabled = disabled; });
  }
  function close() {
    narration.stop();
    translation.reset();
    ++renderVersion;
    clearTimeout(saveTimer); save(); ++request; ready = false; reader.close(); document.body.style.overflow = '';
    window.dispatchEvent(new Event('shelf-progress'));
    if (opener?.isConnected) opener.focus();
  }
  let renderVersion = 0;
  function showChapter(index, ratio = 0, fragment = '', anchor = null, autoplay = false) {
    if (!ready || index < 0 || index >= chapters.length) return;
    narration.stop();
    translation.reset();
    if (chapters[chapter] && !restoring) save();
    activeMark = null; chapter = index; restoring = true; layoutPlace = {chapter, ratio, anchor}; pageIndex = 0; content.style.transform = ""; ++layoutVersion; const version = ++renderVersion;
    viewport.scrollTop = 0; content.innerHTML = chapters[chapter].html;
    content.lang = ({German:'de',Chinese:'zh',French:'fr',Spanish:'es',Japanese:'ja'})[book.language] || 'en';
    translation.load();
    $('#chapterEyebrow').textContent = `Section ${chapter+1} of ${chapters.length}`;
    $('#chapterLabel').textContent = chapters[chapter].title;
    $('#selectionToolbar').hidden = true;
    $('#previousChapter').disabled = chapter === 0; $('#nextChapter').disabled = chapter === chapters.length-1;
    $('#nextChapterInline').hidden = chapter === chapters.length-1;
    document.querySelectorAll('[data-chapter]').forEach(el => { el.setAttribute('aria-current', String(Number(el.dataset.chapter) === chapter)); });
    paintHighlights();
    const restore = () => {
      if (version !== renderVersion) return;
      const target = fragment ? document.getElementById('reader-' + fragment) : null;
      layoutReading({ratio, anchor});
      if (target && content.contains(target)) {
        if (isPaged()) {
          content.style.transform = ''; const rect = target.getBoundingClientRect();
          pageIndex = Math.floor(Math.max(0, rect.left - pageWindow.getBoundingClientRect().left + 2) / pageStride); renderPagePosition();
        } else target.scrollIntoView({block: 'start'});
      }
      restoring = false; save(); updateProgress();
      narration.load(autoplay);
    };
    // Wait for chapter images before restoring progress so illustrated books do not jump.
    const images = [...content.querySelectorAll('img')];
    Promise.all(images.map(img => img.complete ? Promise.resolve() : new Promise(resolve => { img.addEventListener('load', resolve, {once:true}); img.addEventListener('error', resolve, {once:true}); }))).then(() => requestAnimationFrame(restore));
    requestAnimationFrame(() => { if (version === renderVersion) updateProgress(); });
  }
  function updateProgress() {
    if (!ready) return;
    const place = location(), percent = Math.round(percentAt(place));
    $('#bookProgress').value = Math.round(percentAt(place) * 10);
    const minutes = Math.max(1, Math.ceil(chapters[chapter].words * (1-place.ratio) / 225));
    $('#progressLabel').textContent = `${percent}% of book · ${minutes} min left in section`;
    const has = personal.annotations.some(n => n.kind === 'bookmark' && bookmarkAtLocation(n, place));
    $('#bookmarkButton').setAttribute('aria-pressed', String(has));
  }
  function currentAnchor(kind, extra = {}) {
    return {id: crypto.randomUUID(), kind, ...location(true), path: chapters[chapter].path, chapterTitle: chapters[chapter].title, createdAt: Date.now(), ...extra};
  }
  function addAnnotation(note) {
    personal.annotations.unshift(note); save(); renderAnnotations(); paintHighlights(); updateProgress();
  }
  function bookmarkAtLocation(note, place) {
    if (note.chapter !== chapter) return false;
    const range = anchorRange(note.anchor);
    if (range && isPaged()) {
      const rect = range.getBoundingClientRect(), clip = pageWindow.getBoundingClientRect();
      return rect.right > clip.left && rect.left < clip.right && rect.bottom > clip.top && rect.top < clip.bottom;
    }
    return Math.abs(note.ratio - place.ratio) < .025;
  }
  function bookmark() {
    if (!ready) return;
    const place = location();
    const existing = personal.annotations.find(n => n.kind === 'bookmark' && bookmarkAtLocation(n, place));
    if (existing) { personal.annotations = personal.annotations.filter(n => n.id !== existing.id); save(); renderAnnotations(); updateProgress(); status('Bookmark removed.'); }
    else { addAnnotation(currentAnchor('bookmark')); status('This place is bookmarked. Find it in your notebook.'); }
  }
  function captureSelection() {
    if (!ready) return;
    const selected = window.getSelection();
    if (!selected?.rangeCount || selected.isCollapsed) { if (!activeMark) $('#selectionToolbar').hidden = true; return; }
    const range = selected.getRangeAt(0);
    if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return;
    const text = selected.toString();
    if (!text.trim()) return;
    const before = document.createRange(); before.selectNodeContents(content); before.setEnd(range.startContainer, range.startOffset);
    selection = {...location(true), start: before.toString().length, end: before.toString().length + text.length, quote: text};
    const existing = personal.annotations.find(n => n.chapter === chapter && n.start === selection.start && n.end === selection.end && n.quote);
    activeMark = existing?.id || null;
    showMarkToolbar();
  }
  function paintHighlights() {
    content.querySelectorAll('mark[data-annotation]').forEach(mark => mark.replaceWith(...mark.childNodes)); content.normalize();
    const notes = personal.annotations.filter(n => n.chapter === chapter && Number.isInteger(n.start) && n.quote);
    // Character anchors distinguish repeated phrases and survive typography changes.
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT); let node, offset = 0; const nodes = [];
    while ((node = walker.nextNode())) { nodes.push({node, start: offset, end: offset + node.length}); offset += node.length; }
    for (const entry of nodes.reverse()) {
      const hits = notes.filter(n => n.start < entry.end && n.end > entry.start);
      if (!hits.length) continue;
      const cuts = new Set([0, entry.node.length]);
      hits.forEach(n => { cuts.add(Math.max(0, n.start-entry.start)); cuts.add(Math.min(entry.node.length, n.end-entry.start)); });
      const bounds = [...cuts].sort((a,b)=>a-b), fragment = document.createDocumentFragment();
      for (let i=0; i<bounds.length-1; i++) {
        const start = bounds[i], end = bounds[i+1], text = entry.node.data.slice(start,end);
        const matching = hits.filter(n => n.start <= entry.start+start && n.end >= entry.start+end);
        let piece = document.createTextNode(text);
        for (const hit of matching.slice().reverse()) {
          const mark = document.createElement('mark'); mark.dataset.annotation = hit.id; mark.dataset.markStyle = markStyle(hit);
          mark.title = `${markLabels[markStyle(hit)]} — click to change or delete`;
          mark.tabIndex = 0; mark.setAttribute('role', 'button'); mark.setAttribute('aria-label', `${markLabels[markStyle(hit)]}: ${hit.quote.slice(0, 100)}`);
          mark.append(piece); piece = mark;
        }
        fragment.append(piece);
      }
      entry.node.replaceWith(fragment);
    }
    narration.refresh();
  }
  function showMarkToolbar() {
    const note = personal.annotations.find(n => n.id === activeMark);
    $('#markToolbarLabel').textContent = note ? 'Edit this mark' : 'Mark this passage';
    $('#deleteMark').hidden = !note;
    $('#deleteMark').textContent = note?.text ? 'Delete annotation' : 'Delete mark';
    document.querySelectorAll('[data-mark-style]').forEach(button => button.setAttribute('aria-pressed', String(!!note && button.dataset.markStyle === markStyle(note))));
    const overlaps = selection ? personal.annotations.filter(n => n.chapter === selection.chapter && n.quote && n.start < selection.end && n.end > selection.start) : [];
    $('#overlappingMarks').hidden = !note || overlaps.length < 2;
    $('#activeMarkSelect').innerHTML = overlaps.map(n => `<option value="${escape(n.id)}" ${n.id === activeMark ? 'selected' : ''}>${escape(markLabels[markStyle(n)])}: ${escape(n.quote.slice(0, 35))}</option>`).join('');
    $('#selectionToolbar').hidden = false; renderQuote();
  }
  function editMark(id) {
    const note = personal.annotations.find(n => n.id === id);
    if (!note) return;
    activeMark = id;
    selection = {chapter: note.chapter, ratio: note.ratio, anchor: note.anchor, start: note.start, end: note.end, quote: note.quote};
    showMarkToolbar();
  }
  function dismissMarkToolbar() {
    activeMark = null; $('#selectionToolbar').hidden = true;
  }
  function deleteAnnotation(id) {
    const note = personal.annotations.find(n => n.id === id);
    if (!note) return;
    personal.annotations = personal.annotations.filter(n => n.id !== id);
    if (activeMark === id) { dismissMarkToolbar(); selection = null; renderQuote(); }
    if ($('#saveNote').dataset.editing === id) {
      delete $('#saveNote').dataset.editing; $('#saveNote').textContent = 'Save note'; $('#cancelEdit').hidden = true; $('#noteText').value = ''; selection = null; renderQuote();
    }
    window.getSelection()?.removeAllRanges();
    save(); renderAnnotations(); paintHighlights(); updateProgress(); status('Annotation deleted.');
  }
  function renderQuote() { $('#clearQuote').hidden = !selection?.quote; $('#selectedQuote').hidden = !selection?.quote; $('#selectedQuote').textContent = selection?.quote || ''; }
  function svgMarkup(lines) {
    const paths = lines.map(line => `<polyline fill="none" stroke="${/^#[a-f0-9]{6}$/i.test(line.color) ? line.color : '#284c3c'}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${line.points.map(p => p.map(v => Number(v) || 0).join(',')).join(' ')}"/>`).join('');
    return `<svg viewBox="0 0 600 300" role="img" aria-label="Saved doodle">${paths}</svg>`;
  }
  function renderAnnotations() {
    $('#annotationCount').textContent = personal.annotations.length;
    $('#annotationList').innerHTML = personal.annotations.length ? personal.annotations.map(n => `<article class="annotation-card"><div class="annotation-meta"><span>${escape(markLabels[n.kind] || n.kind)} · ${new Date(n.createdAt).toLocaleDateString(undefined, {month:'short', day:'numeric'})}</span><button type="button" data-delete-note="${escape(n.id)}" aria-label="Delete ${escape(markLabels[n.kind] || n.kind)}">×</button></div><button class="annotation-location" type="button" data-note-location="${escape(n.id)}">${escape(n.chapterTitle)} ↗</button>${n.quote ? `<blockquote><span class="annotation-sample" data-mark-style="${markStyle(n)}">${escape(n.quote)}</span></blockquote>` : ''}${n.text ? `<p>${escape(n.text)}</p><button type="button" class="edit-note" data-edit-note="${escape(n.id)}">Edit comment</button>` : ''}${n.strokes ? svgMarkup(n.strokes) : ''}</article>`).join('') : '<div class="notebook-empty"><span>✎</span><p>A book is a conversation.</p><small>Your bookmarks, highlights, notes, and sketches will gather here.</small></div>';
  }
  function redraw() {
    const canvas = $('#doodleCanvas'), ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 3;
    for (const line of strokes) { ctx.strokeStyle = line.color; ctx.beginPath(); line.points.forEach(([x,y], i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y)); ctx.stroke(); }
  }
  function drawingPoint(event) { const box = $('#doodleCanvas').getBoundingClientRect(); return [Math.max(0, Math.min(600, (event.clientX-box.left)*600/box.width)), Math.max(0, Math.min(300, (event.clientY-box.top)*300/box.height))]; }
  function composeTab(draw) {
    $('#doodleComposer').hidden = !draw; $('#noteComposer').hidden = draw;
    $('#drawTab').setAttribute('aria-pressed', String(draw)); $('#writeTab').setAttribute('aria-pressed', String(!draw));
  }
  $('#leaveReader').addEventListener('click', close);
  reader.addEventListener('cancel', e => { e.preventDefault(); if (!$('#selectionToolbar').hidden) dismissMarkToolbar(); else if (reader.classList.contains('is-focused')) setFocus(false); else if (reader.dataset.sidebar) setSidebar(''); else close(); });
  for (const name of ['contents', 'appearance', 'notebook', 'speech']) $(`#${name}Toggle`).addEventListener('click', () => toggleSidebar(name));
  document.querySelectorAll('[data-close-sidebar]').forEach(el => el.addEventListener('click', () => setSidebar('')));
  $('#focusToggle').addEventListener('click', () => { if (ready) setFocus(true); }); $('#exitFocus').addEventListener('click', () => setFocus(false));
  $('#previousPage').addEventListener('click', () => turnPage(-1));
  $('#nextPage').addEventListener('click', () => turnPage(1));
  document.querySelectorAll('[data-experience]').forEach(button => button.addEventListener('click', () => {
    const place = location(true);
    personal.preferences = {...scenes[button.dataset.experience], motion: personal.preferences.motion, paper: personal.preferences.paper, texture: personal.preferences.texture};
    applyPreferences(true, place);
  }));
  document.querySelectorAll('[data-columns]').forEach(button => button.addEventListener('click', () => {
    const place = location(true);
    personal.preferences.columns = Number(button.dataset.columns);
    if (personal.preferences.columns > 1) {
      personal.preferences.flow = 'pages';
      personal.preferences.width = Math.max(personal.preferences.width, Math.ceil((personal.preferences.columns * 300 + 36 * (personal.preferences.columns - 1)) / 20) * 20);
      personal.preferences.canvasWidth = Math.max(personal.preferences.canvasWidth, personal.preferences.width);
    }
    applyPreferences(true, place);
  }));
  $('#motionSetting').addEventListener('change', event => { personal.preferences.motion = event.target.checked; save(false); });
  document.querySelectorAll('button[data-paper]').forEach(button => button.addEventListener('click', () => {
    personal.preferences.paper = button.dataset.paper;
    applyPreferences(false);
  }));
  $('#canvasWidthSetting').addEventListener('input', event => {
    const place = location(true);
    personal.preferences.canvasWidth = Number(event.target.value);
    personal.preferences.canvasFull = false;
    applyPreferences(true, place);
  });
  $('#canvasFullSetting').addEventListener('change', event => {
    const place = location(true);
    personal.preferences.canvasFull = event.target.checked;
    applyPreferences(true, place);
  });
  new ResizeObserver(() => {
    if (!ready || restoring) return;
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => scheduleLayout(layoutPlace || personal.location));
  }).observe(pageWindow);
  let swipeStart = null;
  pageWindow.addEventListener('pointerdown', event => {
    swipeStart = event.pointerType === 'touch' && !event.target.closest('a, mark, button') ? {x:event.clientX, y:event.clientY} : null;
  }, {passive:true});
  pageWindow.addEventListener('pointerup', event => {
    if (swipeStart && isPaged() && window.getSelection()?.isCollapsed) {
      const dx = event.clientX - swipeStart.x, dy = event.clientY - swipeStart.y;
      if (Math.abs(dx) > 65 && Math.abs(dy) < 45) turnPage(dx < 0 ? 1 : -1);
    }
    swipeStart = null;
  }, {passive:true});
  $('#previousChapter').addEventListener('click', () => showChapter(chapter-1));
  $('#nextChapter').addEventListener('click', () => showChapter(chapter+1));
  $('#nextChapterInline').addEventListener('click', () => showChapter(chapter+1));
  $('#chapterList').addEventListener('click', e => { const target = e.target.closest('[data-chapter]'); if (target) { showChapter(Number(target.dataset.chapter)); if (matchMedia('(max-width: 900px)').matches) setSidebar(''); } });
  content.addEventListener('click', e => {
    const savedMark = e.target.closest('mark[data-annotation]');
    if (savedMark && (!window.getSelection()?.rangeCount || window.getSelection().isCollapsed)) { editMark(savedMark.dataset.annotation); e.preventDefault(); return; }
    const link = e.target.closest('a[data-path]');
    if (link) { e.preventDefault(); const target = chapters.findIndex(c => c.path === link.dataset.path); if (target >= 0) showChapter(target, 0, link.dataset.fragment); else status('This link points to a section outside the reading order. Use the original EPUB to open it.'); }
    if (!savedMark && window.getSelection()?.isCollapsed) dismissMarkToolbar();
  });
  viewport.addEventListener('scroll', () => { if (!ready || restoring) return; updateProgress(); clearTimeout(saveTimer); saveTimer = setTimeout(save, 250); }, {passive:true});
  $('#bookProgress').addEventListener('input', e => {
    const weights = chapters.map(c=>Math.max(30,c.words)); let remaining = Number(e.target.value)/1000 * weights.reduce((a,b)=>a+b,0), target=0;
    while (target < weights.length-1 && remaining > weights[target]) remaining -= weights[target++];
    showChapter(target, remaining/weights[target]);
  });
  document.querySelectorAll('[data-pref]').forEach(el => el.addEventListener('input', () => { const place = location(true); personal.preferences[el.dataset.pref] = el.type === 'range' ? Number(el.value) : el.value; applyPreferences(true, place); }));
  document.querySelectorAll('[data-reader-theme]').forEach(el => el.addEventListener('click', () => { personal.preferences.theme = el.dataset.readerTheme; applyPreferences(); }));
  $('#resetAppearance').addEventListener('click', () => { const place = location(true); personal.preferences = {...defaults}; applyPreferences(true, place); status('Reading appearance reset.'); });
  $('#bookmarkButton').addEventListener('click', bookmark);
  content.addEventListener('pointerup', () => setTimeout(captureSelection, 0));
  content.addEventListener('keyup', captureSelection);
  document.querySelectorAll('[data-mark-style]').forEach(button => button.addEventListener('click', () => {
    if (!selection) return;
    const style = button.dataset.markStyle;
    const existing = personal.annotations.find(n => n.id === activeMark);
    if (existing) {
      existing.markStyle = style;
      if (Object.hasOwn(markLabels, existing.kind)) existing.kind = style;
      save(); renderAnnotations(); paintHighlights();
    } else {
      const note = currentAnchor(style, {...selection, markStyle: style, path: chapters[selection.chapter].path, chapterTitle: chapters[selection.chapter].title});
      addAnnotation(note); activeMark = note.id;
    }
    window.getSelection()?.removeAllRanges(); showMarkToolbar(); save(); status(`${markLabels[style]} saved. Tap the mark to change or delete it.`);
  }));
  $('#deleteMark').addEventListener('click', () => deleteAnnotation(activeMark));
  $('#dismissMarkToolbar').addEventListener('click', dismissMarkToolbar);
  $('#activeMarkSelect').addEventListener('change', event => editMark(event.target.value));
  content.addEventListener('keydown', event => {
    const mark = event.target.closest('mark[data-annotation]');
    if (mark && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); event.stopPropagation(); editMark(mark.dataset.annotation);
      $('#selectionToolbar button').focus();
    }
  });
  $('#commentSelection').addEventListener('click', () => {
    const note = personal.annotations.find(n => n.id === activeMark);
    if (note) { $('#saveNote').dataset.editing = note.id; $('#saveNote').textContent = 'Update note'; $('#cancelEdit').hidden = false; $('#noteText').value = note.text || ''; }
    else { delete $('#saveNote').dataset.editing; $('#saveNote').textContent = 'Save note'; $('#cancelEdit').hidden = true; }
    setSidebar('notebook'); composeTab(false); renderQuote(); dismissMarkToolbar(); $('#noteText').focus();
  });
  $('#saveNote').addEventListener('click', () => {
    const text = $('#noteText').value.trim();
    if (!text) { status('Write a thought before saving your note.'); $('#noteText').focus(); return; }
    const editing = $('#saveNote').dataset.editing;
    if (editing) { const note = personal.annotations.find(n => n.id === editing); if (note) note.text = text; delete $('#saveNote').dataset.editing; $('#saveNote').textContent = 'Save note'; $('#cancelEdit').hidden = true; }
    else addAnnotation(currentAnchor('note', {...(selection || {}), ...(selection ? {path: chapters[selection.chapter].path, chapterTitle: chapters[selection.chapter].title} : {}), text}));
    $('#noteText').value = ''; selection = null; renderQuote(); save(); renderAnnotations(); paintHighlights(); status('Note saved in your notebook.');
  });
  $('#clearQuote').addEventListener('click', () => { dismissMarkToolbar(); selection = null; renderQuote(); save(false); });
  $('#cancelEdit').addEventListener('click', () => { delete $('#saveNote').dataset.editing; $('#saveNote').textContent = 'Save note'; $('#cancelEdit').hidden = true; $('#noteText').value = ''; selection = null; renderQuote(); save(false); });
  $('#noteText').addEventListener('input', () => save(false));
  $('#annotationList').addEventListener('click', e => {
    const remove = e.target.closest('[data-delete-note]'), jump = e.target.closest('[data-note-location]'), edit = e.target.closest('[data-edit-note]');
    if (remove) deleteAnnotation(remove.dataset.deleteNote);
    if (jump) { const note = personal.annotations.find(n=>n.id===jump.dataset.noteLocation); showChapter(note.chapter,note.ratio, '', note.anchor); if (matchMedia('(max-width: 900px)').matches) setSidebar(''); }
    if (edit) { const note = personal.annotations.find(n=>n.id===edit.dataset.editNote); $('#noteText').value = note.text; selection = note.quote ? {...note} : null; renderQuote(); composeTab(false); $('#saveNote').dataset.editing = note.id; $('#saveNote').textContent = 'Update note'; $('#cancelEdit').hidden = false; $('#noteText').focus(); }
  });
  $('#writeTab').addEventListener('click', () => composeTab(false)); $('#drawTab').addEventListener('click', () => composeTab(true));
  $('#doodleCanvas').addEventListener('pointerdown', e => { e.preventDefault(); drawing = {color: $('#doodleColor').value, points: [drawingPoint(e)]}; strokes.push(drawing); e.currentTarget.setPointerCapture(e.pointerId); });
  $('#doodleCanvas').addEventListener('pointermove', e => { if (drawing) { drawing.points.push(drawingPoint(e)); redraw(); } });
  function finishDrawing() { if (drawing?.points.length === 1) { const p = drawing.points[0]; drawing.points.push([p[0]+.2, p[1]+.2]); redraw(); } drawing = null; save(false); }
  $('#doodleCanvas').addEventListener('pointerup', finishDrawing); $('#doodleCanvas').addEventListener('pointercancel', finishDrawing);
  $('#undoDoodle').addEventListener('click', () => { strokes.pop(); redraw(); save(false); });
  $('#clearDoodle').addEventListener('click', () => { strokes = []; redraw(); save(false); });
  $('#saveDoodle').addEventListener('click', () => { if (!strokes.length) return status('Draw something on the page first.'); addAnnotation(currentAnchor('doodle', {strokes: structuredClone(strokes)})); strokes = []; redraw(); save(); status('Sketch saved at this place in the book.'); });
  $('#exportEpub').addEventListener('click', async e => {
    const button = e.currentTarget, exportBook = book; button.disabled = true; button.textContent = 'Creating your edition…'; save();
    try {
      const blob = await window.ShelfBooks.exportBook(exportBook.id, {preferences: personal.preferences, annotations: personal.annotations});
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `${exportBook.title.replace(/[\\/:*?"<>|]/g, '')} — My edition.epub`; document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url), 60000);
      status('Your personal EPUB is ready. Your browser has started the download.');
    } catch(error) { status(`Could not create EPUB: ${error.message}`, true); }
    finally { button.disabled = false; button.textContent = '↓ Create my EPUB'; }
  });
  reader.addEventListener('keydown', e => {
    if (!ready || e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, select')) return;
    if (isPaged() && (e.key === 'PageDown' || e.key === 'PageUp')) { e.preventDefault(); turnPage(e.key === 'PageDown' ? 1 : -1); return; }
    if (e.key.toLowerCase() === 'b') { e.preventDefault(); bookmark(); }
    if (e.key.toLowerCase() === 'f') { e.preventDefault(); setFocus(!reader.classList.contains('is-focused')); }
    if (e.key === ']') { e.preventDefault(); showChapter(chapter+1); }
    if (e.key === '[') { e.preventDefault(); showChapter(chapter-1); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (e.target.closest('.reader-sidebar')) return;
      e.preventDefault(); const forward = e.key === 'ArrowRight';
      if (isPaged()) { turnPage(forward ? 1 : -1); return; }
      if (forward && viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight-4) showChapter(chapter+1);
      else if (!forward && viewport.scrollTop <= 0) showChapter(chapter-1, 1);
      else viewport.scrollBy({top: (forward ? 1 : -1)*viewport.clientHeight*.85, behavior: 'smooth'});
    }
  });
  window.addEventListener('pagehide', () => save());
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  const narration = window.ShelfNarration.create({
    content,
    preferences: () => personal ? (personal.narration ||= {}) : {},
    save: () => save(false),
    anchor: () => textAnchor(),
    reveal: offset => {
      const range = anchorRange(offset); if (!range || !ready) return;
      const rect = range.getBoundingClientRect(), clip = (isPaged() ? pageWindow : viewport).getBoundingClientRect();
      if (isPaged()) {
        if (rect.left < clip.left || rect.right > clip.right) {
          pageIndex += Math.floor((rect.left - clip.left + 2) / pageStride); renderPagePosition(); save();
        }
      } else if (rect.top < clip.top+20 || rect.bottom > clip.bottom-30) {
        viewport.scrollTop += rect.top - clip.top - 40; save();
      }
    },
    nextChapter: () => { if (chapter < chapters.length-1) showChapter(chapter+1,0,'',null,true); },
    onPick: () => { if (matchMedia('(max-width: 900px)').matches) setSidebar(''); }
  });
  $('#readSelection').addEventListener('click', () => {
    if (!selection) return;
    narration.seek(selection.start, true); dismissMarkToolbar(); setSidebar('speech');
  });
  const translation = window.ShelfTranslation.create({
    content,
    preferences: () => personal ? (personal.translation ||= {}) : {},
    save: () => save(false),
    view: window.ShelfTranslation.inlineView(content, active => {
      const place = ready ? location(true) : null;
      const entering = active && !bilingual;
      bilingual = active; reader.classList.toggle('is-bilingual', active);
      if (entering) { narration.stop(); setSidebar(''); }
      if (place) scheduleLayout(place);
    })
  });
  $('#translationToggle').addEventListener('click', () => {
    if (!ready) return;
    $('#translationPanel').hidden = !$('#translationPanel').hidden;
    $('#translationToggle').setAttribute('aria-expanded', String(!$('#translationPanel').hidden));
    scheduleLayout(location(true));
  });
  $('#translationClose').addEventListener('click', () => {
    $('#translationPanel').hidden = true; $('#translationToggle').setAttribute('aria-expanded', 'false'); scheduleLayout(location(true));
  });
  $('#translationOriginal').addEventListener('click', () => translation.reset());
  $('#translateSelection').addEventListener('click', () => {
    if (!selection || selection.chapter !== chapter) return;
    $('#translationPanel').hidden = false; $('#translationToggle').setAttribute('aria-expanded', 'true'); translation.translate(selection.quote, selection.start); dismissMarkToolbar();
  });
  window.ShelfReader = {open, progress};
})();
