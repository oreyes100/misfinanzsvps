#!/usr/bin/env python3
"""
Servidor HTTP local para PaddleOCR (CPU, rápido ~10-15s por imagen).
Expone la misma API que ocr_server.py (Unlimited-OCR) para que el cliente
ocr.mjs de Hermes funcione sin cambios:

  POST /ocr   {"image": "/ruta/imagen.jpg", "mode": "gundam"|"base"}
              -> {"ok": true, "text": "...", "boxes": [[x,y,x2,y2], ...], "elapsed": segundos}
  GET  /health -> {"ok": true, "loaded": true, "uptime": segundos}

El texto se devuelve como líneas "y x\ttexto" (coordenadas del centro del box)
para que el parser local pueda reconstruir la estructura (fechas, importes,
descripciones) sin depender de la IA.
"""
import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PADDLE_OCR_PORT", "8765"))
LANG = os.environ.get("PADDLE_OCR_LANG", "es")

_ocr = None
_lock = threading.Lock()
_started = time.time()


def load_model():
    global _ocr
    from paddleocr import PaddleOCR
    print("Cargando PaddleOCR (%s)..." % LANG, flush=True)
    _ocr = PaddleOCR(
        lang=LANG,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=True,
        enable_mkldnn=False,
    )
    print("PaddleOCR listo", flush=True)


def run_infer(image_path):
    t0 = time.time()
    tmp = None
    if image_path.endswith(".processing"):
        # Hermes reclama el archivo renombrándolo a X.jpeg.processing; PaddleOCR
        # rechaza extensiones desconocidas, así que copiamos a un temp con la
        # extensión de imagen correcta (X.jpeg, que ya no existe en disco).
        import shutil
        tmp = image_path[:-len(".processing")]
        shutil.copyfile(image_path, tmp)
        image_path = tmp
    try:
        res = _ocr.predict(image_path)
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass
    texts = []
    for r in res:
        j = getattr(r, "json", None) or r
        d = j.get("res", j)
        for t, b in zip(d.get("rec_texts", []), d.get("rec_boxes", [])):
            if not t or not t.strip():
                continue
            x0, y0, x1, y1 = b
            cx = (x0 + x1) / 2.0
            cy = (y0 + y1) / 2.0
            texts.append({"x": round(cx, 1), "y": round(cy, 1), "text": t})
    texts.sort(key=lambda it: (it["y"], it["x"]))
    out = "\n".join("%d\t%d\t%s" % (int(it["y"]), int(it["x"]), it["text"]) for it in texts)
    return out, time.time() - t0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, {"ok": True, "loaded": _ocr is not None, "uptime": round(time.time() - _started)})
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
        if not image or not os.path.isfile(image):
            self._send(400, {"ok": False, "error": "imagen no encontrada: %s" % image})
            return
        if _ocr is None:
            self._send(503, {"ok": False, "error": "modelo aún no cargado"})
            return
        try:
            with _lock:
                text, elapsed = run_infer(image)
            self._send(200, {"ok": True, "text": text, "elapsed": round(elapsed, 2)})
        except Exception as e:
            self._send(500, {"ok": False, "error": "%s" % e, "trace": traceback.format_exc()[-2000:]})


def main():
    load_model()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("PaddleOCR server en http://127.0.0.1:%d" % PORT, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()