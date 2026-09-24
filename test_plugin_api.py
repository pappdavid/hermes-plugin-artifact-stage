"""Smoke tests for the artifact-stage backend (in-process, real files)."""
import importlib.util
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent
PLUGIN_API = ROOT / "dashboard" / "plugin_api.py"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "runtime" / "artifact-stage" / "artifacts").mkdir(parents=True)
    spec = importlib.util.spec_from_file_location("artifact_stage_plugin_api", PLUGIN_API)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(mod.router)
    return TestClient(app)


def test_state_absent_returns_none_cmd(client, tmp_path):
    r = client.get("/state")
    assert r.status_code == 200
    assert r.json() == {"cmd": "none", "seq": 0}


def test_state_written_by_session_is_served(client, tmp_path):
    state = tmp_path / "runtime" / "artifact-stage" / "state.json"
    state.write_text('{"cmd":"open","seq":42,"artifact":{"id":"a.pdf","kind":"pdf"}}', encoding="utf-8")
    assert client.get("/state").json()["seq"] == 42


def test_ack_roundtrip(client, tmp_path):
    r = client.post("/ack", json={"seq": 7, "rendered": True, "error": None})
    assert r.status_code == 200 and r.json()["ok"] is True
    ack = client.get("/ack").json()
    assert ack["seq"] == 7 and ack["rendered"] is True
    # ack.json exists on disk where the session CLI reads it
    assert (tmp_path / "runtime" / "artifact-stage" / "ack.json").exists()


def test_file_serves_staged_bytes(client, tmp_path):
    art = tmp_path / "runtime" / "artifact-stage" / "artifacts" / "abc.pdf"
    art.write_bytes(b"%PDF-1.4 fake")
    r = client.get("/file/abc.pdf")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/pdf")
    assert r.content == b"%PDF-1.4 fake"


def test_file_rejects_traversal(client):
    assert client.get("/file/..%2F..%2Fconfig.yaml").status_code in (400, 404)
    assert client.get("/file/does-not-exist.pdf").status_code == 404


def test_file_data_url_serves_staged_bytes_as_json(client, tmp_path):
    art = tmp_path / "runtime" / "artifact-stage" / "artifacts" / "abc.png"
    art.write_bytes(b"hello")
    r = client.get("/file-data-url/abc.png")
    assert r.status_code == 200
    assert r.json() == {
        "mime_type": "image/png",
        "data_url": "data:image/png;base64,aGVsbG8=",
    }


def test_file_data_url_rejects_traversal(client):
    assert client.get("/file-data-url/..%2F..%2Fconfig.yaml").status_code in (400, 404)
    assert client.get("/file-data-url/does-not-exist.png").status_code == 404


def test_session_cli_roundtrip(tmp_path, monkeypatch):
    """CLI stages a file + writes state.json the backend would serve."""
    cli = ROOT / "bin" / "artifact-stage"
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    sample = tmp_path / "sample.md"
    sample.write_text("# hello stage", encoding="utf-8")
    rc = os.system(f'{sys.executable} {cli} open {sample} --title "Sample"')
    assert rc == 0
    import json

    state = json.loads((tmp_path / "runtime" / "artifact-stage" / "state.json").read_text())
    assert state["cmd"] == "open" and state["artifact"]["kind"] == "markdown"
    assert state["artifact"]["text"].startswith("# hello")
    assert (tmp_path / "runtime" / "artifact-stage" / "artifacts" / state["artifact"]["id"]).exists()
    # scroll + status
    assert os.system(f"{sys.executable} {cli} scroll 50") == 0
    state = json.loads((tmp_path / "runtime" / "artifact-stage" / "state.json").read_text())
    assert state["cmd"] == "scroll" and abs(state["view"]["scroll_pct"] - 0.5) < 1e-9
