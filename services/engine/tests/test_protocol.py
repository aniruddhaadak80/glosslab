"""The stdin/stdout boundary itself: one request in, one response out."""

from __future__ import annotations

import io
import json

import pytest

from glosslab.__main__ import handle, main
from glosslab.analysis import DESCRIPTIONS
from glosslab.protocol import EngineError, read_request, write_response


def test_reads_one_request() -> None:
    op, payload = read_request(io.StringIO('{"op":"segment","input":{"word":"kav"}}'))
    assert op == "segment"
    assert payload == {"word": "kav"}


def test_reads_a_request_with_no_input() -> None:
    op, payload = read_request(io.StringIO('{"op":"analyze_corpus"}'))
    assert op == "analyze_corpus"
    assert payload is None


@pytest.mark.parametrize(
    "raw",
    ["", "   ", "not json", "[1,2]", '{"input":{}}', '{"op":7}', '{"op":""}', "null"],
)
def test_rejects_malformed_requests(raw: str) -> None:
    with pytest.raises(EngineError):
        read_request(io.StringIO(raw))


def test_refuses_an_oversized_request() -> None:
    payload = json.dumps({"op": "segment", "input": {"word": "x" * 10}})
    with pytest.raises(EngineError) as error:
        read_request(io.StringIO(payload + " " * (8 * 1024 * 1024)))
    assert "INPUT_TOO_LARGE" in str(error.value) or "exceeds" in str(error.value)


def test_a_response_is_exactly_one_line_of_json() -> None:
    out = io.StringIO()
    write_response({"ok": True, "value": {"a": 1}, "durationMs": 3}, out)
    text = out.getvalue()
    assert text.endswith("\n")
    assert len(text.strip().splitlines()) == 1
    assert json.loads(text) == {"ok": True, "value": {"a": 1}, "durationMs": 3}


def test_handle_routes_a_real_operation() -> None:
    result = handle(
        "segment",
        {
            "word": "kav",
            "lexemes": [
                {"id": "kav", "morph": "kav", "type": "stem", "gloss": "person",
                 "weight": 3.0, "priority": 10, "features": {}}
            ],
        },
    )
    assert result["ok"] is True
    assert [part["morph"] for part in result["morphemes"]] == ["kav"]


def test_handle_turns_an_engine_error_into_a_stable_code() -> None:
    with pytest.raises(EngineError) as error:
        handle("segment", {"lexemes": []})
    assert error.value.code == "MISSING_FIELD"


def test_every_operation_is_described_for_a_model() -> None:
    described = {item["name"] for item in DESCRIPTIONS}
    assert described == {
        "segment",
        "unify",
        "schedule_review",
        "verify_plan",
        "analyze_corpus",
    }
    for item in DESCRIPTIONS:
        assert item["summary"].endswith("."), f"{item['name']} needs a full sentence"


def test_main_writes_an_error_envelope_and_exits_zero() -> None:
    stdin, stdout = io.StringIO('{"op":"nope"}'), io.StringIO()
    original_stdin, original_stdout = __import__("sys").stdin, __import__("sys").stdout
    __import__("sys").stdin, __import__("sys").stdout = stdin, stdout
    try:
        code = main()
    finally:
        __import__("sys").stdin, __import__("sys").stdout = original_stdin, original_stdout
    assert code == 0
    body = json.loads(stdout.getvalue())
    assert body["ok"] is False
    assert body["error"]["code"] == "UNKNOWN_OP"
