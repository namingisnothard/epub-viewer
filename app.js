/* The viewer only knows publications explicitly uploaded to this server session. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  let books = [], uploading = false;
  function render() {
    $('#uploadedSection').hidden = !books.length;
    $('#resultCount').textContent = `${books.length} ${books.length === 1 ? 'book' : 'books'}`;
    $('#bookGrid').replaceChildren();
    for (const book of books) {
      const card = document.createElement('article'); card.className = 'uploaded-book';
      const details = document.createElement('div');
      const title = document.createElement('h3'); title.textContent = book.title;
      const author = document.createElement('p'); author.textContent = `${book.author} · ${book.language}`;
      const progress = ShelfReader.progress(book);
      const open = document.createElement('button'); open.type = 'button';
      open.textContent = progress.updatedAt ? `Continue · ${progress.percent}% →` : 'Read →';
      open.addEventListener('click', () => ShelfReader.open(book));
      details.append(title, author); card.append(details, open); $('#bookGrid').append(card);
    }
  }
  async function importFiles(files) {
    if (uploading || !files.length) return;
    uploading = true; $('#uploadEpub').disabled = true;
    $('#uploadFeedback').hidden = false; $('#uploadResults').replaceChildren();
    let added = 0, failed = 0, singleBook;
    try {
      for (const [index, file] of [...files].entries()) {
        const row = document.createElement('li'); $('#uploadResults').append(row);
        $('#uploadStatus').textContent = `Opening ${index + 1} of ${files.length}: ${file.name}`;
        try {
          if (!/\.epub$/i.test(file.name) || !file.size || file.size > 100 * 1024 * 1024) throw new Error('Choose a non-empty .epub file up to 100 MB.');
          const response = await fetch('/api/upload', {method:'POST', headers:{'Content-Type':'application/epub+zip', 'X-Filename':encodeURIComponent(file.name)}, body:file});
          const data = await response.json();
          if (!response.ok || !data.book) throw new Error(data.error || 'Could not open this EPUB.');
          books = data.books; added++; singleBook = data.book; render();
          row.textContent = `${data.book.title} — ${data.duplicate ? 'already uploaded' : 'ready to read'}.`;
        } catch (error) {
          failed++; row.className = 'upload-error'; row.textContent = `${file.name}: ${error.message}`;
        }
      }
      $('#uploadStatus').textContent = `${added} ready to read${failed ? ` · ${failed} could not be opened` : ''}.`;
      if (files.length === 1 && singleBook) ShelfReader.open(singleBook);
    } finally {
      uploading = false; $('#uploadEpub').disabled = false; $('#epubFiles').value = '';
    }
  }
  $('#uploadEpub').addEventListener('click', () => $('#epubFiles').click());
  $('#epubFiles').addEventListener('change', () => importFiles($('#epubFiles').files));
  let dragDepth = 0;
  const zone = $('#uploadZone');
  zone.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; zone.classList.add('is-dragging'); });
  zone.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = uploading ? 'none' : 'copy'; });
  zone.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; zone.classList.remove('is-dragging'); } });
  zone.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; zone.classList.remove('is-dragging'); importFiles(event.dataTransfer.files); });
  $('#themeButton').addEventListener('click', () => {
    document.body.classList.toggle('dark');
    try { localStorage.setItem('shelf-theme', document.body.classList.contains('dark') ? 'dark' : 'light'); } catch {}
  });
  try { document.body.classList.toggle('dark', localStorage.getItem('shelf-theme') === 'dark'); } catch {}
  window.addEventListener('shelf-progress', render);
  fetch('/api/library').then(response => {
    if (!response.ok) throw new Error('Viewer server unavailable');
    return response.json();
  }).then(data => { books = data.books || []; render(); }).catch(() => {
    $('#uploadFeedback').hidden = false;
    $('#uploadStatus').textContent = 'Start the viewer with python3 scripts/serve.py, then open http://127.0.0.1:3000.';
  });
})();
