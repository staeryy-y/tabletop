"""app/signaling.py — the highest-stakes module in the backend, and the one hardest to
integration-test in the real (browser, WebRTC, many peers) case per the project's own
docs (see docs/NETWORKING.md). Two layers of tests:

1. Unit tests against the pure/async logic (RoomState.pick_next_host, _handle_message,
   _handle_disconnect) using a FakeWebSocket — fast, deterministic, and able to assert
   on *exactly* what was sent to whom, which is hard to do precisely once real WS frames
   and asyncio scheduling are involved.
2. End-to-end protocol tests over TestClient.websocket_connect — real (in-process) WS
   frames, real session cookies, exercising the actual route handler.
"""
from __future__ import annotations

import asyncio

import pytest
from starlette.websockets import WebSocketDisconnect

import app.signaling as signaling
from app.signaling import Peer, RoomState
from tests.fakes import FakeWebSocket


def make_peer(peer_id: str, is_gm: bool = False, joined_at: float = 0.0) -> Peer:
    return Peer(peer_id=peer_id, name=peer_id, is_gm=is_gm, ws=FakeWebSocket(), joined_at=joined_at)


# --- RoomState.pick_next_host ---


def test_pick_next_host_returns_none_when_room_is_empty():
    state = RoomState()
    assert state.pick_next_host(exclude="anyone") is None


def test_pick_next_host_returns_none_when_only_the_excluded_peer_remains():
    state = RoomState()
    state.peers["a"] = make_peer("a")
    assert state.pick_next_host(exclude="a") is None


def test_pick_next_host_picks_the_oldest_joined_when_no_gm_present():
    state = RoomState()
    state.peers["a"] = make_peer("a", joined_at=5)
    state.peers["b"] = make_peer("b", joined_at=1)
    state.peers["c"] = make_peer("c", joined_at=10)
    assert state.pick_next_host(exclude="a") == "b"


def test_pick_next_host_prefers_a_connected_gm_even_if_not_oldest():
    state = RoomState()
    state.peers["a"] = make_peer("a", is_gm=False, joined_at=0)  # oldest, not GM
    state.peers["b"] = make_peer("b", is_gm=True, joined_at=5)  # GM, joined later
    state.peers["c"] = make_peer("c", is_gm=False, joined_at=1)
    assert state.pick_next_host(exclude="a") == "b"


def test_pick_next_host_picks_oldest_gm_if_multiple_gms_somehow_present():
    state = RoomState()
    state.peers["a"] = make_peer("a", is_gm=True, joined_at=5)
    state.peers["b"] = make_peer("b", is_gm=True, joined_at=1)
    assert state.pick_next_host(exclude="") == "b"


# --- RoomState.elect_host_on_join (D13: the GM is always host when connected) ---


def test_elect_host_on_join_first_ever_joiner_becomes_host_even_if_not_gm():
    state = RoomState()
    promoted, needs_broadcast = state.elect_host_on_join("a", is_gm=False)
    assert (promoted, needs_broadcast) == (True, False)  # no one else to notify
    assert state.host_peer_id == "a"


def test_elect_host_on_join_non_gm_joining_an_already_hosted_room_does_not_become_host():
    state = RoomState()
    state.host_peer_id = "host"
    promoted, needs_broadcast = state.elect_host_on_join("guest", is_gm=False)
    assert (promoted, needs_broadcast) == (False, False)
    assert state.host_peer_id == "host"


def test_elect_host_on_join_gm_takes_over_from_a_different_existing_host():
    state = RoomState()
    state.host_peer_id = "temp-host"
    promoted, needs_broadcast = state.elect_host_on_join("gm", is_gm=True)
    assert (promoted, needs_broadcast) == (True, True)  # temp-host needs a host-changed
    assert state.host_peer_id == "gm"


