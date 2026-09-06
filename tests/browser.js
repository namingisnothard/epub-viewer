/* Generated test publications only. Open tests/browser.html on a static server. */
(async () => {
  const rows = document.getElementById('results'); let passed = 0, failed = 0;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  async function test(name, run) {
    const row = document.createElement('li'); rows.append(row);
    try { await run(); passed++; row.textContent = 'PASS · ' + name; }
    catch (error) { failed++; row.textContent = 'FAIL · ' + name + ': ' + error.message; }
  }
  async function fixture(options = {}) {
    const zip = new JSZip();
    zip.file('mimetype','application/epub+zip');
    zip.file('META-INF/container.xml','<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>');
    zip.file('OPS/book.opf','<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>A Quiet Page</dc:title><dc:creator>Example Author</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="one" href="Text/chapter.xhtml" media-type="application/xhtml+xml"/><item id="image" href="Images/circle.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="one"/></spine></package>');
    zip.file('OPS/Text/chapter.xhtml','<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><h1>A Quiet Page</h1><p id="one" onclick="bad()">A small&nbsp;story about a <em>garden</em>.</p><script>window.unwantedScript=true;</script><iframe src="https://tracker.example/"></iframe><img src="../Images/circle.svg" alt="A circle"/><img src="https://tracker.example/image.png"/><a href="#one">Back</a><a href="javascript:bad()">Unsafe</a></body></html>');
    zip.file('OPS/Images/circle.svg','<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>bad()</script><circle cx="50" cy="50" r="30" fill="green" onclick="bad()"/></svg>');
    if (options.encrypted) zip.file('META-INF/encryption.xml','<encryption><EncryptionMethod Algorithm="unsupported"/></encryption>');
    if (options.missing) zip.remove('OPS/Text/chapter.xhtml');
    return new File([await zip.generateAsync({type:'uint8array'})], 'example.epub', {type:'application/epub+zip'});
  }
  let imported, file;
  await test('Starts with no books', () => assert(ShelfBooks.list().length === 0,'Unexpected catalog'));
  await test('Opens a generated EPUB without a server API', async () => {
    file = await fixture(); imported = await ShelfBooks.importFile(file);
    assert(imported.book.title === 'A Quiet Page','Wrong title');
    assert(ShelfBooks.read(imported.book.id).chapters.length === 1,'Missing chapter');
  });
  await test('Sanitizes chapters, keeps relative images, and handles HTML entities', async () => {
    const chapter = ShelfBooks.read(imported.book.id).chapters[0];
    assert(!/script|iframe|onclick|tracker.example|javascript:/.test(chapter.html),'Unsafe markup survived');
    assert(chapter.html.includes('blob:'),'Missing local image');
    assert(chapter.html.includes('reader-one') && chapter.html.includes('data-path="OPS/Text/chapter.xhtml"'),'Lost anchors');
    assert(chapter.html.includes('garden'),'Missing text');
    const holder = document.createElement('div'); holder.innerHTML = chapter.html;
    const svg = await fetch(holder.querySelector('img').src).then(response => response.text());
    assert(!/script|onclick/.test(svg),'Unsafe SVG survived');
  });
  await test('Reopening identical bytes preserves identity', async () => {
    const again = await ShelfBooks.importFile(new File([await file.arrayBuffer()],'renamed.epub'));
    assert(again.duplicate && again.book.id === imported.book.id && ShelfBooks.list().length === 1,'Deduplication failed');
  });
  await test('Rejects non-EPUB, damaged, encrypted and missing-chapter publications', async () => {
    for (const bad of [new File(['bad'],'file.pdf'),new File(['bad'],'bad.epub'),await fixture({encrypted:true}),await fixture({missing:true})]) {
      let rejected = false; try { await ShelfBooks.importFile(bad); } catch { rejected = true; }
      assert(rejected,'Invalid publication was accepted');
    }
    assert(ShelfBooks.list().length === 1,'Failed imports added books');
  });
  await test('Two language columns preserve source offsets and restore original markup', () => {
    const select = document.createElement('select'); select.id = 'translationDirection'; select.append(new Option('English','en-zh')); document.body.append(select);
    const content = document.createElement('article'); content.innerHTML = ShelfBooks.read(imported.book.id).chapters[0].html; document.body.append(content);
    const original = content.innerHTML, text = content.textContent;
    const view = ShelfTranslation.inlineView(content, () => {});
    const parts = view.prepare();
    view.pair(parts[0],'安静的一页',0,'en','zh');
    assert(content.querySelectorAll('.bilingual-spread').length === 1,'Expected a single spread');
    assert(content.querySelector('.bilingual-source').textContent === text,'Source column changed');
    assert(content.textContent === text,'Translation changed annotation offsets');
    assert(content.querySelector('.bilingual-target').shadowRoot.textContent.includes('安静的一页'),'Missing Chinese');
    view.clear(); assert(content.innerHTML === original,'Original markup not restored'); content.remove(); select.remove();
  });
  await test('Exports a valid personalized EPUB while preserving original resources', async () => {
    const before = await file.arrayBuffer();
    const blob = await ShelfBooks.exportBook(imported.book.id,{preferences:{paper:'kraft',texture:70,theme:'night',size:24,columns:2},annotations:[{kind:'note',path:'OPS/Text/chapter.xhtml',chapterTitle:'Chapter',text:'A thought & another',quote:'A <garden>'},{kind:'doodle',strokes:[{color:'#284c3c',points:[[1,2],[3,4]]}]}]});
    const bytes = await blob.arrayBuffer(), zip = await JSZip.loadAsync(bytes);
    const view = new DataView(bytes); assert(view.getUint16(8,true) === 0,'Mimetype compressed');
    assert(new TextDecoder().decode(new Uint8Array(bytes,30,8)) === 'mimetype','Mimetype not first');
    const notes = Object.keys(zip.files).find(name => name.endsWith('/notebook.xhtml'));
    const notebook = await zip.file(notes).async('string');
    assert(notebook.includes('A thought &amp; another') && notebook.includes('<polyline'),'Notebook incomplete');
    const opf = new DOMParser().parseFromString(await zip.file('OPS/book.opf').async('string'),'application/xml');
    assert(!opf.querySelector('parsererror'),'Invalid package XML');
    assert(opf.getElementsByTagNameNS('*','itemref').length === 2,'Notebook missing from spine');
    assert((await zip.file('OPS/Text/chapter.xhtml').async('string')).includes('reading.css'),'Missing reading style');
    const original = await JSZip.loadAsync(before);
    assert(await zip.file('OPS/Images/circle.svg').async('string') === await original.file('OPS/Images/circle.svg').async('string'),'Original image changed');
    const reimport = await ShelfBooks.importFile(new File([blob],'personal.epub'));
    assert(ShelfBooks.read(reimport.book.id).chapters.length === 2,'Export cannot be reopened');
  });
  await test('Actual reader opens the browser-held book with no API requests', async () => {
    const frame = document.createElement('iframe'); frame.style.cssText='width:100%;height:650px';
    const ready = new Promise(resolve => frame.onload = resolve); frame.src='index.html'; document.body.append(frame); await ready;
    const app = frame.contentWindow;
    const transfer = new app.DataTransfer(); transfer.items.add(new app.File([await file.arrayBuffer()],file.name,{type:'application/epub+zip'}));
    const input = frame.contentDocument.getElementById('epubFiles'); input.files = transfer.files; input.dispatchEvent(new app.Event('change',{bubbles:true}));
    for (let i = 0; i < 200 && !frame.contentDocument.getElementById('reader').open; i++) await new Promise(resolve => setTimeout(resolve,25));
    assert(frame.contentDocument.getElementById('reader').open,'Reader did not open');
    assert(frame.contentDocument.getElementById('readingContent').textContent.includes('garden'),'Missing book text');
  });
  document.getElementById('status').textContent = `${passed} passed · ${failed} failed`;
})();
