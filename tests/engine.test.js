/* Тесты движка. Запуск: bash tests/run.sh (конкатенирует engine.js + этот файл в JavaScriptCore). */
(function () {
  'use strict';
  const E = globalThis.Engine;
  let passed = 0, failed = 0;
  function eq(actual, expected, name) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a === b) { passed++; }
    else { failed++; console.log('FAIL ' + name + ': got ' + a + ', want ' + b); }
  }

  const word = { id: 'w', lemma: 'make', is_irregular: true };            // 7 осей
  const expr = { id: 'x', lemma: 'give up', is_expression: true };        // 5 осей (без speak/forms)
  const D1 = '2026-06-29', D2 = '2026-06-30';

  // --- оси ---
  eq(E.typesFor(word), ['listen', 'translate', 'context', 'write', 'recall', 'speak', 'forms'], 'axes word+irregular');
  eq(E.typesFor(expr), ['listen', 'translate', 'context', 'write', 'recall'], 'axes expression');
  eq(E.typesFor({ id: 'p', kind: 'prep_pattern' }), ['context', 'write'], 'axes prep pattern');

  // --- кап Этапа 1: максимум +3/день на тип ---
  let e = E.newEntry('active1', word);
  for (let i = 0; i < 5; i++) E.applyAnswer(e, word, 'listen', true, D1);
  eq(e.points.listen, 3, 'cap: 5 верных за день дают 3');
  E.applyAnswer(e, word, 'listen', true, D2);
  eq(e.points.listen, 4, 'cap: новый день снова даёт');
  eq(E.playableTypes(e, word, D2).includes('listen'), true, 'playable после 1 из 3 сегодня');
  E.applyAnswer(e, word, 'listen', true, D2); E.applyAnswer(e, word, 'listen', true, D2);
  eq(E.playableTypes(e, word, D2).includes('listen'), false, 'не playable после капа');
  eq(E.cappedTypes(e, word, D2).includes('listen'), true, 'listen в capped-списке');

  // --- штраф: −2, пол 0, капом не ограничен ---
  e = E.newEntry('active1', word);
  E.applyAnswer(e, word, 'write', false, D1);
  eq(e.points.write, 0, 'штраф не уводит ниже 0');
  e.points.write = 9;
  E.applyAnswer(e, word, 'write', false, D1);
  eq(e.points.write, 7, 'пример get: 9 → 7 после ошибки');

  // --- error-review: ошибка без штрафа ---
  e.points.write = 5;
  E.applyAnswer(e, word, 'write', false, D1, { noPenalty: true });
  eq(e.points.write, 5, 'review: повторная ошибка не штрафуется');

  // --- переход Этап 1 → 2 (все оси по 10) ---
  e = E.newEntry('active1', word);
  E.typesFor(word).forEach(t => e.points[t] = 10);
  e.points.forms = 9;
  e.dayGain.forms = { date: D1, n: 0 };
  const r1 = E.applyAnswer(e, word, 'forms', true, D1);
  eq(r1.event, 'stage2', 'переход на Этап 2');
  eq(e.stage, 2, 'stage=2');
  eq(e.points.forms, 0, 'баллы сброшены');

  // --- Этап 2: 1 показ/день на тип ---
  e = E.newEntry('active2', expr);
  E.applyAnswer(e, expr, 'listen', true, D1);
  eq(e.points.listen, 1, 'stage2: +1');
  const r2 = E.applyAnswer(e, expr, 'listen', true, D1);
  eq(r2.capped, true, 'stage2: второй показ в день не считается');
  eq(e.points.listen, 1, 'stage2: баллы не изменились');
  eq(E.playableTypes(e, expr, D1).includes('listen'), false, 'stage2: listen выпал до завтра');
  eq(E.playableTypes(e, expr, D2).includes('listen'), true, 'stage2: завтра снова доступен');

  // --- Этап 2 → выучено ---
  e = E.newEntry('active2', expr);
  E.typesFor(expr).forEach(t => e.points[t] = 30);
  e.points.recall = 29;
  const r3 = E.applyAnswer(e, expr, 'recall', true, D1);
  eq(r3.event, 'learned', 'событие learned');
  eq(e.list, 'learned', 'слово в выученных');

  // --- опечатки ---
  eq(E.editDistance('make', 'make'), 0, 'lev 0');
  eq(E.isTypo('meke', 'make'), true, 'опечатка в 1 символ');
  eq(E.isTypo('mkae', 'make'), false, 'перестановка = дистанция 2, не опечатка');
  eq(E.isTypo('make', 'make'), false, 'точный ответ — не опечатка');

  // --- нарастающая сложность (3.5): продукция после базы ---
  e = E.newEntry('active1', word);
  eq(E.baseReady(e, word), false, 'свежее слово: база не готова');
  eq(E.readyTypes(e, word, D1), ['listen', 'translate', 'context'], 'сначала только рецепция');
  e.points.listen = 3; e.points.translate = 3; e.points.context = 3;
  eq(E.baseReady(e, word), true, 'база ≥3 по рецептивным — готова');
  eq(E.readyTypes(e, word, D1).includes('recall'), true, 'продукция открылась');
  e = E.newEntry('active2', word);
  eq(E.readyTypes(e, word, D1).length, E.playableTypes(e, word, D1).length, 'Этап 2: всё открыто сразу');

  // --- стрик (US-13) ---
  eq(E.calcStreak({ '2026-07-09': 1, '2026-07-08': 1, '2026-07-07': 2 }, 1, '2026-07-09'), 3, 'стрик 3 дня подряд');
  eq(E.calcStreak({ '2026-07-08': 1, '2026-07-07': 1 }, 1, '2026-07-09'), 2, 'сегодня без цели — стрик не рвётся');
  eq(E.calcStreak({ '2026-07-09': 1, '2026-07-07': 1 }, 1, '2026-07-09'), 1, 'пропуск вчера рвёт стрик');
  eq(E.calcStreak({ '2026-07-09': 1, '2026-07-08': 1 }, 2, '2026-07-09'), 0, 'цель 2: одного блока мало');
  eq(E.calcStreak({}, 1, '2026-07-09'), 0, 'пустая история — стрик 0');

  // --- миграция v2 → v3 ---
  const old = { list: 'active', stage: 1, points: { listen: 4, translate: 1, context: 0, write: 0, speak: 0, forms: 2 }, day: {} };
  E.migrate(old, word);
  eq(old.points.recall, 0, 'миграция добавляет recall');
  eq(typeof old.dayGain, 'object', 'миграция добавляет dayGain');
  eq(old.points.listen, 4, 'миграция не трогает старые баллы');

  console.log(failed === 0 ? `OK: ${passed} tests passed` : `FAILED: ${failed} of ${passed + failed}`);
})();