def test_elect_host_on_join_gm_joining_an_empty_room_is_the_plain_first_join_case():
    state = RoomState()
    promoted, needs_broadcast = state.elect_host_on_join("gm", is_gm=True)
    assert (promoted, needs_broadcast) == (True, False)  # nobody was hosting to displace
    assert state.host_peer_id == "gm"


def test_elect_host_on_join_gm_is_already_host_rejoining_changes_nothing():
    state = RoomState()
    state.host_peer_id = "gm"
    promoted, needs_broadcast = state.elect_host_on_join("gm", is_gm=True)
    assert (promoted, needs_broadcast) == (False, False)
    assert state.host_peer_id == "gm"


# --- _handle_message ---


def test_offer_is_relayed_only_to_the_named_target_with_from_set():
    state = RoomState()
    sender = make_peer("sender")
    target = make_peer("target")
    bystander = make_peer("bystander")
    state.peers = {"sender": sender, "target": target, "bystander": bystander}

    asyncio.run(signaling._handle_message(state, sender, {"type": "offer", "to": "target", "sdp": "xyz"}))

    assert target.ws.sent == [{"type": "offer", "to": "target", "sdp": "xyz", "from": "sender"}]
    assert bystander.ws.sent == []
    assert sender.ws.sent == []


def test_answer_and_ice_relay_the_same_way_as_offer():
    state = RoomState()
    sender, target = make_peer("sender"), make_peer("target")
    state.peers = {"sender": sender, "target": target}

    asyncio.run(signaling._handle_message(state, sender, {"type": "answer", "to": "target", "sdp": "a"}))
    asyncio.run(signaling._handle_message(state, sender, {"type": "ice", "to": "target", "candidate": "c"}))

    assert target.ws.sent == [
        {"type": "answer", "to": "target", "sdp": "a", "from": "sender"},
        {"type": "ice", "to": "target", "candidate": "c", "from": "sender"},
    ]


def test_relay_to_an_unknown_target_is_silently_ignored():
    state = RoomState()
    sender = make_peer("sender")
    state.peers = {"sender": sender}

    # must not raise
    asyncio.run(signaling._handle_message(state, sender, {"type": "offer", "to": "ghost", "sdp": "x"}))
    assert sender.ws.sent == []


def test_snapshot_from_the_host_is_stored():
    state = RoomState()
    host = make_peer("host")
    state.peers = {"host": host}
    state.host_peer_id = "host"

    asyncio.run(signaling._handle_message(state, host, {"type": "snapshot", "blob": {"cards": [1, 2]}}))

    assert state.snapshot == {"cards": [1, 2]}


def test_snapshot_from_a_non_host_peer_is_ignored():
    state = RoomState()
    host, guest = make_peer("host"), make_peer("guest")
    state.peers = {"host": host, "guest": guest}
    state.host_peer_id = "host"

    asyncio.run(signaling._handle_message(state, guest, {"type": "snapshot", "blob": {"sneaky": True}}))

    assert state.snapshot is None


def test_relay_message_forwards_opaque_payload():
    state = RoomState()
    sender, target = make_peer("sender"), make_peer("target")
    state.peers = {"sender": sender, "target": target}

    asyncio.run(
        signaling._handle_message(state, sender, {"type": "relay", "to": "target", "payload": {"anything": 1}})
    )

    assert target.ws.sent == [{"type": "relay", "from": "sender", "payload": {"anything": 1}}]


def test_promote_ack_is_a_no_op():
    state = RoomState()
    sender = make_peer("sender")
    state.peers = {"sender": sender}
    asyncio.run(signaling._handle_message(state, sender, {"type": "promote-ack"}))
    assert sender.ws.sent == []


def test_unknown_message_type_is_ignored_without_raising():
    state = RoomState()
    sender = make_peer("sender")
    state.peers = {"sender": sender}
    asyncio.run(signaling._handle_message(state, sender, {"type": "made-up-nonsense"}))
    assert sender.ws.sent == []


# --- set-presence: color + eyes-closed, presence metadata over the signaling WS ---


