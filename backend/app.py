"""FastAPI backend for a lightweight online study room."""

from __future__ import annotations

import asyncio
import time
from typing import Dict, List, Optional, Set

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, validator


class RoomConfig(BaseModel):
    """Payload used to create or update a room."""

    room_id: str = Field(..., min_length=3, max_length=32)
    goal: str = Field(default="")
    timer_length: int = Field(default=25 * 60, ge=60, le=120 * 60)
    break_length: int = Field(default=5 * 60, ge=60, le=30 * 60)

    @validator("room_id")
    def room_id_slug(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned.isalnum():
            raise ValueError("room_id must be alphanumeric.")
        return cleaned.lower()


class RoomState(BaseModel):
    """Current public state of a room."""

    room_id: str
    goal: str
    timer_length: int
    break_length: int
    remaining: int
    status: str
    cycle: str
    participants: List[str]
    media_states: Dict[str, Dict[str, bool]] = Field(default_factory=dict)
    leaderboard: List[Dict[str, int]] = Field(default_factory=list)
    updated_at: float


class Room:
    """Represents a single study room with timer and chat state."""

    def __init__(self, config: RoomConfig):
        self.room_id = config.room_id
        self.goal = config.goal
        self.timer_length = config.timer_length
        self.break_length = config.break_length
        self.status = "idle"  # idle | running | paused
        self.cycle = "focus"  # focus | break
        self.remaining = self.timer_length
        self.updated_at = time.time()
        self.participants: Dict[str, float] = {}
        self.clients: Set[WebSocket] = set()
        self.user_sockets: Dict[str, WebSocket] = {}
        self.media_states: Dict[str, Dict[str, bool]] = {}
        self.timer_task: Optional[asyncio.Task] = None
        self.lock = asyncio.Lock()

    async def apply_config(self, config: RoomConfig) -> None:
        async with self.lock:
            self.goal = config.goal
            self.timer_length = config.timer_length
            self.break_length = config.break_length
            if self.cycle == "focus":
                self.remaining = min(self.remaining, self.timer_length)
            else:
                self.remaining = min(self.remaining, self.break_length)
            self.updated_at = time.time()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self.lock:
            self.clients.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self.lock:
            self.clients.discard(websocket)
            for user, ws in list(self.user_sockets.items()):
                if ws is websocket:
                    self.user_sockets.pop(user, None)
                    break

    async def add_participant(self, name: str) -> None:
        async with self.lock:
            self.participants[name] = time.time()

    async def remove_participant(self, name: str) -> None:
        async with self.lock:
            self.participants.pop(name, None)
            self.media_states.pop(name, None)
            self.user_sockets.pop(name, None)

    async def pause(self, user: str) -> None:
        async with self.lock:
            if self.status != "running":
                return
            self.status = "paused"
            self.updated_at = time.time()
            if self.timer_task:
                self.timer_task.cancel()
                self.timer_task = None
        await self.broadcast({"type": "event", "event": "timer:pause", "user": user})
        await self.broadcast_state()

    async def reset(self, user: str) -> None:
        async with self.lock:
            if self.timer_task:
                self.timer_task.cancel()
                self.timer_task = None
            self.cycle = "focus"
            self.status = "idle"
            self.remaining = self.timer_length
            self.updated_at = time.time()
        await self.broadcast({"type": "event", "event": "timer:reset", "user": user})
        await self.broadcast_state()

    async def skip_break(self, user: str) -> None:
        async with self.lock:
            if self.cycle != "break":
                return
            if self.timer_task:
                self.timer_task.cancel()
                self.timer_task = None
            self.cycle = "focus"
            self.status = "idle"
            self.remaining = self.timer_length
            self.updated_at = time.time()
        await self.broadcast({"type": "event", "event": "timer:skip_break", "user": user})
        await self.broadcast_state()

    async def start_focus(self, user: str) -> None:
        async with self.lock:
            if self.timer_task:
                self.timer_task.cancel()
            if self.cycle != "focus":
                self.cycle = "focus"
                self.remaining = self.timer_length
            elif self.status == "idle":
                self.remaining = self.timer_length
            self.status = "running"
            self.updated_at = time.time()
            self.timer_task = asyncio.create_task(self._timer_loop())
        await self.broadcast({"type": "event", "event": "timer:start_focus", "user": user})
        await self.broadcast_state()

    async def start_break(self, user: str) -> None:
        async with self.lock:
            if self.timer_task:
                self.timer_task.cancel()
            self.cycle = "break"
            self.status = "running"
            self.remaining = self.break_length
            self.updated_at = time.time()
            self.timer_task = asyncio.create_task(self._timer_loop())
        await self.broadcast({"type": "event", "event": "timer:start_break", "user": user})
        await self.broadcast_state()

    async def _timer_loop(self) -> None:
        try:
            while True:
                async with self.lock:
                    if self.status != "running":
                        self.timer_task = None
                        return
                    remaining = self.remaining
                    cycle = self.cycle
                if remaining <= 0:
                    proceed = await self._advance_cycle()
                    if not proceed:
                        return
                    continue
                await asyncio.sleep(1)
                async with self.lock:
                    if self.status != "running":
                        self.timer_task = None
                        return
                    self.remaining = max(0, self.remaining - 1)
                    remaining = self.remaining
                if remaining % 5 == 0 or remaining <= 10:
                    await self.broadcast_state()
        except asyncio.CancelledError:
            pass
        finally:
            async with self.lock:
                if self.timer_task and self.timer_task.done():
                    self.timer_task = None

    async def _advance_cycle(self) -> bool:
        async with self.lock:
            if self.cycle == "focus":
                self.cycle = "break"
                self.status = "running"
                self.remaining = self.break_length
                self.updated_at = time.time()
                continue_running = True
                event = "timer:break_auto"
            else:
                self.cycle = "focus"
                self.status = "idle"
                self.remaining = self.timer_length
                self.updated_at = time.time()
                continue_running = False
                event = "timer:cycle_complete"
        await self.broadcast({"type": "event", "event": event})
        await self.broadcast_state()
        return continue_running

    async def serialize(self) -> RoomState:
        async with self.lock:
            return RoomState(
                room_id=self.room_id,
                goal=self.goal,
                timer_length=self.timer_length,
                break_length=self.break_length,
                remaining=self.remaining,
                status=self.status,
                cycle=self.cycle,
                participants=sorted(self.participants.keys()),
                media_states={k: dict(v) for k, v in self.media_states.items()},
                updated_at=self.updated_at,
            )

    async def broadcast_state(self) -> None:
        state = await self.serialize()
        await self.broadcast({"type": "state", "data": state.dict()})

    async def broadcast(self, payload: dict) -> None:
        dead: List[WebSocket] = []
        async with self.lock:
            targets = list(self.clients)
        for ws in targets:
            try:
                await ws.send_json(payload)
            except WebSocketDisconnect:
                dead.append(ws)
        for ws in dead:
            await self.disconnect(ws)

    async def send_to_user(self, user: str, payload: dict) -> None:
        async with self.lock:
            target = self.user_sockets.get(user)
        if not target:
            return
        try:
            await target.send_json(payload)
        except WebSocketDisconnect:
            await self.disconnect(target)

    async def register_socket(self, user: str, websocket: WebSocket) -> None:
        async with self.lock:
            self.user_sockets[user] = websocket

    async def update_media_state(self, user: str, media: Optional[Dict[str, bool]]) -> Dict[str, bool]:
        defaults = {"audio": False, "video": False, "screen": False}
        media = media or {}
        normalized = {
            "audio": bool(media.get("audio")),
            "video": bool(media.get("video")),
            "screen": bool(media.get("screen")),
        }
        async with self.lock:
            self.media_states[user] = normalized
            snapshot = dict(self.media_states[user])
        return snapshot


class RoomManager:
    """Keeps track of multiple rooms."""

    def __init__(self) -> None:
        self.rooms: Dict[str, Room] = {}
        self.lock = asyncio.Lock()

    async def upsert(self, config: RoomConfig) -> Room:
        async with self.lock:
            room = self.rooms.get(config.room_id)
            if room:
                await room.apply_config(config)
            else:
                room = Room(config)
                self.rooms[config.room_id] = room
            return room

    async def get(self, room_id: str) -> Room:
        async with self.lock:
            room = self.rooms.get(room_id)
            if room is None:
                raise KeyError(room_id)
            return room

    async def list_states(self) -> List[RoomState]:
        async with self.lock:
            rooms = list(self.rooms.values())
        return await asyncio.gather(*(room.serialize() for room in rooms))


manager = RoomManager()

app = FastAPI(title="Online Study Room API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class RoomCreateRequest(RoomConfig):
    pass


class Message(BaseModel):
    type: str
    user: Optional[str] = None
    text: Optional[str] = None
    goal: Optional[str] = None
    target: Optional[str] = None
    sdp: Optional[dict] = None
    candidate: Optional[dict] = None
    media: Optional[Dict[str, bool]] = None


@app.post("/rooms", response_model=RoomState)
async def create_room(payload: RoomCreateRequest) -> RoomState:
    room = await manager.upsert(payload)
    return await room.serialize()


@app.get("/rooms", response_model=List[RoomState])
async def list_rooms() -> List[RoomState]:
    return await manager.list_states()


@app.get("/rooms/{room_id}", response_model=RoomState)
async def get_room(room_id: str) -> RoomState:
    try:
        room = await manager.get(room_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Room not found") from exc
    return await room.serialize()


@app.post("/rooms/{room_id}/reset", response_model=RoomState)
async def reset_room(room_id: str, user: str = "system") -> RoomState:
    try:
        room = await manager.get(room_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Room not found") from exc
    await room.reset(user=user)
    return await room.serialize()


@app.websocket("/ws/rooms/{room_id}")
async def room_socket(websocket: WebSocket, room_id: str) -> None:
    try:
        room = await manager.get(room_id)
    except KeyError:
        config = RoomConfig(room_id=room_id)
        room = await manager.upsert(config)

    await room.connect(websocket)
    await room.broadcast_state()

    user_name = f"guest-{int(time.time())}"

    try:
        while True:
            try:
                raw = await websocket.receive_json()
            except RuntimeError as exc:
                # Starlette raises RuntimeError instead of WebSocketDisconnect
                # when the client disappears before we can accept / read.
                message = str(exc)
                if "WebSocket is not connected" in message:
                    raise WebSocketDisconnect() from exc
                raise
            message = Message(**raw)
            user = message.user or user_name

            if message.type == "join":
                user_name = user
                await room.add_participant(user)
                await room.register_socket(user, websocket)
                await room.broadcast({"type": "event", "event": "user:join", "user": user})
                await room.broadcast_state()
            elif message.type == "leave":
                await room.remove_participant(user)
                await room.broadcast({"type": "event", "event": "user:leave", "user": user})
                await room.broadcast_state()
            elif message.type == "timer:start_focus":
                await room.start_focus(user=user)
            elif message.type == "timer:start_break":
                await room.start_break(user=user)
            elif message.type == "timer:pause":
                await room.pause(user=user)
            elif message.type == "timer:reset":
                await room.reset(user=user)
            elif message.type == "timer:skip_break":
                await room.skip_break(user=user)
            elif message.type == "chat":
                if not message.text:
                    continue
                payload = {
                    "type": "chat",
                    "user": user,
                    "text": message.text.strip(),
                    "ts": time.time(),
                }
                await room.broadcast(payload)
            elif message.type == "goal:update":
                goal_text = message.goal or ""
                room.goal = goal_text[:120]
                room.updated_at = time.time()
                await room.broadcast({"type": "event", "event": "goal:update", "goal": room.goal})
                await room.broadcast_state()
            elif message.type == "media:update":
                snapshot = await room.update_media_state(user, message.media)
                payload = {"type": "media:update", "user": user, "media": snapshot}
                await room.broadcast(payload)
            elif message.type in {"webrtc:offer", "webrtc:answer", "webrtc:candidate"}:
                if not message.target:
                    continue
                payload = {
                    "type": message.type,
                    "user": user,
                    "target": message.target,
                    "sdp": message.sdp,
                    "candidate": message.candidate,
                }
                await room.send_to_user(message.target, payload)
    except WebSocketDisconnect:
        await room.disconnect(websocket)
    except RuntimeError as exc:
        # Some uvicorn/starlette versions bubble a RuntimeError instead of
        # WebSocketDisconnect when the client closes the tab abruptly.
        if "WebSocket is not connected" not in str(exc):
            raise
        await room.disconnect(websocket)
    finally:
        await room.remove_participant(user_name)
        await room.broadcast_state()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
