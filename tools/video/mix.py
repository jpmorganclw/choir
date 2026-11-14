"""Writes the film's score and mixes it under the voices.

    python mix.py        reads timeline.json, writes ~/.choir/video/mix.wav

The music is generated here note by note, so there is nothing to license: a soft bed of sung-like
tones (it is a film about a choir) and a few felt-piano notes on top.
"""

import json
import os
import subprocess
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy.ndimage import uniform_filter1d
from scipy.signal import butter, fftconvolve, sosfilt

HOME = Path(os.environ.get("CHOIR_VIDEO_HOME", Path.home() / ".choir" / "video"))
HERE = Path(__file__).parent
SR = 48000
BEAT = 60.0 / 72.0
BAR = 4 * BEAT
rng = np.random.default_rng(23)
NAMES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def hz(note):
    pitch = NAMES[note[0]]
    rest = note[1:]
    if rest.startswith("b"):
        pitch -= 1
        rest = rest[1:]
    elif rest.startswith("#"):
        pitch += 1
        rest = rest[1:]
    return 440.0 * 2 ** ((pitch + (int(rest) + 1) * 12 - 69) / 12)


def piano(freq, seconds, velocity):
    """A soft felt piano: a few decaying partials, a slow attack and no bright overtones."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    top = 7 if freq < 400 else 5
    for k in range(1, top + 1):
        partial = k * freq * np.sqrt(1 + 0.00035 * k * k)
        if partial > 4200:
            break
        decay = (1.5 + 0.55 * k) * (freq / 262.0) ** 0.35
        for detune in (0.9994, 1.0006):
            out += (k ** -1.75) * np.sin(2 * np.pi * partial * detune * t) * np.exp(-t * decay)
    attack = 1 - np.exp(-t / (0.016 - 0.008 * min(1.0, velocity)))
    release = np.minimum(1.0, (seconds - t) / 0.12)
    return out * attack * release * velocity


def voice(freq, seconds, velocity):
    """One sung-like tone: a handful of slightly detuned singers on an open vowel, swelling in and out."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for _ in range(5):
        detune = 1 + rng.normal(0, 0.0022)
        rate = 4.6 + rng.normal(0, 0.5)
        # Vibrato of about a fifth of a semitone that arrives late, as it does when people hold a note.
        depth = 0.011 * (1 - np.exp(-t / 0.9))
        phase = 2 * np.pi * freq * detune * t + (freq * detune * depth / rate) * np.sin(2 * np.pi * rate * t + rng.uniform(0, 6.28))
        tone = np.zeros(n)
        for k in range(1, 9):
            # An "ah": energy near 700 Hz and 1100 Hz, little above.
            f = k * freq
            gain = np.exp(-((f - 700) / 420) ** 2) + 0.55 * np.exp(-((f - 1150) / 380) ** 2) + 0.25 / k
            tone += gain * np.sin(k * phase + rng.uniform(0, 6.28))
        out += tone
    swell = np.minimum(1.0, t / 1.3) * np.minimum(1.0, (seconds - t) / 1.6)
    return out / 5 * np.clip(swell, 0, 1) ** 1.5 * velocity


# One key throughout (D major), so the film feels like one piece. The opening leans on its minor side.
WORRY = [("B2", ["F#3", "B3", "D4"]), ("G2", ["D3", "G3", "B3"]), ("D3", ["A3", "D4", "F#4"]), ("A2", ["E3", "A3", "C#4"])]
IDEA = [("D3", ["A3", "D4", "F#4"]), ("A2", ["E3", "A3", "C#4"]), ("B2", ["F#3", "B3", "D4"]), ("G2", ["D3", "G3", "B3"])]
BRIGHT = [("G2", ["D3", "B3", "D4", "G4"]), ("D3", ["A3", "F#4", "A4"]), ("A2", ["E3", "C#4", "E4"]), ("B2", ["F#3", "D4", "F#4"])]
RESOLVE = [("G2", ["D3", "G3", "B3", "D4"]), ("A2", ["E3", "A3", "C#4", "E4"]), ("D3", ["A3", "D4", "F#4", "A4"])]


def score(duration, cues):
    """Returns the piano notes and the sung chords for the whole film."""
    notes, chords = [], []
    sections = [
        (0.0, cues["idea"], WORRY, 0.30, 1, 0.55),
        (cues["idea"], cues["work"], IDEA, 0.36, 1, 0.8),
        (cues["work"], cues["paid"], IDEA, 0.40, 2, 0.7),
        (cues["paid"], cues["handover"], BRIGHT, 0.46, 3, 0.9),
        (cues["handover"], cues["matters"], IDEA, 0.38, 2, 0.75),
        (cues["matters"], cues["end"] - BAR, BRIGHT, 0.44, 2, 1.0),
        (cues["end"] - BAR, duration, RESOLVE, 0.48, 3, 1.1),
    ]
    for start, end, progression, level, density, choir in sections:
        bar = 0
        t = start
        while t < end - 0.2:
            bass, walk = progression[bar % len(progression)]
            human = lambda: float(rng.normal(0, 0.012))  # noqa: E731
            notes.append((t + human(), bass, level * 0.8, BAR * 1.6))
            steps = {1: [2], 2: [1, 2.5], 3: [1, 2, 3]}[density]
            for i, beat in enumerate(steps):
                note = walk[min(i + (len(walk) - len(steps)), len(walk) - 1)]
                when = t + beat * BEAT + human()
                if when < end:
                    notes.append((when, note, level * (0.6 + 0.08 * i), BAR * 1.2))
            # The choir holds the chord for the whole bar and overlaps into the next.
            for note in walk[:3]:
                chords.append((t, note, 0.5 * choir, BAR + 1.6))
            t += BAR
            bar += 1
    return notes, chords


