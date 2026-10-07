"""Minimal OpenAI-compatible /v1/embeddings server over a local fastembed (ONNX) model, for evaluating
SAM's optional embedding path without any cloud call.
  pip install fastembed
  python3 bench/retrieval/embed_server.py [port] [model]
  default model: sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 (384-d, 220 MB, EN+TR)
Responses are memoised per text (the eval re-asks the same queries many times)."""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from fastembed import TextEmbedding

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8089
MODEL = sys.argv[2] if len(sys.argv) > 2 else 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'
model = TextEmbedding(MODEL, cache_dir='/tmp/fe')
cache = {}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
        inp = body.get('input', [])
        if isinstance(inp, str):
            inp = [inp]
        todo = [t for t in inp if t not in cache]
        if todo:
            for t, v in zip(todo, model.embed(todo)):
                cache[t] = [float(x) for x in v]
        out = json.dumps({'object': 'list', 'model': MODEL, 'data': [{'object': 'embedding', 'index': i, 'embedding': cache[t]} for i, t in enumerate(inp)]}).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

if __name__ == '__main__':
    print('ready', MODEL, PORT, flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
