"""Regenerate the Nemotron diarization parity fixtures used by Vitest.

Requires: torch, numpy, librosa, transformers>=5.19 (Nemotron3Diarization), and a
local copy of the nvidia/Nemotron-3-Diarization processor config. Run with:

    python scripts/fixtures/generate-nemotron-fixtures.py <processor_dir>
"""

import base64
import json
import math
import sys
from pathlib import Path

import numpy as np
import torch
from transformers import AutoProcessor
from transformers.models.nemotron3_diarization.configuration_nemotron3_diarization import (
    Nemotron3DiarizationStreamingConfig,
)
from transformers.models.nemotron3_diarization.modeling_nemotron3_diarization import (
    Nemotron3DiarizationSpeakerCache,
)

OUT = Path(__file__).resolve().parents[2] / "src/features/transcription/lib/__fixtures__"


def b64(array):
    return base64.b64encode(np.ascontiguousarray(array, dtype=np.float32).tobytes()).decode()


def feature_fixture(processor_dir):
    processor = AutoProcessor.from_pretrained(processor_dir)
    rng = np.random.default_rng(7)
    n = 16000 * 3 // 4 + 37
    t = np.arange(n) / 16000
    pcm = (0.3 * np.sin(2 * np.pi * 180 * t) * (t > 0.2) + 0.02 * rng.standard_normal(n)).astype(np.float32)
    inputs = processor.feature_extractor(pcm, sampling_rate=16000, return_tensors="pt")
    valid = int(inputs["attention_mask"][0].sum())
    features = inputs["input_features"][0, :valid].numpy()
    return {"pcm": b64(pcm), "frames": valid, "melBins": 128, "features": b64(features)}


def cache_fixture():
    config = Nemotron3DiarizationStreamingConfig(
        num_speakers=4,
        speaker_cache_length=16,
        fifo_length=6,
        speaker_cache_update_period=5,
        speaker_cache_silence_frames_per_speaker=1,
    )
    cache = Nemotron3DiarizationSpeakerCache(config)
    hidden, sub = 3, config.subsampling_factor
    rng = np.random.default_rng(11)
    silence = torch.tensor(rng.standard_normal(hidden), dtype=torch.float32)
    steps = []
    for step, chunk_frames in enumerate([4, 5, 3, 6, 7, 5, 6, 4]):
        lookahead = 2 if step < 7 else 0
        cached = cache.get_embeds(torch.zeros(1, 1, hidden)) if cache.is_initialized else torch.zeros(1, 0, hidden)
        chunk = torch.tensor(rng.standard_normal((1, chunk_frames + lookahead, hidden)), dtype=torch.float32)
        inputs = torch.cat([cached, chunk], 1)
        logits = torch.tensor(rng.standard_normal((1, inputs.shape[1] * sub, config.num_speakers)) * 3, dtype=torch.float32)
        mask = torch.ones(1, inputs.shape[1], dtype=torch.bool)
        if step == 7:
            mask[:, -1] = False
        cache.update(inputs, logits, silence, chunk_frames, mask=mask)
        steps.append(
            {
                "cachedFrames": cached.shape[1],
                "chunkFrames": chunk_frames,
                "inputEmbeds": b64(inputs[0]),
                "inputFrames": inputs.shape[1],
                "logits": b64(logits[0]),
                "mask": mask[0].int().tolist(),
                "expected": {
                    "numCacheFrames": cache.num_cache_frames,
                    "numFifoFrames": cache.num_fifo_frames,
                    "isCompressed": cache.is_compressed,
                    "embeds": b64(cache.embeds[0, : cache.num_cache_frames]),
                    "probs": b64(cache.probs[0, : cache.num_cache_frames]),
                    "fifo": b64(cache.fifo[0, : cache.num_fifo_frames]),
                },
            }
        )
    return {
        "config": {
            "numSpeakers": config.num_speakers,
            "speakerCacheLength": config.speaker_cache_length,
            "fifoLength": config.fifo_length,
            "speakerCacheUpdatePeriod": config.speaker_cache_update_period,
            "silenceFramesPerSpeaker": config.speaker_cache_silence_frames_per_speaker,
            "predictionScoreThreshold": config.prediction_score_threshold,
            "latestFramesScoreBoost": config.latest_frames_score_boost,
            "minPositiveScoresRate": config.min_positive_scores_rate,
            "strongBoostRate": config.strong_boost_rate,
            "weakBoostRate": config.weak_boost_rate,
            "subsamplingFactor": sub,
            "hiddenSize": hidden,
        },
        "silence": b64(silence),
        "steps": steps,
    }


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "nemotronFeatures.fixture.json").write_text(json.dumps(feature_fixture(sys.argv[1])))
    (OUT / "nemotronSpeakerCache.fixture.json").write_text(json.dumps(cache_fixture()))
    print("wrote fixtures to", OUT)
