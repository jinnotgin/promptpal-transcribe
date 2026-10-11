"""Regenerate the Qwen3-ForcedAligner text and timestamp fixtures used by Vitest.

Covers the aligner's word splitting, the Qwen2 BPE token ids of its prompt
(with a vocab/merges subset sufficient for the test words) and the
timestamp repair in `parse_timestamp`.
Requires: qwen-asr==0.0.6 and a local copy of Qwen/Qwen3-ForcedAligner-0.6B
(tokenizer files only). Run with:

    python scripts/fixtures/generate-qwen-aligner-fixtures.py <model_dir>
"""

import json
import sys
from pathlib import Path

import numpy as np
from qwen_asr.inference.qwen3_forced_aligner import Qwen3ForceAlignProcessor
from transformers import AutoTokenizer

OUT = Path(__file__).resolve().parents[2] / "src/features/transcription/lib/__fixtures__"

TEXTS = [
    "大家早上好，今天我们来讨论一下下个月的活动安排。",
    "这个 budget 够不够我们办一个 workshop？",
    "那我们下周一之前把 proposal 发给大家，好吗？",
    "OK, so the U.S. team's Q3 numbers—about 3,000 dollars—don't add up!",
    "Ｗi-Fi 密码是 abc123，记得 e-mail 给我 😀 谢谢",
    "  ",
]


def main(model_dir):
    aligner = Qwen3ForceAlignProcessor()
    tokenizer = AutoTokenizer.from_pretrained(model_dir, fix_mistral_regex=True)
    cases = []
    used = set()
    for text in TEXTS:
        words, prompt = aligner.encode_timestamp(text, "Chinese")
        ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
        cases.append({"text": text, "words": words, "promptIds": ids})
        used.update(ids)

    # Keep only the merges BPE applies to the test words (with their ranks):
    # with those, greedy lowest-rank merging takes the same path.
    vocab = tokenizer.get_vocab()
    merges = [line for line in Path(model_dir, "merges.txt").read_text("utf-8").splitlines() if line and not line.startswith("#")]
    ranks = {tuple(m.split(" ")): rank for rank, m in enumerate(merges)}
    applied = {}
    tokens = set()
    pre = tokenizer.backend_tokenizer.pre_tokenizer
    for case in cases:
        for word in case["words"]:
            for piece, _ in pre.pre_tokenize_str(word):
                symbols = list(piece)
                tokens.update(symbols)
                while len(symbols) > 1:
                    pairs = [(ranks.get((a, b), 1 << 30), i) for i, (a, b) in enumerate(zip(symbols, symbols[1:]))]
                    rank, i = min(pairs)
                    if rank == 1 << 30:
                        break
                    applied[rank] = merges[rank]
                    symbols[i : i + 2] = [symbols[i] + symbols[i + 1]]
                    tokens.add(symbols[i])
    kept = [[rank, applied[rank]] for rank in sorted(applied)]
    sub_vocab = {t: vocab[t] for t in sorted(tokens) if t in vocab}

    rng = np.random.default_rng(7)
    repairs = []
    for length in (6, 10, 16, 24):
        base = np.sort(rng.integers(0, 400, length)).astype(float)
        noisy = base.copy()
        for index in rng.choice(length, size=max(1, length // 4), replace=False):
            noisy[index] = rng.integers(0, 400)
        repairs.append({"input": noisy.tolist(), "output": aligner.fix_timestamp(noisy)})

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "qwenAligner.fixture.json").write_text(
        json.dumps({"cases": cases, "vocab": sub_vocab, "merges": kept, "repairs": repairs}, ensure_ascii=False)
    )
    print("cases", len(cases), "merges", len(kept), "vocab", len(sub_vocab))


if __name__ == "__main__":
    main(sys.argv[1])
