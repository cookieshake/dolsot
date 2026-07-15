from dolsot.types import Result


def test_result_truncated_defaults_false():
    r = Result(ok=True, value="1", stdout="", error=None, exit_code=0)
    assert r.truncated is False


def test_result_truncated_can_be_set():
    r = Result(ok=True, value=None, stdout="x", error=None, exit_code=0, truncated=True)
    assert r.truncated is True
