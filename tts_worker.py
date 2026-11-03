#!/usr/bin/env python3
"""
Persistent ZeroTTS Worker Daemon (voice='maichi' default).
- Strict Vietnamese-only text sanitizer: strips all Cuneiform (𒐫), Zalgo, emojis, and foreign scripts
  before passing to ZeroTTS so the model never chokes or glitches.
- Single-pass continuous synthesis + soft peak normalization (<= 0.90) + cosine fade-in/out.
- Low CPU configuration: intra_op_num_threads=3 + OMP_WAIT_POLICY=PASSIVE (0% CPU when idle).
"""
import hashlib
import io
import json
import os
import re
import sys
import time
import traceback
import unicodedata
from pathlib import Path

# Đảm bảo I/O tiếng Việt luôn dùng UTF-8 trên Windows
if sys.platform == "win32":
    if hasattr(sys.stdin, "buffer"):
        sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace")
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "buffer"):
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("OMP_NUM_THREADS", "3")
os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")
os.environ.setdefault("MKL_NUM_THREADS", "3")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "3")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "3")

import numpy as np
from zerotts import ZeroTTS, normalize_vi_text
from zerotts.chunking import normalize_punctuation

CACHE_DIR = Path(__file__).resolve().parent / "data" / "tts-cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

LOCAL_MODEL_CANDIDATES = [
    os.environ.get("ZEROTTS_MODEL_PATH", ""),
    "/Users/zens/Work/UIT/Projects/f1-metrics-explainer/models/zerotts",
]

# Bộ lọc chữ cái tiếng Việt đầy đủ (cả chữ hoa và chữ thường có dấu)
VIETNAMESE_ALLOWED_RE = re.compile(
    r"[^0-9a-zA-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúýĂăĐđĨĩŨũƠơƯưẠ-ỹ\s.,!?]"
)
BRACKET_EMOTE_RE = re.compile(r"\[[^\]]{1,24}\]")
REPEATED_CHARS_RE = re.compile(r"(.)\1{2,}", re.IGNORECASE)
MULTI_PUNCT_RE = re.compile(r"([.,!?])\1+")
MULTI_SPACE_RE = re.compile(r"\s+")


def resolve_model_source() -> str:
    for candidate in LOCAL_MODEL_CANDIDATES:
        if candidate and os.path.isdir(candidate) and os.path.isfile(os.path.join(candidate, "config.json")):
            return candidate
    return "zeroweight-ai/ZeroTTS"


def emit(payload: dict) -> None:
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    if hasattr(sys.stdout, "buffer"):
        sys.stdout.buffer.write(line.encode("utf-8"))
        sys.stdout.buffer.flush()
    else:
        sys.stdout.write(line)
        sys.stdout.flush()


def clean_and_normalize_text(raw_text: str) -> str:
    if not raw_text:
        return ""
    # 1. Chuẩn hóa NFKC (biến chữ kiểu toán học 𝒯𝒽𝒾ê𝓃 𝒯â𝓂 -> Thiên Tâm) rồi NFC
    text = unicodedata.normalize("NFC", unicodedata.normalize("NFKC", str(raw_text)))
    # 2. Xóa các mã emote kiểu [thanks], [rose] và chuyển các ký tự nối (_, @, -) thành khoảng trắng
    text = BRACKET_EMOTE_RE.sub(" ", text)
    text = re.sub(r"[@_/\-]+", " ", text)
    # 3. Xóa sạch ký tự lạ (𒐫, emoji, ký tự ngoại ngữ, ký tự điều khiển)
    text = VIETNAMESE_ALLOWED_RE.sub(" ", text)
    # 4. Thu gọn ký tự lặp quá 2 lần (ví dụ: aaaaa -> aa, ..... -> .)
    text = MULTI_PUNCT_RE.sub(r"\1", text)
    text = REPEATED_CHARS_RE.sub(r"\1\1", text)
    text = MULTI_SPACE_RE.sub(" ", text).strip(" .,!?-")

    # Phải có ít nhất 2 chữ cái hợp lệ mới đọc
    letters = re.findall(r"[a-zA-ZÀ-ỹĂăĐđĨĩŨũƠơƯư]", text)
    if len(letters) < 2:
        return ""

    # Giới hạn độ dài an toàn cho 1 câu đọc TTS (tối đa 160 ký tự)
    if len(text) > 160:
        text = text[:160].rsplit(" ", 1)[0]

    normalized = normalize_vi_text(text)
    normalized = normalize_punctuation(normalized).strip()
    normalized = VIETNAMESE_ALLOWED_RE.sub(" ", normalized)
    normalized = MULTI_SPACE_RE.sub(" ", normalized).strip()
    if normalized and normalized[-1] not in ".!?":
        normalized += "."
    return normalized


