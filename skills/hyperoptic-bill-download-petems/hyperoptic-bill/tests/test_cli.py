"""Argument handling and the exit-code contract, without a browser."""

from __future__ import annotations

import json

import pytest

from hyperoptic_bill import cli


def test_download_defaults():
    args = cli.build_parser().parse_args(["download"])
    assert (args.latest, args.month, args.year, args.out, args.overwrite) == (
        False,
        None,
        None,
        "~/Desktop",
        False,
    )


@pytest.mark.parametrize(
    "argv",
    [
        ["download", "--latest", "--year", "2026"],
        ["download", "--month", "Smarch"],
        ["download", "--latest", "--month", "May"],
        ["list", "--year", "26"],
    ],
)
def test_bad_arguments_exit_2(argv, tmp_path):
    with pytest.raises(SystemExit) as info:
        cli.main(["--home", str(tmp_path), *argv])
    assert info.value.code == 2


def test_missing_profile_is_exit_3(tmp_path, capsys):
    code = cli.main(["--home", str(tmp_path), "download", "--latest"])
    assert code == 3
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "no_profile"
    assert "hyperoptic-bill login" in err["message"]


def test_env_prefix(monkeypatch, tmp_path):
    monkeypatch.setenv("HYPEROPTIC_BILL_HOME", str(tmp_path))
    args = cli.build_parser().parse_args(["list"])
    assert str(args.home) == str(tmp_path)
