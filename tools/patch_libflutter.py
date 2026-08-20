#!/usr/bin/env python3
import argparse, hashlib
from pathlib import Path

EXPECTED_INPUT_SHA256 = "bc65ea22533619373528334ecab818f8220f2f1136cd09c44fb141d7377f93b2"
EXPECTED_OUTPUT_SHA256 = "18b8e471096737d67ccff2d311b7d1b1ef360946ec7cc7b91a84d3f5d1490348"

PATCHES = [
    (0x0f570d, "38", "39"),
    (0x111e02, "38", "39"),
    (0x111ea8, "38", "39"),
    (0x11b385, "38", "39"),
    (0x11c1e1, "38", "39"),
    (0x11f0e1, "38", "39"),
    (0x4a6e44, "0000", "ff83"),
    (0x4a6e47, "000000", "d1e007"),
    (0x4a6e4b, "000000", "a9fe0f"),
    (0x4a6e4f, "00", "f9"),
    (0x4a6e53, "00", "d0"),
    (0x4a6e55, "00000000", "30019141"),
    (0x4a6e5a, "00000000", "80521301"),
    (0x4a6e5f, "00000000000000000000000000000000000000", "b073522d914b0a1894fe0f40f9e00740a9ff83"),
    (0x4a6e73, "00000000000000000000000000", "91ff4305d1fd7b12a960021fd6"),
    (0x4a804c, "000000000000000000000000", "6c69626761646765742e736f"),
    (0x4c7b4c, "ff4305d1fd7b12a9", "be7cff171f2003d5"),
]

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ns=ap.parse_args()
    src=Path(ns.input).read_bytes()
    got=sha(src)
    if got != EXPECTED_INPUT_SHA256:
        raise SystemExit(f"REFUSING: unsupported libflutter.so sha256={got}")
    b=bytearray(src)
    for off, before_hex, after_hex in PATCHES:
        before=bytes.fromhex(before_hex); after=bytes.fromhex(after_hex)
        if len(before) != len(after):
            raise SystemExit(f"internal patch length mismatch at {off:#x}")
        if bytes(b[off:off+len(before)]) != before:
            raise SystemExit(f"REFUSING: unexpected bytes at {off:#x}")
        b[off:off+len(after)] = after
    out=bytes(b)
    got_out=sha(out)
    if got_out != EXPECTED_OUTPUT_SHA256:
        raise SystemExit(f"REFUSING: patched output hash mismatch {got_out}")
    Path(ns.output).write_bytes(out)
    print(f"libflutter patch: PASS input={got} output={got_out} changed_bytes=76")

if __name__ == "__main__":
    main()