def render_music(duration, cues):
    notes, chords = score(duration, cues)
    keys = np.zeros(int((duration + 8) * SR))
    sung = np.zeros(int((duration + 8) * SR))
    for start, note, velocity, length in notes:
        tone = piano(hz(note), length, velocity)
        at = max(0, int(start * SR))
        end = min(len(keys), at + len(tone))
        keys[at:end] += tone[: end - at]
    for start, note, velocity, length in chords:
        tone = voice(hz(note), length, velocity)
        at = max(0, int(start * SR))
        end = min(len(sung), at + len(tone))
        sung[at:end] += tone[: end - at]
    sung = sosfilt(butter(2, [180, 2400], "band", fs=SR, output="sos"), sung)
    sung /= np.max(np.abs(sung)) or 1.0
    keys /= np.max(np.abs(keys)) or 1.0
    track = 0.8 * keys + 0.42 * sung
    tail = int(2.6 * SR)
    ir = rng.standard_normal(tail) * np.exp(-np.arange(tail) / (0.62 * SR))
    ir = sosfilt(butter(2, 2400, "low", fs=SR, output="sos"), ir)
    ir /= np.sqrt(np.sum(ir**2))
    wet = fftconvolve(track, ir)[: len(track)]
    mixed = 0.7 * track + 0.5 * wet
    mixed = sosfilt(butter(2, 70, "high", fs=SR, output="sos"), mixed)
    mixed = sosfilt(butter(2, 5000, "low", fs=SR, output="sos"), mixed)
    return mixed[: int(duration * SR)] / (np.max(np.abs(mixed)) or 1.0)


def master():
    """Two-pass loudness matching, so the whole film moves by one fixed gain and stays natural."""
    ffmpeg = os.environ["FFMPEG"]
    target = "I=-16:TP=-1.5:LRA=11"
    raw = str(HOME / "mix.raw.wav")
    first = subprocess.run([ffmpeg, "-hide_banner", "-nostats", "-i", raw, "-af", f"loudnorm={target}:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
    m = json.loads(first[first.rindex("{"): first.rindex("}") + 1])
    settings = f"{target}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
    subprocess.run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", raw, "-af", f"loudnorm={settings},aresample=48000", "-c:a", "pcm_s24le", str(HOME / "mix.wav")], check=True)
    print(f"measured {m['input_i']} LUFS, true peak {m['input_tp']}")


def main():
    timeline = json.loads((HERE / "timeline.json").read_text(encoding="utf-8"))
    duration = timeline["duration"]
    takes = HOME / timeline.get("voices", "voices")
    length = int(duration * SR)
    voices = np.zeros(length)
    speaker_rms = {}
    for line in timeline["lines"]:
        audio, _ = sf.read(takes / f"{line['id']}.{line['take']}.wav")
        speaker_rms.setdefault(line["voice"], []).append(float(np.sqrt(np.mean(audio[np.abs(audio) > 0.02] ** 2))))
    speaker_gain = {name: min(0.135 / float(np.mean(values)), 4.0) for name, values in speaker_rms.items()}
    for line in timeline["lines"]:
        audio, sr = sf.read(takes / f"{line['id']}.{line['take']}.wav")
        audio = librosa.resample(audio.astype(np.float32), orig_sr=sr, target_sr=SR) * speaker_gain[line["voice"]]
        at = int(line["at"] * SR)
        end = min(length, at + len(audio))
        voices[at:end] += audio[: end - at]

    # A little of a small room around the voices, so they sound spoken rather than pasted in.
    tail = int(0.42 * SR)
    room = rng.standard_normal(tail) * np.exp(-np.arange(tail) / (0.085 * SR))
    room = sosfilt(butter(2, [280, 5200], "band", fs=SR, output="sos"), room)
    room /= np.sqrt(np.sum(room**2))
    voices = voices + 0.1 * fftconvolve(voices, room)[:length]

    # The music steps back under speech and comes forward in the gaps.
    active = np.abs(voices) > 0.012
    window = int(0.35 * SR)
    held = uniform_filter1d(active.astype(float), size=window, mode="nearest")
    speaking = uniform_filter1d(np.clip(held * 6.0, 0.0, 1.0), size=window, mode="nearest")
    music = render_music(duration, timeline["cues"])
    gain = 0.26 + (0.055 - 0.26) * speaking
    ramp = int(1.4 * SR)
    gain[:ramp] *= np.linspace(0.0, 1.0, ramp)
    gain[-int(1.6 * SR):] *= np.linspace(1.0, 0.0, int(1.6 * SR))
    mixed = voices + music * gain
    peak = float(np.max(np.abs(mixed)))
    mixed = mixed * (0.89 / peak)
    sf.write(HOME / "mix.raw.wav", np.column_stack([mixed, mixed]), SR, subtype="PCM_24")
    master()
    print(f"duration {duration:.1f}s, peak was {peak:.2f}")


if __name__ == "__main__":
    main()
