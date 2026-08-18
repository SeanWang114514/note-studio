#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Qwen3-ASR 本地识别服务（OpenAI 兼容 /v1/audio/transcriptions + 模型管理）
=========================================================================
为「笔记工作台」的语音识别提供 Qwen3-ASR 后端：
浏览器把录音（16kHz 16bit WAV）POST 到这里，识别在本机完成，音频不上传公网。

安装（Python 3.12 推荐）：
    pip install -U qwen-asr fastapi "uvicorn[standard]" python-multipart

启动：
    # CPU（较慢但无需 GPU）
    python server/qwen3_asr_server.py --device cpu --port 8000
    # GPU（推荐，bfloat16）
    python server/qwen3_asr_server.py --device cuda:0 --port 8000
    # 启动时立即加载模型（首次会从 HuggingFace 下载权重，1.7B 约 1.4GB）
    python server/qwen3_asr_server.py --device cuda:0 --preload

接口：
    POST /v1/audio/transcriptions
        multipart: file=<wav>  model=Qwen3-ASR-1.7B  language=(可选，如 Chinese)
        -> {"text": "...", "language": "..."}
    GET  /health
    GET  /models                      列出可下载/已下载的本地量化模型
    POST /models/download  {"id": ...} 后台下载（GGUF Q4_K_M / MLX 4bit）
    DELETE /models/{id}               停止下载并删除本地文件

量化模型下载源默认 hf-mirror.com（国内可直连），可用环境变量切换：
    QWEN_HF_MIRROR=https://huggingface.co python server/qwen3_asr_server.py ...
