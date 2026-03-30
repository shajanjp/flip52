import { Hono } from "https://deno.land/x/hono@v4.3.11/mod.ts";
import { serveStatic } from "https://deno.land/x/hono@v4.3.11/middleware.ts";
import { upgradeWebSocket } from "https://deno.land/x/hono@v4.3.11/adapter/deno/websocket.ts";

const app = new Hono();
const kv = await Deno.openKv();

interface Player {
  id: string;
  name: string;
  hand: string[];
}

interface RoomData {
  roomId: string;
  hostId: string;
  players: Player[];
  table: { cardId: string; playedBy: string }[];
  discard: string[];
  chat: { name: string; message: string; type: "chat" | "activity"; playerId?: string }[];
  state: "WAITING" | "PLAYING";
  scores: Record<string, number>;
}

const activeConnections = new Map<string, Map<string, WebSocket>>();

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function createDeck() {
  const suits = ["S", "H", "D", "C"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const deck: string[] = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push(`${rank}${suit}`);
    }
  }
  return deck;
}

function shuffle(deck: string[]) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

async function broadcast(roomId: string) {
  const roomRes = await kv.get<RoomData>(["rooms", roomId]);
  const room = roomRes.value;
  if (!room) return;

  const roomWsMap = activeConnections.get(roomId);
  if (!roomWsMap) return;

  const baseState = {
    roomId: room.roomId,
    hostId: room.hostId,
    table: room.table,
    chat: room.chat,
    state: room.state,
    scores: room.scores,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      online: roomWsMap ? roomWsMap.has(p.id) : false
    }))
  };

  for (const player of room.players) {
    const ws = roomWsMap.get(player.id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "ROOM_STATE",
        ...baseState,
        hand: player.hand,
        myId: player.id
      }));
    }
  }
}