def test_peer_default_color_comes_from_the_palette():
    for _ in range(50):  # random.choice — sample enough to catch a bad palette/typo
        peer = make_peer("p")
        assert peer.color in signaling.DEFAULT_COLOR_PALETTE


def test_peer_starts_with_eyes_open():
    assert make_peer("p").eyes_closed is False


def test_set_presence_updates_color_and_broadcasts_to_everyone_including_the_sender():
    state = RoomState()
    sender = make_peer("sender")
    bystander = make_peer("bystander")
    state.peers = {"sender": sender, "bystander": bystander}

    asyncio.run(signaling._handle_message(state, sender, {"type": "set-presence", "color": "#123abc"}))

    assert sender.color == "#123abc"
    expected = {
        "type": "presence-changed",
        "peerId": "sender",
        "name": "sender",
        "isGM": False,
        "color": "#123abc",
        "eyesClosed": False,
        "tokenX": None,
        "tokenY": None,
    }
    assert sender.ws.sent == [expected]
    assert bystander.ws.sent == [expected]


def test_set_presence_rejects_a_malformed_color_and_keeps_the_previous_one():
    state = RoomState()
    sender = make_peer("sender")
    sender.color = "#000000"
    state.peers = {"sender": sender}

    for bad in ["red", "#12345", "#gggggg", "123abc", "#12345678"]:
        asyncio.run(signaling._handle_message(state, sender, {"type": "set-presence", "color": bad}))
        assert sender.color == "#000000", f"{bad!r} should have been rejected"


def test_set_presence_toggles_eyes_closed():
    state = RoomState()
    sender = make_peer("sender")
    state.peers = {"sender": sender}

    asyncio.run(signaling._handle_message(state, sender, {"type": "set-presence", "eyesClosed": True}))
    assert sender.eyes_closed is True

    asyncio.run(signaling._handle_message(state, sender, {"type": "set-presence", "eyesClosed": False}))
    assert sender.eyes_closed is False


def test_set_presence_ignores_a_non_boolean_eyes_closed():
    state = RoomState()
    sender = make_peer("sender")
    state.peers = {"sender": sender}

    asyncio.run(signaling._handle_message(state, sender, {"type": "set-presence", "eyesClosed": "yes"}))
    assert sender.eyes_closed is False


def test_set_presence_with_neither_field_still_broadcasts_current_presence():
    # Harmless no-op update — still confirms the broadcast always reflects live state.
    state = RoomState()
    sender = make_peer("sender", is_gm=True)
    state.peers = {"sender": sender}

    asyncio.run(signaling._handle_message(state, sender, {"type": "set-presence"}))

    assert sender.ws.sent == [
        {"type": "presence-changed", "peerId": "sender", "name": "sender", "isGM": True,
         "color": sender.color, "eyesClosed": False, "tokenX": None, "tokenY": None}
    ]


def test_player_can_move_only_own_token_but_gm_can_move_any_token():
    state = RoomState()
    player = make_peer("player")
    gm = make_peer("gm", is_gm=True)
    state.peers = {"player": player, "gm": gm}

    asyncio.run(signaling._handle_message(state, player, {"type": "set-player-token", "peerId": "player", "x": 12, "y": -4}))
    assert (player.token_x, player.token_y) == (12.0, -4.0)

    asyncio.run(signaling._handle_message(state, player, {"type": "set-player-token", "peerId": "gm", "x": 1, "y": 2}))
    assert (gm.token_x, gm.token_y) == (None, None)

    asyncio.run(signaling._handle_message(state, gm, {"type": "set-player-token", "peerId": "player", "x": 1, "y": 2}))
    assert (player.token_x, player.token_y) == (1.0, 2.0)


# --- _handle_disconnect ---


