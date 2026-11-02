/** Browser contract tests for the shipped plugin; no OnlyOffice credentials or real documents. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
// Reuse the exact browser runtime installed by the frontend browser CI job.
const webRequire = createRequire(resolve('web/package.json'));
const providerRequire = createRequire(
  webRequire.resolve('@vitest/browser-playwright'),
);
const { chromium, webkit } = providerRequire('playwright');
import ts from 'typescript';
const bridgeSource = (
  await readFile(
    resolve('web/src/components/files/viewers/onlyoffice-assistant-bridge.ts'),
    'utf8',
  )
).replace(/^import [^\n]+;\n/gm, '');
const bridgeScript = ts
  .transpileModule(bridgeSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  })
  .outputText.replace(/^export /gm, '');

const directory = resolve('web/public/onlyoffice-assistant');
// The official SDK accepts executable parent initialization. Reject foreign
// senders before its listener runs, while preserving trusted editor/host traffic.
const officeParent = {},
  mergeronHost = {};
let filter;
runInNewContext(await readFile(resolve(directory, 'bootstrap.js'), 'utf8'), {
  document: {
    currentScript: { dataset: { officeOrigin: 'https://office.test' } },
  },
  location: { origin: 'https://mergeron.test' },
  window: {
    parent: officeParent,
    top: mergeronHost,
    addEventListener(name, listener, capture) {
      assert.equal(name, 'message');
      assert.equal(capture, true);
      filter = listener;
    },
  },
});
for (const [origin, source, type, blocked] of [
  ['https://office.test', officeParent, 'plugin_init', false],
  ['https://evil.test', officeParent, 'plugin_init', true],
  ['https://office.test', {}, 'plugin_init', true],
  ['https://mergeron.test', mergeronHost, 'plugin_init', true],
  [
    'https://mergeron.test',
    mergeronHost,
    'mergeron.onlyoffice.response',
    false,
  ],
  ['https://evil.test', mergeronHost, 'mergeron.onlyoffice.response', true],
  ['https://mergeron.test', {}, 'mergeron.onlyoffice.response', true],
]) {
  let stopped = false;
  filter({
    origin,
    source,
    data: { type },
    stopImmediatePropagation() {
      stopped = true;
    },
  });
  assert.equal(stopped, blocked);
}
const output = resolve(
  process.env.OFFICE_ASSISTANT_SCREENSHOTS || 'artifacts/onlyoffice-assistant',
);
const channel = 'a'.repeat(64);
const sdk = `
window.fixtureState={text:'Introduction initiale.',selection:'',index:0,slides:[{text:'Contexte initial'}],edits:0};
const state=window.fixtureState;
const paragraph=(text='')=>({text,GetText(){return this.text},AddText(t){this.text+=t},SetFontSize(){},SetBold(){},SetColor(){}});
const content=(text)=>({items:[paragraph(text)],GetAllParagraphs(){return this.items},RemoveAllElements(){this.items=[]},Push(p){this.items.push(p)}});
const slide=(text='')=>({text,objects:[],GetAllShapes(){return [{GetDocContent:()=>content(this.text)}]},GetTheme(){return{}},GetLayout(){return{}},ApplyTheme(){},ApplyLayout(){},RemoveAllObjects(){this.objects=[]},AddObject(o){this.objects.push(o)}});
const original=slide(state.slides[0].text);state.slides=[original];
window.Api={GetDocument:()=>({GetAllParagraphs:()=>[paragraph(state.text)],GetRangeBySelect:()=>({GetText:()=>state.selection}),InsertContent(items){const text=items.map(p=>p.text).join('\\n');state.text=state.selection?state.text.replace(state.selection,text):state.text+text;state.edits++}}),CreateParagraph:()=>paragraph(),
GetPresentation:()=>({GetCurSlideIndex:()=>state.index,GetSlidesCount:()=>state.slides.length,GetCurrentSlide:()=>state.slides[state.index],GetSelection:()=>({GetText:()=>state.selection}),GetWidth:()=>12192000,GetHeight:()=>6858000,AddSlide(s,i){state.slides.splice(i,0,s);state.edits++},EnterText(t){state.slides[state.index].text+=t;state.edits++;return true}}),
ThemeColor:()=>({}),CreateSlide:()=>slide(),CreateNoFill:()=>({}),CreateStroke:()=>({}),CreateShape:()=>({content:content(''),SetPosition(){},GetDocContent(){return this.content}})};
window.Asc={scope:{},plugin:{info:{options:{mergeronChannel:"${channel}",mergeronLang:"fr"}},executeMethod(name,args,done){done(state.selection)},callCommand(fn,close,recalc,done){setTimeout(()=>done(fn()),0)}}};
`;
const host = (
  kind,
) => `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OnlyOffice assistant contract fixture</title><style>body{margin:0;background:#e9edf3;font:15px system-ui}header{padding:18px;background:#fff;border-bottom:1px solid #cad2dc}section{display:flex;height:calc(100vh - 57px)}article{flex:1;padding:36px;color:#718096}iframe{border:0;width:360px;background:#f7f9fc}@media(max-width:600px){article{display:none}iframe{width:100%}}</style><header>OnlyOffice · ${kind === 'word' ? 'Dossier de conception.docx' : 'Présentation.pptx'}</header><section><article>Document de vérification</article><iframe title="Mergeron"></iframe></section><script>
window.calls=[];
function getAuthorizationHeader(){return 'Bearer host-only-test-key'}
function withBasePath(path){return path}
window.fetch=async (url,options)=>{const body=JSON.parse(options.body);if(body.sessionId!=='host-only-session'||options.headers.Authorization!=='Bearer host-only-test-key')return new Response('{}',{status:403});let result;const method=url.endsWith('/context')?'context':url.endsWith('/proposals')?'propose':'read';window.calls.push({method,args:body});
if(method==='context')result={project:{id:'p',name:'Projet Conception'},document:{name:'Dossier de conception',kind:'${kind}'},canRun:true,agents:[{id:'agent-a',name:'Rédaction du dossier'},{id:'agent-b',name:'Relecture'}]};
if(method==='propose')result={id:'11111111-1111-4111-8111-111111111111',status:'running'};
if(method==='read')result={id:'11111111-1111-4111-8111-111111111111',status:'ready',action:window.calls.findLast(x=>x.method==='propose').args.action,text:'Une proposition claire et précise.',title:window.calls.findLast(x=>x.method==='propose').args.action==='addSlide'?'Objectifs du projet':''};
return new Response(JSON.stringify(result),{status:200});};
${bridgeScript}
connectOfficeAssistant({sessionId:'host-only-session',channel:'${channel}'});
document.querySelector('iframe').src='/plugin?kind=${kind}&channel=${channel}&mergeronLang=fr';
</script></html>`;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end(host(url.searchParams.get('kind') || 'word'));
    return;
  }
  if (url.pathname === '/plugin') {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      `<html><link rel="stylesheet" href="/plugin.css"><script src="/bootstrap.js" data-office-origin="http://${request.headers.host}"></script><script>${sdk}</script><body><main id="assistant"></main><script src="/plugin.js"></script><script>Asc.plugin.init()</script></body></html>`,
    );
    return;
  }
  const allowed = {
    '/plugin.js': 'application/javascript; charset=utf-8',
    '/bootstrap.js': 'application/javascript; charset=utf-8',
    '/plugin.css': 'text/css',
    '/icon.svg': 'image/svg+xml',
  };
  if (!allowed[url.pathname]) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader('Content-Type', allowed[url.pathname]);
  response.end(await readFile(resolve(directory, url.pathname.slice(1))));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(output, { recursive: true });
try {
  for (const [name, engine] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const width of [1280, 390]) {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
        });
        await page.goto(base);
        const frame = page.frameLocator('iframe');
        await frame
          .getByRole('combobox', { name: 'Agent du projet' })
          .selectOption('agent-b');
        await frame.getByRole('textbox').fill('Ajoute une introduction.');
        await frame
          .getByRole('button', { name: 'Préparer une proposition' })
          .click();
        await frame
          .getByRole('button', { name: 'Appliquer dans le document' })
          .waitFor();
        assert.equal(
          await page.evaluate(
            () =>
              window.calls.find((x) => x.method === 'propose').args.threadId,
          ),
          'agent-b',
        );
        await page.screenshot({
          path: resolve(output, `${name}-${width}.png`),
        });
        const editor = page.frames().find((f) => f.url().includes('/plugin'));
        await editor.evaluate(() => {
          window.fixtureState.text += ' Modification par un coauteur.';
        });
        await frame
          .getByRole('button', { name: 'Appliquer dans le document' })
          .click();
        await frame
          .getByText(
            'Le document ou la sélection a changé. Prépare une nouvelle proposition.',
          )
          .waitFor();
        assert.equal(await editor.evaluate(() => window.fixtureState.edits), 0);
        await frame
          .getByRole('button', { name: 'Préparer une proposition' })
          .click();
        await frame
          .getByRole('button', { name: 'Appliquer dans le document' })
          .waitFor({ state: 'visible' });
        await frame
          .getByRole('button', { name: 'Appliquer dans le document' })
          .click();
        await frame
          .getByText(
            'Modification appliquée. Elle est enregistrée avec les autres modifications OnlyOffice.',
          )
          .waitFor();
        assert.equal(await editor.evaluate(() => window.fixtureState.edits), 1);
        assert.match(
          await editor.evaluate(() => window.fixtureState.text),
          /Modification par un coauteur/,
        );
        // Explicit replacement and duplicate-click protection.
        await editor.evaluate(() => {
          window.fixtureState.selection = 'Introduction initiale.';
        });
        await frame
          .getByRole('combobox', { name: 'Modification', exact: true })
          .selectOption('replaceSelection');
        await frame
          .getByRole('button', { name: 'Préparer une proposition' })
          .click();
        await frame
          .getByRole('button', { name: 'Appliquer dans le document' })
          .waitFor({ state: 'visible' });
        await frame
          .getByRole('button', { name: 'Appliquer dans le document' })
          .click();
        await frame
          .getByText(
            'Modification appliquée. Elle est enregistrée avec les autres modifications OnlyOffice.',
          )
          .waitFor();
        assert.doesNotMatch(
          await editor.evaluate(() => window.fixtureState.text),
          /Introduction initiale/,
        );
        await page.close();
      }
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      await page.goto(base + '/?kind=slide');
      const frame = page.frameLocator('iframe');
      await frame
        .getByRole('combobox', { name: 'Modification', exact: true })
        .selectOption('addSlide');
      await frame
        .getByRole('textbox')
        .fill('Ajoute une diapositive sur les objectifs.');
      await frame
        .getByRole('button', { name: 'Préparer une proposition' })
        .click();
      await frame
        .getByRole('button', { name: 'Appliquer dans le document' })
        .waitFor();
      await frame
        .getByRole('button', { name: 'Appliquer dans le document' })
        .click();
      await frame
        .getByText(
          'Modification appliquée. Elle est enregistrée avec les autres modifications OnlyOffice.',
        )
        .waitFor();
      const state = await page
        .frames()
        .find((f) => f.url().includes('/plugin'))
        .evaluate(() => window.fixtureState);
      assert.equal(state.slides.length, 2);
      assert.equal(state.slides[0].text, 'Contexte initial');
      assert.equal(state.slides[1].objects.length, 2);
      await page.screenshot({ path: resolve(output, `${name}-slides.png`) });
      await page.close();
    } finally {
      await browser.close();
    }
    console.log(
      `${name}: desktop/mobile insertion, replacement, stale-edit rejection and slide addition passed`,
    );
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