def polish_waveform(wav: np.ndarray, sample_rate: int) -> np.ndarray:
    """De-click ends and prevent PCM_16 digital clipping ('xước/rè')."""
    arr = np.asarray(wav, dtype=np.float32).reshape(-1)
    if arr.size == 0:
        return arr.reshape(1, 0)

    arr = arr - np.mean(arr)

    peak = float(np.max(np.abs(arr)))
    if peak > 0.90:
        arr = arr * (0.90 / peak)

    fade_in = min(int(sample_rate * 0.012), arr.size // 4)
    fade_out = min(int(sample_rate * 0.020), arr.size // 4)
    if fade_in > 1:
        ramp_in = 0.5 * (1.0 - np.cos(np.linspace(0, np.pi, fade_in, dtype=np.float32)))
        arr[:fade_in] *= ramp_in
    if fade_out > 1:
        ramp_out = 0.5 * (1.0 + np.cos(np.linspace(0, np.pi, fade_out, dtype=np.float32)))
        arr[-fade_out:] *= ramp_out

    return arr.reshape(1, -1)


def main() -> None:
    t0 = time.time()
    model_src = resolve_model_source()
    emit({"type": "status", "status": "loading", "model": model_src})

    try:
        tts = ZeroTTS.from_pretrained(model_src, intra_op_num_threads=3)
        voices = tts.list_voices()
        default_voice = "maichi" if "maichi" in voices else (voices[0] if voices else None)
        load_sec = round(time.time() - t0, 2)
        emit({
            "type": "ready",
            "model": model_src,
            "voice": default_voice,
            "voices": voices,
            "sampleRate": int(tts.sample_rate),
            "loadSec": load_sec,
        })
    except Exception as exc:
        emit({
            "type": "error",
            "fatal": True,
            "error": str(exc),
            "trace": traceback.format_exc(),
        })
        sys.exit(1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            text = (req.get("text") or "").strip()
            voice = (req.get("voice") or "maichi").strip().lower()
            if voice not in voices:
                voice = "maichi"

            norm_text = clean_and_normalize_text(text)
            if not norm_text:
                emit({"type": "result", "id": req_id, "ok": False, "error": "Filtered empty/spam text"})
                continue

            cache_key = hashlib.sha1(f"v3::{voice}::{norm_text}".encode("utf-8")).hexdigest()[:20]
            out_name = f"{voice}_{cache_key}.wav"
            out_path = CACHE_DIR / out_name

            if out_path.is_file() and out_path.stat().st_size > 200:
                emit({
                    "type": "result",
                    "id": req_id,
                    "ok": True,
                    "cached": True,
                    "voice": voice,
                    "file": out_name,
                    "url": f"/tts-cache/{out_name}",
                    "synthSec": 0.0,
                })
                continue

            t_synth = time.time()
            raw_wav = tts.synthesize(norm_text, voice=voice, eoa_extra_frames=2)
            if raw_wav is None or raw_wav.size == 0:
                emit({"type": "result", "id": req_id, "ok": False, "error": "No audio generated"})
                continue

            clean_audio = polish_waveform(raw_wav, int(tts.sample_rate))
            tts.save_audio(clean_audio, str(out_path))
            synth_sec = round(time.time() - t_synth, 2)
            duration_sec = round(clean_audio.shape[-1] / float(tts.sample_rate), 2)

            emit({
                "type": "result",
                "id": req_id,
                "ok": True,
                "cached": False,
                "voice": voice,
                "file": out_name,
                "url": f"/tts-cache/{out_name}",
                "synthSec": synth_sec,
                "durationSec": duration_sec,
            })
        except Exception as exc:
            emit({
                "type": "result",
                "id": req_id,
                "ok": False,
                "error": str(exc),
            })


if __name__ == "__main__":
    main()
