#!/usr/bin/env python3
"""Minimal HTTP CONNECT proxy for LAN-only release rescue (SOP §11.30).

When the Windows signing machine's egress hard-blocks github.com:443 (HTTP/1.1,
alternate IPs, and curloptResolve all fail — a GFW-style port block, not the
h2-RST form that this Mac can route around), run this proxy on a Mac in the
same LAN and point the signer's git at it, scoped to github.com only:

  # Mac (this script):
  python3 scripts/dev/github-connect-proxy.py            # listens on 0.0.0.0:8899
  # Signer:
  git config --global http.https://github.com.proxy http://<mac-lan-ip>:8899
  git ls-remote https://github.com/<org>/<repo> HEAD     # must print a SHA

Implementation notes that cost a debugging round (2026-11-14, v1.1.0):
- The CONNECT request must be read to its BLANK line. Reading only the first
  line leaks the remaining headers (Host:, User-Agent:) into the tunnel, the
  upstream TLS server sees plaintext garbage and closes the connection — the
  symptom is "established then immediate EOF" against every target.
- Upstream connections are IPv4-only (getaddrinfo AF_INET) to avoid
  IPv6-preference paths that bypass the working route.
- git smart-HTTP is end-to-end TLS, so only CONNECT is supported; other
  domains (npmjs, certum) are untouched by the scoped signer config.

Cleanup discipline: when the release finishes, kill this process AND unset
the signer's git proxy config — a dead proxy endpoint breaks signer git
worse than the intermittent direct block it was rescuing.
"""
import asyncio
import socket

LISTEN_ADDR = "0.0.0.0"
LISTEN_PORT = 8899


async def pipe(reader, writer, tag=""):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                print(f"[proxy] {tag} EOF", flush=True)
                break
            print(f"[proxy] {tag} {len(data)}B {data[:16].hex()}", flush=True)
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle(reader, writer):
    peer = writer.get_extra_info("peername")
    try:
        line = await asyncio.wait_for(reader.readline(), 30)
        if not line:
            return
        parts = line.decode("latin1").split()
        if len(parts) < 2 or parts[0] != "CONNECT":
            writer.write(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            await writer.drain()
            return
        # Drain the rest of the CONNECT request headers (Host:, User-Agent:, ...)
        # until the blank line — otherwise they leak into the tunnel as garbage.
        while True:
            header = await asyncio.wait_for(reader.readline(), 15)
            if header in (b"\r\n", b"\n", b""):
                break
        host, _, port = parts[1].partition(":")
        port = int(port or 443)
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(host, port, family=socket.AF_INET, type=socket.SOCK_STREAM)
            addr = infos[0][4]
            up_r, up_w = await asyncio.wait_for(asyncio.open_connection(addr[0], addr[1]), 15)
        except Exception as exc:
            print(f"[proxy] {peer} -> {host}:{port} upstream failed: {exc!r}")
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            await writer.drain()
            return
        print(f"[proxy] {peer} -> {host}:{port} established")
        writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        await writer.drain()
        await asyncio.gather(pipe(reader, up_w, tag=f"{peer} c->u"), pipe(up_r, writer, tag=f"{peer} u->c"))
    except Exception as exc:
        print(f"[proxy] {peer} handler error: {exc!r}")


async def main():
    server = await asyncio.start_server(handle, LISTEN_ADDR, LISTEN_PORT)
    print(f"[proxy] listening on {LISTEN_ADDR}:{LISTEN_PORT}")
    await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
