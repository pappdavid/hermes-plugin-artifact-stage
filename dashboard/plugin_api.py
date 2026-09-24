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
import json
import mimetypes
import os
import re
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
    ack = {
        "seq": int(body.get("seq", 0)),
        "rendered": bool(body.get("rendered", False)),
        "error": body.get("error"),
        "scroll_pct": body.get("scroll_pct"),
        "at": body.get("at"),
    }
    _atomic_write_json(_runtime_dir() / "ack.json", ack)
    return {"ok": True, "seq": ack["seq"]}


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