def test_disconnect_of_a_non_host_peer_just_broadcasts_peer_left():
    state = RoomState()
    host, guest = make_peer("host"), make_peer("guest")
    state.peers = {"host": host, "guest": guest}
    state.host_peer_id = "host"

    asyncio.run(signaling._handle_disconnect(state, "guest"))

    assert "guest" not in state.peers
    assert state.host_peer_id == "host"
    assert host.ws.sent == [{"type": "peer-left", "peerId": "guest"}]


def test_disconnect_of_the_host_promotes_a_gm_and_notifies_everyone():
    state = RoomState()
    host = make_peer("host")
    gm = make_peer("gm", is_gm=True, joined_at=100)  # joined late, but is GM
    other = make_peer("other", joined_at=1)
    state.peers = {"host": host, "gm": gm, "other": other}
    state.host_peer_id = "host"
    state.snapshot = {"table": "state"}

    asyncio.run(signaling._handle_disconnect(state, "host"))

    assert state.host_peer_id == "gm"
    assert "host" not in state.peers

    # the promoted GM gets peer-left (broadcast to all *remaining* peers) then you-are-host
    assert gm.ws.sent == [
        {"type": "peer-left", "peerId": "host"},
        {"type": "you-are-host", "snapshot": {"table": "state"}},
    ]
    # everyone else hears peer-left and host-changed, but is never told they're host
    assert other.ws.sent == [
        {"type": "peer-left", "peerId": "host"},
        {"type": "host-changed", "hostPeerId": "gm"},
    ]
    assert all(m["type"] != "you-are-host" for m in other.ws.sent)


def test_disconnect_of_the_last_peer_clears_host_but_keeps_the_snapshot():
    # The snapshot deliberately survives the room going momentarily empty — the common
    # way this happens is the sole player reloading (or briefly closing) their own tab,
    # and they should resume where they left off rather than finding an empty table.
    state = RoomState()
    host = make_peer("host")
    state.peers = {"host": host}
    state.host_peer_id = "host"
    state.snapshot = {"table": "state"}

    asyncio.run(signaling._handle_disconnect(state, "host"))

    assert state.peers == {}
    assert state.host_peer_id is None
    assert state.snapshot == {"table": "state"}


def test_disconnect_of_the_last_peer_in_an_anonymous_room_discards_it_completely():
    # D19: the opposite of the accounted-room case above — an anonymous room has no
    # server-side recovery to preserve in the first place (its client never uploads a
    # snapshot at all) and no dashboard listing anyone could use to find it again, so
    # an empty one is discarded outright rather than kept around.
    import app.rooms as rooms_module

    slug = "anon-room-under-test"
    rooms_module._anonymous_rooms[slug] = rooms_module.AnonymousRoom(
        slug=slug, name="Pickup", game_def_ref="bundled:generic-freeform", password_hash=None, created_at="now"
    )
    state = RoomState(slug=slug, is_anonymous=True)
    host = make_peer("host")
    state.peers = {"host": host}
    state.host_peer_id = "host"
    state.snapshot = {"table": "state"}  # shouldn't matter either way — it's discarded
    signaling._rooms[slug] = state

    asyncio.run(signaling._handle_disconnect(state, "host"))

    assert slug not in rooms_module._anonymous_rooms
    assert slug not in signaling._rooms


def test_rejoining_an_emptied_room_resumes_from_the_kept_snapshot():
    state = RoomState()
    host = make_peer("host")
    state.peers = {"host": host}
    state.host_peer_id = "host"
    state.snapshot = {"table": "state"}
    asyncio.run(signaling._handle_disconnect(state, "host"))
    assert state.host_peer_id is None  # room is momentarily empty

    promoted, needs_broadcast = state.elect_host_on_join("host", is_gm=False)

    assert (promoted, needs_broadcast) == (True, False)
    assert state.host_peer_id == "host"
    assert state.snapshot == {"table": "state"}  # still there for the `you-are-host` reply


# --- End-to-end protocol, over real (in-process) WebSocket frames ---


def _join(client, slug: str, name: str) -> dict:
    return client.post(f"/api/rooms/{slug}/join", json={"display_name": name}).json()


