"""The film's voices, spoken by Orpheus: open weights that run on a CPU through llama.cpp.

    python voices.py [id ...]     speaks the lines in script.json into ~/.choir/video/voices

Every voice is one of the model's stock voices, so no real person's voice is copied.
"""

import json
import os
import sys
import time
from pathlib import Path

HOME = Path(os.environ.get("CHOIR_VIDEO_HOME", Path.home() / ".choir" / "video"))
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

import llama_cpp  # noqa: E402
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from orpheus_cpp import OrpheusCpp  # noqa: E402


class SmallContext(llama_cpp.Llama):
    """orpheus_cpp opens the model with n_ctx=0, which makes llama.cpp reserve the model's whole
    training context (131,072 tokens, about 15 GB of cache for this 3B model). One line needs at
    most max_tokens (2,400) plus its prompt, so 4,096 is plenty and needs about 0.5 GB."""

    def __init__(self, *args, **kwargs):
        if not kwargs.get("n_ctx"):
            kwargs["n_ctx"] = int(os.environ.get("TTS_CTX", "4096"))
        super().__init__(*args, **kwargs)


# orpheus_cpp imports Llama from llama_cpp when it is constructed, so this is the class it gets.
llama_cpp.Llama = SmallContext

HERE = Path(__file__).parent
SCRIPT = json.loads((HERE / "script.json").read_text(encoding="utf-8"))
OUT = HOME / "voices-raw"
SR = 24000
CAST = SCRIPT["cast"]


def tidy(audio):
    """Cuts only real silence, and leaves the small breaths at each end of a line."""
    frame = int(0.02 * SR)
    energy = np.sqrt(np.convolve(audio**2, np.ones(frame) / frame, mode="same"))
    loud = np.flatnonzero(energy > max(energy.max() * 0.012, 1e-4))
    start = max(0, loud[0] - int(0.09 * SR))
    end = min(len(audio), loud[-1] + int(0.14 * SR))
    audio = audio[start:end].copy()
    fade = int(0.02 * SR)
    ramp = np.linspace(0.0, 1.0, fade)
    audio[:fade] *= ramp
    audio[-fade:] *= ramp[::-1]
    return audio * (0.85 / (np.abs(audio).max() or 1.0))


def main(ids):
    OUT.mkdir(parents=True, exist_ok=True)
    started = time.time()
    engine = OrpheusCpp(verbose=False, lang="en", n_threads=int(os.environ.get("TTS_THREADS", "6")))
    print(f"model ready in {time.time() - started:.0f}s", flush=True)
    by_id = {line["id"]: line for line in SCRIPT["lines"]}
    for line in [by_id[i] for i in ids] if ids else SCRIPT["lines"]:
        text = line.get("human", line["text"])
        for take in range(line.get("takes", 2)):
            path = OUT / f"{line['id']}.{take}.wav"
            if path.exists():
                continue
            began = time.time()
            options = {"voice_id": CAST[line["voice"]], "temperature": 0.72 + 0.06 * take, "top_p": 0.95, "max_tokens": 2400}
            _, samples = engine.tts(text, options=options)
            audio = tidy(np.asarray(samples, dtype=np.float32).squeeze() / 32768.0)
            sf.write(path, audio, SR)
            print(f"{line['id']}.{take}: {len(audio) / SR:.1f}s audio in {time.time() - began:.0f}s", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
