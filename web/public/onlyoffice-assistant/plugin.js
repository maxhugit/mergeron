/* global Asc, Api */
(() => {
  function start(options) {
    'use strict';
    const channel = options.mergeronChannel;
    const fr = options.mergeronLang === 'fr';
    const copy = fr
      ? {
          title: 'Avec Mergeron',
          agent: 'Agent du projet',
          action: 'Modification',
          insert: 'Ajouter du texte au curseur',
          replace: 'Remplacer la sélection',
          slide: 'Ajouter une diapositive après celle-ci',
          redesign: 'Retravailler cette slide (nouvelle version)',
          reformulate: 'Reformuler la sélection',
          replaceMenu: 'Remplacer la sélection…',
          redesignPrompt:
            'Retravaille cette slide brouillon : clarifie et synthétise le texte, conserve les faits et propose une mise en page plus lisible.',
          reformulatePrompt:
            'Reformule la sélection pour la rendre plus claire et fluide, en conservant ses faits, ses nombres et sa langue.',
          newSlide: 'Ajouter la nouvelle slide',
          layoutNames: {
            stack: 'Sections empilées',
            columns: 'Deux colonnes',
            cards: 'Cartes',
          },
          originalKept:
            'Une nouvelle slide sera ajoutée après la source. L’original reste intact.',
          complexSlide:
            'Cette slide contient des éléments groupés ou non pris en charge. Dissocie-les dans une copie avant de la retravailler.',
          noSlideText:
            'Cette slide ne contient pas de texte éditable. Le texte présent uniquement dans une image n’est pas analysé.',
          tooLarge:
            'Cette slide contient trop de texte ou d’objets pour être retravaillée en une fois.',
          instruction: 'Que souhaites-tu modifier ?',
          placeholder: 'Ex. : reformule ce passage plus simplement…',
          generate: 'Préparer une proposition',
          apply: 'Appliquer dans le document',
          discard: 'Écarter',
          refresh: 'Actualiser les agents',
          waiting: 'Ouverture depuis Mergeron…',
          unavailable:
            'Rouvre ce document depuis Mergeron. La connexion a expiré ou tes droits ont changé.',
          empty: 'Aucun agent actif accessible dans ce projet.',
          restricted:
            'Ton compte peut consulter les agents. Leur exécution est réservée aux administrateurs.',
          generating:
            'L’agent prépare une proposition. Tu peux continuer à travailler.',
          ready: 'Relis la proposition avant de l’appliquer.',
          failed:
            'La proposition n’a pas pu être préparée. Réessaie depuis Mergeron.',
          changed:
            'Le document ou la sélection a changé. Prépare une nouvelle proposition.',
          selection:
            'Sélectionne le texte à remplacer (4 000 caractères maximum).',
          cursor:
            'Pour ajouter du texte, place le curseur sans sélectionner de texte.',
          unsupported:
            'Cette action n’est pas disponible dans cette version de l’éditeur ou à cet emplacement.',
          applied:
            'Modification appliquée. Elle est enregistrée avec les autres modifications OnlyOffice.',
          detail:
            'Le contexte récent de cet agent sert à préparer une proposition séparée, sans interrompre sa conversation.',
          proposal: 'Proposition',
          request: 'Décris la modification souhaitée.',
        }
      : {
          title: 'With Mergeron',
          agent: 'Project agent',
          action: 'Edit',
          insert: 'Add text at the cursor',
          replace: 'Replace selection',
          slide: 'Add a slide after this one',
          redesign: 'Redesign this slide (new version)',
          reformulate: 'Rewrite selection',
          replaceMenu: 'Replace selection…',
          redesignPrompt:
            'Redesign this draft slide: clarify and summarize its text, preserve its facts and propose a more readable layout.',
          reformulatePrompt:
            'Rewrite the selection more clearly and fluently, preserving its facts, numbers and language.',
          newSlide: 'Add the new slide',
          layoutNames: {
            stack: 'Stacked sections',
            columns: 'Two columns',
            cards: 'Cards',
          },
          originalKept:
            'A new slide will be added after the source. The original stays unchanged.',
          complexSlide:
            'This slide contains grouped or unsupported objects. Ungroup them in a copy before redesigning it.',
          noSlideText:
            'This slide contains no editable text. Text inside images is not analyzed.',
          tooLarge:
            'This slide contains too much text or too many objects to redesign at once.',
          instruction: 'What would you like to change?',
          placeholder: 'E.g. rewrite this passage more simply…',
          generate: 'Prepare a proposal',
          apply: 'Apply to document',
          discard: 'Discard',
          refresh: 'Refresh agents',
          waiting: 'Connecting to Mergeron…',
          unavailable:
            'Reopen this document from Mergeron. The connection expired or your permissions changed.',
          empty: 'No accessible active agents in this project.',
          restricted:
            'You can view agents. Running them requires an administrator account.',
          generating:
            'The agent is preparing a proposal. You can keep working.',
          ready: 'Review the proposal before applying it.',
          failed:
            'The proposal could not be prepared. Try again from Mergeron.',
          changed: 'The document or selection changed. Prepare a new proposal.',
          selection: 'Select the text to replace (up to 4,000 characters).',
          cursor: 'To add text, place the cursor without selecting text.',
          unsupported:
            'This action is unavailable in this editor version or at this position.',
          applied: 'Edit applied. OnlyOffice saves it with your other edits.',
          detail:
            'This agent’s recent context prepares a separate proposal without interrupting its conversation.',
          proposal: 'Proposal',
          request: 'Describe the edit you want.',
        };
    const root = document.getElementById('assistant');
    root.innerHTML =
      '<header><img src="icon.svg" alt=""><div><strong id="heading"></strong><p id="project"></p></div></header><p id="document"></p><form><label for="agent"></label><div class="agent-row"><select id="agent"></select><button id="refresh" type="button">↻</button></div><label for="action"></label><select id="action"></select><label for="instruction"></label><textarea id="instruction" rows="4" maxlength="4000"></textarea><p id="detail" class="muted"></p><button id="generate" class="primary" disabled></button></form><p id="status" role="status" aria-live="polite"></p><section id="proposal" hidden><h2></h2><h3 id="slide-title"></h3><p id="layout" class="muted"></p><div id="text"></div><div class="actions"><button id="apply" class="primary"></button><button id="discard"></button></div></section>';
    const el = (id) => document.getElementById(id);
    el('heading').textContent = copy.title;
    for (const [id, label] of [
      ['agent', copy.agent],
      ['action', copy.action],
      ['instruction', copy.instruction],
    ])
      root.querySelector(`label[for="${id}"]`).textContent = label;
    for (const id of ['refresh', 'generate', 'apply', 'discard']) {
      if (id !== 'refresh') el(id).textContent = copy[id];
      el(id).title = copy[id];
      el(id).setAttribute('aria-label', copy[id]);
    }
    el('instruction').placeholder = copy.placeholder;
    el('detail').textContent = copy.detail;
    root.querySelector('h2').textContent = copy.proposal;
    el('status').textContent = copy.waiting;
    let context,
      proposal,
      captured,
      busy = false,
      disposed = false;
    let sequence = 0;
    const pending = new Map();
    const status = (message, error = false) => {
      el('status').textContent = message;
      el('status').dataset.error = String(error);
    };
    function rpc(method, args = {}) {
      return new Promise((resolve, reject) => {
        const id = 'office-' + ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error('unavailable'));
        }, 90000);
        pending.set(id, { resolve, reject, timer });
        window.top.postMessage(
          { type: 'mergeron.onlyoffice.request', channel, id, method, args },
          location.origin,
        );
      });
    }
    window.addEventListener('message', (event) => {
      if (
        event.origin !== location.origin ||
        event.source !== window.top ||
        event.data?.type !== 'mergeron.onlyoffice.response' ||
        event.data.channel !== channel
      )
        return;
      const item = pending.get(event.data.id);
      if (!item) return;
      pending.delete(event.data.id);
      clearTimeout(item.timer);
      if (event.data.error) item.reject(Error('unavailable'));
      else item.resolve(event.data.result);
    });
    window.addEventListener('pagehide', () => {
      disposed = true;
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(Error('unavailable'));
      }
      pending.clear();
    });

    /** This fixed function is serialized by OnlyOffice; no agent-generated code is executed. */
    function transaction() {
      try {
        var input = Asc.scope.mergeron;
        var doc,
          presentation,
          slide,
          text,
          range,
          selection = '',
          index = -1,
          count = 0,
          visualState = '',
          drawings = [],
          visuals = [],
          blocks = [];
        function drawingText(drawing) {
          // GetDocContent creates a text body on an empty shape in Docs 10.
          // Reading a draft must not mutate its decorative shapes.
          if (!drawing.GetDocContent) return '';
          if (drawing.HasTextContent && !drawing.HasTextContent()) return '';
          if (!drawing.HasTextContent && drawing.ToJSON) {
            var raw = drawing.ToJSON();
            var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (data && data.content === null) return '';
          }
          var content = drawing.GetDocContent();
          return content
            ? content
                .GetAllParagraphs()
                .map(function (p) {
                  return p.GetText();
                })
                .join('\n')
            : '';
        }
        if (input.kind === 'word') {
          doc = Api.GetDocument();
          text = doc
            .GetAllParagraphs()
            .map(function (p) {
              return p.GetText();
            })
            .join('\n');
          range = doc.GetRangeBySelect();
          selection = range ? range.GetText() : '';
        } else {
          presentation = Api.GetPresentation();
          index = presentation.GetCurSlideIndex();
          count = presentation.GetSlidesCount();
          slide = presentation.GetCurrentSlide();
          if (!slide) return { error: 'unsupported' };
          text = slide.GetAllShapes().map(drawingText).join('\n');
          if (input.action === 'redesignSlide') {
            if (!slide.GetAllDrawings || !slide.Copy)
              return { error: 'complexSlide' };
            drawings = slide.GetAllDrawings();
            if (drawings.length > 50 || text.length > 12000)
              return { error: 'tooLarge' };
            var fingerprints = [];
            for (var n = 0; n < drawings.length; n++) {
              var drawing = drawings[n],
                kind = drawing.GetClassType();
              if (
                !['shape', 'image', 'chart', 'table'].includes(kind) ||
                !drawing.Copy ||
                !drawing.ToJSON
              )
                return { error: 'complexSlide' };
              fingerprints.push(drawing.ToJSON());
              var value = kind === 'shape' ? drawingText(drawing) : '';
              if (value.trim())
                blocks.push({
                  text: value,
                  x: drawing.GetPosX(),
                  y: drawing.GetPosY(),
                });
              else visuals.push(drawing);
            }
            visualState = JSON.stringify(fingerprints);
            if (!blocks.length) return { error: 'noSlideText' };
            if (visualState.length > 2000000) return { error: 'tooLarge' };
          }
          var selected = presentation.GetSelection
            ? presentation.GetSelection()
            : null;
          selection =
            selected && selected.GetText
              ? selected.GetText()
              : input.liveSelection;
        }
        // Content stamps detect coauthor edits, selection changes and slide movement.
        var state =
          text +
          '\u0000' +
          selection +
          '\u0000' +
          index +
          ':' +
          count +
          visualState;
        var hash = 2166136261;
        for (var i = 0; i < state.length; i++)
          hash = Math.imul(hash ^ state.charCodeAt(i), 16777619);
        var stamp = (hash >>> 0).toString(16) + ':' + state.length;
        if (!input.apply) {
          var reference =
            input.action === 'redesignSlide'
              ? JSON.stringify({
                  text: text,
                  blocks: blocks,
                  illustrations: visuals.map(function (d) {
                    return {
                      kind: d.GetClassType(),
                      width: d.GetWidth(),
                      height: d.GetHeight(),
                    };
                  }),
                })
              : text.slice(0, 16000);
          if (reference.length > 16000) return { error: 'tooLarge' };
          return {
            context: reference,
            selection: selection,
            stamp: stamp,
            index: index,
          };
        }
        if (stamp !== input.stamp) return { error: 'changed' };
        if (input.action === 'replaceSelection' && !selection)
          return { error: 'selection' };
        if (input.action === 'insertText' && selection)
          return { error: 'cursor' };
        if (input.kind === 'word') {
          var paragraphs = input.text.split('\n').map(function (line) {
            var p = Api.CreateParagraph();
            p.AddText(line);
            return p;
          });
          doc.InsertContent(paragraphs);
        } else if (
          input.action === 'addSlide' ||
          input.action === 'redesignSlide'
        ) {
          var redesign = input.action === 'redesignSlide';
          var created = redesign ? slide.Copy() : Api.CreateSlide();
          if (created.ApplyTheme && slide.GetTheme)
            created.ApplyTheme(slide.GetTheme());
          if (created.ApplyLayout && slide.GetLayout)
            created.ApplyLayout(slide.GetLayout());
          // Keep the source theme/background; new content never duplicates old objects.
          created.RemoveAllObjects();
          var width = presentation.GetWidth(),
            height = presentation.GetHeight();
          function shape(value, y, h, size, bold, x, w, card, sectionHeading) {
            x = x === undefined ? 0.08 : x;
            w = w === undefined ? 0.84 : w;
            var object = Api.CreateShape(
              'rect',
              Math.round(width * w),
              Math.round(height * h),
              card
                ? Api.CreateSolidFill(Api.ThemeColor('bg2'))
                : Api.CreateNoFill(),
              Api.CreateStroke(0, Api.CreateNoFill()),
            );
            object.SetPosition(Math.round(width * x), Math.round(height * y));
            var content = object.GetDocContent();
            content.RemoveAllElements();
            value.split('\n').forEach(function (line, lineIndex) {
              var p = Api.CreateParagraph();
              p.AddText(line);
              // OnlyOffice expresses paragraph font sizes in half-points.
              p.SetFontSize(
                (size + (sectionHeading && lineIndex === 0 ? 2 : 0)) * 2,
              );
              p.SetBold(bold || (sectionHeading && lineIndex === 0));
              p.SetColor(Api.ThemeColor('tx1'));
              content.Push(p);
            });
            if (object.SetTextFit) object.SetTextFit('normAutoFit');
            created.AddObject(object);
          }
          shape(input.title, 0.06, 0.18, 32, true);
          if (redesign) {
            var sections = input.sections;
            if (
              !sections ||
              !sections.length ||
              sections.length > 3 ||
              !['stack', 'columns', 'cards'].includes(input.layout)
            )
              return { error: 'unsupported' };
            var available = visuals.length ? 0.5 : 0.84;
            var horizontal = input.layout !== 'stack';
            var gap = 0.025;
            for (var k = 0; k < sections.length; k++) {
              var section = sections[k];
              var x = horizontal
                ? 0.08 + (k * (available + gap)) / sections.length
                : 0.08;
              var y = horizontal ? 0.31 : 0.31 + (k * 0.6) / sections.length;
              var w = horizontal
                ? (available - (sections.length - 1) * gap) / sections.length
                : available;
              var h = horizontal ? 0.57 : 0.6 / sections.length - gap;
              var value = [section.heading, section.body]
                .filter(Boolean)
                .join('\n\n');
              shape(
                value,
                y,
                h,
                visuals.length ? 18 : 22,
                false,
                x,
                w,
                input.layout === 'cards',
                Boolean(section.heading),
              );
            }
            // Copy illustrations as a single proportionally scaled composition.
            // Originals are never mutated, even if constructing the new slide fails.
            if (visuals.length) {
              var minX = Infinity,
                minY = Infinity,
                maxX = -Infinity,
                maxY = -Infinity;
              visuals.forEach(function (d) {
                minX = Math.min(minX, d.GetPosX());
                minY = Math.min(minY, d.GetPosY());
                maxX = Math.max(maxX, d.GetPosX() + d.GetWidth());
                maxY = Math.max(maxY, d.GetPosY() + d.GetHeight());
              });
              var groupW = maxX - minX,
                groupH = maxY - minY;
              if (!(groupW > 0 && groupH > 0)) return { error: 'complexSlide' };
              var scale = Math.min(
                (width * 0.3) / groupW,
                (height * 0.57) / groupH,
              );
              visuals.forEach(function (d) {
                var copy = d.Copy();
                copy.SetSize(
                  Math.round(d.GetWidth() * scale),
                  Math.round(d.GetHeight() * scale),
                );
                copy.SetPosition(
                  Math.round(
                    width * 0.62 +
                      (width * 0.3 - groupW * scale) / 2 +
                      (d.GetPosX() - minX) * scale,
                  ),
                  Math.round(
                    height * 0.31 +
                      (height * 0.57 - groupH * scale) / 2 +
                      (d.GetPosY() - minY) * scale,
                  ),
                );
                created.AddObject(copy);
              });
            }
          } else shape(input.text, 0.3, 0.58, 22, false);
          presentation.AddSlide(created, index + 1);
          if (redesign && created.Select) {
            try {
              created.Select();
            } catch {}
          }
        } else {
          if (!presentation.EnterText) return { error: 'unsupported' };
          if (presentation.EnterText(input.text) === false)
            return { error: 'unsupported' };
        }
        return { applied: true };
      } catch {
        return { error: 'unsupported' };
      }
    }
    async function editor(args) {
      // Docs 10 supports GetSelectedText in presentations but not yet the
      // newer Office API GetSelection method. Read immediately before command.
      const liveSelection =
        context.document.kind === 'slide'
          ? await new Promise((resolve, reject) => {
              const timer = setTimeout(
                () => reject(Error('unsupported')),
                15000,
              );
              Asc.plugin.executeMethod(
                'GetSelectedText',
                [{ Numbering: false, Math: false, ParaSeparator: '\n' }],
                (value) => {
                  clearTimeout(timer);
                  if (typeof value === 'string') resolve(value);
                  else reject(Error('unsupported'));
                },
              );
            })
          : '';
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('unsupported')), 15000);
        Asc.scope = Asc.scope || {};
        Asc.scope.mergeron = {
          kind: context.document.kind,
          liveSelection,
          ...args,
        };
        Asc.plugin.callCommand(transaction, false, false, (result) => {
          clearTimeout(timer);
          if (!result || result.error)
            reject(Error(result?.error || 'unsupported'));
          else resolve(result);
        });
      });
    }
    function controls() {
      el('generate').disabled = busy || !context?.canRun || !el('agent').value;
      el('agent').disabled = busy;
      el('action').disabled = busy;
      el('refresh').disabled = busy;
    }
    async function load() {
      try {
        const selected = el('agent').value;
        context = await rpc('context');
        el('project').textContent = context.project.name;
        el('document').textContent = context.document.name;
        el('agent').replaceChildren(
          ...context.agents.map((agent) => {
            const option = document.createElement('option');
            option.value = agent.id;
            option.textContent = agent.name;
            return option;
          }),
        );
        if (context.agents.some((agent) => agent.id === selected))
          el('agent').value = selected;
        if (!el('action').options.length) {
          for (const [value, label] of [
            ['insertText', copy.insert],
            ['replaceSelection', copy.replace],
            ...(context.document.kind === 'slide'
              ? [
                  ['addSlide', copy.slide],
                  ['redesignSlide', copy.redesign],
                ]
              : []),
          ]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            el('action').append(option);
          }
        }
        status(
          !context.agents.length
            ? copy.empty
            : !context.canRun
              ? copy.restricted
              : '',
        );
        controls();
      } catch {
        status(copy.unavailable, true);
      }
    }
    el('refresh').onclick = load;
    el('discard').onclick = () => {
      proposal = null;
      el('proposal').hidden = true;
      status('');
    };
    root.querySelector('form').onsubmit = async (event) => {
      event.preventDefault();
      if (busy) return;
      if (!el('instruction').value.trim()) {
        status(copy.request, true);
        return;
      }
      busy = true;
      controls();
      el('proposal').hidden = true;
      proposal = null;
      try {
        const action = el('action').value;
        captured = await editor({ action });
        if (
          (action === 'replaceSelection' && !captured.selection) ||
          captured.selection.length > 4000
        )
          throw Error('selection');
        if (action === 'insertText' && captured.selection)
          throw Error('cursor');
        status(copy.generating);
        let result = await rpc('propose', {
          requestId: crypto.randomUUID(),
          threadId: el('agent').value,
          instruction: el('instruction').value,
          action,
          context: captured.context,
          selection: captured.selection,
        });
        const deadline = Date.now() + 240000;
        while (
          result.status === 'running' &&
          !disposed &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          if (!disposed) result = await rpc('read', { id: result.id });
        }
        if (disposed) return;
        if (result.status !== 'ready') throw Error('failed');
        proposal = result;
        el('text').className = result.layout
          ? 'slide-preview ' + result.layout
          : '';
        el('text').replaceChildren();
        if (result.layout) {
          for (const part of result.sections) {
            const section = document.createElement('div');
            const heading = document.createElement('strong');
            heading.textContent = part.heading;
            const body = document.createElement('p');
            body.textContent = part.body;
            section.append(heading, body);
            el('text').append(section);
          }
        } else el('text').textContent = result.text;
        el('layout').textContent = result.layout
          ? copy.layoutNames[result.layout] + ' · ' + copy.originalKept
          : '';
        el('apply').textContent = result.layout ? copy.newSlide : copy.apply;
        el('apply').setAttribute(
          'aria-label',
          result.layout ? copy.newSlide : copy.apply,
        );
        el('slide-title').textContent = result.title;
        el('proposal').hidden = false;
        el('apply').disabled = false;
        status(copy.ready);
      } catch (error) {
        status(copy[error.message] || copy.failed, true);
      } finally {
        busy = false;
        controls();
      }
    };
    el('apply').onclick = async () => {
      if (!proposal || busy) return;
      busy = true;
      controls();
      el('apply').disabled = true;
      try {
        // Revalidate permissions and agent membership immediately before applying.
        const fresh = await rpc('read', { id: proposal.id });
        if (fresh.status !== 'ready') throw Error('failed');
        await editor({
          apply: true,
          action: fresh.action,
          text: fresh.text,
          title: fresh.title,
          layout: fresh.layout,
          sections: fresh.sections,
          stamp: captured.stamp,
        });
        proposal = null;
        el('proposal').hidden = true;
        status(copy.applied);
      } catch (error) {
        status(copy[error.message] || copy.unavailable, true);
      } finally {
        busy = false;
        controls();
      }
    };
    if (
      Asc.plugin.attachEditorEvent &&
      Asc.plugin.attachContextMenuClickEvent
    ) {
      // The SDK stores click callbacks locally; subscribe the editor too.
      const dispatchClick = Asc.plugin.event_onContextMenuClick;
      if (typeof dispatchClick === 'function')
        Asc.plugin.attachEditorEvent('onContextMenuClick', dispatchClick);
      Asc.plugin.attachEditorEvent('onContextMenuShow', () => {
        let answered = false;
        const reply = (selection = '') => {
          if (answered) return;
          answered = true;
          const disabled =
            busy || !context?.canRun || !el('agent').value || disposed;
          const children = [
            {
              id: 'mergeron-reformulate',
              text: copy.reformulate,
              disabled: disabled || !selection.trim(),
            },
            {
              id: 'mergeron-replace',
              text: copy.replaceMenu,
              disabled: disabled || !selection.trim(),
            },
            ...(context?.document.kind === 'slide'
              ? [
                  {
                    id: 'mergeron-redesign',
                    text: copy.redesign,
                    disabled,
                  },
                ]
              : []),
          ];
          // Always answer, including empty/loading/revoked states: Docs waits
          // for every subscribed plugin before displaying its own menu.
          Asc.plugin.executeMethod('AddContextMenuItem', [
            {
              guid: Asc.plugin.guid,
              items: disposed
                ? []
                : [
                    {
                      id: 'mergeron-actions',
                      text: 'Mergeron',
                      items: children,
                    },
                  ],
            },
          ]);
        };
        const timer = setTimeout(() => reply(), 400);
        try {
          Asc.plugin.executeMethod(
            'GetSelectedText',
            [{ Numbering: false, Math: false, ParaSeparator: '\n' }],
            (value) => {
              clearTimeout(timer);
              reply(typeof value === 'string' ? value : '');
            },
          );
        } catch {
          clearTimeout(timer);
          reply();
        }
      });
      const choose = (action, instruction, submit) => {
        if (busy || disposed || !context?.canRun || !el('agent').value) return;
        proposal = null;
        el('proposal').hidden = true;
        el('action').value = action;
        if (instruction) el('instruction').value = instruction;
        // Reuse the visible review workflow; a right-click never applies an edit.
        Asc.plugin.executeMethod('ActivateWindow', [
          'iframe_' + Asc.plugin.guid,
        ]);
        if (submit) root.querySelector('form').requestSubmit();
        else {
          el('instruction').focus();
          status(copy.request);
        }
      };
      Asc.plugin.attachContextMenuClickEvent('mergeron-reformulate', () =>
        choose('replaceSelection', copy.reformulatePrompt, true),
      );
      Asc.plugin.attachContextMenuClickEvent('mergeron-replace', () =>
        choose('replaceSelection', '', false),
      );
      Asc.plugin.attachContextMenuClickEvent('mergeron-redesign', () =>
        choose('redesignSlide', copy.redesignPrompt, true),
      );
    }
    if (!/^[a-f0-9]{64}$/.test(channel || '') || !window.Asc?.plugin) {
      status(copy.unavailable, true);
      return;
    }
    void load();
    Asc.plugin.onThemeChanged = (theme) => {
      document.documentElement.dataset.theme =
        theme.type === 'dark' ? 'dark' : 'light';
    };
  }
  let initialized = false;
  if (window.Asc?.plugin)
    Asc.plugin.init = () => {
      if (!initialized) {
        initialized = true;
        start(Asc.plugin.info.options || {});
      }
    };
})();