def test_ws_rejects_an_unknown_room(client):
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect("/ws/room/does-not-exist?token=whatever"):
            pass
    assert exc_info.value.code == 4404


def test_ws_rejects_an_invalid_token(admin_client):
    slug = admin_client.post("/api/rooms", json={"name": "R"}).json()["slug"]
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with admin_client.websocket_connect(f"/ws/room/{slug}?token=garbage"):
            pass
    assert exc_info.value.code == 4401


def test_ws_rejects_a_token_issued_for_a_different_room(admin_client):
    slug_a = admin_client.post("/api/rooms", json={"name": "A"}).json()["slug"]
    slug_b = admin_client.post("/api/rooms", json={"name": "B"}).json()["slug"]
    token_for_a = _join(admin_client, slug_a, "Alice")["token"]
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with admin_client.websocket_connect(f"/ws/room/{slug_b}?token={token_for_a}"):
            pass
    assert exc_info.value.code == 4401


def test_ws_first_connection_becomes_host_and_room_owner_is_attested_as_gm(admin_client):
    slug = admin_client.post("/api/rooms", json={"name": "R"}).json()["slug"]
    join = _join(admin_client, slug, "GM Alice")

    with admin_client.websocket_connect(f"/ws/room/{slug}?token={join['token']}") as ws:
        welcome = ws.receive_json()
        assert welcome["type"] == "welcome"
        assert welcome["hostPeerId"] == welcome["peerId"]
        assert welcome["gmPeerId"] == welcome["peerId"]
        assert welcome["roomInfo"]["slug"] == slug

        you_are_host = ws.receive_json()
        assert you_are_host == {"type": "you-are-host", "snapshot": None}


def test_ws_welcome_includes_the_joiners_own_presence_so_it_learns_its_real_color(admin_client):
    # A joiner is never told about itself via peer-joined (that broadcast excludes the
    # peer it's about — see app/signaling.py), so without this it had no way to learn
    # the random color the server actually assigned it.
    slug = admin_client.post("/api/rooms", json={"name": "R"}).json()["slug"]
    join = _join(admin_client, slug, "Alice")

    with admin_client.websocket_connect(f"/ws/room/{slug}?token={join['token']}") as ws:
        welcome = ws.receive_json()
        assert welcome["self"]["peerId"] == welcome["peerId"]
        assert welcome["self"]["name"] == "Alice"
        assert welcome["self"]["color"] in signaling.DEFAULT_COLOR_PALETTE


def test_ws_a_guest_without_the_owners_session_is_not_attested_as_gm(admin_client, second_client):
    slug = admin_client.post("/api/rooms", json={"name": "R"}).json()["slug"]
    join = _join(second_client, slug, "Bob")  # `second_client` has no session at all

    with second_client.websocket_connect(f"/ws/room/{slug}?token={join['token']}") as ws:
        welcome = ws.receive_json()
        assert welcome["gmPeerId"] is None
        assert welcome["hostPeerId"] == welcome["peerId"]  # still becomes host, just not GM


def test_ws_peer_joined_is_broadcast_to_existing_peers_only(admin_client, second_client):
    slug = admin_client.post("/api/rooms", json={"name": "R"}).json()["slug"]
    join1 = _join(admin_client, slug, "Alice")
    join2 = _join(second_client, slug, "Bob")

    with admin_client.websocket_connect(f"/ws/room/{slug}?token={join1['token']}") as ws1:
        welcome1 = ws1.receive_json()
        ws1.receive_json()  # you-are-host

        with second_client.websocket_connect(f"/ws/room/{slug}?token={join2['token']}") as ws2:
            welcome2 = ws2.receive_json()
            assert welcome2["hostPeerId"] == welcome1["peerId"], "Bob should not become host — Alice already is"

            joined_evt = ws1.receive_json()
            assert joined_evt["type"] == "peer-joined"
            assert joined_evt["peerId"] == welcome2["peerId"]
            assert joined_evt["name"] == "Bob"
            assert joined_evt["isGM"] is False


