/* Browser-only EPUB storage, passive chapter rendering, and personal exports. */
(() => {
  'use strict';
  const MAX_FILE = 100 * 1024 * 1024;
  const books = new Map();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const number = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
  function resolve(base, href) {
    const value = decodeURIComponent(href.split('#')[0].split('?')[0]);
    if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(value) || value.includes('\\')) throw new Error('Invalid EPUB resource path.');
    const parts = base.split('/').slice(0, -1);
    for (const part of value.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) throw new Error('EPUB resource escapes its archive.'); parts.pop(); }
      else parts.push(part);
    }
    return parts.join('/');
  }
  function checkZip(buffer) {
    const view = new DataView(buffer); let end = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === buffer.byteLength) { end = i; break; }
    }
    if (end < 0) throw new Error('This file is not a supported EPUB archive.');
    const count = view.getUint16(end + 10, true), centralSize = view.getUint32(end + 12, true);
    let at = view.getUint32(end + 16, true), total = 0;
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true) || !count || count > 10000 || at + centralSize > end) throw new Error('Unsupported or oversized EPUB archive.');
    const names = new Set(), decoder = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) throw new Error('Damaged EPUB directory.');
      const size = view.getUint32(at + 24, true), nameLength = view.getUint16(at + 28, true);
      total += size;
      if (size > MAX_FILE || total > 512 * 1024 * 1024 || view.getUint16(at + 8, true) & 1) throw new Error('This EPUB is encrypted or too large when unpacked.');
      const next = at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
      if (next > end) throw new Error('Damaged EPUB directory.');
      const name = decoder.decode(new Uint8Array(buffer, at + 46, nameLength));
      if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || names.has(name)) throw new Error('Unsafe or duplicate EPUB resource path.');
      names.add(name); at = next;
    }
    return count;
  }
  function xml(raw) {
    raw = raw.replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (entity, name) => {
      if (['amp','lt','gt','quot','apos'].includes(name)) return entity;
      const decoder = document.createElement('textarea'); decoder.innerHTML = entity;
      return decoder.value === entity ? entity : [...decoder.value].map(char => `&#${char.codePointAt(0)};`).join('');
    });
    const doc = new DOMParser().parseFromString(raw, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('This EPUB contains malformed XML.');
    return doc;
  }
  const elements = (root, name) => [...root.getElementsByTagNameNS('*', name)];
  async function textFile(zip, path) {
    const file = zip.file(path);
    if (!file) throw new Error('This EPUB is missing a required resource.');
    return file.async('string');
  }
  function sanitizeSvg(raw) {
    const doc = xml(raw);
    const tags = new Set('svg g defs symbol use path rect circle ellipse line polyline polygon text tspan title desc linearGradient radialGradient stop clipPath mask'.split(' '));
    for (const el of [...doc.getElementsByTagName('*')]) {
      if (!tags.has(el.localName)) { el.remove(); continue; }
      for (const attr of [...el.attributes]) {
        const value = attr.value.trim();
        if (/^on/i.test(attr.name) || attr.name === 'style' || (attr.localName === 'href' && !value.startsWith('#')) || (/url\s*\(/i.test(value) && !/^url\(#[\w.-]+\)$/.test(value))) el.removeAttributeNode(attr);
      }
    }
    if (doc.documentElement?.localName !== 'svg') throw new Error('Unsupported SVG image.');
    return new XMLSerializer().serializeToString(doc);
  }
  async function passiveChapter(raw, path, entry) {
    const doc = xml(raw), body = elements(doc, 'body')[0];
    if (!body) throw new Error('This EPUB chapter has no body.');
    const holder = document.createElement('div');
    const allowed = new Set('p div span h1 h2 h3 h4 h5 h6 em strong b i u s small sup sub blockquote pre code ul ol li dl dt dd table thead tbody tfoot tr th td caption hr br img a figure figcaption section article aside ruby rt rp'.split(' '));
    const blocked = new Set('script style iframe object embed form audio video link meta'.split(' '));
    async function imageUrl(href) {
      if (!href || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(href)) return null;
      const resource = resolve(path, href);
      if (entry.urls.has(resource)) return entry.urls.get(resource);
      const file = entry.zip.file(resource);
      const extension = resource.split('.').pop().toLowerCase();
      const mime = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',svg:'image/svg+xml'}[extension];
      if (!file || !mime) return null;
      const data = extension === 'svg' ? sanitizeSvg(await file.async('string')) : await file.async('uint8array');
      const url = URL.createObjectURL(new Blob([data], {type:mime})); entry.urls.set(resource, url); return url;
    }
    async function append(node, parent) {
      if (node.nodeType === 3) { parent.append(document.createTextNode(node.nodeValue)); return; }
      if (node.nodeType !== 1 || blocked.has(node.localName)) return;
      const tag = node.localName === 'image' ? 'img' : node.localName;
      if (!allowed.has(tag)) { for (const child of node.childNodes) await append(child, parent); return; }
      const el = document.createElement(tag);
      for (const name of ['id','lang','title','alt','colspan','rowspan']) {
        if (node.hasAttribute(name)) el.setAttribute(name, (name === 'id' ? 'reader-' : '') + node.getAttribute(name));
      }
      if (tag === 'img') {
        const url = await imageUrl(node.getAttribute('src') || node.getAttribute('href') || node.getAttribute('xlink:href'));
        if (!url) return;
        el.src = url;
      }
      if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        if (/^https?:\/\//i.test(href)) { el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
        else if (!/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(href)) {
          el.href = '#'; el.dataset.path = href.split('#')[0] ? resolve(path, href) : path;
          el.dataset.fragment = decodeURIComponent(href.split('#')[1] || '');
        }
      }
      for (const child of node.childNodes) await append(child, el);
      parent.append(el);
    }
    for (const child of body.childNodes) await append(child, holder);
    return {html:holder.innerHTML, words:(holder.textContent.match(/[\p{L}\p{N}]+/gu) || []).length, heading:holder.querySelector('h1,h2,h3')?.textContent};
  }
  async function importFile(file) {
    if (!/\.epub$/i.test(file.name) || !file.size || file.size > MAX_FILE) throw new Error('Choose a non-empty .epub file up to 100 MB.');
    const buffer = await file.arrayBuffer(); checkZip(buffer);
    const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(byte => byte.toString(16).padStart(2,'0')).join('');
    if (books.has(id)) return {book:books.get(id).book, books:list(), duplicate:true};
    const zip = await JSZip.loadAsync(buffer);
    if ((await textFile(zip, 'mimetype')).trim() !== 'application/epub+zip') throw new Error('This file is not an EPUB publication.');
    if (zip.file('META-INF/encryption.xml')) {
      const encryption = xml(await textFile(zip,'META-INF/encryption.xml'));
      if (elements(encryption,'EncryptionMethod').some(el => !['http://www.idpf.org/2008/embedding','http://ns.adobe.com/pdf/enc#RC'].includes(el.getAttribute('Algorithm')))) throw new Error('Encrypted EPUBs are unsupported.');
    }
    const container = xml(await textFile(zip,'META-INF/container.xml'));
    const opfPath = resolve('', elements(container,'rootfile')[0]?.getAttribute('full-path') || '');
    const opf = xml(await textFile(zip,opfPath));
    const manifest = new Map(elements(opf,'item').map(el => [el.getAttribute('id'),el]));
    const entry = {zip, buffer, opfPath, opf, urls:new Map(), chapters:[]};
    try {
      const labels = new Map();
      for (const item of manifest.values()) {
        if (item.getAttribute('media-type') !== 'application/x-dtbncx+xml') continue;
        const navPath = resolve(opfPath,item.getAttribute('href'));
        const nav = xml(await textFile(zip,navPath));
        for (const point of elements(nav,'navPoint')) {
          const source = elements(point,'content')[0]?.getAttribute('src');
          if (source) labels.set(resolve(navPath,source),elements(point,'text')[0]?.textContent || '');
        }
      }
      for (const ref of elements(opf,'itemref')) {
        const item = manifest.get(ref.getAttribute('idref'));
        if (!item) throw new Error('This EPUB is missing a chapter.');
        if (!/html/.test(item.getAttribute('media-type'))) continue;
        const path = resolve(opfPath,item.getAttribute('href'));
        const raw = await textFile(zip,path);
        const chapter = await passiveChapter(raw,path,entry);
        entry.chapters.push({path, title:(labels.get(path) || chapter.heading || `Section ${entry.chapters.length + 1}`).slice(0,180), html:chapter.html, words:chapter.words});
      }
      if (!entry.chapters.length) throw new Error('No readable chapters were found.');
      const metadata = elements(opf,'metadata')[0];
      const value = (name, fallback) => metadata && elements(metadata,name)[0]?.textContent.trim() || fallback;
      const language = value('language','en').toLowerCase().split('-')[0];
      entry.book = {id, title:value('title',file.name.replace(/\.epub$/i,'')), author:value('creator','Unknown author'), language:({en:'English',zh:'Chinese',de:'German',fr:'French',es:'Spanish',ja:'Japanese'})[language] || language, wordCount:entry.chapters.reduce((sum,chapter) => sum+chapter.words,0)};
      books.set(id,entry); return {book:entry.book, books:list(), duplicate:false};
    } catch (error) { entry.urls.forEach(url => URL.revokeObjectURL(url)); throw error; }
  }
  const list = () => [...books.values()].map(entry => entry.book);
  function read(id) {
    const entry = books.get(id); if (!entry) throw new Error('Choose your EPUB again to reopen it.');
    return {chapters:entry.chapters};
  }
  async function exportBook(id, data) {
    const entry = books.get(id); if (!entry) throw new Error('Choose your EPUB again to export it.');
    const zip = await JSZip.loadAsync(entry.buffer), opf = xml(await textFile(zip,entry.opfPath));
    const folder = `shelf-personal-${crypto.randomUUID()}`;
    const base = entry.opfPath.split('/').slice(0,-1).join('/');
    const root = (base ? base+'/' : '') + folder;
    const p = data.preferences || {}, n = number;
    const themes = {paper:['#faf7f0','#283830'],white:['#ffffff','#202522'],sepia:['#eee0c6','#493c2a'],night:['#19241f','#e0e6dc']};
    let [bg,fg] = themes[p.theme] || themes.paper;
    const materials = {kraft:['#d6b686','#382919'],cotton:['#f5f1e7','#343b33'],grain:['#e5dfd1','#383a32']};
    if (materials[p.paper] && p.theme !== 'night') [bg,fg] = materials[p.paper];
    const fonts = {literary:'Georgia, serif',classic:'Palatino, serif',clean:'Arial, sans-serif',mono:'monospace'};
    let css = `html,body{background:${bg}!important;color:${fg}!important}body{font-family:${fonts[p.font] || fonts.literary}!important;font-size:${n(p.size,20,14,32)}px!important;line-height:${n(p.line,1.8,1.3,2.4)}!important;max-width:${n(p.width,680,440,1600)}px;margin:auto!important;padding:1.5em!important;column-count:${n(p.columns,1,1,3)}}p{margin:0 0 ${n(p.paragraph,1,.3,2)}em;letter-spacing:${n(p.spacing,0,0,2)}px;text-align:${p.align === 'justify' ? 'justify' : 'left'}}img,svg{max-width:100%;height:auto}body.shelf-notebook{column-count:1}blockquote{border-left:2px solid currentColor;padding-left:1em}article{margin-bottom:2em}.shelf-mark-highlight{background:#e8cf79;color:#222}.shelf-mark-underline{text-decoration:underline}.shelf-mark-wavy{text-decoration:underline wavy}.shelf-mark-strikethrough{text-decoration:line-through}`;
    const manifest = elements(opf,'manifest')[0], spine = elements(opf,'spine')[0], ns = opf.documentElement.namespaceURI;
    function item(key, href, type) {
      const el = opf.createElementNS(ns,'item'); el.setAttribute('id',folder+'-'+key); el.setAttribute('href',folder+'/'+href); el.setAttribute('media-type',type); manifest.append(el);
    }
    if (materials[p.paper] && n(p.texture,55,0,100) > 0) {
      const response = await fetch(new URL(`assets/paper-${p.paper}.svg`,document.baseURI));
      if (!response.ok) throw new Error('Could not load the selected paper texture.');
      const texture = (await response.text()).replace('>', `><g opacity="${n(p.texture,55,0,100)/100}">`).replace('</svg>','</g></svg>');
      zip.file(root+'/paper.svg',texture); item('paper','paper.svg','image/svg+xml'); css += 'body{background-image:url("paper.svg")}';
    }
    zip.file(root+'/reading.css',css); item('style','reading.css','text/css');
    function relative(from,to) {
      const a = from.split('/').slice(0,-1), b = to.split('/');
      while (a.length && b.length && a[0] === b[0]) { a.shift(); b.shift(); }
      return '../'.repeat(a.length)+b.join('/');
    }
    for (const chapter of entry.chapters) {
      const doc = xml(await textFile(zip,chapter.path));
      const link = doc.createElementNS('http://www.w3.org/1999/xhtml','link'); link.setAttribute('rel','stylesheet'); link.setAttribute('type','text/css'); link.setAttribute('href',relative(chapter.path,root+'/reading.css'));
      elements(doc,'head')[0]?.append(link); zip.file(chapter.path,new XMLSerializer().serializeToString(doc));
    }
    const annotations = (data.annotations || []).map(note => {
      const path = entry.chapters.some(chapter => chapter.path === note.path) ? `<a href="${escape(relative(root+'/notebook.xhtml',note.path))}">${escape(note.chapterTitle || 'Chapter')}</a>` : escape(note.chapterTitle || 'Note');
      const mark = ['highlight','underline','wavy','strikethrough'].includes(note.markStyle || note.kind) ? note.markStyle || note.kind : 'highlight';
      const sketch = note.strokes?.length ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300">'+note.strokes.map(line => `<polyline fill="none" stroke="${/^#[a-f0-9]{6}$/i.test(line.color) ? line.color : '#284c3c'}" stroke-width="3" points="${(line.points || []).map(point => point.map(value => n(value,0,0,600)).join(',')).join(' ')}"/>`).join('')+'</svg>' : '';
      return `<article><h2>${path}</h2>${note.quote ? `<blockquote><span class="shelf-mark-${mark}">${escape(note.quote)}</span></blockquote>` : ''}${note.text ? `<p>${escape(note.text).replace(/\n/g,'<br/>')}</p>` : ''}${sketch}</article>`;
    }).join('');
    zip.file(root+'/notebook.xhtml',`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>My reading notebook</title><link rel="stylesheet" href="reading.css"/></head><body class="shelf-notebook"><h1>My reading notebook</h1>${annotations || '<p>No saved annotations.</p>'}</body></html>`);
    item('notes','notebook.xhtml','application/xhtml+xml');
    const ref = opf.createElementNS(ns,'itemref'); ref.setAttribute('idref',folder+'-notes'); spine.append(ref);
    zip.file(entry.opfPath,new XMLSerializer().serializeToString(opf));
    // Rebuild insertion order so the uncompressed mimetype is always the first entry.
    const output = new JSZip(); output.file('mimetype','application/epub+zip',{compression:'STORE'});
    for (const file of Object.values(zip.files)) if (!file.dir && file.name !== 'mimetype') output.file(file.name,await file.async('uint8array'),{compression:'DEFLATE'});
    return output.generateAsync({type:'blob',mimeType:'application/epub+zip'});
  }
  function clear() { books.forEach(entry => entry.urls.forEach(url => URL.revokeObjectURL(url))); books.clear(); }
  const api = {importFile,list,read,exportBook,clear};
  if (typeof window !== 'undefined') window.ShelfBooks = api;
  if (typeof module !== 'undefined') module.exports = {checkZip,resolve,escape};
})();
