#!/usr/bin/env python3
"""
build-vector-set.py — assemble the pilot vector-set metafile payload.

Copies the two authoritative set files from the IDBots repo:
  tests/fixtures/metatask/conformance-vectors.json           (16 legacy v1.2.1 vectors)
  tests/fixtures/metatask/conformance-vectors-v13-draft.json (11 competitive v1.3 draft vectors)
into vector-set/, writes manifest.json with byte sha256 + canonJ sha256 per
file, and packs the directory as vector-set/vector-set.tar.gz (the uploadable
metafile payload).

The canonJ sha256 of the legacy set MUST equal the announced constant
106aa1f3bee8ebd48339ceb65f97a12e54247e1e831296a394a974c9cb22f2c4 — this script
refuses to build otherwise (it is the set the v1.2.1 registration announced).

Usage: python3 scripts/metatask-v13-pilot/build-vector-set.py
"""
import hashlib
import json
import os
import shutil
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(HERE, "vector-set")

LEGACY_CANONICAL_SHA256 = "106aa1f3bee8ebd48339ceb65f97a12e54247e1e831296a394a974c9cb22f2c4"

SETS = [
    ("conformance-vectors.json", "tests/fixtures/metatask/conformance-vectors.json", "legacy"),
    ("competitive-vectors.json", "tests/fixtures/metatask/conformance-vectors-v13-draft.json", "competitive"),
]


def canonJ(obj):
    """Canonical JSON per the MetaTask protocol (matches src/main/services/metatask/canon.ts)."""
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def main():
    os.makedirs(OUT, exist_ok=True)
    files = {}
    for name, rel, role in SETS:
        src = os.path.join(REPO, rel)
        with open(src, "rb") as handle:
            raw = handle.read()
        parsed = json.loads(raw.decode("utf-8"))
        canonical = sha256_hex(canonJ(parsed))
        entry = {
            "role": role,
            "bytes": len(raw),
            "sha256": sha256_hex(raw),
            "canonicalSha256": canonical,
            "vectors": len(parsed.get("vectors", [])),
            "protocolVersion": parsed.get("protocolVersion"),
        }
        if role == "legacy" and canonical != LEGACY_CANONICAL_SHA256:
            print("FATAL: legacy set canonical sha256 mismatch: %s != %s" % (canonical, LEGACY_CANONICAL_SHA256))
            return 1
        with open(os.path.join(OUT, name), "wb") as handle:
            handle.write(raw)
        files[name] = entry
        print("copied %-28s vectors=%-3d canonical=%s" % (name, entry["vectors"], canonical))

    manifest = {
        "setId": "metatask-v13-pilot-vectors",
        "createdAt": "2026-10-03",
        "note": "legacy = the registered v1.2.1 conformance set (byte copy); competitive = the v1.3.0 draft set (PRE-ACTIVATION, free to change until H_ACT3)",
        "files": files,
    }
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")

    tarball = os.path.join(OUT, "vector-set.tar.gz")
    if os.path.exists(tarball):
        os.remove(tarball)
    with tarfile.open(tarball, "w:gz") as tar:
        for name in sorted(os.listdir(OUT)):
            if name == "vector-set.tar.gz":
                continue
            tar.add(os.path.join(OUT, name), arcname=name)
    with open(tarball, "rb") as handle:
        digest = sha256_hex(handle.read())
    print("packed vector-set.tar.gz sha256=%s bytes=%d" % (digest, os.path.getsize(tarball)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
