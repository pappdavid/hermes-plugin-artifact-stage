"""Artifact Stage — backend half, mounted by the Hermes dashboard.

Serves the session-written control state and staged artifact bytes to the
desktop pane at ``/api/plugins/artifact-stage/*``. The pane (a desktop plugin
under ``~/.hermes/desktop-plugins/artifact-stage/``) polls ``/state``, renders
the artifact, and POSTs ``/ack`` receipts.

Control flow is FILE-BASED on purpose: the session side never calls the
dashboard API (cookie gate) — any session with file access writes
``state.json`` (see ``~/.hermes/bin/artifact-stage``). This module is read-mostly:
state in, bytes out, acks back.
"""

from __future__ import annotations

import base64
import fcntl
import json
import math
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter()

_ARTIFACT_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def _home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes"))


def _runtime_dir() -> Path:
    return _home() / "runtime" / "artifact-stage"


def _artifacts_dir() -> Path:
    return _runtime_dir() / "artifacts"


def _atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path: Path, default: dict) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


@contextmanager
def _talks_lock():
    runtime = _runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)
    with (runtime / ".pending-turns.lock").open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _talks_path() -> Path:
    return _runtime_dir() / "pending-turns.jsonl"


def _read_talk_entries() -> list[dict]:
    path = _talks_path()
    if not path.exists():
        return []
    entries = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except ValueError as exc:
            raise HTTPException(status_code=500, detail=f"corrupt pending turns at line {line_no}") from exc
        if not isinstance(entry, dict):
            raise HTTPException(status_code=500, detail=f"invalid pending turn at line {line_no}")
        entries.append(entry)
    return entries


def _write_talk_entries(entries: list[dict]) -> None:
    path = _talks_path()
    tmp = path.with_suffix(path.suffix + ".tmp")
    payload = "".join(json.dumps(entry, ensure_ascii=False) + "\n" for entry in entries)
    with tmp.open("w", encoding="utf-8") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


def _validate_talk(body: dict) -> dict:
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not 1 <= len(prompt) <= 2000:
        raise HTTPException(status_code=422, detail="prompt must contain 1..2000 characters")
    entry = {
        "id": uuid.uuid4().hex,
        "request_id": str(body.get("request_id") or uuid.uuid4().hex),
        "ts_iso": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "prompt": prompt,
        "region": None,
        "artifact_id": None,
        "profile": str(body.get("profile") or "default"),
        "delivered": False,
        "delivery_status": "pending",
        "queued_at": None,
        "consumed": False,
    }
    request_id = entry["request_id"]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request_id):
        raise HTTPException(status_code=422, detail="invalid request_id")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", entry["profile"]):
        raise HTTPException(status_code=422, detail="invalid profile")
    if "artifact_id" in body and body["artifact_id"] is not None:
        artifact_id = body["artifact_id"]
        if not isinstance(artifact_id, str) or not _ARTIFACT_ID_RE.fullmatch(artifact_id) or ".." in artifact_id:
            raise HTTPException(status_code=422, detail="invalid artifact_id")
        entry["artifact_id"] = artifact_id
    if "region" in body and body["region"] is not None:
        region = body["region"]
        if not isinstance(region, dict) or region.get("normalized") is not True:
            raise HTTPException(status_code=422, detail="region must use normalized coordinates")
        values = [region.get(key) for key in ("x", "y", "w", "h")]
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in values):
            raise HTTPException(status_code=422, detail="region coordinates must be finite numbers")
        x, y, w, h = (float(value) for value in values)
        if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > 1 or y + h > 1:
            raise HTTPException(status_code=422, detail="region must fit within normalized 0..1 bounds")
        entry["region"] = {"x": x, "y": y, "w": w, "h": h, "normalized": True}
    return entry


def _artifact_path(artifact_id: str) -> Path:
    if not _ARTIFACT_ID_RE.match(artifact_id) or ".." in artifact_id:
        raise HTTPException(status_code=400, detail="bad artifact id")
    artifacts_dir = _artifacts_dir().resolve()
    path = (artifacts_dir / artifact_id).resolve()
    if path.parent != artifacts_dir or not path.is_file():
        raise HTTPException(status_code=404, detail="artifact not found")
    return path


@router.get("/state")
def get_state() -> dict:
    return _read_json(_runtime_dir() / "state.json", {"cmd": "none", "seq": 0})


@router.get("/ack")
def get_ack() -> dict:
    return _read_json(_runtime_dir() / "ack.json", {})


@router.post("/ack")
def post_ack(body: dict) -> dict:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    previous = _read_json(_runtime_dir() / "ack.json", {})
    if body.get("heartbeat") is True:
        ack = dict(previous)
        ack.setdefault("seq", int(body.get("seq", 0)))
        ack.setdefault("rendered", False)
        ack.setdefault("error", None)
        ack.setdefault("scroll_pct", None)
        ack.setdefault("at", None)
        ack["polled_at"] = now
    else:
        ack = {
            "seq": int(body.get("seq", 0)),
            "rendered": bool(body.get("rendered", False)),
            "error": body.get("error"),
            "scroll_pct": body.get("scroll_pct"),
            "at": now,
            "polled_at": now,
        }
    _atomic_write_json(_runtime_dir() / "ack.json", ack)
    return {"ok": True, "seq": ack["seq"], "polled_at": ack["polled_at"]}


