"""Voices spoken by Kokoro, a small open model that is fast on a CPU.

    python draft_voices.py [id ...]

Writes one take per line to ~/.choir/video/voices-draft and a report to voices-draft.json, in the
same shape check.py writes. With ids, only those lines are spoken again. Run check.py on them
(CHOIR_RAW=voices-draft CHOIR_TAKES=voices-kokoro) to tighten pauses and score the words; the cut
then uses them with CHOIR_VOICES=voices-kokoro. voices.py makes Orpheus takes instead, which need
a few GB of free memory.
"""

import json
import os
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

HOME = Path(os.environ.get("CHOIR_VIDEO_HOME", Path.home() / ".choir" / "video"))
MODELS = Path(os.environ.get("KOKORO_HOME", Path.home() / ".choir" / "video" / "kokoro"))
HERE = Path(__file__).parent
SCRIPT = json.loads((HERE / "script.json").read_text(encoding="utf-8"))
OUT = HOME / "voices-draft"
CAST = {"asha": ("af_heart", 0.98), "maya": ("af_bella", 1.02), "narrator": ("am_michael", 0.98), "sam": ("am_onyx", 1.0)}


def engine():
    import onnxruntime as rt
    from kokoro_onnx import Kokoro

    class Renamed:
        """This export of the model names its first input `input_ids` and adds a batch dimension."""

        def __init__(self, session):
            self.session = session
            self._model_path = session._model_path

        def run(self, names, inputs):
            renamed = dict(inputs)
            renamed["input_ids"] = np.array(renamed.pop("tokens"), dtype=np.int64)
            return [np.squeeze(self.session.run(names, renamed)[0])]

    model = (MODELS / "model_path.txt").read_text(encoding="utf-8").strip()
    session = Renamed(rt.InferenceSession(model, providers=["CPUExecutionProvider"]))
    return Kokoro.from_session(session, str(MODELS / "voices.json"))


def main(ids):
    OUT.mkdir(parents=True, exist_ok=True)
    kokoro = engine()
    report_path = HOME / "voices-draft.json"
    report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() and ids else {}
    for line in [item for item in SCRIPT["lines"] if not ids or item["id"] in ids]:
        voice, speed = CAST[line["voice"]]
        text = re.sub(r"<[^>]+>", "", line.get("human", line["text"])).replace("N F T", "NFT").strip()
        samples, sr = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
        audio = np.asarray(samples, dtype=np.float32)
        loud = np.flatnonzero(np.abs(audio) > 0.01)
        audio = audio[max(0, loud[0] - int(0.05 * sr)) : loud[-1] + int(0.12 * sr)]
        audio = audio * (0.85 / (np.abs(audio).max() or 1.0))
        sf.write(OUT / f"{line['id']}.0.wav", audio, sr)
        report[f"{line['id']}.0"] = {"seconds": round(len(audio) / sr, 2), "wer": 0.0, "heard": "(draft)", "pitch_spread_semitones": 0.0}
        print(f"{line['id']}: {len(audio) / sr:.1f}s", flush=True)
    report_path.write_text(json.dumps(report, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1:])
