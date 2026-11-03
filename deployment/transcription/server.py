"""Private bounded job API. No account credentials, remote input URLs or request logs."""
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

LIMIT = 128 * 1024**2
UUID = re.compile(r"^[a-f0-9-]{36}$")
TOKEN = os.environ.get("TRANSCRIPTION_TOKEN", "")
JOBS = {}
LOCK = threading.RLock()


def remove(job):
    process = job["process"]
    try:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=3)
    finally:
        shutil.rmtree(job["directory"], ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self):
        return bool(TOKEN) and hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN)

    def do_GET(self):
        if self.path == "/healthz":
            return self.reply(200, {"ready": Path("/models/asr/model.bin").is_file()})
        if not self.authorized():
            return self.reply(401, {"code": "UNAUTHORIZED"})
        audio_request = self.path.endswith("/audio")
        identifier = self.path.removeprefix("/jobs/").removesuffix("/audio") if audio_request else self.path.removeprefix("/jobs/")
        if not self.path.startswith("/jobs/") or not UUID.fullmatch(identifier):
            return self.reply(404, {"code": "NOT_FOUND"})
        with LOCK:
            job = JOBS.get(identifier)
            if not job:
                return self.reply(404, {"code": "NOT_FOUND"})
            directory = Path(job["directory"])
            if audio_request:
                audio = directory / "audio.mp3"
                if job["process"].poll() != 0 or not audio.is_file() or audio.is_symlink() or not 0 < audio.stat().st_size <= LIMIT:
                    return self.reply(404, {"code": "NOT_FOUND"})
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(audio.stat().st_size))
                self.end_headers()
                self.connection.settimeout(60)
                try:
                    with audio.open("rb") as source:
                        shutil.copyfileobj(source, self.wfile, length=65536)
                except (BrokenPipeError, ConnectionResetError, TimeoutError):
                    pass
                return
            if job["process"].poll() is not None:
                result = directory / "result.json"
                if job["process"].returncode == 0 and result.is_file() and result.stat().st_size <= 4 * 1024**2:
                    payload = json.loads(result.read_text())
                    return self.reply(200, {"state": "ready", "result": payload["transcript"], "audio": payload["audio"], "transcriptionError": payload.get("transcriptionError")})
                code = "TRANSCRIPTION_PROCESSING_FAILED"
                error = directory / "error.json"
                if error.is_file():
                    code = json.loads(error.read_text()).get("code", code)
                return self.reply(200, {"state": "failed", "error": code})
            progress = directory / "progress.json"
            phase = json.loads(progress.read_text())["phase"] if progress.is_file() else "decoding"
            # The engine writes terminal progress before it exits. Only the
            # completed-process branch above may publish ready/result or failed.
            # Keep reporting the last active phase until that commit boundary.
            active_phases = {"decoding", "loading", "extracting", "transcribing", "diarizing"}
            if phase in active_phases:
                job["phase"] = phase
            return self.reply(200, {"state": job.get("phase", "decoding")})

    def do_POST(self):
        if not self.authorized():
            return self.reply(401, {"code": "UNAUTHORIZED"})
        identifier = self.headers.get("X-Job-Id", "")
        if self.path != "/jobs" or not UUID.fullmatch(identifier):
            return self.reply(400, {"code": "INVALID_JOB"})
        operation = self.headers.get("X-Media-Operation", "transcribe")
        if operation not in {"extract", "both", "transcribe"}:
            return self.reply(400, {"code": "INVALID_OPERATION"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if self.headers.get("Transfer-Encoding") or not 0 < size <= LIMIT:
            return self.reply(413, {"code": "UPLOAD_LIMIT"})
        with LOCK:
            # Reap abandoned results; only files created by this process are touched.
            for key, job in list(JOBS.items()):
                if time.monotonic() - job["created"] > 2100:
                    remove(job)
                    del JOBS[key]
            if identifier in JOBS or any(j["process"].poll() is None for j in JOBS.values()) or len(JOBS) >= 4:
                return self.reply(409, {"code": "BUSY"})
            directory = tempfile.mkdtemp(prefix="transcription-")
            self.connection.settimeout(60)
            try:
                with open(Path(directory) / "input", "wb") as target:
                    remaining = size
                    while remaining:
                        chunk = self.rfile.read(min(65536, remaining))
                        if not chunk:
                            raise ValueError("incomplete upload")
                        target.write(chunk)
                        remaining -= len(chunk)
                process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("engine.py")), directory, operation], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                JOBS[identifier] = {"directory": directory, "process": process, "created": time.monotonic()}
                return self.reply(202, {"id": identifier})
            except Exception:
                shutil.rmtree(directory, ignore_errors=True)
                return self.reply(400, {"code": "INVALID_UPLOAD"})

    def do_DELETE(self):
        if not self.authorized():
            return self.reply(401, {"code": "UNAUTHORIZED"})
        identifier = self.path.removeprefix("/jobs/")
        if not self.path.startswith("/jobs/") or not UUID.fullmatch(identifier):
            return self.reply(404, {"code": "NOT_FOUND"})
        with LOCK:
            job = JOBS.pop(identifier, None)
            if job:
                remove(job)
        return self.reply(200, {"removed": True})


if __name__ == "__main__":
    if not re.fullmatch(r"[a-f0-9]{64}", TOKEN):
        raise RuntimeError("TRANSCRIPTION_TOKEN must be provisioned by the Manager")
    ThreadingHTTPServer(("0.0.0.0", 8090), Handler).serve_forever()