def test_ws_gm_joining_after_a_temporary_host_takes_over_immediately(admin_client, second_client):
    # D13: the room's creator (GM) is always host when connected. Bob (no session,
    # so not the GM) opens the link first and becomes a temporary host; once Alice
    # (the actual room owner) joins, hosting must move to her immediately.
    slug = admin_client.post("/api/rooms", json={"name": "R"}).json()["slug"]
    join_bob = _join(second_client, slug, "Bob")
    join_alice = _join(admin_client, slug, "Alice")

    with second_client.websocket_connect(f"/ws/room/{slug}?token={join_bob['token']}") as ws_bob:
        welcome_bob = ws_bob.receive_json()
        assert welcome_bob["hostPeerId"] == welcome_bob["peerId"], "Bob is host until the GM shows up"
        assert ws_bob.receive_json() == {"type": "you-are-host", "snapshot": None}

        with admin_client.websocket_connect(f"/ws/room/{slug}?token={join_alice['token']}") as ws_alice:
            welcome_alice = ws_alice.receive_json()
            assert welcome_alice["hostPeerId"] == welcome_alice["peerId"], "the GM takes over even though she joined second"
            assert welcome_alice["gmPeerId"] == welcome_alice["peerId"]
            assert ws_alice.receive_json() == {"type": "you-are-host", "snapshot": None}

            # Bob hears about Alice's presence and, separately, that hosting moved to
            # her — order between the two isn't asserted, just that both arrived and
            # neither claims Bob is still host.
            events = [ws_bob.receive_json(), ws_bob.receive_json()]
            assert {e["type"] for e in events} == {"peer-joined", "host-changed"}
            host_changed = next(e for e in events if e["type"] == "host-changed")
            assert host_changed["hostPeerId"] == welcome_alice["peerId"]


def test_ws_gm_joining_an_empty_room_first_still_just_becomes_host_normally(admin_client):
    # The plain case (GM opens their own room first) shouldn't get an extra, spurious
    # host-changed broadcast — there was no one else hosting to displace.
    slug = admin_client.post("/api/rooms", json={"name": "R"}).json()["slug"]
    join = _join(admin_client, slug, "Alice")

    with admin_client.websocket_connect(f"/ws/room/{slug}?token={join['token']}") as ws:
        welcome = ws.receive_json()
        assert welcome["hostPeerId"] == welcome["peerId"]
        assert ws.receive_json() == {"type": "you-are-host", "snapshot": None}
        # nothing else should arrive unprompted


def test_ws_welcome_lists_every_already_connected_peer_so_a_joiner_sees_them_immediately(admin_client, second_client):
    slug = admin_client.post("/api/rooms", json={"name": "R"}).json()["slug"]
    join1 = _join(admin_client, slug, "Alice")
    join2 = _join(second_client, slug, "Bob")

    with admin_client.websocket_connect(f"/ws/room/{slug}?token={join1['token']}") as ws1:
        welcome1 = ws1.receive_json()
        assert welcome1["peers"] == []  # Alice is first; no one else here yet
        ws1.receive_json()  # you-are-host

        with second_client.websocket_connect(f"/ws/room/{slug}?token={join2['token']}") as ws2:
            welcome2 = ws2.receive_json()
            assert len(welcome2["peers"]) == 1
            assert welcome2["peers"][0]["peerId"] == welcome1["peerId"]
            assert welcome2["peers"][0]["name"] == "Alice"
            assert "color" in welcome2["peers"][0]
            assert welcome2["peers"][0]["eyesClosed"] is False
            # and it should not list Bob himself
            assert all(p["peerId"] != welcome2["peerId"] for p in welcome2["peers"])


