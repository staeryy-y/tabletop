"""A minimal stand-in for a Starlette WebSocket, for unit-testing app/signaling.py's
message-handling and disconnect logic without opening a real socket. Real end-to-end
protocol behavior (actual WS frames, real session cookies) is covered separately in
test_signaling.py using TestClient.websocket_connect — this fake is for testing the
pure dispatch logic (_handle_message, _handle_disconnect) in isolation, with assertions
on exactly what was sent to whom.
"""
from __future__ import annotations


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.closed_with: tuple[int, str] | None = None

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)