// WebSocket Route
app.get(
  "/ws",
  upgradeWebSocket((c) => {
    console.log(`New WS connection attempt from ${c.req.header("user-agent")}`);
    let currentPlayerId: string | null = null;
    let currentRoomId: string | null = null;

    return {
      onOpen: () => {
        console.log("WS Connection opened");
      },
      onMessage: async (event, ws) => {
        const data = JSON.parse(event.data as string);

        switch (data.type) {
          case "CREATE_ROOM": {
            const roomId = generateRoomId();
            const playerId = data.playerId || crypto.randomUUID().substring(0, 8);
            const roomData: RoomData = {
              roomId,
              hostId: playerId,
              players: [{ id: playerId, name: data.name, hand: [] }],
              table: [],
              discard: [],
              chat: [{ name: "System", message: `${data.name} created the room`, type: "activity" }],
              state: "WAITING",
              scores: { [playerId]: 0 }
            };
            
            await kv.set(["rooms", roomId], roomData);
            currentPlayerId = playerId;
            currentRoomId = roomId;
            
            if (!activeConnections.has(roomId)) activeConnections.set(roomId, new Map());
            activeConnections.get(roomId)!.set(playerId, ws as unknown as WebSocket);
            
            ws.send(JSON.stringify({ type: "PLAYER_ID", playerId }));
            broadcast(roomId);
            break;
          }

          case "JOIN_ROOM": {
            const roomRes = await kv.get<RoomData>(["rooms", data.roomId]);
            const room = roomRes.value;
            if (!room) {
              ws.send(JSON.stringify({ type: "ERROR", message: "Room not found" }));
              return;
            }

            let playerId = data.playerId;
            let player = room.players.find(p => p.id === playerId);

            if (!room.scores) room.scores = {};

            if (player) {
              // Reconnecting
              room.chat.push({ name: "System", message: `${player.name} reconnected`, type: "activity" });
            } else {
              if (room.players.length >= 10) {
                ws.send(JSON.stringify({ type: "ERROR", message: "Room full" }));
                return;
              }
              playerId = crypto.randomUUID().substring(0, 8);
              player = { id: playerId, name: data.name, hand: [] };
              room.players.push(player);
              room.scores[playerId] = 0;
              room.chat.push({ name: "System", message: `${data.name} joined the room`, type: "activity" });
            }
            
            await kv.set(["rooms", data.roomId], room);
            currentPlayerId = playerId;
            currentRoomId = data.roomId;
            
            if (!activeConnections.has(data.roomId)) activeConnections.set(data.roomId, new Map());
            activeConnections.get(data.roomId)!.set(playerId, ws as unknown as WebSocket);
            
            ws.send(JSON.stringify({ type: "PLAYER_ID", playerId }));
            broadcast(data.roomId);
            break;
          }

          case "START_GAME": {
            if (!currentRoomId || !currentPlayerId) return;
            const roomRes = await kv.get<RoomData>(["rooms", currentRoomId]);
            const room = roomRes.value;
            if (!room || room.hostId !== currentPlayerId) return;
            if (room.players.length < 2) {
              ws.send(JSON.stringify({ type: "ERROR", message: "Need at least 2 players" }));
              return;
            }

            let deck = createDeck();
            deck = shuffle(deck);
            
            const playerCount = room.players.length;
            const cardsPerPlayer = Math.floor(deck.length / playerCount);
            
            for (let i = 0; i < playerCount; i++) {
              const start = i * cardsPerPlayer;
              const end = i === playerCount - 1 ? deck.length : (i + 1) * cardsPerPlayer;
              room.players[i].hand = deck.slice(start, end);
            }
            
            room.table = [];
            room.discard = [];
            room.chat = [{ name: "System", message: "Game started!", type: "activity" }];
            room.state = "PLAYING";
            
            await kv.set(["rooms", currentRoomId], room);
            broadcast(currentRoomId);
            break;
          }

          case "LEAVE_ROOM": {
            if (!currentRoomId || !currentPlayerId) return;
            const roomRes = await kv.get<RoomData>(["rooms", currentRoomId]);
            const room = roomRes.value;
            if (room) {
              const index = room.players.findIndex(p => p.id === currentPlayerId);
              if (index !== -1) {
                const playerName = room.players[index].name;
                room.players.splice(index, 1);
                
                const roomWsMap = activeConnections.get(currentRoomId);
                if (roomWsMap) roomWsMap.delete(currentPlayerId);

                if (room.players.length === 0) {
                  await kv.delete(["rooms", currentRoomId]);
                  activeConnections.delete(currentRoomId);
                } else {
                  if (room.hostId === currentPlayerId) {
                    room.hostId = room.players[0].id;
                  }
                  room.chat.push({ name: "System", message: `${playerName} left the room`, type: "activity" });
                  await kv.set(["rooms", currentRoomId], room);
                  broadcast(currentRoomId);
                }
              }
            }
            currentPlayerId = null;
            currentRoomId = null;
            break;
          }

          case "UPDATE_SCORE": {
            if (!currentRoomId || !currentPlayerId) return;
            const roomRes = await kv.get<RoomData>(["rooms", currentRoomId]);
            const room = roomRes.value;
            if (!room) return;

            const player = room.players.find(p => p.id === currentPlayerId);
            if (!player) return;

            const targetPlayer = room.players.find(p => p.id === data.targetPlayerId);
            if (!targetPlayer) return;

            if (!room.scores) room.scores = {};
            room.scores[data.targetPlayerId] = data.newScore;
            
            room.chat.push({ 
              name: "System", 
              message: `${player.name} updated ${targetPlayer.name}'s score to ${data.newScore}`, 
              type: "activity" 
            });

            await kv.set(["rooms", currentRoomId], room);
            broadcast(currentRoomId);
            break;
          }

          case "PLAY_CARD":
          case "TAKE_CARD":
          case "DISCARD_CARD":
          case "SEND_CHAT": {
            if (!currentRoomId || !currentPlayerId) return;
            const roomRes = await kv.get<RoomData>(["rooms", currentRoomId]);
            const room = roomRes.value;
            if (!room) return;
            
            const player = room.players.find(p => p.id === currentPlayerId);
            if (!player) return;

            const cardIds = Array.isArray(data.cardIds) ? data.cardIds : (data.cardId ? [data.cardId] : []);

            if (data.type === "PLAY_CARD") {
              for (const cardId of cardIds) {
                const index = player.hand.indexOf(cardId);
                if (index !== -1) {
                  player.hand.splice(index, 1);
                  room.table.push({ cardId, playedBy: player.name });
                  room.chat.push({ name: "System", message: `${player.name} played ${cardId}`, type: "activity" });
                }
              }
            } else if (data.type === "TAKE_CARD") {
              for (const cardId of cardIds) {
                const index = room.table.findIndex(t => t.cardId === cardId);
                if (index !== -1) {
                  room.table.splice(index, 1);
                  player.hand.push(cardId);
                  room.chat.push({ name: "System", message: `${player.name} took ${cardId} from table`, type: "activity" });
                }
              }
            } else if (data.type === "DISCARD_CARD") {
              for (const cardId of cardIds) {
                let index = player.hand.indexOf(cardId);
                if (index !== -1) {
                  player.hand.splice(index, 1);
                  room.discard.push(cardId);
                  room.chat.push({ name: "System", message: `${player.name} discarded ${cardId} from hand`, type: "activity" });
                } else {
                  index = room.table.findIndex(t => t.cardId === cardId);
                  if (index !== -1) {
                    room.table.splice(index, 1);
                    room.discard.push(cardId);
                    room.chat.push({ name: "System", message: `${player.name} discarded ${cardId} from table`, type: "activity" });
                  }
                }
              }
            } else if (data.type === "SEND_CHAT") {
              room.chat.push({ name: player.name, message: data.message, type: "chat" });
            }

            await kv.set(["rooms", currentRoomId], room);
            broadcast(currentRoomId);
            break;
          }
        }
      },
      onClose: async () => {
        if (currentRoomId && currentPlayerId) {
          const roomWsMap = activeConnections.get(currentRoomId);
          if (roomWsMap) {
            roomWsMap.delete(currentPlayerId);
            
            // If no more connections in the room, we could potentially delete it after a timeout
            // or just leave it for now since we're using KV and the room stays active
            if (roomWsMap.size === 0) {
              // activeConnections.delete(currentRoomId);
            }
          }
          
          const roomRes = await kv.get<RoomData>(["rooms", currentRoomId]);
          const room = roomRes.value;
          if (room) {
            const player = room.players.find(p => p.id === currentPlayerId);
            if (player) {
              room.chat.push({ name: "System", message: `${player.name} disconnected`, type: "activity" });
              await kv.set(["rooms", currentRoomId], room);
              broadcast(currentRoomId);
            }
          }
        }
      },
    };
  })
);

// Serve static files
app.use("/*", serveStatic({ root: "./public" }));

Deno.serve({ port: 8000, hostname: "0.0.0.0" }, (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/ws") {
    console.log(`Incoming request to /ws: ${req.method} ${req.headers.get("upgrade")}`);
  }
  return app.fetch(req);
});
