const {test} = require('node:test');
const assert = require('node:assert/strict');
const {chunks, create} = require('../translation.js');

test('translation chunks retain Chinese, English and Unicode without exceeding input bounds', () => {
  const text = ('Hello world. 你好，世界！😀'.repeat(300));
  const parts = chunks(text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => p.length <= 1200 && !/[\uD800-\uDBFF]$/.test(p)));
  assert.equal(parts.join('').replace(/\s/g,''), text.replace(/\s/g,''));
  assert.deepEqual(chunks('First paragraph.\n\n第二段。'), ['First paragraph.', '第二段。']);
  assert.deepEqual(chunks('   '), []);
});

function setup(api) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {value:'en-zh', textContent:'', children:[], handlers:{}, addEventListener(e,f){this.handlers[e]=f;}, setAttribute(){}, replaceChildren(){this.children=[];}, append(...nodes){this.children.push(...nodes);}});
    return elements.get(id);
  }
  global.window = {isSecureContext:true, Translator:api};
  global.document = {getElementById:element, createElement:()=>element(Symbol())};
  const preferences = {};
  const pairs=[];
  const view={clear(){pairs.length=0;},prepare:selected=>chunks(selected),pair(...args){pairs.push(args);}};
  const controller = create({view,content:{lang:'en'}, preferences:()=>preferences, save(){}});
  return {element, controller, pairs};
}

test('unavailable native API disables chapter translation and explains support', async () => {
  const {element,controller} = setup(undefined);
  assert.equal(element('translateChapter').disabled,true);
  await controller.translate('Hello');
  assert.match(element('translationStatus').textContent,/Chrome/);
});

test('direction, safe text rendering, and successful translation', async () => {
  let options, destroyed = 0;
  const {element,controller,pairs} = setup({async create(value){options=value; return {translate:async text=>'译文 '+text, destroy(){destroyed++;}};}});
  element('translationDirection').value='zh-en';
  await controller.translate('<script>你好</script>');
  assert.equal(options.sourceLanguage,'zh');
  assert.equal(options.targetLanguage,'en');
  assert.equal(pairs[0][0],'<script>你好</script>');
  assert.equal(pairs[0][1],'译文 <script>你好</script>');
  assert.equal(pairs[0][4],'en');
  assert.equal(destroyed,1);
  assert.equal(element('translationStop').disabled,true);
});

test('chapter reset discards pending translation and destroys session', async () => {
  let resolve, destroyed=0;
  const {element,controller,pairs}=setup({async create(){return {translate:()=>new Promise(r=>resolve=r),destroy(){destroyed++;}};}});
  const pending=controller.translate('Hello');
  await Promise.resolve();
  controller.reset(); resolve('你好'); await pending;
  assert.equal(pairs.length,0);
  assert.equal(destroyed,1);
  assert.equal(element('translateChapter').disabled,false);
});

test('cancel during model creation disposes late sessions', async () => {
  let resolve, destroyed=0;
  const {controller}=setup({create:()=>new Promise(r=>resolve=r)});
  const pending=controller.translate('Hello'); controller.reset();
  resolve({destroy(){destroyed++;}}); await pending;
  assert.equal(destroyed,1);
});

test('translation failure restores retry controls', async () => {
  const {controller,element}=setup({async create(){throw new Error('Model unavailable');}});
  await controller.translate('Hello');
  assert.match(element('translationStatus').textContent,/Model unavailable/);
  assert.equal(element('translateChapter').disabled,false);
});

test('chapter extraction keeps inline marks in their paragraph without changing source text', () => {
  const {chapterText} = require('../translation.js');
  const p1={}, p2={};
  const nodes=[['Hello ',p1],['marked',p1],[' world.',p1],['第二段。',p2]].map(([textContent,block])=>({textContent,parentElement:{closest:()=>block}}));
  global.NodeFilter={SHOW_TEXT:4};
  global.document={createTreeWalker(){let i=0; return {nextNode:()=>nodes[i++]};}};
  assert.equal(chapterText({}), 'Hello marked world.\n\n第二段。');
  assert.equal(nodes.map(n=>n.textContent).join(''), 'Hello marked world.第二段。');
});