def test_ws_set_presence_round_trips_to_other_connected_peers(admin_client, second_client):
    slug = admin_client.post("/api/rooms", json={"name": "R"}).json()["slug"]
    join1 = _join(admin_client, slug, "Alice")
    join2 = _join(second_client, slug, "Bob")

    with admin_client.websocket_connect(f"/ws/room/{slug}?token={join1['token']}") as ws1:
        ws1.receive_json()  # welcome
        ws1.receive_json()  # you-are-host

        with second_client.websocket_connect(f"/ws/room/{slug}?token={join2['token']}") as ws2:
            ws2.receive_json()  # welcome
            ws1.receive_json()  # peer-joined

            ws2.send_json({"type": "set-presence", "color": "#00ff00", "eyesClosed": True})

            update_on_1 = ws1.receive_json()
            update_on_2 = ws2.receive_json()  # the sender also gets the canonical broadcast
            assert update_on_1 == update_on_2
            assert update_on_1["type"] == "presence-changed"
            assert update_on_1["color"] == "#00ff00"
            assert update_on_1["eyesClosed"] is True


def test_ws_offer_answer_relay_end_to_end(admin_client, second_client):
    slug = admin_client.post("/api/rooms", json={"name": "R"}).json()["slug"]
    join1 = _join(admin_client, slug, "Alice")
    join2 = _join(second_client, slug, "Bob")

    with admin_client.websocket_connect(f"/ws/room/{slug}?token={join1['token']}") as ws1:
        welcome1 = ws1.receive_json()
        ws1.receive_json()  # you-are-host

        with second_client.websocket_connect(f"/ws/room/{slug}?token={join2['token']}") as ws2:
            welcome2 = ws2.receive_json()
            ws1.receive_json()  # peer-joined

            ws2.send_json({"type": "offer", "to": welcome1["peerId"], "sdp": "fake-sdp"})
            offer = ws1.receive_json()
            assert offer == {"type": "offer", "to": welcome1["peerId"], "sdp": "fake-sdp", "from": welcome2["peerId"]}

            ws1.send_json({"type": "answer", "to": welcome2["peerId"], "sdp": "fake-answer"})
            answer = ws2.receive_json()
            assert answer == {
                "type": "answer",
                "to": welcome2["peerId"],
                "sdp": "fake-answer",
                "from": welcome1["peerId"],
            }


def test_ws_host_migration_end_to_end_with_snapshot_recovery(admin_client, second_client):
    # NOTE: both sessions must go through proper `with` blocks. Calling .__enter__()
    # directly (an earlier version of this test did) skips .__exit__(), which is the
    # only thing that ever cancels that session's background anyio task — the task
    # parks in `sleep_forever()` after the connection ends, waiting to be cancelled, so
    # skipping __exit__ leaks a thread that never terminates and hangs the whole test
    # process at interpreter shutdown. Simulating "the host disconnects" mid-block by
    # calling ws1.close() *inside* its `with` is fine; its __exit__ closing an
    # already-closed session again afterward is harmless.
    slug = admin_client.post("/api/rooms", json={"name": "R"}).json()["slug"]
    join1 = _join(admin_client, slug, "Alice")
    join2 = _join(second_client, slug, "Bob")

    with admin_client.websocket_connect(f"/ws/room/{slug}?token={join1['token']}") as ws1:
        ws1.receive_json()  # welcome
        ws1.receive_json()  # you-are-host

        with second_client.websocket_connect(f"/ws/room/{slug}?token={join2['token']}") as ws2:
            ws2.receive_json()  # welcome
            ws1.receive_json()  # peer-joined

            ws1.send_json({"type": "snapshot", "blob": {"cards": ["a", "b"]}})
            ws1.close()

            left = ws2.receive_json()
            assert left["type"] == "peer-left"
            promoted = ws2.receive_json()
            assert promoted == {"type": "you-are-host", "snapshot": {"cards": ["a", "b"]}}


