#!/usr/bin/env python3
"""
Query metafs-indexer API: user info (by address/metaid/globalmetaid) and file metadata (by pinid).
Base URL: https://file.metaid.io/metafile-indexer (override with METAFS_INDEXER_BASE_URL).
Stdout: JSON. Stderr: summary lines like AVATAR_URL=..., CONTENT_URL=..., ACCELERATE_URL=...
"""

import argparse
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

BASE_URL = os.environ.get(
    "METAFS_INDEXER_BASE_URL", "https://file.metaid.io/metafile-indexer"
).rstrip("/")


def get_url(path: str) -> str:
    return f"{BASE_URL}{path}"


def get_json(url: str) -> dict:
    req = Request(url, method="GET")
    req.add_header("Accept", "application/json")
    try:
        with urlopen(req, timeout=30) as resp:
            body = resp.read().decode()
            return json.loads(body)
    except HTTPError as e:
        body = e.read().decode() if e.fp else ""
        try:
            err = json.loads(body)
            msg = err.get("message", err.get("msg", body or str(e)))
        except Exception:
            msg = body or str(e)
        print(f"Error {e.code}: {msg}", file=sys.stderr)
        sys.exit(1)
    except (URLError, json.JSONDecodeError) as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_user(args: argparse.Namespace) -> None:
    if args.address:
        path = f"/api/info/address/{quote(args.address, safe='')}"
    elif args.metaid:
        path = f"/api/info/metaid/{quote(args.metaid, safe='')}"
    elif args.globalmetaid:
        path = f"/api/info/globalmetaid/{quote(args.globalmetaid, safe='')}"
    else:
        print("One of --address, --metaid, --globalmetaid is required.", file=sys.stderr)
        sys.exit(1)

    out = get_json(get_url(path))
    print(json.dumps(out, ensure_ascii=False))

    data = out.get("data")
    if not data:
        return
    avatar_pin_id = data.get("avatarId") or data.get("avatarPinId")
    if avatar_pin_id:
        avatar_url = f"{BASE_URL}/content/{avatar_pin_id}"
        print(f"AVATAR_URL={avatar_url}", file=sys.stderr)


def cmd_file(args: argparse.Namespace) -> None:
    if not args.pinid:
        print("--pinid is required.", file=sys.stderr)
        sys.exit(1)
    pin_id = quote(args.pinid, safe="")
    path = f"/api/v1/files/{pin_id}"
    out = get_json(get_url(path))
    print(json.dumps(out, ensure_ascii=False))

    data = out.get("data")
    if data:
        content_url = f"{BASE_URL}/api/v1/files/content/{args.pinid}"
        accelerate_url = f"{BASE_URL}/api/v1/files/accelerate/content/{args.pinid}"
        print(f"CONTENT_URL={content_url}", file=sys.stderr)
        print(f"ACCELERATE_URL={accelerate_url}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Query metafs-indexer: user info or file metadata."
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    user_p = sub.add_parser("user", help="Query user by address, metaid, or globalmetaid")
    g = user_p.add_mutually_exclusive_group(required=True)
    g.add_argument("--address", help="User address")
    g.add_argument("--metaid", help="User metaid or globalMetaId (for /api/info/metaid)")
    g.add_argument("--globalmetaid", help="User globalMetaID")
    user_p.set_defaults(func=cmd_user)

    file_p = sub.add_parser("file", help="Query file metadata by pinid")
    file_p.add_argument("--pinid", required=True, help="File PIN ID")
    file_p.set_defaults(func=cmd_file)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
