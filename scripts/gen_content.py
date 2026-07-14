#!/usr/bin/env python3
"""
Этап 1, шаг 2: генерация контента на частотную базу (масштабируемый путь к 15k).

Берёт wordbase.csv, и для каждой леммы через Anthropic API генерирует Item в формате движка:
  { id, lemma, pos, freq_rank, ipa, is_irregular?, forms?, senses[]{gloss,pos,example}, usage? }
Пишет в data/items_generated.json. Резюмируемо (уже сгенерированные id пропускаются).

Требует:
  - переменную окружения ANTHROPIC_API_KEY
  - пакет anthropic:  ./.venv/bin/python -m pip install anthropic

Запуск (траншами по частоте):
  ./.venv/bin/python scripts/gen_content.py --limit 300            # первые 300 по частоте
  ./.venv/bin/python scripts/gen_content.py --start 300 --limit 300
  ./.venv/bin/python scripts/gen_content.py --dry-run --limit 3    # показать промпт без вызова API

Модель по умолчанию — Haiku (дёшево). Оценка: ~15k слов пакетами реально за несколько $ и часы.
"""
import argparse
import csv
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORDBASE = ROOT / "data" / "wordbase.csv"
OUT = ROOT / "data" / "items_generated.json"
MODEL = "claude-haiku-4-5-20251001"

SYSTEM = (
    "Ты лексикограф. По английской лемме выдай строго JSON-объект для тренажёра лексики, "
    "русские переводы. Только самые частотные значения (2-4), без экзотики. Формат:\n"
    '{"lemma","pos":"noun|verb|adjective|adverb","ipa","is_irregular":bool,'
    '"forms":{"past","pp"}(только для irregular verb),'
    '"senses":[{"gloss":"русский перевод","pos":"...","example":"короткое англ. предложение"}],'
    '"usage":"короткая заметка по-русски или пусто"}\n'
    "Верни ТОЛЬКО JSON, без markdown."
)


def load_done():
    if OUT.exists():
        try:
            return json.loads(OUT.read_text())
        except Exception:
            return []
    return []


def build_prompt(lemma, pos):
    return f"Лемма: {lemma}\nЧасть речи (подсказка): {pos}\nВыдай JSON."


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = list(csv.DictReader(WORDBASE.open()))
    chunk = rows[args.start: args.start + args.limit]

    done = load_done()
    done_ids = {x["id"] for x in done}

    if args.dry_run:
        for r in chunk[:3]:
            print("=== SYSTEM ===\n", SYSTEM)
            print("=== USER ===\n", build_prompt(r["lemma"], r["pos"]), "\n")
        print(f"(dry-run) обработал бы {len(chunk)} лемм, уже готово {len(done)}.")
        return

    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("Нет ANTHROPIC_API_KEY в окружении. export ANTHROPIC_API_KEY=... и повтори.")
    try:
        import anthropic
    except ImportError:
        sys.exit("Нет пакета anthropic. Поставь: ./.venv/bin/python -m pip install anthropic")

    client = anthropic.Anthropic(api_key=key)
    added = 0
    for r in chunk:
        lemma, pos, rank = r["lemma"], r["pos"], int(r["rank"])
        item_id = f"g_{lemma.replace(' ', '_')}"
        if item_id in done_ids:
            continue
        msg = client.messages.create(
            model=MODEL, max_tokens=700, system=SYSTEM,
            messages=[{"role": "user", "content": build_prompt(lemma, pos)}],
        )
        try:
            obj = json.loads(msg.content[0].text)
            obj["id"] = item_id
            obj["freq_rank"] = rank
            done.append(obj)
            done_ids.add(item_id)
            added += 1
        except Exception as e:
            print(f"  ! пропуск {lemma}: {e}")
        if added % 25 == 0 and added:
            OUT.write_text(json.dumps(done, ensure_ascii=False, indent=1))
            print(f"  …сохранено {len(done)}")

    OUT.write_text(json.dumps(done, ensure_ascii=False, indent=1))
    print(f"Готово: +{added}, всего {len(done)} -> {OUT}")


if __name__ == "__main__":
    main()
