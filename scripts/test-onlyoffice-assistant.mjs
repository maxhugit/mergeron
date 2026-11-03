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
const ts = webRequire('typescript');
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
window.fixtureState={text:'Introduction initiale.',selection:'',index:0,slides:[],edits:0,events:{},clicks:{},menu:null};
const state=window.fixtureState;
const paragraph=(text='')=>({text,GetText(){return this.text},AddText(t){this.text+=t},SetFontSize(){},SetBold(){},SetColor(){}});
const content=(text)=>({items:[paragraph(text)],GetAllParagraphs(){return this.items},RemoveAllElements(){this.items=[]},Push(p){this.items.push(p)}});
function drawing(kind='shape',text='',x=0,y=0,w=5000000,h=1000000){return {kind,x,y,w,h,content:content(text),GetClassType(){return this.kind},HasTextContent(){return this.content.items.some(p=>p.text.length>0)},GetDocContent(){if(kind==='shape'&&!this.HasTextContent())this.touched=true;return kind==='shape'?this.content:null},GetPosX(){return this.x},GetPosY(){return this.y},GetWidth(){return this.w},GetHeight(){return this.h},SetPosition(x,y){this.x=x;this.y=y},SetSize(w,h){this.w=w;this.h=h},SetTextFit(){},ToJSON(){return JSON.stringify({touched:!!this.touched,kind:this.kind,x:this.x,y:this.y,w:this.w,h:this.h,text:this.content.items.map(p=>p.text).join('\\n')})},Copy(){return drawing(this.kind,this.content.items.map(p=>p.text).join('\\n'),this.x,this.y,this.w,this.h)}};}
const slide=(text='')=>({text,objects:[],visuals:[],GetAllShapes(){return [...(this.objects.length?this.objects.filter(o=>o.kind==='shape'):[drawing('shape',this.text)]),...this.visuals.filter(d=>d.kind==='shape')]},GetAllDrawings(){return [...(this.objects.length?this.objects:[drawing('shape',this.text)]),...this.visuals]},Copy(){return slide(this.text)},GetTheme(){return{}},GetLayout(){return{}},ApplyTheme(){},ApplyLayout(){},RemoveAllObjects(){this.objects=[];this.text='';this.visuals=[]},AddObject(o){this.objects.push(o)},Select(){state.index=state.slides.indexOf(this);return true}});
const original=slide('Contexte initial');original.visuals=[drawing('image','',9000000,2000000,2000000,1000000),drawing('shape','',8500000,3500000,1000000,500000)];state.slides=[original];
window.Api={GetDocument:()=>({GetAllParagraphs:()=>[paragraph(state.text)],GetRangeBySelect:()=>({GetText:()=>state.selection}),InsertContent(items){const text=items.map(p=>p.text).join('\\n');state.text=state.selection?state.text.replace(state.selection,text):state.text+text;state.edits++}}),CreateParagraph:()=>paragraph(),
GetPresentation:()=>({GetCurSlideIndex:()=>state.index,GetSlidesCount:()=>state.slides.length,GetCurrentSlide:()=>state.slides[state.index],GetSelection:()=>({GetText:()=>state.selection}),GetWidth:()=>12192000,GetHeight:()=>6858000,AddSlide(s,i){state.slides.splice(i,0,s);state.edits++},EnterText(t){state.slides[state.index].text+=t;state.edits++;return true}}),
ThemeColor:()=>({}),CreateSolidFill:()=>({}),CreateSlide:()=>slide(),CreateNoFill:()=>({}),CreateStroke:()=>({}),CreateShape:(kind,w,h)=>drawing('shape','',0,0,w,h)};
window.Asc={scope:{},plugin:{guid:'asc.{7A57B7C9-3208-4C67-9722-3D6B7CFB5920}',info:{options:{mergeronChannel:"${channel}",mergeronLang:"fr"}},attachEditorEvent(name,fn){state.events[name]=fn},attachContextMenuClickEvent(id,fn){state.clicks[id]=fn},event_onContextMenuClick(id){const item=state.menu?.items[0]?.items.find(x=>x.id===id);if(item&&!item.items&&!item.disabled)state.clicks[id]?.()},executeMethod(name,args,done){if(name==='GetSelectedText')done(state.selection);else if(name==='AddContextMenuItem')state.menu=args[0];},callCommand(fn,close,recalc,done){setTimeout(()=>done(fn()),0)}}};
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
if(method==='read' && window.calls.findLast(x=>x.method==='propose').args.action==='redesignSlide')result={id:'11111111-1111-4111-8111-111111111111',status:'ready',action:'redesignSlide',title:'Un projet clair',layout:'columns',sections:[{heading:'Cadrer',body:'Conserver les 3 objectifs.'},{heading:'Livrer',body:'Valider avec l’équipe.'}],text:'Cadrer : conserver les 3 objectifs. Livrer : valider avec l’équipe.'};
else if(method==='read')result={id:'11111111-1111-4111-8111-111111111111',status:'ready',action:window.calls.findLast(x=>x.method==='propose').args.action,text:'Une proposition claire et précise.',title:window.calls.findLast(x=>x.method==='propose').args.action==='addSlide'?'Objectifs du projet':''};
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
        // Native context-menu action prepares a draft; it never applies it.
        await editor.evaluate(() => {
          window.fixtureState.selection = '';
          window.fixtureState.events.onContextMenuShow();
        });
        let menu = await editor.evaluate(() => window.fixtureState.menu);
        assert.equal(menu.items[0].items[0].disabled, true);
        assert.equal(
          menu.items[0].items.some((x) => x.id === 'mergeron-redesign'),
          false,
        );
        await editor.evaluate(() => {
          window.fixtureState.selection = 'Une proposition claire et précise.';
          window.fixtureState.events.onContextMenuShow();
        });
        menu = await editor.evaluate(() => window.fixtureState.menu);
        assert.equal(menu.items[0].items[0].disabled, false);
        const beforeRewrite = await editor.evaluate(
          () => window.fixtureState.edits,
        );
        await editor.evaluate(() =>
          window.fixtureState.events.onContextMenuClick('mergeron-reformulate'),
        );
        await frame
          .getByRole('button', { name: 'Appliquer dans le document' })
          .waitFor();
        assert.equal(
          await editor.evaluate(() => window.fixtureState.edits),
          beforeRewrite,
        );
        await frame
          .getByRole('button', { name: 'Écarter', exact: true })
          .click();
        await editor.evaluate(() =>
          window.fixtureState.events.onContextMenuClick('mergeron-replace'),
        );
        assert.equal(
          await frame
            .getByRole('combobox', { name: 'Modification', exact: true })
            .inputValue(),
          'replaceSelection',
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
      const editor = page.frames().find((f) => f.url().includes('/plugin'));
      await editor.evaluate(() =>
        window.fixtureState.events.onContextMenuShow(),
      );
      assert.equal(
        await editor.evaluate(() =>
          window.fixtureState.menu.items[0].items.some(
            (x) => x.id === 'mergeron-redesign',
          ),
        ),
        true,
      );
      await editor.evaluate(() =>
        window.fixtureState.events.onContextMenuClick('mergeron-redesign'),
      );
      await frame
        .getByRole('button', { name: 'Ajouter la nouvelle slide', exact: true })
        .waitFor();
      await page.screenshot({
        path: resolve(output, `${name}-redesign-proposal.png`),
      });
      // A visual-only coauthor edit must invalidate the design too.
      await editor.evaluate(() => {
        window.fixtureState.slides[0].visuals[0].x += 1000;
      });
      await frame
        .getByRole('button', { name: 'Ajouter la nouvelle slide', exact: true })
        .click();
      await frame
        .getByText(
          'Le document ou la sélection a changé. Prépare une nouvelle proposition.',
        )
        .waitFor();
      assert.equal(
        await editor.evaluate(() => window.fixtureState.slides.length),
        2,
      );
      const original = await editor.evaluate(() =>
        JSON.stringify({
          text: window.fixtureState.slides[0].text,
          visuals: window.fixtureState.slides[0].visuals.map((d) => d.ToJSON()),
        }),
      );
      await frame
        .getByRole('button', { name: 'Préparer une proposition' })
        .click();
      await frame
        .getByRole('button', { name: 'Ajouter la nouvelle slide', exact: true })
        .waitFor();
      await frame
        .getByRole('button', { name: 'Ajouter la nouvelle slide', exact: true })
        .click();
      await frame
        .getByText(
          'Modification appliquée. Elle est enregistrée avec les autres modifications OnlyOffice.',
        )
        .waitFor();
      assert.equal(
        await editor.evaluate(() => window.fixtureState.slides.length),
        3,
      );
      assert.equal(
        await editor.evaluate(() =>
          JSON.stringify({
            text: window.fixtureState.slides[0].text,
            visuals: window.fixtureState.slides[0].visuals.map((d) =>
              d.ToJSON(),
            ),
          }),
        ),
        original,
      );
      const redesigned = await editor.evaluate(
        () => window.fixtureState.slides[1].objects,
      );
      assert.equal(redesigned.filter((d) => d.kind === 'shape').length, 4);
      const illustration = redesigned.find((d) => d.kind === 'image');
      assert.ok(illustration.x >= 12192000 * 0.62);
      assert.ok(illustration.x + illustration.w <= 12192000 * 0.92 + 1);
      assert.equal(redesigned[1].y, redesigned[2].y);
      assert.ok(redesigned[1].x < redesigned[2].x);
      // Unsupported grouped content is refused before any generation/edit.
      await editor.evaluate(() => {
        window.fixtureState.index = 0;
        window.fixtureState.slides[0].visuals[0].kind = 'group';
      });
      const requestsBefore = await page.evaluate(
        () => window.calls.filter((x) => x.method === 'propose').length,
      );
      await frame
        .getByRole('button', { name: 'Préparer une proposition' })
        .click();
      await frame
        .getByText(
          'Cette slide contient des éléments groupés ou non pris en charge. Dissocie-les dans une copie avant de la retravailler.',
        )
        .waitFor();
      assert.equal(
        await page.evaluate(
          () => window.calls.filter((x) => x.method === 'propose').length,
        ),
        requestsBefore,
      );
      assert.equal(
        await editor.evaluate(() => window.fixtureState.slides.length),
        3,
      );
      await page.close();
    } finally {
      await browser.close();
    }
    console.log(
      `${name}: desktop/mobile insertion, replacement, stale-edit rejection, slide redesign and native context menus passed`,
    );
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
