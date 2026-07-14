#!/usr/bin/env python3
"""
Этап 1, шаг 1: собрать частотную базу одиночных слов.

Подход (полностью локальный, без платных сервисов):
  - частотно-ранжированный список английских слов  -> wordfreq
  - часть речи + лемматизация                       -> WordNet (NLTK)
  - служебные слова выброшены                        -> nltk stopwords
  - оставляем content words: noun / verb / adjective / adverb
  - словоформы схлопываем в лемму (run/runs/running -> run)
  - топ-N лемм по частоте, проставляем freq_rank

POS определяется по доминирующему значению слова в WordNet:
  сначала по частоте (lemma.count из SemCor), при нулях — по числу синсетов.
Это первый проход, помечаем для QA-ревью.

Результат: data/wordbase.csv  (rank, lemma, pos, zipf)
"""
import csv
from collections import Counter
from pathlib import Path

import nltk
from nltk.corpus import stopwords, wordnet as wn
from nltk.stem import WordNetLemmatizer
from wordfreq import top_n_list, zipf_frequency

TARGET = 15_000     # сколько content-лемм оставить
SCAN = 50_000       # сколько частотных токенов просканировать (с запасом)
MIN_ZIPF = 1.5      # отсечь совсем редкий шум

WN_TO_POS = {wn.NOUN: "noun", wn.VERB: "verb", wn.ADJ: "adjective", wn.ADV: "adverb"}
STOP = set(stopwords.words("english"))
LEM = WordNetLemmatizer()
OUT = Path(__file__).resolve().parent.parent / "data" / "wordbase.csv"


def dominant_pos(word: str):
    """Вернуть (wn_pos, lemma) по доминирующему значению слова или None."""
    by_count: Counter = Counter()
    by_syn: Counter = Counter()
    for wn_pos in (wn.NOUN, wn.VERB, wn.ADJ, wn.ADV):
        syns = wn.synsets(word, pos=wn_pos)
        if not syns:
            continue
        by_syn[wn_pos] = len(syns)
        for s in syns:
            for lm in s.lemmas():
                if lm.name().lower() == word:
                    by_count[wn_pos] += lm.count()
    if not by_syn:
        return None
    # доминирующая POS: по частоте, при нулях — по числу синсетов
    if sum(by_count.values()) > 0:
        wn_pos = by_count.most_common(1)[0][0]
    else:
        wn_pos = by_syn.most_common(1)[0][0]
    lemma = LEM.lemmatize(word, wn_pos).lower()
    return wn_pos, lemma


def main() -> None:
    print(f"Загружаю топ-{SCAN} частотных токенов…")
    tokens = top_n_list("en", SCAN)

    print("Размечаю по WordNet…")
    seen: dict[str, dict] = {}
    for word in tokens:
        if not word.isalpha() or len(word) < 2 or word in STOP:
            continue
        res = dominant_pos(word)
        if res is None:
            continue
        wn_pos, lemma = res
        if not lemma.isalpha() or len(lemma) < 2 or lemma in STOP:
            continue
        z = zipf_frequency(lemma, "en")
        if z < MIN_ZIPF:
            continue
        pos = WN_TO_POS[wn_pos]
        prev = seen.get(lemma)
        # дедуп по лемме: держим самую частотную форму/значение
        if prev is None or z > prev["zipf"]:
            seen[lemma] = {"lemma": lemma, "pos": pos, "zipf": round(z, 2)}

    rows = sorted(seen.values(), key=lambda r: r["zipf"], reverse=True)[:TARGET]
    for i, r in enumerate(rows, 1):
        r["rank"] = i

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["rank", "lemma", "pos", "zipf"])
        w.writeheader()
        for r in rows:
            w.writerow({k: r[k] for k in ("rank", "lemma", "pos", "zipf")})

    by_pos = Counter(r["pos"] for r in rows)
    print(f"\nГотово: {len(rows)} лемм -> {OUT}")
    print("По частям речи:", dict(by_pos))
    print("Топ-20 примеров:")
    for r in rows[:20]:
        print(f"  {r['rank']:>3}  {r['lemma']:<14} {r['pos']:<10} zipf={r['zipf']}")


if __name__ == "__main__":
    main()
