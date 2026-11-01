"""Local-only access control.

Any website the user visits can try to reach a server on localhost. So:
  * the API needs a session cookie, set by /auth?token=... (the CLI opens that URL);
  * the Host header must be 127.0.0.1:<port> or localhost:<port> (blocks DNS rebinding);
  * WebSocket handshakes must come from our own origin.
"""

from __future__ import annotations

import hmac
from http.cookies import SimpleCookie
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..core.studio import Studio

COOKIE = "texkit_session"
PUBLIC_PATHS = {"/api/health", "/auth"}


def _headers(scope) -> dict[str, str]:
    return {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}


def token_ok(studio: Studio, cookie_header: str) -> bool:
    jar = SimpleCookie()
    try:
        jar.load(cookie_header or "")
    except Exception:
        return False
    morsel = jar.get(COOKIE)
    return bool(morsel) and hmac.compare_digest(morsel.value, studio.token)


class GuardMiddleware:
    def __init__(self, app, studio: Studio) -> None:
        self.app = app
        self.studio = studio

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = _headers(scope)
        host = headers.get("host", "")
        path = scope.get("path", "")
        if host not in self.studio.allowed_hosts:
            return await self._deny(scope, send, 400, "Unknown host")
        needs_auth = path.startswith("/api/") and path not in PUBLIC_PATHS
        if needs_auth and not token_ok(self.studio, headers.get("cookie", "")):
            return await self._deny(scope, send, 401, "Not signed in. Open TexKit Studio from its terminal command.")
        if scope["type"] == "websocket" and headers.get("origin") not in {f"http://{h}" for h in self.studio.allowed_hosts}:
            return await self._deny(scope, send, 403, "Bad origin")
        return await self.app(scope, receive, send)

    async def _deny(self, scope, send, status: int, message: str):
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4000 + status})
            return
        body = ('{"detail": "%s"}' % message).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
