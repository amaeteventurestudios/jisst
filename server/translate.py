#!/usr/bin/env python3
"""Jisste's translator: Argos Translate's open models (OPUS-MT, CC BY 4.0) run with CTranslate2 (MIT) and SentencePiece
(Apache 2.0) on the server's own processor, so translating costs nothing and no text leaves the server. Loopback only;
the gateway checks who is asking. Nothing is stored.

  translate.py --install DIR    download the models for English <-> French, Spanish, Portuguese and Arabic into DIR
  translate.py --serve DIR      answer POST /translate {"text", "target", "source"?} -> {"text", "source"} on 127.0.0.1:8305
"""
import json, re, sys, threading, urllib.request, zipfile, io, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LANGS = os.environ.get("JISST_TRANSLATE_LANGS", "fr es pt ar").split()
INDEX = "https://raw.githubusercontent.com/argosopentech/argospm-index/main/index.json"
PORT = int(os.environ.get("JISST_TRANSLATE_PORT", "8305"))
STOP = {  # a few very common words per language, enough to tell short chat messages apart
    "en": "hello hi thanks the and you is are to of it that for with this have what my your i we not be on at do",
    "fr": "bonjour salut merci le la les et est vous je tu une un des pas que qui pour avec ce cette mon ton sur dans au",
    "es": "hola gracias amigo el la los las y es usted yo tu una un de que no por para con este esta mi su en del",
    "pt": "olá oi obrigado obrigada o a os as e é você eu tu uma um de que não por para com este esta meu seu em do da",
}


def fetch(url: str, timeout: int) -> bytes:
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "jisste-translate/1"}), timeout=timeout).read()


def ver(p: dict) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", str(p.get("package_version", "0"))))


def install(target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    index = json.loads(fetch(INDEX, 60))
    want = {("en", l) for l in LANGS} | {(l, "en") for l in LANGS}
    best = {}
    for p in index:
        k = (p.get("from_code"), p.get("to_code"))
        if k in want and (k not in best or ver(p) > ver(best[k])):
            best[k] = p
    for (a, b), p in sorted(best.items()):
        d = target / f"{a}_{b}"
        done = d / "done"
        if done.exists() and done.read_text().strip() == str(p.get("package_version")):
            continue
        print(f"model {a} -> {b} {p.get('package_version')}", flush=True)
        data = fetch(p["links"][0], 600)
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            root = z.namelist()[0].split("/")[0]
            for n in z.namelist():
                rel = n[len(root) + 1:]
                if not rel or n.endswith("/") or not (rel.startswith("model/") or rel in ("sentencepiece.model", "metadata.json", "LICENSE", "README.md")):
                    continue
                out = d / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(z.read(n))
        (d / "done").write_text(str(p.get("package_version")))
    missing = want - set(best)
    if missing:
        print("not in the index:", sorted(missing), flush=True)


class Models:
    def __init__(self, root: Path):
        import ctranslate2, sentencepiece  # noqa: imported here so --install needs neither
        self.ct, self.sp_mod, self.root, self.cache, self.lock = ctranslate2, sentencepiece, root, {}, threading.Lock()

    def pair(self, a: str, b: str):
        k = f"{a}_{b}"
        with self.lock:
            if k not in self.cache:
                d = self.root / k
                if not (d / "model").exists():
                    return None
                self.cache[k] = (self.ct.Translator(str(d / "model"), device="cpu", inter_threads=1, intra_threads=2),
                                 self.sp_mod.SentencePieceProcessor(model_file=str(d / "sentencepiece.model")))
            return self.cache[k]

    def run(self, a: str, b: str, text: str) -> str:
        m = self.pair(a, b)
        if not m:
            raise KeyError(f"{a}->{b}")
        tr, sp = m
        out = []
        for para in text.split("\n"):
            parts = [s for s in re.split(r"(?<=[.!?؟])\s+", para.strip()) if s]
            if not parts:
                out.append("")
                continue
            res = tr.translate_batch([sp.encode(s, out_type=str) for s in parts], beam_size=2, max_decoding_length=256)
            out.append(" ".join("".join(r.hypotheses[0]).replace("\u2581", " ").strip() for r in res))
        return "\n".join(out)

    def translate(self, text: str, target: str, source: str = "") -> dict:
        src = source or detect(text)
        if src == target:
            return {"text": text, "source": src}
        if src == "en" or target == "en":
            return {"text": self.run(src, target, text), "source": src}
        return {"text": self.run("en", target, self.run(src, "en", text)), "source": src}   # through English


def detect(text: str) -> str:
    if re.search(r"[؀-ۿ]", text):
        return "ar"
    words = re.findall(r"[a-zà-ÿ']+", text.lower())
    score = {l: sum(w in set(v.split()) for w in words) for l, v in STOP.items()}
    if re.search(r"[ãõç]", text.lower()):
        score["pt"] += 2
    if re.search(r"[ñ¿¡]", text.lower()):
        score["es"] += 2
    if re.search(r"[èêàùœ]", text.lower()):
        score["fr"] += 1
    return max(score, key=lambda l: (score[l], l == "en"))


def serve(root: Path) -> None:
    models = Models(root)

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):  # never log what people wrote
            pass

        def send(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self.send(200, {"ok": True, "pairs": sorted(p.name for p in root.iterdir() if (p / "done").exists())})

        def do_POST(self):
            try:
                n = min(int(self.headers.get("content-length") or 0), 20000)
                q = json.loads(self.rfile.read(n) or b"{}")
                text, target = str(q.get("text", ""))[:4000], str(q.get("target", "en"))[:2]
                if not text.strip():
                    return self.send(400, {"error": "Nothing to translate."})
                self.send(200, models.translate(text, target, str(q.get("source", ""))[:2]))
            except KeyError:
                self.send(422, {"error": "That language isn't available yet."})
            except Exception:
                self.send(500, {"error": "Translation failed."})

    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--install":
        install(Path(sys.argv[2]))
    elif len(sys.argv) == 3 and sys.argv[1] == "--serve":
        serve(Path(sys.argv[2]))
    elif len(sys.argv) == 2 and sys.argv[1] == "--detect":
        print(detect(sys.stdin.read()))
    else:
        print(__doc__)
        sys.exit(2)