def test_ws_reloading_as_the_sole_player_resumes_from_the_last_snapshot_instead_of_resetting(admin_client):
    # The regression this guards: reloading (or briefly closing) the only open tab in a
    # room used to wipe app.signaling's in-memory snapshot the instant the room went
    # empty, so reopening it always started from a blank table even though nothing else
    # in the session had actually asked for a fresh start.
    slug = admin_client.post("/api/rooms", json={"name": "R"}).json()["slug"]
    join = _join(admin_client, slug, "Alice")

    with admin_client.websocket_connect(f"/ws/room/{slug}?token={join['token']}") as ws1:
        ws1.receive_json()  # welcome
        ws1.receive_json()  # you-are-host
        ws1.send_json({"type": "snapshot", "blob": {"cards": ["a", "b"]}})
        ws1.close()

    # Reconnecting (simulating a page reload) with the same guest token re-joins the
    # now-empty room.
    with admin_client.websocket_connect(f"/ws/room/{slug}?token={join['token']}") as ws2:
        welcome = ws2.receive_json()
        assert welcome["hostPeerId"] == welcome["peerId"]
        resumed = ws2.receive_json()
        assert resumed == {"type": "you-are-host", "snapshot": {"cards": ["a", "b"]}}


# --- Anonymous rooms (docs/DECISIONS.md D19) ---


def test_ws_anonymous_room_has_no_gm_ever(client):
    slug = client.post("/api/rooms/anonymous", json={"name": "Pickup"}).json()["slug"]
    join = _join(client, slug, "Alice")

    with client.websocket_connect(f"/ws/room/{slug}?token={join['token']}") as ws:
        welcome = ws.receive_json()
        assert welcome["gmPeerId"] is None
        assert welcome["hostPeerId"] == welcome["peerId"]  # still becomes host, just never GM
        assert welcome["roomInfo"]["isAnonymous"] is True
        assert ws.receive_json() == {"type": "you-are-host", "snapshot": None}


def test_ws_accounted_room_roominfo_says_not_anonymous(admin_client):
    slug = admin_client.post("/api/rooms", json={"name": "R"}).json()["slug"]
    join = _join(admin_client, slug, "Alice")

    with admin_client.websocket_connect(f"/ws/room/{slug}?token={join['token']}") as ws:
        welcome = ws.receive_json()
        assert welcome["roomInfo"]["isAnonymous"] is False
        ws.receive_json()  # you-are-host


def test_ws_anonymous_room_second_joiner_never_displaces_the_first_host(client, second_client):
    # Without a GM, D13's "the GM always takes over" re-election never triggers — a
    # later joiner in an anonymous room is just an ordinary peer, always.
    slug = client.post("/api/rooms/anonymous", json={"name": "Pickup"}).json()["slug"]
    join1 = _join(client, slug, "Alice")
    join2 = _join(second_client, slug, "Bob")

    with client.websocket_connect(f"/ws/room/{slug}?token={join1['token']}") as ws1:
        welcome1 = ws1.receive_json()
        ws1.receive_json()  # you-are-host

        with second_client.websocket_connect(f"/ws/room/{slug}?token={join2['token']}") as ws2:
            welcome2 = ws2.receive_json()
            assert welcome2["hostPeerId"] == welcome1["peerId"]

            joined = ws1.receive_json()
            assert joined["type"] == "peer-joined"  # no host-changed follows it


def test_ws_anonymous_room_is_gone_once_everyone_leaves(client):
    slug = client.post("/api/rooms/anonymous", json={"name": "Pickup"}).json()["slug"]
    join = _join(client, slug, "Alice")

    with client.websocket_connect(f"/ws/room/{slug}?token={join['token']}") as ws:
        ws.receive_json()  # welcome
        ws.receive_json()  # you-are-host

    # A fresh join attempt against the same (now-abandoned) slug 404s — the room and
    # everything about it is completely gone, not just temporarily hostless.
    r = client.post(f"/api/rooms/{slug}/join", json={"display_name": "Bob"})
    assert r.status_code == 404
