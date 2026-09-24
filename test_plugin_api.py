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
    sys.modules[spec.name] = mod
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
    assert ack["at"] and ack["polled_at"]
    # ack.json exists on disk where the session CLI reads it
    assert (tmp_path / "runtime" / "artifact-stage" / "ack.json").exists()


def test_ack_heartbeat_updates_liveness_without_overwriting_render(client):
    rendered = client.post("/ack", json={"seq": 7, "rendered": True}).json()
    before = client.get("/ack").json()
    heartbeat = client.post("/ack", json={"seq": 8, "heartbeat": True}).json()
    after = client.get("/ack").json()
    assert heartbeat["ok"] and heartbeat["polled_at"] >= rendered["polled_at"]
    assert after["seq"] == before["seq"] == 7
    assert after["at"] == before["at"]
    assert after["polled_at"] == heartbeat["polled_at"]


def test_refer_delivery_receipt_records_region_and_is_not_left_pending(client, monkeypatch):
    import artifact_stage_plugin_api as mod
    delivered = []
    monkeypatch.setattr(mod, "_spawn_reference_delivery", lambda entry: delivered.append(entry["id"]))
    payload = {
        "request_id": "test-request-1",
        "prompt": "Review this heading",
        "artifact_id": "html-report.html",
        "artifact_title": "HTML master report",
        "profile": "verifier",
        "region": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4, "normalized": True},
    }
    response = client.post("/talk", json=payload)
    assert response.status_code == 200
    receipt = response.json()
    duplicate = client.post("/talk", json=payload).json()
    assert receipt["id"] and receipt["delivered"] is False and receipt["consumed"] is True
    assert receipt["delivery_status"] == "queued" and receipt["queued_at"]
    assert receipt["region"] == payload["region"]
    assert duplicate["id"] == receipt["id"]
    assert delivered == [receipt["id"]]
    mod._record_delivery_completion(receipt["id"], type("Process", (), {"wait": lambda self: 0})())
    completed = client.get(f"/talks/{receipt['id']}").json()
    assert completed["delivered"] is True and completed["delivery_status"] == "delivered"
    assert completed["completed_at"]
    assert client.get("/talks").json()["pending"] == []
    saved = (Path(os.environ["HERMES_HOME"]) / "runtime" / "artifact-stage" / "pending-turns.jsonl").read_text()
    assert receipt["id"] in saved


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
