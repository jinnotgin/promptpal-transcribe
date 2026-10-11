"""Regenerate the sherpa-onnx diarization parity fixtures used by Vitest.

Covers the speaker-embedding fbank (kaldi-native-fbank with sherpa-onnx's
options) and sherpa-onnx's complete-linkage clustering.
Requires: numpy, kaldi-native-fbank==1.22.3, sherpa-onnx. Run with:

    python scripts/fixtures/generate-sherpa-fixtures.py
"""

import base64
import json
from pathlib import Path

import kaldi_native_fbank as knf
import numpy as np
import sherpa_onnx

OUT = Path(__file__).resolve().parents[2] / "src/features/transcription/lib/__fixtures__"


def b64(array):
    return base64.b64encode(np.ascontiguousarray(array, dtype=np.float32).tobytes()).decode()


def sherpa_fbank(pcm):
    # sherpa-onnx FeatureExtractorConfig defaults for speaker embeddings.
    opts = knf.FbankOptions()
    opts.frame_opts.dither = 0
    opts.frame_opts.snip_edges = False
    opts.frame_opts.samp_freq = 16000
    opts.frame_opts.frame_shift_ms = 10
    opts.frame_opts.frame_length_ms = 25
    opts.frame_opts.remove_dc_offset = True
    opts.frame_opts.preemph_coeff = 0.97
    opts.frame_opts.window_type = "povey"
    opts.frame_opts.round_to_power_of_two = True
    opts.mel_opts.num_bins = 80
    opts.mel_opts.low_freq = 20
    opts.mel_opts.high_freq = -400
    opts.mel_opts.is_librosa = False
    fbank = knf.OnlineFbank(opts)
    fbank.accept_waveform(16000, pcm.tolist())
    fbank.input_finished()
    return np.stack([fbank.get_frame(i) for i in range(fbank.num_frames_ready)])


def clustering_case(rng, clusters, per_cluster, dim, noise):
    centres = rng.standard_normal((clusters, dim))
    points = np.concatenate([c + noise * rng.standard_normal((per_cluster, dim)) for c in centres])
    points = points[rng.permutation(len(points))].astype(np.float32)
    by_count = sherpa_onnx.FastClustering(sherpa_onnx.FastClusteringConfig(num_clusters=clusters))(points.copy())
    by_threshold = sherpa_onnx.FastClustering(sherpa_onnx.FastClusteringConfig(threshold=0.5))(points.copy())
    return {
        "rows": int(points.shape[0]),
        "dim": dim,
        "clusters": clusters,
        "points": b64(points),
        "labelsByCount": [int(x) for x in by_count],
        "labelsByThreshold": [int(x) for x in by_threshold],
    }


if __name__ == "__main__":
    rng = np.random.default_rng(11)
    n = 16000 * 3 // 4 + 37
    t = np.arange(n) / 16000
    pcm = (0.3 * np.sin(2 * np.pi * 220 * t) * (t > 0.2) + 0.02 * rng.standard_normal(n)).astype(np.float32)
    features = sherpa_fbank(pcm)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "sherpaFbank.fixture.json").write_text(
        json.dumps({"pcm": b64(pcm), "frames": int(features.shape[0]), "bins": 80, "features": b64(features)})
    )
    cases = [clustering_case(rng, 3, 7, 16, 0.35), clustering_case(rng, 9, 6, 24, 0.9), clustering_case(rng, 12, 5, 32, 1.4)]
    (OUT / "sherpaClustering.fixture.json").write_text(json.dumps({"cases": cases}))
    print("fbank frames", features.shape, "clustering", [(c["rows"], c["clusters"]) for c in cases])
