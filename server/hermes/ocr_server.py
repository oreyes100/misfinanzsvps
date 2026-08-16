#!/usr/bin/env python3
"""
Servidor HTTP local para Unlimited-OCR (CPU).
Carga el modelo UNA sola vez y expone:

  POST /ocr   {"image": "/ruta/imagen.jpg", "mode": "gundam"|"base"}
              -> {"ok": true, "text": "...", "elapsed": segundos}
  GET  /health

Requiere el modeling_unlimitedocr.py parcheado a CPU (sin .cuda()).
Variables de entorno:
  UNLIMITED_OCR_MODEL  (default /home/devops/unlimited-ocr/model)
  UNLIMITED_OCR_PORT   (default 8765)
  UNLIMITED_OCR_DTYPE  (default bfloat16 | float32)
"""
import json
import os
import shutil
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModel, AutoTokenizer

MODEL_DIR = os.environ.get("UNLIMITED_OCR_MODEL", "/home/devops/unlimited-ocr/model")
PORT = int(os.environ.get("UNLIMITED_OCR_PORT", "8765"))
DTYPE = os.environ.get("UNLIMITED_OCR_DTYPE", "bfloat16")

_model = None
_tokenizer = None
_lock = threading.Lock()
_started = time.time()


def load_model():
    global _model, _tokenizer
    dtype = torch.bfloat16 if DTYPE == "bfloat16" else torch.float32
    print("Cargando tokenizer...", flush=True)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR, trust_remote_code=True)
    print("Cargando modelo (CPU, %s)... puede tardar unos minutos" % DTYPE, flush=True)
    t0 = time.time()
    model = AutoModel.from_pretrained(
        MODEL_DIR,
        trust_remote_code=True,
        use_safetensors=True,
        torch_dtype=dtype,
    )
    model = model.eval()
    print("Modelo cargado en %.1fs" % (time.time() - t0), flush=True)
    _tokenizer = tokenizer
    _model = model


def run_infer(image_path, mode):
    t0 = time.time()
    outdir = tempfile.mkdtemp(prefix="uocr_")
    try:
        res = _model.infer(
            _tokenizer,
            prompt="<image>document parsing.",
            image_file=image_path,
            output_path=outdir,
            base_size=1024,
            image_size=640 if mode == "gundam" else 1024,
            crop_mode=(mode == "gundam"),
            eval_mode=True,
            max_length=32768,
            no_repeat_ngram_size=35,
            ngram_window=128,
            save_results=False,
            temperature=0.0,
        )
        text = res if isinstance(res, str) else str(res)
    finally:
        shutil.rmtree(outdir, ignore_errors=True)
    return text, time.time() - t0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, {"ok": True, "loaded": _model is not None, "uptime": round(time.time() - _started)})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/ocr":
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            self._send(400, {"ok": False, "error": "bad request: %s" % e})
            return
        image = req.get("image")
        mode = req.get("mode", "gundam")
        if not image or not os.path.isfile(image):
            self._send(400, {"ok": False, "error": "imagen no encontrada: %s" % image})
            return
        if _model is None:
            self._send(503, {"ok": False, "error": "modelo aún no cargado"})
            return
        try:
            with _lock:
                text, elapsed = run_infer(image, mode)
            self._send(200, {"ok": True, "text": text, "elapsed": round(elapsed, 2)})
        except Exception as e:
            self._send(500, {"ok": False, "error": "%s" % e, "trace": traceback.format_exc()[-2000:]})


def main():
    load_model()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("OCR server en http://127.0.0.1:%d" % PORT, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()