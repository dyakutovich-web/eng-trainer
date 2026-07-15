/* English Vocab Trainer — UI v3 (релиз 3.0). Логика усвоения — в js/engine.js (Engine).
   Новое: recall RU→EN, дневной кап, error-review + сводка блока, экспорт/импорт, меню-статус. */
(() => {
  'use strict';
  const E = window.Engine;

  const STORE_KEY = 'evt_progress_v2';       // ключ прежний, записи мигрируются
  const K_FILTER = 'evt_posfilter', K_DAILY = 'evt_daily', K_EXPORT = 'evt_lastExport', K_SET = 'evt_settings';
  const K_DAYS = 'evt_days', K_LOG = 'evt_anslog', K_LASTTEST = 'evt_lastTest', K_SNOOZE = 'evt_testSnooze';
  const K_CUSTOM = 'evt_custom', K_CEX = 'evt_customex';   // свои слова и свои примеры

  const TYPE_LABEL = { listen: 'Аудирование', translate: 'EN→RU', context: 'Контекст', write: 'Написание', recall: 'RU→EN', speak: 'Произношение', forms: 'Формы' };
  const K_FLAGS = 'evt_flags';   // жалобы на качество перевода/примера

  const app = document.getElementById('app');
  const footer = document.getElementById('footer');
  const statsEl = document.getElementById('stats');
  document.getElementById('home-btn').onclick = () => showMenu();

  let ITEMS = [], BY_ID = {};
  let progress = load();
  let posFilter = localStorage.getItem(K_FILTER) || 'all';
  let settings = readJSON(K_SET) || {};
  let blockLimit = null;                     // переопределение размера блока (мини-блок трудных слов)
  const blockSize = () => blockLimit || settings.block || 20;
  const dayGoal = () => settings.goal || 1;

  /* режимы: study (на баллы) | free (без баллов) | test (проверка выученных) */
  let mode = 'study';
  let phase = 'main';                        // main | review
  let poolFilter = null;                     // null — обычный пул | 'preps' — предлоги | 'weak' — трудные слова
  let weakIds = new Set();
  let blockN = 0, blockStats = null, reviewQueue = [], reviewIdx = 0;
  let recent = [], flash = '', current = null;
  const lastEx = {};                         // ротация примеров: itemId -> последний показанный пример
  const PREPS = ['at', 'on', 'in', 'to', 'for', 'from', 'of', 'by', 'with', 'about'];

  /* ---------- хранение ---------- */
  function readJSON(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function load() { return readJSON(STORE_KEY) || {}; }
  function save() { localStorage.setItem(STORE_KEY, JSON.stringify(progress)); renderStats(); }
  const listOf = (it) => (progress[it.id] && progress[it.id].list) || 'catalog';
  function P(it) { return progress[it.id]; }
  const todayStr = () => new Date().toISOString().slice(0, 10);

  function daily() {
    const d = readJSON(K_DAILY);
    return d && d.date === todayStr() ? d : { date: todayStr(), rounds: 0, blocks: 0 };
  }
  function bumpDaily(field) {
    const d = daily(); d[field]++; localStorage.setItem(K_DAILY, JSON.stringify(d));
    if (field === 'blocks') {                                    // история дней для стрика (US-13)
      const days = readJSON(K_DAYS) || {};
      days[todayStr()] = d.blocks;
      const keys = Object.keys(days).sort();                     // ротация: держим последние 60 дней
      keys.slice(0, Math.max(0, keys.length - 60)).forEach(k => delete days[k]);
      localStorage.setItem(K_DAYS, JSON.stringify(days));
    }
  }

  /* лог ответов для «трудных слов» (US-16): последние 30 дней, максимум 2000 записей */
  function logAnswer(it, type, ok) {
    const log = readJSON(K_LOG) || [];
    log.push({ d: todayStr(), id: it.id, ok: ok ? 1 : 0 });
    const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const trimmed = log.filter(e2 => e2.d >= cutoff).slice(-2000);
    localStorage.setItem(K_LOG, JSON.stringify(trimmed));
  }
  function weakWords() {
    const cutoff = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const errs = {};
    (readJSON(K_LOG) || []).forEach(e2 => { if (e2.d >= cutoff && !e2.ok) errs[e2.id] = (errs[e2.id] || 0) + 1; });
    return Object.entries(errs)
      .filter(([id]) => BY_ID[id] && listOf(BY_ID[id]) === 'active')
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, n]) => ({ it: BY_ID[id], n }));
  }

  /* ---------- утилиты ---------- */
  const norm = (s) => (s || '').toLowerCase().trim().replace(/[^\p{L}\s]/gu, '').replace(/\s+/g, ' ');
  const esc = (s) => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }
  function speak(t, rate) { if (!('speechSynthesis' in window)) return; speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(t); u.lang = 'en-US'; u.rate = rate || 0.95; speechSynthesis.speak(u); }
  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 2500);
  }
  const glosses = (it) => (it.senses || []).map(s => s.gloss);
  const posSet = (it) => Array.from(new Set([it.pos, ...(it.senses || []).map(s => s.pos)]));
  const matchesPOS = (it) => posFilter === 'all' ? true : posFilter === 'expressions' ? !!it.is_expression : posSet(it).includes(posFilter);

  function otherValues(it, n, valueFn, ownSet) {
    const pool = shuffle(ITEMS.filter(x => x.id !== it.id && !x.kind));
    const out = [], seen = new Set(ownSet.map(norm));
    for (const x of pool) {
      const v = valueFn(x); if (!v) continue;
      if (seen.has(norm(v))) continue;
      seen.add(norm(v)); out.push(v); if (out.length >= n) break;
    }
    return out;
  }

  /* ---------- умные дистракторы (US-09): item.distractors[type] важнее эвристики ---------- */
  function fillTo(arr, it, n, valueFn, ownSet) {
    if (arr.length < n) arr.push(...otherValues(it, n - arr.length, valueFn, ownSet.concat(arr)));
    return arr.slice(0, n);
  }
  function distractorsListen(it) {
    if (it.distractors && it.distractors.listen) return it.distractors.listen.slice(0, 3);
    const t = it.lemma;
    const scored = ITEMS.filter(x => x.id !== it.id && !x.kind).map(x => ({
      v: x.lemma,
      s: (x.lemma[0] === t[0] ? 0 : 2) + Math.abs(x.lemma.length - t.length) + Math.min(E.editDistance(x.lemma, t), 6)
    })).sort((a, b) => a.s - b.s);
    const out = [], seen = new Set([norm(t)]);
    for (const c of scored) { if (seen.has(norm(c.v))) continue; seen.add(norm(c.v)); out.push(c.v); if (out.length >= 3) break; }
    return fillTo(out, it, 3, x => x.lemma, [t]);
  }
  function distractorsTranslate(it) {
    if (it.distractors && it.distractors.translate) return it.distractors.translate.slice(0, 3);
    const rank = it.freq_rank || 500;
    const own = glosses(it);
    const pool = ITEMS.filter(x => x.id !== it.id && !x.kind && x.pos === it.pos)
      .sort((a, b) => Math.abs((a.freq_rank || 500) - rank) - Math.abs((b.freq_rank || 500) - rank));
    const out = [], seen = new Set(own.map(norm));
    for (const x of shuffle(pool.slice(0, 12))) {
      const v = x.senses[0].gloss;
      if (seen.has(norm(v))) continue; seen.add(norm(v)); out.push(v); if (out.length >= 3) break;
    }
    return fillTo(out, it, 3, x => x.senses[0].gloss, own);
  }
  function distractorsContext(it) {
    if (it.distractors && it.distractors.context) return it.distractors.context.slice(0, 3);
    const pool = shuffle(ITEMS.filter(x => x.id !== it.id && !x.kind && x.pos === it.pos));
    const out = [], seen = new Set([norm(it.lemma)]);
    for (const x of pool) { if (seen.has(norm(x.lemma))) continue; seen.add(norm(x.lemma)); out.push(x.lemma); if (out.length >= 3) break; }
    return fillTo(out, it, 3, x => x.lemma, [it.lemma]);
  }
  function prepOptions(it) {
    const correct = it.prep;
    const base = (it.distractor_preps || []).filter(p => p !== correct);
    const extra = PREPS.filter(p => p !== correct && !base.includes(p));
    return [correct, ...base.concat(shuffle(extra)).slice(0, 3)];
  }

  /* ротация примеров (US-10): не повторять один пример два показа подряд; свои примеры — в пул */
  function customExamples(it) {
    const cex = readJSON(K_CEX) || {};
    return (cex[it.id] || []).filter(e2 => !it.lemma || e2.toLowerCase().includes(it.lemma.toLowerCase()));
  }
  function pickExample(it, list) {
    const pool = (list && list.length ? list : []).concat(customExamples(it)).filter(Boolean);
    if (!pool.length) return '';
    let cand = pool.filter(e2 => e2 !== lastEx[it.id]);
    if (!cand.length) cand = pool;
    const ex = cand[Math.floor(Math.random() * cand.length)];
    lastEx[it.id] = ex;
    return ex;
  }

  /* ---------- фильтр POS ---------- */
  const POS_CHIPS = [['all', 'Все'], ['noun', 'Сущ.'], ['verb', 'Глаг.'], ['adjective', 'Прил.'], ['adverb', 'Нареч.'], ['expressions', 'Выражения']];
  const chipsHtml = () => `<div class="chips">${POS_CHIPS.map(([v, l]) => `<button class="chip ${v === posFilter ? 'on' : ''}" data-pos="${v}">${l}</button>`).join('')}</div>`;
  function wireChips(after) {
    document.querySelectorAll('.chip').forEach(c => c.onclick = () => { posFilter = c.dataset.pos; localStorage.setItem(K_FILTER, posFilter); after(); });
  }

  /* ---------- счётчики ---------- */
  function counts() {
    const c = { catalog: 0, active: 0, solid: 0, learned: 0 };
    ITEMS.forEach(it => c[listOf(it)]++);
    return c;
  }
  function availableToday() {
    return ITEMS.filter(it => listOf(it) === 'active' && it.kind !== 'prep_pattern' && matchesPOS(it) && E.playableTypes(P(it), it, todayStr()).length).length;
  }
  function renderStats() { const c = counts(); statsEl.textContent = `учу ${c.active} · выучено ${c.learned} · железно ${c.solid}`; }

  /* ---------- МЕНЮ (UX-1) ---------- */
  function exportBannerHtml() {
    const hasProgress = Object.keys(progress).length > 0;
    if (!hasProgress) return '';
    const last = localStorage.getItem(K_EXPORT);
    const stale = !last || (Date.now() - new Date(last).getTime()) > 7 * 864e5;
    return stale ? `<div class="banner">💾 Давно не было резервной копии <button id="b-export" class="small btn-primary">Скачать</button></div>` : '';
  }
  /* напоминание о тесте выученных раз в 14 дней (US-18) */
  function testReminderHtml(c) {
    if (!c.learned) return '';
    const snooze = localStorage.getItem(K_SNOOZE);
    if (snooze && (Date.now() - new Date(snooze).getTime()) < 3 * 864e5) return '';
    const last = localStorage.getItem(K_LASTTEST);
    if (last && (Date.now() - new Date(last).getTime()) < 14 * 864e5) return '';
    return `<div class="banner">✅ В «Выученных» ${c.learned} слов — давно не проверялись
      <span style="white-space:nowrap"><button id="b-test" class="small btn-primary">Тест</button>
      <button id="b-snooze" class="small ghost">Позже</button></span></div>`;
  }
  function showMenu() {
    mode = 'study'; phase = 'main'; recent = []; blockLimit = null; poolFilter = null;
    const c = counts(), d = daily(), avail = availableToday();
    const streak = E.calcStreak(readJSON(K_DAYS) || {}, dayGoal(), todayStr());
    app.innerHTML = `<div class="card">
      <div class="status-row">🔥 стрик: ${streak} дн · сегодня: ${d.blocks}/${dayGoal()} блоков
        <button id="m-set" class="ghost small" style="float:right" title="Настройки">⚙</button></div>
      ${exportBannerHtml()}
      ${testReminderHtml(c)}
      <button class="full btn-primary cta" id="m-study">▶ Учить<br><small>активных ${c.active} · доступно сегодня ${avail}</small></button>
      <button class="full" id="m-triage" style="margin-top:12px;padding:16px">➕ Пополнить слова <small class="muted">· разметка каталога (${c.catalog})</small></button>
      <div class="mode-grid" style="margin-top:12px">
        <button class="mode-tile" id="m-search">🔍 Поиск<small>найти / добавить</small></button>
        <button class="mode-tile" id="m-preps">🧩 Предлоги<small>паттерны и чанки</small></button>
        <button class="mode-tile" id="m-test">✅ Тест выученных<small>${c.learned} слов</small></button>
        <button class="mode-tile" id="m-lists">📊 Прогресс<small>списки, копия</small></button>
      </div>
      <div class="section-label">Часть речи</div>
      ${chipsHtml()}
    </div>`;
    footer.innerHTML = '';
    wireChips(showMenu);
    document.getElementById('m-study').onclick = () => startStudy();
    document.getElementById('m-triage').onclick = () => showTriageIntro();
    document.getElementById('m-search').onclick = () => showSearch('');
    document.getElementById('m-preps').onclick = () => startPreps();
    document.getElementById('m-test').onclick = () => startTest();
    document.getElementById('m-lists').onclick = () => showLists();
    document.getElementById('m-set').onclick = () => showSettings();
    const be = document.getElementById('b-export'); if (be) be.onclick = doExport;
    const bt = document.getElementById('b-test'); if (bt) bt.onclick = () => startTest();
    const bs = document.getElementById('b-snooze'); if (bs) bs.onclick = () => { localStorage.setItem(K_SNOOZE, new Date().toISOString()); showMenu(); };
    renderStats();
  }

  /* ---------- НАСТРОЙКИ (US-17) ---------- */
  function showSettings() {
    const chip = (group, v, label, cur) => `<button class="chip ${v === cur ? 'on' : ''}" data-g="${group}" data-v="${v}">${label}</button>`;
    app.innerHTML = `<div class="card"><h2>Настройки</h2>
      <div class="section-label">Длина блока</div>
      <div class="chips">${[10, 20, 30].map(v => chip('block', v, v, settings.block || 20)).join('')}</div>
      <div class="section-label">Цель: блоков в день</div>
      <div class="chips">${[1, 2, 3].map(v => chip('goal', v, v, settings.goal || 1)).join('')}</div>
      <div class="section-label">Данные</div>
      <button id="exp" class="full">⬇ Скачать резервную копию</button>
    </div>`;
    footer.innerHTML = `<button class="full" id="menu">← В меню</button>`;
    document.querySelectorAll('.chip[data-g]').forEach(b => b.onclick = () => {
      settings[b.dataset.g] = Number(b.dataset.v);
      localStorage.setItem(K_SET, JSON.stringify(settings));
      showSettings();
    });
    document.getElementById('exp').onclick = doExport;
    document.getElementById('menu').onclick = showMenu;
  }

  /* ---------- ПОПОЛНЕНИЕ ---------- */
  let skipped = new Set();
  function nextCatalogItem() {
    const pool = ITEMS.filter(it => listOf(it) === 'catalog' && it.kind !== 'prep_pattern' && matchesPOS(it) && !skipped.has(it.id))
      .sort((a, b) => (a.freq_rank || 999) - (b.freq_rank || 999));
    return pool[0] || null;
  }
  function addTo(it, kind) { progress[it.id] = E.newEntry(kind, it); save(); }
  function showCatalog() {
    const it = nextCatalogItem();
    if (!it) {
      app.innerHTML = `<div class="card"><h2>Пополнение</h2><p class="muted">В каталоге нет слов по этому фильтру.</p>${chipsHtml()}</div>`;
      footer.innerHTML = `<button class="full" id="back">← В меню</button>`;
      wireChips(showCatalog); document.getElementById('back').onclick = showMenu; return;
    }
    app.innerHTML = `<div class="card">
      <div class="section-label">Пополнение · ${esc(it.pos)}${it.prep ? ' <span class="chip on" style="font-size:11px;padding:2px 8px">prep</span>' : ''}</div>
      <div class="lemma">${esc(it.lemma)}</div>
      <div class="ipa">${esc(it.ipa || '')}</div>
      <button class="audio-btn" id="say" style="margin-top:12px">🔊</button>
      <p class="muted" style="margin-top:16px">Знаешь это слово?</p>
      <div class="row stack">
        <button class="full" id="c-no">Не знаю — учить</button>
        <button class="full btn-primary" id="c-check">Знаю — показать значение</button>
        <button class="full btn-warn" id="c-solid">Знаю железно — не учить</button>
        <button class="full ghost" id="c-skip">Пропустить</button>
      </div></div>`;
    footer.innerHTML = `<button class="full ghost" id="back">← В меню</button>`;
    document.getElementById('say').onclick = () => speak(it.lemma);
    document.getElementById('c-no').onclick = () => { addTo(it, 'active1'); showCatalog(); };
    document.getElementById('c-solid').onclick = () => { addTo(it, 'solid'); showCatalog(); };
    document.getElementById('c-skip').onclick = () => { skipped.add(it.id); showCatalog(); };
    document.getElementById('c-check').onclick = () => showCatalogReveal(it);
    document.getElementById('back').onclick = showMenu;
  }
  function showCatalogReveal(it) {
    const sl = it.senses.map(s => `<li><b>${esc(s.gloss)}</b> <span class="muted">(${esc(s.pos)})</span> — ${esc(s.example)}</li>`).join('');
    app.innerHTML = `<div class="card">
      <div class="section-label">Значения слова</div>
      <div class="lemma">${esc(it.lemma)}</div>
      <ul class="examples">${sl}</ul>
      ${it.usage ? `<div class="muted">${esc(it.usage)}</div>` : ''}
      <p class="muted" style="margin-top:14px">Знаешь все эти значения?</p>
      <div class="row stack">
        <button class="full btn-warn" id="r-solid">Да, железно — не учить</button>
        <button class="full" id="r-passive">Знаю, но пассивно</button>
        <button class="full btn-primary" id="r-no">Не знаю — учить</button>
      </div></div>`;
    footer.innerHTML = '';
    speak(it.lemma);
    document.getElementById('r-solid').onclick = () => { addTo(it, 'solid'); showCatalog(); };
    document.getElementById('r-passive').onclick = () => { addTo(it, 'active2'); showCatalog(); };
    document.getElementById('r-no').onclick = () => { addTo(it, 'active1'); showCatalog(); };
  }

  /* ---------- БЫСТРАЯ РАЗМЕТКА (3.4): калибровка → массовое «железно» → чеклист ---------- */
  function catalogPool() {
    return ITEMS.filter(it => listOf(it) === 'catalog' && it.kind !== 'prep_pattern')
      .sort((a, b) => (a.freq_rank || 99999) - (b.freq_rank || 99999));
  }
  function addToNoSave(it, kind) { progress[it.id] = E.newEntry(kind, it); }

  function showTriageIntro() {
    const pool = catalogPool();
    app.innerHTML = `<div class="card"><h2>⚡ Быстрая разметка</h2>
      <p class="muted">В каталоге ${pool.length} слов. Два пути:</p>
      <div class="row stack">
        <button class="full btn-primary" id="t-calib">🎯 Калибровка (~2 мин)<br><small style="font-weight:400">80 случайных слов → оценю границу знания → предложу массовое «железно», остальное — чеклистом</small></button>
        <button class="full" id="t-list">📋 Листать чеклистом<br><small style="font-weight:400" class="muted">страницы по 50, по умолчанию «знаю» — отмечай только незнакомое</small></button>
        <button class="full ghost" id="t-one">🐢 По одному, со значениями<br><small style="font-weight:400" class="muted">медленный режим для вдумчивого разбора</small></button>
      </div></div>`;
    footer.innerHTML = `<button class="full ghost" id="back">← В меню</button>`;
    document.getElementById('t-calib').onclick = () => startCalibration();
    document.getElementById('t-list').onclick = () => showChecklist(0);
    document.getElementById('t-one').onclick = () => showCatalog();
    document.getElementById('back').onclick = showMenu;
  }

  /* --- калибровка: 8 частотных полос × 10 случайных слов --- */
  let calib = null;
  function startCalibration() {
    const pool = catalogPool();
    if (pool.length < 80) return showChecklist(0);
    const bandSize = Math.ceil(pool.length / 8);
    const sample = [];
    for (let b = 0; b < 8; b++) {
      const band = pool.slice(b * bandSize, (b + 1) * bandSize);
      shuffle(band).slice(0, 10).forEach(it => sample.push({ it, band: b }));
    }
    calib = { sample: shuffle(sample), i: 0, known: Array(8).fill(0), total: Array(8).fill(0), bandSize, poolLen: pool.length };
    calibNext();
  }
  function calibNext() {
    if (calib.i >= calib.sample.length) return showCalibResult();
    const { it } = calib.sample[calib.i];
    app.innerHTML = `<div class="card">
      <div class="section-label">Калибровка · ${calib.i + 1}/${calib.sample.length}</div>
      <div class="lemma" style="margin-top:10px">${esc(it.lemma)}</div>
      <p class="muted">Знаешь перевод этого слова?</p>
      <div class="row" style="margin-top:14px">
        <button class="full btn-bad" id="c-no">Не знаю</button>
        <button class="full btn-good" id="c-yes">Знаю</button>
      </div></div>`;
    footer.innerHTML = `<button class="full ghost" id="stop">Прервать</button>`;
    const answer = (ok) => {
      const s = calib.sample[calib.i];
      calib.total[s.band]++; if (ok) calib.known[s.band]++;
      calib.i++; calibNext();
    };
    document.getElementById('c-yes').onclick = () => answer(true);
    document.getElementById('c-no').onclick = () => answer(false);
    document.getElementById('stop').onclick = showTriageIntro;
  }
  function showCalibResult() {
    const pool = catalogPool();
    // консервативная граница: полосы подряд с ≥95% знания
    let cutBand = -1;
    for (let b = 0; b < 8; b++) {
      const pct = calib.total[b] ? calib.known[b] / calib.total[b] : 0;
      if (pct >= 0.95) cutBand = b; else break;
    }
    const rows = Array.from({ length: 8 }, (_, b) => {
      const pct = calib.total[b] ? Math.round(100 * calib.known[b] / calib.total[b]) : 0;
      const from = pool[b * calib.bandSize] ? (pool[b * calib.bandSize].freq_rank || '?') : '?';
      return `<div class="tprow ${b <= cutBand ? '' : 'dim'}"><span class="tname">полоса ${b + 1} (ранг ~${from}+)</span>
        <div class="bar"><span style="width:${pct}%"></span></div><span class="tnum">${pct}%</span></div>`;
    }).join('');
    const massCount = cutBand >= 0 ? Math.min((cutBand + 1) * calib.bandSize, pool.length) : 0;
    app.innerHTML = `<div class="card"><h2>Результат калибровки</h2>
      <div class="tpbars" style="margin-top:10px">${rows}</div>
      ${massCount > 0
        ? `<p style="margin-top:14px">Первые <b>${massCount}</b> слов ты знаешь на ≥95% — можно пометить «железно» одной кнопкой. Дыры выловит <b>скрининг железных</b> (экран «Прогресс»), любое слово вернёшь через поиск.</p>`
        : `<p class="muted" style="margin-top:14px">Ни одна полоса не дотянула до 95% — надёжнее пройти чеклистом.</p>`}
      </div>`;
    footer.innerHTML = `<div class="row stack">
      ${massCount > 0 ? `<button class="full btn-primary" id="mass">Пометить ${massCount} слов железно → чеклист дальше</button>` : ''}
      <button class="full" id="list">Просто листать чеклистом</button>
      <button class="full ghost" id="menu">В меню</button></div>`;
    const mb = document.getElementById('mass');
    if (mb) mb.onclick = () => {
      pool.slice(0, massCount).forEach(it => addToNoSave(it, 'solid'));
      save(); toast(`${massCount} слов → железно`);
      showChecklist(0);
    };
    document.getElementById('list').onclick = () => showChecklist(0);
    document.getElementById('menu').onclick = showMenu;
  }

  /* --- чеклист: страницы по 50, дефолт «знаю железно», тап циклом железно→учить→пассивно --- */
  const T_STATES = ['solid', 'learn', 'passive'];
  const T_LABEL = { solid: 'знаю', learn: 'учить', passive: 'пассивно' };
  function showChecklist(pageStart) {
    const pool = catalogPool();
    if (!pool.length) {
      app.innerHTML = `<div class="card"><h2>Каталог размечен 🎉</h2><p class="muted">Все слова распределены по спискам.</p></div>`;
      footer.innerHTML = `<button class="full" id="menu">В меню</button>`;
      document.getElementById('menu').onclick = showMenu; return;
    }
    const page = pool.slice(pageStart, pageStart + 50);
    const state = {};
    page.forEach(it => state[it.id] = 'solid');
    const row = (it) => `<div class="trow state-solid" data-id="${it.id}">
      <span class="tr-lemma">${esc(it.lemma)}</span>
      <span class="tr-gloss muted">${esc((it.senses && it.senses[0] || {}).gloss || '')}</span>
      <span class="tr-state">${T_LABEL.solid}</span></div>`;
    app.innerHTML = `<div class="card">
      <div class="section-label">Чеклист · слова ${pageStart + 1}–${pageStart + page.length} из ${pool.length} · тап = сменить статус</div>
      <div class="row" style="margin:10px 0">
        <button class="small" id="inv">Инвертировать</button>
        <button class="small" id="alllearn">Все → учить</button>
      </div>
      <div id="tlist">${page.map(row).join('')}</div></div>`;
    footer.innerHTML = `<div class="row">
      <button class="ghost" id="menu">В меню</button>
      <button class="full btn-primary" id="apply">✓ Сохранить страницу</button></div>`;
    const applyRow = (el, st) => {
      el.className = 'trow state-' + st;
      el.querySelector('.tr-state').textContent = T_LABEL[st];
    };
    document.querySelectorAll('.trow').forEach(el => el.onclick = () => {
      const id = el.dataset.id;
      const next = T_STATES[(T_STATES.indexOf(state[id]) + 1) % 3];
      state[id] = next; applyRow(el, next);
    });
    document.getElementById('inv').onclick = () => document.querySelectorAll('.trow').forEach(el => {
      const id = el.dataset.id;
      state[id] = state[id] === 'solid' ? 'learn' : 'solid'; applyRow(el, state[id]);
    });
    document.getElementById('alllearn').onclick = () => document.querySelectorAll('.trow').forEach(el => {
      state[el.dataset.id] = 'learn'; applyRow(el, 'learn');
    });
    document.getElementById('apply').onclick = () => {
      page.forEach(it => addToNoSave(it, { solid: 'solid', learn: 'active1', passive: 'active2' }[state[it.id]]));
      save();
      const learned = Object.values(state).filter(s => s !== 'solid').length;
      toast(learned ? `+${learned} в учёбу, остальные — железно` : 'страница → железно');
      showChecklist(pageStart);   // пул сдвинулся — та же позиция покажет следующие слова
    };
    document.getElementById('menu').onclick = showMenu;
  }

  /* ---------- ПОИСК + СВОИ СЛОВА (3.4) ---------- */
  function showSearch(q) {
    const query = norm(q);
    const hits = query.length >= 2
      ? ITEMS.filter(it => it.lemma && it.lemma.toLowerCase().includes(query)).sort((a, b) => (a.freq_rank || 99999) - (b.freq_rank || 99999)).slice(0, 20)
      : [];
    const badge = { catalog: 'каталог', active: 'учу', solid: 'железно', learned: 'выучено' };
    const row = (it) => {
      const l = listOf(it);
      const act = l === 'catalog'
        ? `<button class="small btn-primary" data-a="learn" data-id="${it.id}">учить</button><button class="small" data-a="solid" data-id="${it.id}">железно</button>`
        : l === 'active' ? `<span class="muted small-txt">уже учишь</span>`
        : `<button class="small" data-a="back" data-id="${it.id}">↩ в учёбу</button>`;
      return `<div class="list-row"><span><b>${esc(it.lemma)}</b> <span class="muted">${esc((it.senses && it.senses[0] || {}).gloss || '')}</span>
        <span class="pos" style="margin-left:6px">${badge[l]}</span></span><span style="white-space:nowrap">${act}</span></div>`;
    };
    app.innerHTML = `<div class="card"><h2>🔍 Поиск</h2>
      <input type="text" id="q" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="введи слово…" value="${esc(q)}" />
      <div id="hits" style="margin-top:10px">${hits.map(row).join('') || (query.length >= 2 ? '<p class="muted">Не найдено.</p>' : '<p class="muted">Минимум 2 буквы.</p>')}</div>
      ${query.length >= 2 ? `<button class="full ghost" id="addcustom" style="margin-top:12px">➕ Добавить своё слово «${esc(q)}»</button>` : ''}
    </div>`;
    footer.innerHTML = `<button class="full" id="menu">← В меню</button>`;
    const inp = document.getElementById('q');
    inp.focus(); inp.setSelectionRange(q.length, q.length);
    let deb;
    inp.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => showSearch(inp.value), 250); });
    document.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      const it = BY_ID[b.dataset.id];
      addTo(it, b.dataset.a === 'solid' ? 'solid' : 'active1');
      toast(b.dataset.a === 'solid' ? `${it.lemma} → железно` : `${it.lemma} → в учёбу`);
      showSearch(inp.value);
    });
    const ac = document.getElementById('addcustom');
    if (ac) ac.onclick = () => showCustomForm(q.trim());
    document.getElementById('menu').onclick = showMenu;
  }

  function showCustomForm(lemma) {
    app.innerHTML = `<div class="card"><h2>➕ Своё слово</h2>
      <input type="text" id="cf-lemma" placeholder="слово / выражение (англ.)" value="${esc(lemma)}" autocapitalize="off" spellcheck="false" />
      <input type="text" id="cf-gloss" placeholder="перевод (рус.)" style="margin-top:10px" />
      <input type="text" id="cf-ex" placeholder="пример употребления (англ., опционально)" style="margin-top:10px" autocapitalize="off" spellcheck="false" />
      <div class="section-label">Часть речи</div>
      <div class="chips" id="cf-pos">${[['noun', 'Сущ.'], ['verb', 'Глаг.'], ['adjective', 'Прил.'], ['adverb', 'Нареч.'], ['expression', 'Выражение']].map(([v, l], i) =>
        `<button class="chip ${i === 0 ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div>
      <p class="muted" style="font-size:12px;margin-top:10px">IPA и дополнительные примеры можно догенерить позже (команда «обогати активные» ассистенту).</p>
    </div>`;
    footer.innerHTML = `<div class="row"><button class="ghost" id="back">← Назад</button><button class="full btn-primary" id="cf-save">Сохранить и учить</button></div>`;
    let pos = 'noun';
    document.querySelectorAll('#cf-pos .chip').forEach(c => c.onclick = () => {
      document.querySelectorAll('#cf-pos .chip').forEach(x => x.classList.remove('on'));
      c.classList.add('on'); pos = c.dataset.v;
    });
    document.getElementById('back').onclick = () => showSearch(lemma);
    document.getElementById('cf-save').onclick = () => {
      const lm = document.getElementById('cf-lemma').value.trim();
      const gl = document.getElementById('cf-gloss').value.trim();
      const ex = document.getElementById('cf-ex').value.trim();
      if (!lm || !gl) return toast('Нужны слово и перевод');
      if (ITEMS.some(x => x.lemma && x.lemma.toLowerCase() === lm.toLowerCase())) return toast('Такое слово уже есть — найди поиском');
      const item = {
        id: 'u_' + lm.toLowerCase().replace(/[^a-z]+/g, '_'),
        lemma: lm, pos: pos === 'expression' ? 'collocation' : pos,
        is_expression: pos === 'expression' || lm.includes(' ') || undefined,
        freq_rank: 99999, custom: true,
        senses: [{ gloss: gl, pos: pos, example: ex || '' }]
      };
      const custom = readJSON(K_CUSTOM) || [];
      custom.push(item);
      localStorage.setItem(K_CUSTOM, JSON.stringify(custom));
      ITEMS.push(item); BY_ID[item.id] = item;
      addTo(item, 'active1');
      toast(`«${lm}» добавлено в учёбу`);
      showSearch('');
    };
  }

  /* ---------- СКРИНИНГ ЖЕЛЕЗНЫХ (3.4): найти дыры в «знаю железно» ---------- */
  let screen20 = null;
  function startScreening() {
    const pool = shuffle(ITEMS.filter(it => listOf(it) === 'solid' && it.senses && it.senses.length)).slice(0, 20);
    if (!pool.length) { toast('Список «железно» пуст'); return showLists(); }
    screen20 = { pool, i: 0, holes: 0 };
    screenNext();
  }
  function screenNext() {
    if (screen20.i >= screen20.pool.length) {
      app.innerHTML = `<div class="card summary"><h2>Скрининг закончен</h2>
        <p>${screen20.holes ? `Найдено дыр: <b>${screen20.holes}</b> — они вернулись в учёбу.` : 'Дыр не найдено. Железно так железно.'}</p></div>`;
      footer.innerHTML = `<div class="row"><button class="full" id="menu">В меню</button><button class="full btn-primary" id="more">Ещё ×20</button></div>`;
      document.getElementById('more').onclick = startScreening;
      document.getElementById('menu').onclick = showMenu;
      return;
    }
    const it = screen20.pool[screen20.i];
    const sense = it.senses[0];
    const opts = [sense.gloss, ...distractorsTranslate(it)];
    app.innerHTML = `<div class="card">
      <div class="section-label">Скрининг железных · ${screen20.i + 1}/${screen20.pool.length}</div>
      <div class="prompt"><span class="lemma">${esc(it.lemma)}</span> <button class="audio-btn" id="say">🔊</button></div>
      ${mcq(opts, sense.gloss)}</div>`;
    footer.innerHTML = `<button class="full ghost" id="stop">Прервать</button>`;
    document.getElementById('say').onclick = () => speak(it.lemma);
    document.querySelectorAll('#opts .option').forEach(b => b.onclick = () => {
      const ok = b.dataset.ok === '1';
      document.querySelectorAll('#opts .option').forEach(x => { x.disabled = true; if (x.dataset.ok === '1') x.classList.add('correct'); else if (x === b) x.classList.add('wrong'); });
      if (ok) { setTimeout(() => { screen20.i++; screenNext(); }, 450); }
      else {
        screen20.holes++;
        addTo(it, 'active1'); speak(it.lemma);
        footer.innerHTML = `<button class="full btn-primary" id="next">Вернул в учёбу → дальше</button>`;
        document.getElementById('next').onclick = () => { screen20.i++; screenNext(); };
      }
    });
    document.getElementById('stop').onclick = showLists;
  }

  /* ---------- УЧЁБА: блок → ревью → сводка ---------- */
  function startStudy() { mode = 'study'; poolFilter = null; blockLimit = null; startBlock(); }
  function startFree() { mode = 'free'; startBlock(); }
  function startWeak(ids) {
    mode = 'study'; poolFilter = 'weak'; weakIds = new Set(ids); blockLimit = 10;
    startBlock();
  }
  function startPreps() {
    mode = 'study'; poolFilter = 'preps';
    // паттерны не проходят каталог — авто-зачисление при первом входе в трек
    ITEMS.filter(it => it.kind === 'prep_pattern' && !progress[it.id])
      .forEach(it => { progress[it.id] = E.newEntry('active1', it); });
    save();
    startBlock();
  }
  function startBlock() {
    phase = 'main'; blockN = 0; recent = [];
    blockStats = { ok: 0, bad: 0, errors: [] };
    studyNext();
  }

  function availableTypes(it) {
    const p = P(it);
    if (mode === 'study') return E.readyTypes(p, it, todayStr());   // с нарастающей сложностью
    const th = E.threshold(p.stage);                       // free: без капов, но добитые оси не гоняем
    return E.typesFor(it).filter(t => p.points[t] < th);
  }
  function inPool(it) {
    if (poolFilter === 'preps') return it.kind === 'prep_pattern' || !!it.prep;   // трек: паттерны + чанки
    if (poolFilter === 'weak') return weakIds.has(it.id);                         // мини-блок трудных слов
    return it.kind !== 'prep_pattern' && matchesPOS(it);                          // обычный пул: без паттернов
  }
  function activePool() {
    return ITEMS.filter(it => listOf(it) === 'active' && inPool(it) && availableTypes(it).length);
  }

  function studyNext() {
    renderStats();
    if (blockN >= blockSize()) return endOfMain();
    const pool = activePool();
    if (!pool.length) {
      if (blockStats && (blockStats.ok + blockStats.bad) > 0) return endOfMain();  // блок начат — закрыть по-честному
      return showStudyEmpty();
    }
    const weighted = pool.map(it => {
      const p = P(it), th = E.threshold(p.stage);
      let rem = availableTypes(it).reduce((s, t) => s + (th - p.points[t]), 0);
      if (recent.includes(it.id)) rem *= 0.1;
      return { it, w: Math.max(rem, 0.1) };
    });
    const sum = weighted.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * sum, it = weighted[weighted.length - 1].it;
    for (const x of weighted) { r -= x.w; if (r <= 0) { it = x.it; break; } }
    recent.push(it.id); while (recent.length > 5) recent.shift();
    const p = P(it);
    const cand = availableTypes(it).sort((a, b) => p.points[a] - p.points[b]);
    const min = p.points[cand[0]];
    const pick = cand.filter(t => p.points[t] === min);
    const type = pick[Math.floor(Math.random() * pick.length)];
    // паттерн предлога показывается первый раз → сначала карточка-правило
    if (it.kind === 'prep_pattern' && !p.seen) return showPatternIntro(it, type);
    // новое слово (Этап 1, ни одного балла) → сначала знакомство, потом упражнения
    if (it.kind !== 'prep_pattern' && p.stage === 1 && !p.met && E.typesFor(it).every(t => !p.points[t])) {
      return showWordIntro(it, type);
    }
    renderExercise(it, type);
  }

  /* 3.5: знакомство со словом перед первым упражнением */
  function showWordIntro(it, type) {
    const sl = (it.senses || []).map(s => `<li><b>${esc(s.gloss)}</b> <span class="muted">(${esc(s.pos)})</span><br><span class="ex-line">${esc(s.example)}</span></li>`).join('');
    app.innerHTML = `<div class="card">
      <div class="section-label">Новое слово · знакомство</div>
      <div class="lemma">${esc(it.lemma)}</div>
      <div class="ipa">${esc(it.ipa || '')} <button class="audio-btn" id="say">🔊</button></div>
      <ul class="examples">${sl}</ul>
      ${it.is_irregular && it.forms ? `<div class="muted">неправильный глагол: ${esc(it.lemma)} — <b>${esc(it.forms.past)}</b> — <b>${esc(it.forms.pp)}</b></div>` : ''}
      ${it.usage ? `<div class="muted" style="margin-top:6px">${esc(it.usage)}</div>` : ''}
      <p class="muted" style="margin-top:14px">Сначала прослушай и прочитай. Дальше — упражнения от простого к сложному: узнавание → контекст → воспроизведение.</p>
    </div>`;
    footer.innerHTML = `<button id="go" class="full btn-primary">Понятно → упражнение</button>`;
    speak(it.lemma);
    document.getElementById('say').onclick = () => speak(it.lemma);
    document.getElementById('go').onclick = () => { P(it).met = true; save(); renderExercise(it, type); };
  }

  function showPatternIntro(it, type) {
    const ex = it.examples.map(e2 => `<li>${esc(e2).replace(new RegExp('\\b' + escRe(it.prep) + '\\b', 'i'), m => `<b class="prep-hl">${m}</b>`)}</li>`).join('');
    app.innerHTML = `<div class="card">
      <div class="section-label">Предлоги · правило</div>
      <h2>${esc(it.title)}</h2>
      <p class="muted">${esc(it.rule)}</p>
      <ul class="examples">${ex}</ul></div>`;
    footer.innerHTML = `<button id="go" class="full btn-primary">Понятно, тренировать →</button>`;
    document.getElementById('go').onclick = () => { P(it).seen = true; save(); renderExercise(it, type); };
  }

  function endOfMain() {
    if (mode === 'study' && blockStats.errors.length) return showReviewIntro();
    return showSummary();
  }

  /* UX-3: empty-state с «без баллов» */
  function showStudyEmpty() {
    const anyActive = ITEMS.some(it => listOf(it) === 'active' && matchesPOS(it));
    app.innerHTML = `<div class="card"><h2>${anyActive ? 'На сегодня всё 🎉' : 'Нет активных слов'}</h2>
      <p class="muted">${anyActive
        ? 'Ты прошёл всё, что даёт баллы сегодня. Интервалы — это и есть запоминание.'
        : 'Зайди в «Пополнить» и выбери, что учить.'}</p>${chipsHtml()}</div>`;
    footer.innerHTML = `<div class="row stack">
      <button id="add" class="full btn-primary">➕ Добавить новые слова</button>
      ${anyActive ? '<button id="free" class="full">Потренировать без баллов</button>' : ''}
      <button id="menu" class="full ghost">В меню</button></div>`;
    wireChips(() => { mode === 'free' ? startFree() : startStudy(); });
    document.getElementById('add').onclick = showCatalog;
    const fr = document.getElementById('free'); if (fr) fr.onclick = startFree;
    document.getElementById('menu').onclick = showMenu;
  }

  /* UX-4: прослойка ревью и сводка */
  function showReviewIntro() {
    const uniq = [];
    const seen = new Set();
    blockStats.errors.forEach(e2 => { const k = e2.id + '|' + e2.type; if (!seen.has(k)) { seen.add(k); uniq.push(e2); } });
    reviewQueue = uniq; reviewIdx = 0;
    app.innerHTML = `<div class="card"><h2>Разбор ошибок</h2>
      <p class="muted">Слов с ошибками: ${reviewQueue.length}. Пройдём их ещё раз — повторная ошибка баллы не снимает.</p></div>`;
    footer.innerHTML = `<button id="go" class="full btn-primary">Начать разбор →</button>`;
    document.getElementById('go').onclick = () => { phase = 'review'; reviewNext(); };
  }
  function reviewNext() {
    if (reviewIdx >= reviewQueue.length) return showSummary();
    const { id, type } = reviewQueue[reviewIdx];
    renderExercise(BY_ID[id], type);
  }
  function showSummary() {
    if (mode === 'study') bumpDaily('blocks');
    const errWords = Array.from(new Set(blockStats.errors.map(e2 => e2.id))).map(id => BY_ID[id]);
    const diff = errWords.length
      ? `<div class="section-label">Трудные слова</div><div class="chips">${errWords.map(w => `<button class="chip" data-w="${w.id}">${esc(w.lemma)}</button>`).join('')}</div>`
      : `<p class="muted">Без ошибок. Красиво.</p>`;
    app.innerHTML = `<div class="card summary"><h2>Блок пройден!</h2>
      <div class="sum-row"><span class="ok-n">✓ ${blockStats.ok}</span> <span class="bad-n">✗ ${blockStats.bad}</span>${mode === 'free' ? ' <span class="muted">· без баллов</span>' : ''}</div>
      ${diff}</div>`;
    footer.innerHTML = `<div class="row"><button id="menu" class="full">В меню</button><button id="more" class="full btn-primary">Ещё блок →</button></div>`;
    document.querySelectorAll('[data-w]').forEach(b => b.onclick = () => showWordCard(BY_ID[b.dataset.w], showSummary));
    document.getElementById('more').onclick = () => startBlock();
    document.getElementById('menu').onclick = showMenu;
  }
  function showWordCard(it, back) {
    if (it.kind === 'prep_pattern') {
      const ex = it.examples.map(e2 => `<li>${esc(e2)}</li>`).join('');
      app.innerHTML = `<div class="card"><h2>${esc(it.title)}</h2><p class="muted">${esc(it.rule)}</p><ul class="examples">${ex}</ul></div>`;
      footer.innerHTML = `<button id="back" class="full">← Назад</button>`;
      document.getElementById('back').onclick = back;
      return;
    }
    const cex = (readJSON(K_CEX) || {})[it.id] || [];
    const sl = it.senses.map(s => `<li><b>${esc(s.gloss)}</b> <span class="muted">(${esc(s.pos)})</span> — ${esc(s.example)}</li>`).join('')
      + cex.map(e2 => `<li class="muted">✎ ${esc(e2)}</li>`).join('');
    app.innerHTML = `<div class="card"><div class="lemma">${esc(it.lemma)}</div>
      <div class="ipa">${esc(it.ipa || '')}</div>
      <button class="audio-btn" id="say" style="margin-top:10px">🔊</button>
      <ul class="examples">${sl}</ul>
      ${it.usage ? `<div class="muted">${esc(it.usage)}</div>` : ''}
      <div class="row" style="margin-top:12px">
        <input type="text" id="newex" placeholder="добавить свой пример (англ.)…" autocapitalize="off" spellcheck="false" style="flex:1" />
        <button class="small" id="addex">＋</button>
      </div></div>`;
    footer.innerHTML = `<button id="back" class="full">← Назад</button>`;
    document.getElementById('say').onclick = () => speak(it.lemma);
    document.getElementById('addex').onclick = () => {
      const v = document.getElementById('newex').value.trim();
      if (!v) return;
      if (it.lemma && !v.toLowerCase().includes(it.lemma.toLowerCase())) return toast('Пример должен содержать само слово');
      const all = readJSON(K_CEX) || {};
      (all[it.id] = all[it.id] || []).push(v);
      localStorage.setItem(K_CEX, JSON.stringify(all));
      toast('Пример добавлен');
      showWordCard(it, back);
    };
    speak(it.lemma);
    document.getElementById('back').onclick = back;
  }

  /* ---------- УПРАЖНЕНИЯ ---------- */
  function progressBars(it) {
    const p = P(it); if (!p || p.list !== 'active') return '';
    const th = E.threshold(p.stage);
    const capped = new Set(E.cappedTypes(p, it, todayStr()));
    const gated = !E.baseReady(p, it);
    const rows = E.typesFor(it).map(t => {
      const pts = p.points[t], done = pts >= th, cap = capped.has(t);
      const lock = gated && E.TIER2.includes(t) && !done;
      return `<div class="tprow ${cap || lock ? 'dim' : ''}"><span class="tname">${TYPE_LABEL[t]}${done ? ' ✓' : ''}</span>
        <div class="bar"><span style="width:${Math.round(100 * pts / th)}%"></span></div>
        <span class="tnum">${lock ? '🔒' : cap ? '✓ на сегодня' : pts + '/' + th}</span></div>`;
    }).join('');
    return `<div class="section-label">Этап ${p.stage} · прогресс по слову${gated ? ' · 🔒 откроются после базы' : ''}</div><div class="tpbars">${rows}</div>`;
  }

  function renderExercise(it, type) {
    current = { it, type, retried: false };
    const head = mode === 'test' ? 'Проверка выученного'
      : phase === 'review' ? `Повтор · ${TYPE_LABEL[type]}`
      : `${mode === 'free' ? 'Без баллов' : 'Блок ' + (blockN + 1) + '/' + blockSize()} · ${TYPE_LABEL[type]}`;
    let body = '';
    if (type === 'translate') body = exTranslate(it);
    else if (type === 'listen') body = exListen(it);
    else if (type === 'context') body = exContext(it);
    else if (type === 'write') body = exWrite(it);
    else if (type === 'recall') body = exRecall(it);
    else if (type === 'speak') body = exSpeak(it);
    else if (type === 'forms') body = exForms(it);
    app.innerHTML = `<div class="card"><div class="section-label">${head}</div>${body}<div id="fb"></div>
      <div id="pbars">${mode === 'study' ? progressBars(it) : ''}</div></div>`;
    footer.innerHTML = '';
    const say = document.getElementById('say'); if (say) say.onclick = () => speak(current.listenText || it.lemma, current.listenRate);
    if (type === 'listen' || current.dictation) speak(current.listenText || it.lemma, current.listenRate);
    wire(it, type);
  }

  function mcq(optionsArr, correct) {
    const opts = shuffle(optionsArr);
    return `<div class="grid" id="opts">${opts.map(o => `<button class="option full" data-v="${esc(o)}" data-ok="${norm(o) === norm(correct) ? 1 : 0}">${esc(o)}</button>`).join('')}</div>`;
  }
  function exTranslate(it) {
    const sense = it.senses[Math.floor(Math.random() * it.senses.length)];
    current.correct = sense.gloss;
    const opts = [sense.gloss, ...distractorsTranslate(it)];
    return `<div class="prompt"><span class="lemma">${esc(it.lemma)}</span> <button class="audio-btn" id="say">🔊</button>
      <div class="muted" style="font-size:13px;margin-top:6px">какое значение?</div></div>${mcq(opts, sense.gloss)}`;
  }
  function exListen(it) {
    current.correct = it.lemma;
    /* US-11: на Этапе 2 — озвучка целого предложения */
    const p = P(it);
    if (mode === 'study' && p && p.stage === 2) {
      const pool = it.senses.map(s => s.example).filter(e2 => e2.toLowerCase().includes(it.lemma.toLowerCase()));
      current.listenText = pickExample(it, pool.length ? pool : it.senses.map(s => s.example));
      current.listenRate = 0.9;
    }
    const hint = current.listenText ? 'какое слово прозвучало в предложении?' : 'какое слово ты слышишь?';
    const opts = [it.lemma, ...distractorsListen(it)];
    return `<div class="prompt"><button class="btn-primary" id="say">🔊 Прослушать снова</button><div class="muted" style="margin-top:8px">${hint}</div></div>${mcq(opts, it.lemma)}
      <button id="skip" class="ghost full" style="margin-top:12px">Пропустить (нет звука) — без очков</button>`;
  }
  function exContext(it) {
    if (it.kind === 'prep_pattern' || it.prep) return exPrepGap(it, 'choice');
    const withLemma = it.senses.filter(s => s.example.toLowerCase().includes(it.lemma.toLowerCase()));
    const sense = withLemma.length ? withLemma[Math.floor(Math.random() * withLemma.length)] : it.senses[0];
    const ex = pickExample(it, withLemma.length ? withLemma.map(s => s.example) : [sense.example]);
    const blanked = ex.replace(new RegExp(escRe(it.lemma), 'i'), '____');
    current.correct = it.lemma;
    const opts = [it.lemma, ...distractorsContext(it)];
    return `<div class="prompt">${esc(blanked)}</div><div class="muted">${esc(sense.gloss)}</div>${mcq(opts, it.lemma)}`;
  }
  /* R6: gap-fill предлога — для паттернов и чанков; choice = 4 предлога в ряд, input = ввод */
  function exPrepGap(it, gapMode) {
    const pool = it.kind === 'prep_pattern' ? it.examples : it.senses.map(s => s.example);
    const ex = pickExample(it, pool);
    const blanked = ex.replace(new RegExp('\\b' + escRe(it.prep) + '\\b', 'i'), '____');
    current.correct = it.prep;
    const hint = it.prep && !it.kind ? `<div class="muted">${esc(it.senses[0].gloss)}</div>` : '';
    if (gapMode === 'input') {
      return `<div class="prompt">${esc(blanked)}</div>${hint}
        <input type="text" id="pin" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="предлог…" maxlength="8" />
        <div class="row" style="margin-top:12px"><button id="pchk" class="full btn-primary">Проверить</button></div>`;
    }
    return `<div class="prompt">${esc(blanked)}</div>${hint}<div class="prep-row" id="opts">${shuffle(prepOptions(it)).map(o =>
      `<button class="option prep-opt" data-v="${esc(o)}" data-ok="${o === it.prep ? 1 : 0}">${esc(o)}</button>`).join('')}</div>`;
  }
  function exWrite(it) {
    if (it.kind === 'prep_pattern') return exPrepGap(it, 'input');
    current.correct = it.lemma;
    /* US-14: на Этапе 2 половина показов «Написания» — аудио-диктант (слышу → пишу) */
    const p = P(it);
    if (mode === 'study' && p && p.stage === 2 && Math.random() < 0.5) {
      current.dictation = true; current.listenText = it.lemma;
      return `<div class="prompt"><button class="btn-primary" id="say">🔊 Прослушать снова</button>
        <div class="muted" style="margin-top:8px">диктант: напиши слово, которое слышишь</div></div>
        <input type="text" id="win" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="type what you hear…" />
        <div class="row" style="margin-top:12px"><button id="wchk" class="full btn-primary">Проверить</button></div>
        <button id="skip" class="ghost full" style="margin-top:12px">Пропустить (нет звука) — без очков</button>`;
    }
    return `<div class="prompt">Напиши по-английски:<br><b>${esc(glosses(it).join(', '))}</b> <button class="audio-btn" id="say">🔊</button></div>
      <input type="text" id="win" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="type in English…" />
      <div class="row" style="margin-top:12px"><button id="wchk" class="full btn-primary">Проверить</button></div>`;
  }
  /* UX-2: recall RU→EN — с контекстом-пропуском, чтобы снять синонимию (3.5) */
  function exRecall(it) {
    const withEx = it.senses.filter(s => s.example && s.example.toLowerCase().includes(it.lemma.toLowerCase()));
    const sense = withEx.length ? withEx[Math.floor(Math.random() * withEx.length)] : it.senses[0];
    current.correct = it.lemma; current.sense = sense;
    const gap = withEx.length ? sense.example.replace(new RegExp(escRe(it.lemma), 'i'), '____') : '';
    return `<div class="prompt"><b style="font-size:24px">${esc(sense.gloss)}</b>
      <span class="pos" style="margin-left:8px">${esc(sense.pos)}</span>
      ${gap ? `<div class="gap-line">${esc(gap)}</div>` : ''}
      <div class="muted" style="font-size:13px;margin-top:6px">${gap ? 'какое слово пропущено?' : 'вспомни и напиши английское слово'}</div></div>
      <input type="text" id="rin" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="type in English…" />
      <div class="row" style="margin-top:12px"><button id="rchk" class="full btn-primary">Проверить</button></div>
      <button id="rgiveup" class="ghost full" style="margin-top:10px">Не помню</button>`;
  }
  function exSpeak(it) {
    const has = ('webkitSpeechRecognition' in window) || ('SpeechRecognition' in window);
    return `<div class="prompt">Произнеси вслух:<br><span class="lemma">${esc(it.lemma)}</span> <button class="audio-btn" id="say">🔊</button></div>
      <div class="muted">${esc(it.ipa || '')}</div>
      ${has ? `<div class="row" style="margin-top:14px"><button id="mic" class="full btn-primary">🎤 Записать</button></div><div class="muted" id="heard" style="margin-top:8px"></div>`
        : `<div class="muted" style="margin-top:14px">Распознавание недоступно. Оцени сам:</div>
           <div class="row" style="margin-top:10px"><button id="sok" class="btn-good">Верно</button><button id="sno" class="btn-bad">Ошибся</button></div>`}
      <button id="skip" class="ghost full" style="margin-top:12px">Пропустить (не могу говорить) — без очков</button>`;
  }
  function exForms(it) {
    /* US-15: половина показов — форма в контексте («Yesterday I ____ (make)…») */
    if (it.past_example && Math.random() < 0.5) {
      const blanked = it.past_example.replace(new RegExp('\\b' + escRe(it.forms.past) + '\\b', 'i'), '____');
      if (blanked !== it.past_example) {
        current.formsGap = true;
        return `<div class="prompt">${esc(blanked)}</div>
          <div class="muted">вставь прошедшую форму глагола <b>${esc(it.lemma)}</b></div>
          <input type="text" id="fg" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="past form…" style="margin-top:10px" />
          <div class="row" style="margin-top:12px"><button id="fgchk" class="full btn-primary">Проверить</button></div>`;
      }
    }
    return `<div class="prompt">Формы глагола <span class="lemma">${esc(it.lemma)}</span></div>
      <div class="muted">Past Simple и Past Participle (V2 / V3)</div>
      <input type="text" id="f2" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Past Simple (V2)" style="margin-top:10px" />
      <input type="text" id="f3" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Past Participle (V3)" style="margin-top:10px" />
      <div class="row" style="margin-top:12px"><button id="fchk" class="full btn-primary">Проверить</button></div>`;
  }

  function skipRound() { flash = ''; if (mode === 'test') return testNext(); nextAfterRound(false); }

  function wire(it, type) {
    const sk = document.getElementById('skip'); if (sk) sk.onclick = () => skipRound();
    if (type === 'translate' || type === 'listen' || type === 'context') {
      document.querySelectorAll('#opts .option').forEach(b => b.onclick = () => {
        const ok = b.dataset.ok === '1';
        document.querySelectorAll('#opts .option').forEach(x => { x.disabled = true; if (x.dataset.ok === '1') x.classList.add('correct'); else if (x === b) x.classList.add('wrong'); });
        grade(it, type, ok, current.correct);
      });
    } else if (type === 'write' && it.kind === 'prep_pattern') {
      const inp = document.getElementById('pin'); inp.focus();
      const chk = () => grade(it, type, norm(inp.value) === norm(it.prep), it.prep);
      document.getElementById('pchk').onclick = chk;
      inp.addEventListener('keydown', e2 => { if (e2.key === 'Enter') chk(); });
    } else if (type === 'write') {
      const inp = document.getElementById('win'); inp.focus();
      const chk = () => {
        const v = norm(inp.value), t = norm(it.lemma);
        if (E.isTypo(v, t) && !current.retried) { current.retried = true; inp.classList.add('typo'); toast('Почти! Проверь написание'); return; }
        grade(it, type, v === t, it.lemma);
      };
      document.getElementById('wchk').onclick = chk;
      inp.addEventListener('keydown', e2 => { if (e2.key === 'Enter') chk(); });
    } else if (type === 'recall') {
      const inp = document.getElementById('rin'); inp.focus();
      const chk = () => {
        const v = norm(inp.value), t = norm(it.lemma);
        if (E.isTypo(v, t) && !current.retried) { current.retried = true; inp.classList.add('typo'); toast('Почти! Проверь написание'); return; }
        grade(it, type, v === t, it.lemma);
      };
      document.getElementById('rchk').onclick = chk;
      inp.addEventListener('keydown', e2 => { if (e2.key === 'Enter') chk(); });
      document.getElementById('rgiveup').onclick = () => grade(it, type, false, it.lemma);
    } else if (type === 'forms' && current.formsGap) {
      const fg = document.getElementById('fg'); fg.focus();
      const chk = () => grade(it, type, norm(fg.value) === norm(it.forms.past), it.forms.past);
      document.getElementById('fgchk').onclick = chk;
      fg.addEventListener('keydown', e2 => { if (e2.key === 'Enter') chk(); });
    } else if (type === 'forms') {
      const f2 = document.getElementById('f2'), f3 = document.getElementById('f3'); f2.focus();
      const ok2 = (v) => norm(v) === norm(it.forms.past);
      const ok3 = (v) => norm(v) === norm(it.forms.pp) || (it.forms.pp_alt && norm(v) === norm(it.forms.pp_alt));
      document.getElementById('fchk').onclick = () => grade(it, type, ok2(f2.value) && ok3(f3.value), `${it.forms.past} / ${it.forms.pp}${it.forms.pp_alt ? ' (' + it.forms.pp_alt + ')' : ''}`);
    } else if (type === 'speak') {
      const heard = document.getElementById('heard'), mic = document.getElementById('mic');
      if (mic) {
        mic.onclick = () => {
          const SR = window.SpeechRecognition || window.webkitSpeechRecognition; const rec = new SR();
          rec.lang = 'en-US'; rec.maxAlternatives = 3; mic.textContent = '🎤 Слушаю…';
          rec.onresult = (e2) => { const alts = Array.from(e2.results[0]).map(a => norm(a.transcript)); heard.textContent = 'Распознано: ' + alts.join(' / '); grade(it, type, alts.some(a => a === norm(it.lemma) || a.includes(norm(it.lemma))), it.lemma); };
          rec.onerror = () => { heard.textContent = 'Не расслышал — попробуй ещё.'; mic.textContent = '🎤 Записать'; };
          rec.start();
        };
      } else {
        document.getElementById('sok').onclick = () => grade(it, type, true, it.lemma);
        document.getElementById('sno').onclick = () => grade(it, type, false, it.lemma);
      }
    }
  }

  /* ---------- ОЦЕНКА ---------- */
  function grade(it, type, ok, correctText) {
    if (mode === 'test') return gradeTest(it, ok, correctText);
    if (mode === 'study') {
      const p = P(it); E.migrate(p, it);
      const res = E.applyAnswer(p, it, type, ok, todayStr(), { noPenalty: phase === 'review' });
      if (res.event === 'stage2') flash = 'Слово перешло на Этап 2 (консолидация, ~30 дней)';
      if (res.event === 'learned') flash = 'Слово выучено! 🎉';
      save();
    }
    bumpDaily('rounds');
    if (mode === 'study') logAnswer(it, type, ok);
    blockStats[ok ? 'ok' : 'bad']++;
    if (!ok && phase === 'main' && mode === 'study') blockStats.errors.push({ id: it.id, type });
    feedback(it, ok, correctText, type);
  }

  function feedback(it, ok, correctText, type) {
    const fb = document.getElementById('fb');
    const reveal = (type === 'recall')
      ? `<div class="reveal"><b>${esc(it.lemma)}</b> ${esc(it.ipa || '')} — ${esc((current.sense || it.senses[0]).example)}</div>` : '';
    const reviewNote = (phase === 'review' && !ok) ? `<div class="muted" style="margin-top:6px">Запомним — вернёмся к нему завтра.</div>` : '';
    const tail = it.kind === 'prep_pattern' ? esc(it.rule) : esc(glosses(it).join(', '));
    fb.innerHTML = (ok ? `<div class="feedback ok">✓ Верно</div>`
      : `<div class="feedback no">✗ Правильно: <b>${esc(correctText)}</b>${tail ? ' — ' + tail : ''}</div>`)
      + reveal + reviewNote
      + (flash ? `<div class="feedback ok" style="margin-top:8px">${esc(flash)}</div>` : '');
    const pb = document.getElementById('pbars'); if (pb) pb.innerHTML = mode === 'study' ? progressBars(it) : '';
    footer.innerHTML = `<div class="row"><button id="flag" class="ghost" title="Пожаловаться на перевод/пример">🚩</button><button id="retire" class="ghost">Убрать</button><button id="next" class="full btn-primary">Дальше →</button></div>`;
    document.getElementById('next').onclick = () => nextAfterRound(true);
    document.getElementById('retire').onclick = () => { flash = ''; addTo(it, 'solid'); nextAfterRound(true); };
    document.getElementById('flag').onclick = () => {
      const flags = readJSON(K_FLAGS) || [];
      flags.push({ id: it.id, lemma: it.lemma, type, d: todayStr() });
      localStorage.setItem(K_FLAGS, JSON.stringify(flags));
      toast('Помечено — исправим при следующей чистке');
    };
    if (it.lemma && (type === 'recall' || !ok)) speak(it.lemma);
  }

  function nextAfterRound() {
    flash = '';
    if (phase === 'review') { reviewIdx++; return reviewNext(); }
    blockN++;
    studyNext();
  }

  /* ---------- ТЕСТ ВЫУЧЕННЫХ ---------- */
  function startTest() { mode = 'test'; phase = 'main'; recent = []; localStorage.setItem(K_LASTTEST, new Date().toISOString()); testNext(); }
  function testNext() {
    renderStats();
    const pool = ITEMS.filter(it => listOf(it) === 'learned' && matchesPOS(it));
    if (!pool.length) {
      app.innerHTML = `<div class="card"><h2>Тест выученных</h2><p class="muted">Список выученных пуст (по этому фильтру).</p>${chipsHtml()}</div>`;
      footer.innerHTML = `<button class="full" id="menu">В меню</button>`; wireChips(testNext);
      document.getElementById('menu').onclick = showMenu; return;
    }
    const it = pool[Math.floor(Math.random() * pool.length)];
    const types = E.typesFor(it);
    renderExercise(it, types[Math.floor(Math.random() * types.length)]);
  }
  function gradeTest(it, ok, correctText) {
    const fb = document.getElementById('fb');
    fb.innerHTML = ok ? `<div class="feedback ok">✓ Помнишь</div>` : `<div class="feedback no">✗ Правильно: <b>${esc(correctText)}</b> — ${esc(glosses(it).join(', '))}</div>`;
    footer.innerHTML = `<div class="row"><button id="ret" class="btn-warn">Забыл — вернуть в обучение</button><button id="next" class="full btn-primary">Дальше →</button></div>`;
    document.getElementById('next').onclick = testNext;
    document.getElementById('ret').onclick = () => { addTo(it, 'active1'); testNext(); };
    if (!ok) speak(it.lemma);
  }

  /* ---------- ЭКСПОРТ / ИМПОРТ (UX-6) ---------- */
  function doExport() {
    const payload = {
      app: 'english-vocab-trainer', version: 3, exported: new Date().toISOString(), progress,
      custom: readJSON(K_CUSTOM) || [], customExamples: readJSON(K_CEX) || {}, flags: readJSON(K_FLAGS) || []
    };
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vocab-progress-${todayStr()}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    localStorage.setItem(K_EXPORT, new Date().toISOString());
    toast('Копия скачана');
    if (document.getElementById('m-study')) showMenu(); else showLists();
  }
  function summarize(prog) {
    const c = { active: 0, learned: 0, solid: 0 };
    Object.values(prog).forEach(v => { if (c[v.list] !== undefined) c[v.list]++; });
    return `учу ${c.active}, выучено ${c.learned}, железно ${c.solid}`;
  }
  function doImport(file) {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const obj = JSON.parse(rd.result);
        if (!obj || typeof obj.progress !== 'object') throw new Error('нет поля progress');
        const okGo = confirm(`Заменить текущий прогресс (${summarize(progress)}) на данные из файла (${summarize(obj.progress)})?`);
        if (!okGo) return;
        progress = obj.progress;
        if (obj.custom) localStorage.setItem(K_CUSTOM, JSON.stringify(obj.custom));
        if (obj.customExamples) localStorage.setItem(K_CEX, JSON.stringify(obj.customExamples));
        save(); toast('Прогресс восстановлен — перезагружаю'); setTimeout(() => location.reload(), 800);
      } catch (err) { toast('Файл не подходит: ' + err.message); }
    };
    rd.readAsText(file);
  }

  /* ---------- СПИСКИ И ПРОГРЕСС ---------- */
  function showLists() {
    const solid = ITEMS.filter(it => listOf(it) === 'solid');
    const learned = ITEMS.filter(it => listOf(it) === 'learned');
    const c = counts();
    const last = localStorage.getItem(K_EXPORT);
    const lastTxt = last ? new Date(last).toLocaleDateString('ru-RU') : 'ещё не было';
    const row = (it) => `<div class="list-row"><span>${esc(it.lemma)} <span class="muted">${esc(it.pos)}</span></span><button class="ghost small" data-id="${it.id}">↩ в обучение</button></div>`;
    app.innerHTML = `<div class="card">
      <h2>Списки и прогресс</h2>
      <div class="muted">каталог ${c.catalog} · учу ${c.active} · выучено ${c.learned} · железно ${c.solid}</div>
      <div class="backup-card">
        <div class="section-label" style="margin-top:0">Резервная копия</div>
        <div class="muted" style="font-size:13px">последний экспорт: ${lastTxt}${(readJSON(K_FLAGS) || []).length ? ` · 🚩 жалоб на контент: ${(readJSON(K_FLAGS) || []).length} (уйдут с экспортом)` : ''}</div>
        <div class="row" style="margin-top:10px">
          <button id="exp" class="btn-primary">⬇ Скачать прогресс</button>
          <button id="imp">⬆ Восстановить</button>
          <input type="file" id="impfile" accept="application/json" style="display:none" />
        </div>
      </div>
      ${(() => {
        const weak = weakWords();
        if (!weak.length) return '';
        return `<div class="section-label">Трудные слова (7 дней)</div>
          ${weak.map(w => `<div class="list-row"><span>${esc(w.it.lemma)} <span class="muted">${w.n} ошиб.</span></span></div>`).join('')}
          <button id="weak-train" class="full btn-primary" style="margin-top:10px">Потренировать только их (×10)</button>`;
      })()}
      <div class="section-label">Выучено (${learned.length})</div>${learned.map(row).join('') || '<div class="muted">пусто</div>'}
      <div class="section-label">Железно знаю (${solid.length})</div>
      ${solid.length ? `<button id="screening" class="full" style="margin-bottom:8px">🩺 Скрининг железных (×20) — найти дыры</button>` : ''}
      ${solid.length > 30 ? `<div class="muted" style="font-size:12px;margin-bottom:6px">показаны первые 30</div>` : ''}
      ${solid.slice(0, 30).map(row).join('') || '<div class="muted">пусто</div>'}
      <button id="reset" class="btn-bad full" style="margin-top:20px">Сбросить весь словарь</button>
    </div>`;
    footer.innerHTML = `<button class="full" id="menu">← В меню</button>`;
    document.querySelectorAll('.list-row button').forEach(b => b.onclick = () => { addTo(BY_ID[b.dataset.id], 'active1'); showLists(); });
    document.getElementById('exp').onclick = doExport;
    const impfile = document.getElementById('impfile');
    document.getElementById('imp').onclick = () => impfile.click();
    impfile.onchange = () => { if (impfile.files[0]) doImport(impfile.files[0]); };
    document.getElementById('reset').onclick = () => { if (confirm(`Сбросить ВЕСЬ прогресс (${summarize(progress)})?`)) { progress = {}; skipped = new Set(); save(); showMenu(); } };
    const wt = document.getElementById('weak-train');
    if (wt) wt.onclick = () => startWeak(weakWords().map(w => w.it.id));
    const scr = document.getElementById('screening');
    if (scr) scr.onclick = startScreening;
    document.getElementById('menu').onclick = showMenu;
  }

  /* ---------- старт ---------- */
  Promise.all([
    fetch('data/seed.json').then(r => r.json()),
    fetch('data/items_extra.json').then(r => r.json()).catch(() => []),
    fetch('data/items_generated.json').then(r => r.json()).catch(() => []),
    fetch('data/preps.json').then(r => r.json()).catch(() => []),
    fetch('data/items_chunks_extra.json').then(r => r.json()).catch(() => [])
  ]).then(parts => {
    const seen = new Set(), data = [];
    parts.flat().concat(readJSON(K_CUSTOM) || []).forEach(x => { if (!seen.has(x.id)) { seen.add(x.id); data.push(x); } });
    ITEMS = data; BY_ID = Object.fromEntries(data.map(x => [x.id, x]));
    Object.keys(progress).forEach(id => { if (BY_ID[id]) E.migrate(progress[id], BY_ID[id]); });  // v2 → v3
    showMenu();
  }).catch(err => { app.innerHTML = `<div class="card">Не удалось загрузить слова: ${esc(String(err))}<br><span class="muted">Запусти через локальный сервер.</span></div>`; });

  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
})();
