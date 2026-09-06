const {test} = require('node:test');
const assert = require('node:assert/strict');
const {segments,locate,create} = require('../narration.js');

test('speech sentences preserve annotation offsets across paragraphs and repeated words', () => {
  const raw='Hello reader. Hello again!Next paragraph.';
  const split=raw.indexOf('Next');
  const result=segments([{text:raw.slice(0,split),start:0},{text:raw.slice(split),start:split}]);
  assert.equal(result.length,3);
  for(const sentence of result) {
    assert.equal(raw.slice(sentence.start,sentence.end),sentence.text);
    for(const word of sentence.words) assert.equal(raw.slice(sentence.start+word.index,sentence.start+word.index+word.text.length),word.text);
  }
  assert.deepEqual(locate(result,raw.indexOf('again')+2),{index:1,word:1});
  assert.deepEqual(locate(result,raw.length),{index:2,word:1});
});
test('Chinese word and sentence offsets work without spaces', () => {
  const raw='你好，世界。阅读让生活更有趣！';
  const result=segments([{text:raw,start:0}],'zh');
  assert.equal(result.length,2);
  assert.ok(result[0].words.length>=2);
  const located=locate(result,raw.indexOf('世界'));
  assert.equal(result[located.index].words[located.word].text,'世界');
  assert.equal(result[1].start,raw.indexOf('阅读'));
});
test('inline formatting remains one sentence and whitespace-only paragraphs are ignored', () => {
  const result=segments([{text:'A bold word and a link. ',start:0},{text:'\n  ',start:24},{text:'One more.',start:27}]);
  assert.equal(result.length,2);
  assert.equal(result[0].words[2].text,'word');
  assert.equal(result[1].start,27);
  assert.deepEqual(locate([],0),{index:0,word:0});
});

test('pause, resume, voice changes and stale speech events preserve position', () => {
  const elements=new Map();
  const element=id=> {
    if(!elements.has(id))elements.set(id,{value:'',checked:true,disabled:false,handlers:{},classList:{toggle(){},remove(){},add(){}},addEventListener(type,handler){this.handlers[type]=handler;},replaceChildren(){},add(){},setAttribute(){}});
    return elements.get(id);
  };
  let last, continued=0;
  const spoken=[];
  const synth={cancel(){},speak(value){last=value;spoken.push(value);},getVoices:()=>[{voiceURI:'test',lang:'en-US',name:'Test',localService:true}],addEventListener(){}};
  const block={};
  const node={textContent:'Hello reader. Next sentence.',length:28,parentElement:{closest:()=>block}};
  global.window={speechSynthesis:synth,SpeechSynthesisUtterance:class{},addEventListener(){}};
  global.SpeechSynthesisUtterance=class {constructor(text){this.text=text;}};
  global.Option=class{};
  global.NodeFilter={SHOW_TEXT:4};
  global.document={getElementById:element,createTreeWalker(){let used=false;return {nextNode(){if(used)return null;used=true;return node;}};}};
  const preferences={};
  const controller=create({content:{lang:'en',addEventListener(){},classList:{remove(){}}},preferences:()=>preferences,save(){},anchor:()=>0,reveal(){},nextChapter(){continued++;},onPick(){}});
  try {
    controller.load();
    element('speechPlay').handlers.click();
    assert.equal(last.text,'Hello reader. ');
    last.onboundary({charIndex:6,name:'word'});
    assert.equal(element('speechWord').textContent,'reader');
    const stale=last;
    element('speechPlay').handlers.click();
    assert.equal(element('speechPlay').textContent,'继续朗读');
    stale.onend();
    assert.equal(spoken.length,1);
    element('speechVoice').value='test';element('speechVoice').handlers.change();
    element('speechRate').value='3';element('speechRate').handlers.input();element('speechRate').handlers.change();
    assert.equal(spoken.length,1);
    element('speechPlay').handlers.click();
    assert.equal(last.text,'reader. ');
    assert.equal(last.voice.voiceURI,'test');
    assert.equal(last.rate,3);
    assert.equal(preferences.rate,3);
    last.onend();
    assert.equal(last.text,'Next sentence.');
    const stopped=last;controller.stop();stopped.onend();
    assert.equal(continued,0);
    assert.equal(element('speechPlay').textContent,'开始朗读');
  } finally {
    for(const name of ['window','SpeechSynthesisUtterance','Option','NodeFilter','document'])delete global[name];
  }
});
