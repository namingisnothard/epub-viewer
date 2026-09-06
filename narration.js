/* Speech offsets use the same raw text coordinates as annotations. */
(() => {
  'use strict';
  function segments(runs, language = 'en') {
    let sentences, words;
    try {
      sentences = new Intl.Segmenter(language, {granularity:'sentence'});
      words = new Intl.Segmenter(language, {granularity:'word'});
    } catch { /* Older browsers use punctuation and whitespace boundaries. */ }
    return runs.flatMap(run => {
      const parts = sentences ? [...sentences.segment(run.text)] : [...run.text.matchAll(/[^.!?。！？\n]+[.!?。！？]*\s*/gu)].map(m => ({segment:m[0], index:m.index}));
      return parts.filter(p => p.segment.trim()).map(p => {
        const tokens = words ? [...words.segment(p.segment)].filter(w => w.isWordLike).map(w => ({index:w.index, text:w.segment})) : [...p.segment.matchAll(/[\p{L}\p{N}]+/gu)].map(m => ({index:m.index, text:m[0]}));
        return {text:p.segment, start:run.start+p.index, end:run.start+p.index+p.segment.length, words:tokens};
      });
    });
  }
  function locate(sentences, offset) {
    let index = sentences.findIndex(s => s.end > offset);
    if (index < 0) index = Math.max(0, sentences.length-1);
    const sentence = sentences[index];
    const word = sentence?.words.findIndex(w => sentence.start+w.index+w.text.length > offset) ?? -1;
    return {index, word:word < 0 ? Math.max(0,(sentence?.words.length || 1)-1) : word};
  }
  function create({content, preferences, save, anchor, reveal, nextChapter, onPick}) {
    const $ = id => document.getElementById(id), synth = window.speechSynthesis;
    const supported = !!synth && 'SpeechSynthesisUtterance' in window;
    let items = [], index = 0, word = 0, state = 'idle', epoch = 0, voices = [], utterance, picking = false, positioned = false, trackingWord = false;
    const prefs = () => preferences();
    const status = text => { $('speechStatus').textContent = text; };
    function range(start, end) {
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      let node, at = 0, result = document.createRange(), found = false;
      while ((node = walker.nextNode())) {
        if (!found && start < at+node.length) { result.setStart(node, Math.max(0,start-at)); found = true; }
        if (found && end <= at+node.length) { result.setEnd(node, Math.max(0,end-at)); return result; }
        at += node.length;
      }
      return null;
    }
    function highlight(wordActive = true) {
      const sentence = items[index];
      if (!sentence) return;
      trackingWord = wordActive;
      const token = wordActive ? sentence.words[word] : null;
      $('speechPosition').textContent = `第 ${index+1} / ${items.length} 句${token ? ` · 第 ${word+1} / ${sentence.words.length} 词` : ''}`;
      $('speechSentence').textContent = sentence.text;
      $('speechWord').textContent = token?.text || '—';
      if (globalThis.CSS?.highlights && globalThis.Highlight) {
        const sr = range(sentence.start,sentence.end), wr = token && range(sentence.start+token.index,sentence.start+token.index+token.text.length);
        CSS.highlights.set('shelf-sentence',new Highlight(...(sr ? [sr] : [])));
        CSS.highlights.set('shelf-word',new Highlight(...(wr ? [wr] : [])));
      }
      if (prefs().follow !== false) reveal(sentence.start+(token?.index || 0));
    }
    function buttons() {
      $('speechPlay').disabled = !supported || !items.length;
      $('speechPlay').textContent = state === 'playing' ? '暂停朗读' : state === 'paused' ? '继续朗读' : '开始朗读';
      $('speechStop').disabled = state === 'idle';
      for (const [id, disabled] of Object.entries({speechPrevSentence:index<=0, speechNextSentence:index>=items.length-1, speechPrevWord:index===0&&word===0, speechNextWord:index>=items.length-1&&word>=((items[index]?.words.length||1)-1)})) $(id).disabled = !items.length || disabled;
      $('speechPick').disabled = !items.length;
      $('speechToggle').classList.toggle('is-speaking',state==='playing');
    }
    function stop(clear = true) {
      ++epoch; synth?.cancel(); utterance = null; state = 'idle'; buttons();
      if (clear) { globalThis.CSS?.highlights?.delete('shelf-sentence'); globalThis.CSS?.highlights?.delete('shelf-word'); }
    }
    function voiceList() {
      if (!supported) return;
      voices = synth.getVoices();
      const selected = prefs()?.voice || '';
      $('speechVoice').replaceChildren(new Option('自动匹配书籍语言',''));
      for (const voice of voices) $('speechVoice').add(new Option(`${voice.name} · ${voice.lang}${voice.localService ? ' · 本机' : ' · 在线'}`,voice.voiceURI));
      $('speechVoice').value = voices.some(v=>v.voiceURI===selected) ? selected : '';
    }
    function speak() {
      if (!supported || !items[index]) return;
      stop(false); state = 'playing'; const ticket = epoch, sentence = items[index];
      const start = sentence.words[word]?.index || 0;
      utterance = new SpeechSynthesisUtterance(sentence.text.slice(start));
      const preferred = voices.find(v => v.voiceURI === prefs().voice);
      utterance.voice = preferred || voices.find(v => v.lang.toLowerCase().split('-')[0] === (content.lang || 'en').split('-')[0]) || null;
      utterance.lang = utterance.voice?.lang || content.lang || 'en';
      utterance.rate = Number(prefs().rate) || 1;
      utterance.onstart = () => { if (ticket===epoch) status('正在朗读 · 句子定位'); };
      utterance.onboundary = event => {
        if (ticket!==epoch || state!=='playing') return;
        const pos = sentence.start+start+event.charIndex;
        word = locate([sentence],pos).word; highlight(event.name === 'word'); buttons();
        status(event.name === 'word' ? '正在朗读 · 单词定位' : '正在朗读 · 句子定位');
      };
      utterance.onend = () => {
        if (ticket!==epoch) return;
        if (index+1<items.length) { ++index; word=0; speak(); }
        else { stop(); status('本章朗读完成'); if (prefs().continue !== false) nextChapter(); }
      };
      utterance.onerror = event => { if (ticket===epoch) { stop(); status(event.error==='not-allowed' ? '请点击开始朗读以启用声音。' : `声音暂时不可用（${event.error}），请换一个声音重试。`); } };
      highlight(false); buttons(); status('正在准备声音…'); synth.speak(utterance);
    }
    function seek(offset, play = false) {
      positioned = true;
      ({index,word} = locate(items,offset));
      if ((play && supported) || state==='playing') speak();
      else { stop(false); highlight(); buttons(); status('已定位，可开始朗读'); }
    }
    function move(unit, delta) {
      positioned = true;
      const playing = state==='playing';
      if (unit==='sentence') { index=Math.max(0,Math.min(items.length-1,index+delta)); word=0; }
      else {
        word+=delta;
        if (word<0 && index>0) { --index; word=Math.max(0,items[index].words.length-1); }
        else if (word>=items[index].words.length && index<items.length-1) { ++index; word=0; }
        word=Math.max(0,Math.min(Math.max(0,items[index].words.length-1),word));
      }
      if (playing) speak(); else { stop(false); highlight(); buttons(); status('已定位，可开始朗读'); }
    }
    function load(autoplay = false) {
      stop(); let rawOffset=0, block=null, runs=[];
      const walker=document.createTreeWalker(content,NodeFilter.SHOW_TEXT); let node;
      while ((node=walker.nextNode())) {
        const parent=node.parentElement.closest('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th,div') || content;
        if (parent!==block) { runs.push({start:rawOffset,text:''}); block=parent; }
        runs[runs.length-1].text+=node.textContent; rawOffset+=node.length;
      }
      items=segments(runs,content.lang||'en'); ({index,word}=locate(items,anchor()||0));
      $('speechRate').value=prefs().rate||1; $('speechRateOutput').textContent=`${prefs().rate||1}×`;
      $('speechFollow').checked=prefs().follow!==false; $('speechContinue').checked=prefs().continue!==false;
      $('speechPosition').textContent=items.length ? `${items.length} 句 · 从当前阅读位置开始` : '本章没有可朗读的文字';
      $('speechSentence').textContent=''; $('speechWord').textContent='—';
      picking=false; positioned=false; $('speechPick').setAttribute('aria-pressed','false'); content.classList.remove('speech-picking');
      voiceList(); buttons(); status(supported ? '准备就绪' : '此浏览器不支持自动朗读，可使用句子／单词定位。');
      if (autoplay) { if(items.length) speak(); else nextChapter(); }
    }
    $('speechPlay').addEventListener('click',()=>{
      // Cancel the current utterance and resume from its last word boundary;
      // native pause can remain stuck across voices in some browser engines.
      if (state==='playing') { ++epoch; synth.cancel(); utterance=null; state='paused'; status('已暂停 · 继续时从当前词开始'); buttons(); }
      else if(state==='paused') speak();
      else { if (!positioned) ({index,word}=locate(items,anchor()||0)); speak(); positioned=true; }
    });
    $('speechStop').addEventListener('click',()=>{stop();status('已停止');});
    for(const [id,unit,delta] of [['speechPrevSentence','sentence',-1],['speechNextSentence','sentence',1],['speechPrevWord','word',-1],['speechNextWord','word',1]]) $(id).addEventListener('click',()=>move(unit,delta));
    $('speechVoice').addEventListener('change',()=>{prefs().voice=$('speechVoice').value;save();if(state==='playing') speak();});
    $('speechRate').addEventListener('input',()=>{prefs().rate=Number($('speechRate').value);$('speechRateOutput').textContent=`${prefs().rate}×`;save();});
    $('speechRate').addEventListener('change',()=>{if(state==='playing') speak();});
    for(const [id,key] of [['speechFollow','follow'],['speechContinue','continue']]) $(id).addEventListener('change',()=>{prefs()[key]=$(id).checked;save();});
    $('speechPick').addEventListener('click',()=>{picking=!picking;$('speechPick').setAttribute('aria-pressed',String(picking));content.classList.toggle('speech-picking',picking);if(picking)onPick();status(picking?'点击正文中的单词，从该处开始。':'点选定位已关闭');});
    content.addEventListener('click',event=>{
      if(!picking) return;
      let node, offset;
      if(document.caretPositionFromPoint) {const caret=document.caretPositionFromPoint(event.clientX,event.clientY);node=caret?.offsetNode;offset=caret?.offset;}
      else {const caret=document.caretRangeFromPoint?.(event.clientX,event.clientY);node=caret?.startContainer;offset=caret?.startOffset;}
      if(!node||!content.contains(node))return;
      event.preventDefault();event.stopImmediatePropagation();
      const before=document.createRange();before.selectNodeContents(content);before.setEnd(node,offset);seek(before.toString().length,true);
    },true);
    synth?.addEventListener('voiceschanged',voiceList);
    window.addEventListener('pagehide',()=>stop());
    return {load,stop,seek,refresh:()=>{if(state!=='idle')highlight(trackingWord);}};
  }
  if (typeof module !== 'undefined') module.exports={segments,locate,create};
  else window.ShelfNarration={create};
})();
