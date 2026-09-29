"""Resolve client IPs to device names: manual alias → Tailscale peer → LAN endpoint of a peer."""
import ipaddress
import json
import os
import socket
import time

from sqlmodel import Session, select

from .models import HostAlias

TS_SOCKET = os.environ.get("TAILSCALE_SOCKET", "/var/run/tailscale/tailscaled.sock")
_CACHE_TTL = 60
_cache: tuple[float, dict[str, dict]] = (0.0, {})


def _tailscale_status() -> dict | None:
    """GET /localapi/v0/status over the tailscaled unix socket (read-only, no auth needed)."""
    if not os.path.exists(TS_SOCKET):
        return None
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(2)
            s.connect(TS_SOCKET)
            s.sendall(b"GET /localapi/v0/status HTTP/1.0\r\nHost: local-tailscaled.sock\r\n\r\n")
            chunks = []
            while chunk := s.recv(65536):
                chunks.append(chunk)
        raw = b"".join(chunks)
        head, _, body = raw.partition(b"\r\n\r\n")
        if b" 200 " not in head.split(b"\r\n", 1)[0]:
            return None
        return json.loads(body)
    except (OSError, ValueError):
        return None


def _display(node: dict) -> str:
    host = node.get("HostName") or ""
    dns = (node.get("DNSName") or "").split(".")[0]
    # some devices (e.g. iOS) report HostName "localhost" — the MagicDNS label is more useful then
    return dns if (not host or host == "localhost") and dns else host or dns or "?"


def tailscale_map() -> dict[str, dict]:
    """ip → {name, dns, os, online, via}. Cached for a minute."""
    global _cache
    ts, cached = _cache
    if time.monotonic() - ts < _CACHE_TTL:
        return cached
    out: dict[str, dict] = {}
    st = _tailscale_status()
    if st:
        nodes = [st.get("Self") or {}, *(st.get("Peer") or {}).values()]
        for n in nodes:
            info = {
                "name": _display(n),
                "dns": (n.get("DNSName") or "").rstrip(".") or None,
                "os": n.get("OS"),
                "online": n.get("Online", True),
            }
            for ip in n.get("TailscaleIPs") or []:
                out[ip] = {**info, "via": "tailscale"}
            cur = (n.get("CurAddr") or "").rsplit(":", 1)[0]
            if cur and cur not in out:
                out[cur] = {**info, "via": "lan"}  # direct peer: its LAN address
    _cache = (time.monotonic(), out)
    return out


def resolve_all(session: Session, ips: list[str]) -> dict[str, dict]:
    aliases = {a.ip: a.name for a in session.exec(select(HostAlias))}
    ts = tailscale_map()
    out = {}
    for ip in ips:
        if ip in aliases:
            out[ip] = {"name": aliases[ip], "via": "alias", "alias": aliases[ip]}
        elif ip in ts:
            out[ip] = {**ts[ip], "alias": None}
        else:
            out[ip] = {"name": _fallback(ip), "via": "unknown", "alias": None}
    return out


def _fallback(ip: str) -> str | None:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return None
    if a.is_loopback:
        return "本机"
    if a in ipaddress.ip_network("172.16.0.0/12"):
        return "本机 (Docker 网关)"
    return None
