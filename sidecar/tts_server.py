"""JARVIS voice helper: offline text-to-speech with Kokoro (Apache-2.0 weights), British male voices.

Started and owned by the desktop app. Protocol: one JSON object per line.
  in : {"id": 1, "text": "...", "voice": "bm_george", "speed": 1.0}
  out: {"ready": true, "voices": [...], "loadMs": 3400}                       (once, at start)
       {"id": 1, "seq": 0, "sr": 24000, "pcm": "<base64 int16 LE>", "text": "..."}   (one per chunk)
       {"id": 1, "done": true}  or  {"id": 1, "error": "..."}
Speech is produced sentence by sentence so the app can start playing the first part while the rest is made.
Nothing is written to disk. Text pronunciation uses espeak-ng via phonemizer (GPL-3.0), inside this process only.
"""
import base64
import json
import os
import re
import sys
import time

MODELS = os.environ.get("JARVIS_MODELS", os.path.join(os.path.dirname(__file__), "..", "models"))
MODEL = os.path.join(MODELS, "kokoro", "kokoro-v1.0.int8.onnx")
VOICES = os.path.join(MODELS, "kokoro", "voices-v1.0.bin")
MAX_CHARS = 2000


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def chunks(text, first_max=9):
    """Sentences, with the very first piece kept short (split at a comma or dash) so speech starts quickly;
    long later sentences are split at commas into pieces of up to 26 words."""
    parts = [p.strip() for p in re.split(r"(?<=[.!?;:])\s+", text.strip()) if p.strip()]
    if first_max and parts and len(parts[0].split()) > first_max:
        first = parts[0]
        best = None
        for m in re.finditer(r"[,—–;]|\s-\s", first):
            n = len(first[:m.end()].split())
            if 3 <= n <= first_max + 3:
                best = m.end()
        if best is None:  # no natural break: cut after `first_max` words
            words = first.split()
            head, tail = " ".join(words[:first_max]), " ".join(words[first_max:])
        else:
            head, tail = first[:best].strip(" -"), first[best:].strip(" -")
        parts[0:1] = [p for p in (head, tail) if p]
    out = []
    for p in parts:
        words = p.split()
        if len(words) <= 26:
            out.append(p)
            continue
        cur = []
        for piece in re.split(r"(?<=,)\s+", p):
            if cur and len(" ".join(cur + [piece]).split()) > 26:
                out.append(" ".join(cur))
                cur = []
            cur.append(piece)
        if cur:
            out.append(" ".join(cur))
    return out


def main():
    t0 = time.time()
    import numpy as np
    import onnxruntime as ort
    from kokoro_onnx import Kokoro

    opts = ort.SessionOptions()
    # Whole CPU: the app never runs the language model while the voice is being made.
    opts.intra_op_num_threads = min(4, os.cpu_count() or 4)
    opts.inter_op_num_threads = 1
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(MODEL, opts, providers=["CPUExecutionProvider"])
    kokoro = Kokoro.from_session(session, VOICES)
    voices = sorted(v for v in kokoro.get_voices() if v.startswith("bm_"))
    kokoro.create("Ready.", voice=voices[0] if voices else "bm_george", lang="en-gb")  # warm-up
    send({"ready": True, "voices": voices, "loadMs": int((time.time() - t0) * 1000)})

    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get("id")
        try:
            text = str(req.get("text", ""))[:MAX_CHARS]
            voice = req.get("voice") or "bm_george"
            if voice not in voices:
                raise ValueError(f"unknown voice {voice}")
            speed = float(req.get("speed") or 1.0)
            speed = min(1.4, max(0.7, speed))
            for seq, part in enumerate(chunks(text, 9 if req.get("first") else 0)):
                audio, sr = kokoro.create(part, voice=voice, speed=speed, lang="en-gb")
                pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
                send({"id": rid, "seq": seq, "sr": sr, "pcm": base64.b64encode(pcm).decode("ascii"), "text": part})
            send({"id": rid, "done": True})
        except Exception as e:  # report and keep serving
            send({"id": rid, "error": str(e)})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        send({"fatal": str(e)})
        sys.exit(1)
