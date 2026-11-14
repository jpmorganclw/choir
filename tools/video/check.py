"""Tightens long pauses, then transcribes every take and scores it against the script.

    python check.py [id ...]

Reads ~/.choir/video/voices-raw, writes the tightened takes to ~/.choir/video/voices and a report
to ~/.choir/video/voices.json. CHOIR_RAW and CHOIR_TAKES name other folders in ~/.choir/video,
for example CHOIR_RAW=voices-draft CHOIR_TAKES=voices-kokoro to check the Kokoro takes; the report
is then voices-kokoro.json and the cut uses it with CHOIR_VOICES=voices-kokoro.

Speech-to-text catches wrong words. It cannot judge how a voice sounds, so a person has to
listen.
"""

import json
import os
import re
import sys
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from faster_whisper import WhisperModel

HOME = Path(os.environ.get("CHOIR_VIDEO_HOME", Path.home() / ".choir" / "video"))
HERE = Path(__file__).parent
SCRIPT = json.loads((HERE / "script.json").read_text(encoding="utf-8"))
RAW = HOME / os.environ.get("CHOIR_RAW", "voices-raw")
TAKES = HOME / os.environ.get("CHOIR_TAKES", "voices")
LONGEST_PAUSE = 0.42


def tighten(source, target):
    """Shortens silences inside a line, and leaves sighs and small sounds alone."""
    audio, sr = sf.read(source, dtype="float32")
    frame = int(0.02 * sr)
    energy = np.sqrt(np.convolve(audio**2, np.ones(frame) / frame, mode="same"))
    quiet = energy < np.max(energy) * 0.012
    pieces, at, i = [], 0, 0
    while i < len(audio):
        if not quiet[i]:
            i += 1
            continue
        j = i
        while j < len(audio) and quiet[j]:
            j += 1
        if i > 0 and j < len(audio) and (j - i) / sr > LONGEST_PAUSE:
            half = int(LONGEST_PAUSE / 2 * sr)
            pieces.append(audio[at : i + half])
            at = j - half
        i = j
    pieces.append(audio[at:])
    fade = int(0.012 * sr)
    out = pieces[0]
    for piece in pieces[1:]:
        ramp = np.linspace(0.0, 1.0, fade)
        out[-fade:] = out[-fade:] * ramp[::-1] + piece[:fade] * ramp
        out = np.concatenate([out, piece[fade:]])
    sf.write(target, out, sr)


def words(text):
    text = text.lower().replace("’", "'").replace("n f t", "nft").replace("n.f.t.", "nft").replace("nfts", "nft")
    text = re.sub(r"<[^>]+>", " ", text)
    return re.findall(r"[a-z0-9']+", text)


def distance(a, b):
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, y in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (x != y))
    return row[-1]


def main(ids):
    TAKES.mkdir(parents=True, exist_ok=True)
    whisper = WhisperModel("Systran/faster-whisper-small.en", device="cpu", compute_type="int8")
    report_path = HOME / f"{TAKES.name}.json"
    report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else {}
    for line in [item for item in SCRIPT["lines"] if not ids or item["id"] in ids]:
        target = words(line["text"])
        for raw in sorted(RAW.glob(f"{line['id']}.*.wav")):
            if raw.stem in report and (TAKES / raw.name).exists():
                continue
            path = TAKES / raw.name
            tighten(raw, path)
            audio, sr = sf.read(path)
            segments, _ = whisper.transcribe(str(path), language="en", beam_size=5, vad_filter=False)
            heard = " ".join(s.text.strip() for s in segments)
            wer = distance(target, words(heard)) / max(1, len(target))
            f0, voiced, _ = librosa.pyin(audio.astype(np.float32), fmin=60, fmax=420, sr=sr, frame_length=2048)
            pitched = f0[voiced] if voiced.any() else np.array([0.0])
            spread = float(np.std(12 * np.log2(pitched / np.median(pitched)))) if voiced.any() else 0.0
            report[path.stem] = {
                "seconds": round(len(audio) / sr, 2),
                "wer": round(wer, 3),
                "heard": heard,
                "pitch_spread_semitones": round(spread, 2),
            }
            print(f"{path.stem}: {len(audio) / sr:.1f}s wer {wer:.2f} spread {spread:.1f} | {heard}", flush=True)
            report_path.write_text(json.dumps(report, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1:])
