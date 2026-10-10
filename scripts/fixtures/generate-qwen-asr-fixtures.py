"""Regenerate the Qwen3-ASR log-mel parity fixture used by Vitest.

Qwen3-ASR uses Whisper's 128-bin feature extractor without 30 s padding.
Requires: numpy, transformers. Run with:

    python scripts/fixtures/generate-qwen-asr-fixtures.py
"""

import base64
import json
from pathlib import Path

import numpy as np
from transformers import WhisperFeatureExtractor

OUT = Path(__file__).resolve().parents[2] / "src/features/transcription/lib/__fixtures__"


def b64(array):
    return base64.b64encode(np.ascontiguousarray(array, dtype=np.float32).tobytes()).decode()


if __name__ == "__main__":
    rng = np.random.default_rng(5)
    n = 16000 * 3 // 4 + 91
    t = np.arange(n) / 16000
    pcm = (0.4 * np.sin(2 * np.pi * 300 * t) * (t > 0.3) + 0.01 * rng.standard_normal(n)).astype(np.float32)
    extractor = WhisperFeatureExtractor(feature_size=128)
    features = extractor(pcm, sampling_rate=16000, padding="longest", return_tensors="np").input_features[0]
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "qwenAsrFeatures.fixture.json").write_text(
        json.dumps({"pcm": b64(pcm), "frames": int(features.shape[1]), "melBins": 128, "features": b64(features)})
    )
    print("frames", features.shape, "samples", n)
