/* Engine — чистая логика усвоения (без DOM). Работает в браузере (window.Engine)
   и в тест-раннере (JavaScriptCore/Node). Правила: SPEC v3, релиз 3.0.
   Оси баллов: listen, translate, context, write, recall (+speak, +forms по типу слова).
   Этап 1: порог 10, кап +3/день на пару слово×тип. Этап 2: порог 30, 1 показ/день/тип.
   Верно: +1. Неверно: −2 (не ниже 0), в error-review без штрафа. */
(function (root) {
  'use strict';

  const TH1 = 10, TH2 = 30, PEN = 2, CAP_PER_DAY = 3;

  function typesFor(item) {
    if (item.kind === 'prep_pattern') return ['context', 'write'];   // паттерны предлогов: только gap-fill
    const t = ['listen', 'translate', 'context', 'write', 'recall'];
    if (!item.is_expression) t.push('speak');
    if (item.is_irregular) t.push('forms');
    return t;
  }

  const threshold = (stage) => (stage === 1 ? TH1 : TH2);

  function zeroPoints(item) {
    const o = {};
    typesFor(item).forEach((t) => (o[t] = 0));
    return o;
  }

  function newEntry(kind, item) {
    if (kind === 'solid') return { list: 'solid' };
    if (kind === 'learned') return { list: 'learned' };
    return {
      list: 'active',
      stage: kind === 'active2' ? 2 : 1,
      points: zeroPoints(item),
      day: {},        // Этап 2: type -> 'YYYY-MM-DD' последнего показа
      dayGain: {},    // Этап 1: type -> {date, n} набранных сегодня
      passive: kind === 'active2'
    };
  }

  // миграция старых записей (v2 без recall/dayGain)
  function migrate(entry, item) {
    if (!entry || entry.list !== 'active') return entry;
    if (!entry.points) entry.points = zeroPoints(item);
    typesFor(item).forEach((t) => { if (entry.points[t] === undefined) entry.points[t] = 0; });
    if (!entry.day) entry.day = {};
    if (!entry.dayGain) entry.dayGain = {};
    return entry;
  }

  function gainedToday(entry, type, today) {
    const g = entry.dayGain && entry.dayGain[type];
    return g && g.date === today ? g.n : 0;
  }

  // типы, доступные к тренировке НА БАЛЛЫ сегодня
  function playableTypes(entry, item, today) {
    if (!entry || entry.list !== 'active') return [];
    const th = threshold(entry.stage);
    return typesFor(item).filter((t) => {
      if (entry.points[t] >= th) return false;
      if (entry.stage === 1) return gainedToday(entry, t, today) < CAP_PER_DAY;
      return entry.day[t] !== today;
    });
  }

  // типы, закрытые сегодня капом/лимитом (для бейджа «✓ на сегодня»)
  function cappedTypes(entry, item, today) {
    if (!entry || entry.list !== 'active') return [];
    const th = threshold(entry.stage);
    return typesFor(item).filter((t) => {
      if (entry.points[t] >= th) return false;
      if (entry.stage === 1) return gainedToday(entry, t, today) >= CAP_PER_DAY;
      return entry.day[t] === today;
    });
  }

  /* Применить ответ. opts: {noPenalty} — режим error-review.
     Возвращает { gained, event: null|'stage2'|'learned', capped } и мутирует entry. */
  function applyAnswer(entry, item, type, ok, today, opts) {
    opts = opts || {};
    const th = threshold(entry.stage);
    let gained = 0, capped = false;

    if (entry.stage === 1) {
      if (ok) {
        if (gainedToday(entry, type, today) >= CAP_PER_DAY) { capped = true; }
        else {
          entry.points[type] = Math.min(th, entry.points[type] + 1); gained = 1;
          entry.dayGain[type] = { date: today, n: gainedToday(entry, type, today) + 1 };
        }
      } else if (!opts.noPenalty) {
        entry.points[type] = Math.max(0, entry.points[type] - PEN); gained = -PEN;
      }
    } else { // stage 2
      if (entry.day[type] === today) { capped = true; }
      else {
        entry.day[type] = today;
        if (ok) { entry.points[type] = Math.min(th, entry.points[type] + 1); gained = 1; }
        else if (!opts.noPenalty) { entry.points[type] = Math.max(0, entry.points[type] - PEN); gained = -PEN; }
      }
    }

    let event = null;
    if (typesFor(item).every((t) => entry.points[t] >= th)) {
      if (entry.stage === 1) {
        entry.stage = 2; entry.points = zeroPoints(item); entry.day = {}; entry.dayGain = {};
        event = 'stage2';
      } else {
        Object.keys(entry).forEach((k) => delete entry[k]);
        entry.list = 'learned';
        event = 'learned';
      }
    }
    return { gained, event, capped };
  }

  // расстояние Левенштейна (для толерантности к опечаткам в recall/write)
  function editDistance(a, b) {
    a = a || ''; b = b || '';
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }
  const isTypo = (input, target) => input !== target && editDistance(input, target) === 1;

  /* Стрик занятий (US-13): days = {'YYYY-MM-DD': blocksCompleted}, goal = блоков/день.
     Подряд идущие дни с выполненной целью; сегодняшний день без цели стрик не рвёт. */
  function calcStreak(days, goal, today) {
    days = days || {}; goal = goal || 1;
    let streak = 0;
    const d = new Date(today + 'T00:00:00Z');
    if ((days[today] || 0) >= goal) streak++;
    for (let i = 1; i < 3650; i++) {
      d.setUTCDate(d.getUTCDate() - 1);
      const key = d.toISOString().slice(0, 10);
      if ((days[key] || 0) >= goal) streak++;
      else break;
    }
    return streak;
  }

  root.Engine = {
    TH1, TH2, PEN, CAP_PER_DAY,
    typesFor, threshold, zeroPoints, newEntry, migrate,
    playableTypes, cappedTypes, gainedToday, applyAnswer,
    editDistance, isTypo, calcStreak
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
