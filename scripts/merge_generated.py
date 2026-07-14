#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Мерж сгенерированных батчей (data/gen/*.json) в data/items_generated.json.
Валидация, дедуп по id/lemma против всех источников, фикс примеров без леммы.
Идемпотентен — можно гонять после каждой волны. Запуск: python3 scripts/merge_generated.py
"""
import json, glob, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = lambda *p: os.path.join(ROOT, "data", *p)

exist_ids, exist_lemmas = set(), set()
for f in ["seed.json", "items_extra.json", "preps.json", "items_chunks_extra.json"]:
    for it in json.load(open(D(f))):
        exist_ids.add(it["id"]); exist_lemmas.add(it.get("lemma", "").lower())

try:
    merged = json.load(open(D("items_generated.json")))
except Exception:
    merged = []
seen_ids = {x["id"] for x in merged}
seen_lemmas = {x["lemma"].lower() for x in merged}

added, dropped, broken = 0, [], []
for f in sorted(glob.glob(D("gen", "*.json"))):
    try:
        batch = json.load(open(f))
        assert isinstance(batch, list)
    except Exception as e:
        broken.append(f"{os.path.basename(f)}: {e}")
        continue
    for x in batch:
        lid, lm = x.get("id"), (x.get("lemma") or "").lower()
        if not lid or not lm or not x.get("senses") or not isinstance(x["senses"], list):
            dropped.append(f"{lm or '?'}(malformed)"); continue
        if lid in seen_ids or lid in exist_ids or lm in seen_lemmas or lm in exist_lemmas:
            dropped.append(f"{lm}(dup)"); continue
        bad_sense = False
        for s in x["senses"]:
            if not s.get("gloss") or not s.get("example"):
                bad_sense = True; break
            if lm not in s["example"].lower():
                fix = next((a for a in s.get("examples_alt", []) if lm in a.lower()), None)
                if fix:
                    s["examples_alt"][s["examples_alt"].index(fix)] = s["example"]
                    s["example"] = fix
                # если не нашли — оставляем как есть: exContext переживёт, отметим в отчёте
        if bad_sense:
            dropped.append(f"{lm}(empty sense)"); continue
        if x.get("is_irregular") and not (x.get("forms", {}).get("past") and x.get("forms", {}).get("pp")):
            x.pop("is_irregular", None); x.pop("forms", None)   # лучше без оси форм, чем с битой
        seen_ids.add(lid); seen_lemmas.add(lm); merged.append(x); added += 1
    os.rename(f, f + ".done")   # обработанный батч не мержится повторно

merged.sort(key=lambda x: x.get("freq_rank", 9999))
json.dump(merged, open(D("items_generated.json"), "w"), ensure_ascii=False, indent=1)

no_lemma = sum(1 for x in merged for s in x["senses"] if x["lemma"].lower() not in s["example"].lower())
print(f"+{added} новых | всего в items_generated.json: {len(merged)} | всего слов в приложении: {len(merged) + len(exist_ids)}")
if dropped: print(f"отброшено {len(dropped)}: {', '.join(dropped[:15])}{'...' if len(dropped) > 15 else ''}")
if broken: print("БИТЫЕ ФАЙЛЫ:", "; ".join(broken))
if no_lemma: print(f"примеров без леммы (жить можно): {no_lemma}")