@router.get("/talks")
def get_talks() -> dict:
    with _talks_lock():
        pending = [entry for entry in _read_talk_entries() if not entry.get("consumed", False)]
    return {"pending": pending}


def _spawn_reference_delivery(entry: dict):
    """Hand one attributed stage reference to the canonical profile Bot Chat."""
    runner = _home() / "hermes-agent" / "tools" / "bot_mode_dm.py"
    cli = shutil.which("hermes")
    if not runner.is_file() or not cli:
        raise RuntimeError("Bot Chat relay runner or hermes CLI is unavailable")
    runtime = _runtime_dir() / "deliveries"
    runtime.mkdir(parents=True, exist_ok=True)
    query = runtime / f"{entry['id']}.txt"
    region = entry.get("region")
    region_text = (f" region x={region['x']:.3f}, y={region['y']:.3f}, "
                   f"w={region['w']:.3f}, h={region['h']:.3f}") if region else ""
    title = entry.get("artifact_title") or entry.get("artifact_id") or "current artifact"
    message = f"Stage reference — {title}{region_text}: {entry['prompt']}"
    query.write_text(message, encoding="utf-8")
    os.chmod(query, 0o600)
    author = json.dumps({"id": "bot:artifact-stage", "name": "artifact-stage", "is_bot": True}, separators=(",", ":"))
    profile = entry["profile"]
    argv = [sys.executable, str(runner), "--run-delivery", "--author", author,
            "query-file", str(query), cli, "-p", profile, "chat", "--in", "~",
            "-c", "Bot Chat", "--create-if-missing", "-Q", "--query-file", str(query)]
    env = dict(os.environ)
    env["HERMES_HOME"] = str(_home())
    try:
        return subprocess.Popen(argv, cwd=str(runner.parent.parent), env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)
    except Exception:
        query.unlink(missing_ok=True)
        raise


def _record_delivery_completion(talk_id: str, process) -> None:
    return_code = process.wait()
    with _talks_lock():
        entries = _read_talk_entries()
        for entry in entries:
            if entry.get("id") == talk_id:
                entry["delivered"] = return_code == 0
                entry["delivery_status"] = "delivered" if return_code == 0 else "failed"
                entry["completed_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                if return_code != 0:
                    entry["delivery_error"] = f"Bot Chat runner exited {return_code}"
                _write_talk_entries(entries)
                return


@router.get("/talks/{talk_id}")
def get_talk(talk_id: str) -> dict:
    with _talks_lock():
        entry = next((item for item in _read_talk_entries() if item.get("id") == talk_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="talk not found")
    return entry


@router.post("/talk")
def post_talk(body: dict) -> dict:
    entry = _validate_talk(body)
    with _talks_lock():
        entries = _read_talk_entries()
        existing = next((item for item in entries if item.get("request_id") == entry["request_id"]), None)
        if existing:
            return existing
        path = _talks_path()
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry, ensure_ascii=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        try:
            process = _spawn_reference_delivery(entry)
        except Exception as exc:
            entry["delivery_status"] = "failed"
            entry["delivery_error"] = str(exc)[:300]
            _write_talk_entries(entries + [entry])
            raise HTTPException(status_code=503, detail="reference delivery could not be started") from exc
        entry["delivered"] = False
        entry["delivery_status"] = "queued"
        entry["queued_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        entry["consumed"] = True
        _write_talk_entries(entries + [entry])
    if process is not None:
        threading.Thread(target=_record_delivery_completion, args=(entry["id"], process),
                         name=f"artifact-stage-delivery-{entry['id'][:8]}", daemon=True).start()
    return entry


@router.post("/talks/pop")
def pop_talk(body: dict) -> dict:
    talk_id = body.get("id")
    if not isinstance(talk_id, str) or not talk_id:
        raise HTTPException(status_code=422, detail="id is required")
    with _talks_lock():
        entries = _read_talk_entries()
        for entry in entries:
            if entry.get("id") == talk_id and not entry.get("consumed", False):
                entry["consumed"] = True
                _write_talk_entries(entries)
                return entry
    raise HTTPException(status_code=404, detail="pending talk not found")


@router.get("/file-data-url/{artifact_id}")
def get_file_data_url(artifact_id: str) -> dict:
    path = _artifact_path(artifact_id)
    media = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return {"mime_type": media, "data_url": f"data:{media};base64,{encoded}"}


@router.get("/file/{artifact_id}")
def get_file(artifact_id: str):
    path = _artifact_path(artifact_id)
    media = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media)
