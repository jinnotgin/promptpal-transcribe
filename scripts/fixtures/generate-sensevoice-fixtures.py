"""Regenerate the SenseVoice front-end parity fixture used by Vitest.

Covers the fbank sherpa-onnx feeds SenseVoice (kaldi-native-fbank with the
options OfflineRecognizerSenseVoiceImpl sets: Hamming window, Nyquist mel
ceiling, snip_edges, samples at int16 scale).
Requires: numpy, kaldi-native-fbank==1.22.3. Run with:

    python scripts/fixtures/generate-sensevoice-fixtures.py
"""

import base64
import json
from pathlib import Path

import kaldi_native_fbank as knf
import numpy as np

OUT = Path(__file__).resolve().parents[2] / "src/features/transcription/lib/__fixtures__"


def b64(array):
    return base64.b64encode(np.ascontiguousarray(array, dtype=np.float32).tobytes()).decode()


def sensevoice_fbank(pcm):
    opts = knf.FbankOptions()
    opts.frame_opts.dither = 0
    opts.frame_opts.snip_edges = True
    opts.frame_opts.samp_freq = 16000
    opts.frame_opts.frame_shift_ms = 10
    opts.frame_opts.frame_length_ms = 25
    opts.frame_opts.remove_dc_offset = True
    opts.frame_opts.preemph_coeff = 0.97
    opts.frame_opts.window_type = "hamming"
    opts.frame_opts.round_to_power_of_two = True
    opts.mel_opts.num_bins = 80
    opts.mel_opts.low_freq = 20
    opts.mel_opts.high_freq = 0
    opts.mel_opts.is_librosa = False
    fbank = knf.OnlineFbank(opts)
    # normalize_samples = 0 in the model metadata: int16-scale input.
    fbank.accept_waveform(16000, (pcm * 32768).tolist())
    fbank.input_finished()
    return np.stack([fbank.get_frame(i) for i in range(fbank.num_frames_ready)])


if __name__ == "__main__":
    rng = np.random.default_rng(17)
    n = 16000 * 3 // 4 + 53
    t = np.arange(n) / 16000
    pcm = (0.3 * np.sin(2 * np.pi * 330 * t) * (t > 0.15) + 0.02 * rng.standard_normal(n)).astype(np.float32)
    features = sensevoice_fbank(pcm)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "senseVoiceFbank.fixture.json").write_text(
        json.dumps({"pcm": b64(pcm), "frames": int(features.shape[0]), "bins": 80, "features": b64(features)})
    )
    print("fbank frames", features.shape)
