"""Phase 2 smoke test: the tracker module imports and its pure helpers work without macOS tools."""

import importlib.util
import pathlib

SPEC = importlib.util.spec_from_file_location("keel_tracker", pathlib.Path(__file__).parents[2] / "tracker" / "keel_tracker.py")
kt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kt)


def test_version_and_port():
    assert kt.VERSION == 2
    assert kt.PORT == 47821


def test_day_key_format():
    assert kt.day_key(0)[:4] in ("1969", "1970")