"""
import argparse
import io
import os
import shutil
import threading
import time
import urllib.request
import wave
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

SERVER_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SERVER_DIR.parent
MODELS_DIR = SERVER_DIR / "models"  # main() 里可用 --models-dir 覆盖

# 可下载的量化模型清单（Qwen3-ASR-0.6B）
MODEL_CATALOG = [
    {
        "id": "gguf_q4km",
        "name": "Qwen3-ASR-0.6B（GGUF Q4_K_M）",
        "kind": "gguf",
        "desc": "transcribe.cpp / llama.cpp 可加载的 4bit 量化 GGUF，CPU 即可离线识别",
        "repo": "handy-computer/Qwen3-ASR-0.6B-gguf",
        "files": [
            {"path": "Qwen3-ASR-0.6B-Q4_K_M.gguf", "size": 589560480},
        ],
    },
    {
        "id": "mlx_4bit",
        "name": "Qwen3-ASR-0.6B（MLX 4bit）",
        "kind": "mlx",
        "desc": "Apple Silicon（macOS）MLX 框架 4bit 量化，含 tokenizer 整仓",
        "repo": "aitytech/Qwen3-ASR-0.6B-MLX-4bit",
        "files": [
            {"path": "config.json", "size": 7187},
            {"path": "merges.txt", "size": 1671853},
            {"path": "model.safetensors", "size": 708236945},
            {"path": "model.safetensors.index.json", "size": 71814},
            {"path": "tokenizer_config.json", "size": 12487},
            {"path": "vocab.json", "size": 2776833},
            {"path": "README.md", "size": 859},
        ],
    },
]
for _m in MODEL_CATALOG:
    _m["sizeBytes"] = sum(f["size"] for f in _m["files"])

# 下载状态 { id: {running, cancel, error, files: {path: {done, total}}, started_at} }
DL_STATE = {}
DL_LOCK = threading.Lock()

# 内置 Vosk 中文小模型（已随项目内置到 public/models/）
VOSK_REL = Path("public") / "models" / "vosk-model-small-cn-0.22.tar.gz"

app = FastAPI(title="Qwen3-ASR 本地识别", version="1.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ARGS = None
MODEL = None
MODEL_LOCK = threading.Lock()
LOAD_ERROR = None


class DownloadRequest(BaseModel):
    id: str


def hf_base():
    """下载源：默认 hf-mirror.com（国内可直连），可用 QWEN_HF_MIRROR 覆盖。"""
    return os.environ.get("QWEN_HF_MIRROR", "https://hf-mirror.com").rstrip("/")


def catalog_item(model_id):
    for m in MODEL_CATALOG:
        if m["id"] == model_id:
            return m
    return None


def model_dir(model_id):
    return MODELS_DIR / model_id


def parse_wav(data: bytes):
    """解析 16-bit PCM WAV，返回 (float32 mono, sample_rate)。"""
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            sr = w.getframerate()
            n = w.getnframes()
            raw = w.readframes(n)
            pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            if w.getnchannels() > 1:
                pcm = pcm.reshape(-1, w.getnchannels()).mean(axis=1)
            return pcm, sr
    except Exception:
        try:
            import soundfile as sf  # 可选：支持更多格式

            return sf.read(io.BytesIO(data), dtype="float32")
        except Exception:
            raise HTTPException(
                status_code=400,
                detail="无法解析音频：请使用 16-bit PCM WAV（本应用录音默认格式）",
            )


def ensure_model():
    global MODEL, LOAD_ERROR
    if MODEL is not None:
        return MODEL
    with MODEL_LOCK:
        if MODEL is not None:
            return MODEL
        if LOAD_ERROR is not None:
            raise HTTPException(status_code=500, detail=LOAD_ERROR)
        try:
            import torch  # noqa: F401
            from qwen_asr import Qwen3ASRModel

            kwargs = dict(
                max_inference_batch_size=1,
                max_new_tokens=ARGS.max_new_tokens,
            )
            if ARGS.device == "cpu":
                kwargs.update(dtype=torch.float32, device_map="cpu")
            else:
                kwargs.update(
                    dtype=torch.bfloat16,
                    device_map="auto" if ARGS.device == "auto" else ARGS.device,
                )
            print(f"[qwen3-asr] 正在加载模型 {ARGS.model}（device={ARGS.device}，首次会下载权重）…")
            MODEL = Qwen3ASRModel.from_pretrained(ARGS.model, **kwargs)
            print("[qwen3-asr] 模型加载完成")
        except HTTPException:
            raise
        except Exception as e:
            LOAD_ERROR = (
                "Qwen3-ASR 模型加载失败：%s。请确认已安装 qwen-asr（pip install -U qwen-asr）"
                "且模型路径/网络正常（首次需从 HuggingFace 下载权重）" % e
            )
            raise HTTPException(status_code=500, detail=LOAD_ERROR)
        return MODEL


# ---------------- 模型下载（后台线程 + 进度） ----------------

def _download_one(url, dest, model_id, fname):
    """流式下载单个文件到 dest，实时更新 DL_STATE 进度。"""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 note-studio/1.1"})
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = str(dest) + ".part"
    done = 0
    with urllib.request.urlopen(req, timeout=60) as resp, open(part, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        with DL_LOCK:
            st = DL_STATE.get(model_id)
            if st:
                st["files"][fname] = {"done": 0, "total": total}
        while True:
            with DL_LOCK:
                dl = DL_STATE.get(model_id)
                if dl and dl.get("cancel"):
                    raise RuntimeError("下载已取消")
            chunk = resp.read(256 * 1024)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            with DL_LOCK:
                dl = DL_STATE.get(model_id)
                if dl:
                    dl["files"][fname]["done"] = done
    os.replace(part, dest)


def _download_all(model_id):
    """下载一个模型的所有文件（先镜像，失败回退官方 HF）。"""
    m = catalog_item(model_id)
    if not m:
        return
    d = model_dir(model_id)
    d.mkdir(parents=True, exist_ok=True)
    base = hf_base()
    for f in m["files"]:
        dest = d / f["path"]
        if dest.exists() and dest.stat().st_size == f["size"]:
            with DL_LOCK:
                st = DL_STATE.get(model_id)
                if st:
                    st["files"][f["path"]] = {"done": f["size"], "total": f["size"]}
            continue
        urls = [
            f"{base}/{m['repo']}/resolve/main/{f['path']}",
            f"https://huggingface.co/{m['repo']}/resolve/main/{f['path']}",
        ]
        last = None
        for u in urls:
            try:
                _download_one(u, dest, model_id, f["path"])
                last = None
                break
            except Exception as e:  # noqa: PERF203
                last = e
        if last is not None:
            raise RuntimeError(f"下载 {f['path']} 失败：{last}")


def _download_worker(model_id):
    try:
        _download_all(model_id)
        with DL_LOCK:
            dl = DL_STATE.get(model_id)
            if dl:
                dl["running"] = False
                dl["error"] = None
    except Exception as e:
        with DL_LOCK:
            dl = DL_STATE.get(model_id)
            if dl:
                dl["running"] = False
                dl["error"] = str(e)


# ---------------- HTTP 接口 ----------------

@app.get("/health")
def health():
    return {"status": "ok", "model": ARGS.model, "loaded": MODEL is not None}


@app.get("/models")
def list_models():
    vosk_path = PROJECT_DIR / VOSK_REL
    out = []
    for m in MODEL_CATALOG:
        d = model_dir(m["id"])
        with DL_LOCK:
            dl = DL_STATE.get(m["id"])
        files = []
        total_done = 0
        all_ok = True
        for f in m["files"]:
            p = d / f["path"]
            ok = p.exists() and p.stat().st_size == f["size"]
            disk = p.stat().st_size if p.exists() else 0
            if ok:
                total_done += f["size"]
            else:
                all_ok = False
            files.append({"path": f["path"], "size": f["size"], "exists": ok, "sizeOnDisk": disk})
        downloading = bool(dl and dl.get("running"))
        err = (dl or {}).get("error") if dl else None
        out.append(
            {
                "id": m["id"],
                "name": m["name"],
                "kind": m["kind"],
                "desc": m["desc"],
                "repo": m["repo"],
                "sizeBytes": m["sizeBytes"],
                "files": files,
                "downloaded": all_ok,
                "downloading": downloading,
                "progress": {"done": total_done, "total": m["sizeBytes"]},
                "error": err,
                "localDir": str(d),
            }
        )
    return {
        "models": out,
        "vosk": {
            "builtin": vosk_path.exists(),
            "path": "/" + str(VOSK_REL).replace("\\", "/"),
            "sizeBytes": vosk_path.stat().st_size if vosk_path.exists() else 0,
        },
    }


@app.post("/models/download")
def start_download(req: DownloadRequest):
    m = catalog_item(req.id)
    if not m:
        raise HTTPException(status_code=404, detail="未知模型：" + req.id)
    with DL_LOCK:
        dl = DL_STATE.get(req.id)
        if dl and dl.get("running"):
            raise HTTPException(status_code=409, detail="该模型正在下载中")
        DL_STATE[req.id] = {
            "running": True,
            "cancel": False,
            "error": None,
            "files": {},
            "started_at": time.time(),
        }
    threading.Thread(target=_download_worker, args=(req.id,), daemon=True).start()
    return {"ok": True, "id": req.id}


@app.delete("/models/{model_id}")
def delete_model(model_id: str):
    m = catalog_item(model_id)
    if not m:
        raise HTTPException(status_code=404, detail="未知模型：" + model_id)
    with DL_LOCK:
        dl = DL_STATE.get(model_id)
        if dl and dl.get("running"):
            dl["cancel"] = True
    # 等待下载线程退出（最多 60s）
    for _ in range(600):
        with DL_LOCK:
            dl = DL_STATE.get(model_id)
            if not (dl and dl.get("running")):
                break
        time.sleep(0.1)
    d = model_dir(model_id)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
    with DL_LOCK:
        DL_STATE.pop(model_id, None)
    return {"ok": True, "id": model_id}


@app.post("/v1/audio/transcriptions")
def transcribe(
    file: UploadFile = File(...),
    model: str = Form("Qwen3-ASR-1.7B"),
    language: str = Form(""),
):
    model_obj = ensure_model()
    data = file.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="音频为空")
    pcm, sr = parse_wav(data)
    try:
        results = model_obj.transcribe(
            audio=(pcm, sr),
            language=language or None,  # None = 自动检测语言
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail="识别失败：%s" % e)
    r = results[0]
    return {
        "text": getattr(r, "text", ""),
        "language": getattr(r, "language", ""),
        "model": model,
    }


def main():
    global ARGS, MODELS_DIR
    parser = argparse.ArgumentParser(description="Qwen3-ASR 本地识别服务（OpenAI 兼容）")
    parser.add_argument("--model", default="Qwen/Qwen3-ASR-1.7B", help="模型名或本地路径（Qwen3-ASR-1.7B / Qwen3-ASR-0.6B）")
    parser.add_argument("--device", default="auto", help="auto / cpu / cuda:0 / cuda:1 ...")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--max-new-tokens", type=int, default=256)
    parser.add_argument("--preload", action="store_true", help="启动时立即加载模型")
    parser.add_argument("--models-dir", default=str(SERVER_DIR / "models"), help="量化模型下载目录（默认 server/models）")
    ARGS = parser.parse_args()
    MODELS_DIR = Path(ARGS.models_dir)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    if ARGS.preload:
        ensure_model()

    import uvicorn

    print(f"[qwen3-asr] 服务就绪：http://{ARGS.host}:{ARGS.port}/v1/audio/transcriptions")
    print(f"[qwen3-asr] 模型管理：GET/POST /models、DELETE /models/{{id}}，下载目录：{MODELS_DIR}")
    uvicorn.run(app, host=ARGS.host, port=ARGS.port)


if __name__ == "__main__":
    main()
