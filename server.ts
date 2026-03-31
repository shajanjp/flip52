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

/**
 * RoomChannel handles pub/sub for each room using Deno's BroadcastChannel.
 * This allows room-wide event distribution across isolates/workers.
 * Each user connection becomes a subscriber to the room's channel.
 */
class RoomChannel {
  private static userChannels = new Map<string, BroadcastChannel>();

  static subscribe(roomId: string, playerId: string, ws: WebSocket) {
    const key = `${roomId}:${playerId}`;
    // Cleanup existing channel if any
    this.userChannels.get(key)?.close();

    const bc = new BroadcastChannel(`rooms:${roomId}`);
    bc.onmessage = (e) => {
      const msg = e.data;
      // Filter for public messages or messages targeted to this specific player
      if (!msg.recipientId || msg.recipientId === playerId) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      }
    };
    this.userChannels.set(key, bc);
  }

  static unsubscribe(roomId: string, playerId: string) {
    const key = `${roomId}:${playerId}`;
    const bc = this.userChannels.get(key);
    if (bc) {
      bc.close();
      this.userChannels.delete(key);
    }
  }

  static publish(roomId: string, message: any) {
    const bc = new BroadcastChannel(`rooms:${roomId}`);
    bc.postMessage(message);
    bc.close();
  }

  static sendTo(roomId: string, playerId: string, message: any) {
    const bc = new BroadcastChannel(`rooms:${roomId}`);
    // Inject recipientId for filtering by subscribers
    bc.postMessage({ ...message, recipientId: playerId });
    bc.close();
  }

  static isOnline(roomId: string, playerId: string): boolean {
    return this.userChannels.has(`${roomId}:${playerId}`);
  }
}

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

  // Publish public state to the room channel
  RoomChannel.publish(roomId, {
    type: "ROOM_STATE",
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
      online: RoomChannel.isOnline(roomId, p.id)
    }))
  });

  // Push private hand updates to each player individually
  for (const player of room.players) {
    RoomChannel.sendTo(roomId, player.id, {
      type: "HAND_UPDATE",
      hand: player.hand,
      myId: player.id // Send once to confirm ID
    });
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
            
            RoomChannel.subscribe(roomId, playerId, ws as unknown as WebSocket);
            
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
            
            RoomChannel.subscribe(data.roomId, playerId, ws as unknown as WebSocket);
            
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
                
                RoomChannel.unsubscribe(currentRoomId, currentPlayerId);

                if (room.players.length === 0) {
                  await kv.delete(["rooms", currentRoomId]);
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
            
            // Broadcast the room state as usual
            broadcast(currentRoomId);
            
            // Broadcast the celebration event
            RoomChannel.publish(currentRoomId, { type: "CELEBRATE" });
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
              const played: string[] = [];
              for (const cardId of cardIds) {
                const index = player.hand.indexOf(cardId);
                if (index !== -1) {
                  player.hand.splice(index, 1);
                  room.table.push({ cardId, playedBy: player.name });
                  played.push(cardId);
                }
              }
              if (played.length > 0) {
                room.chat.push({ name: "System", message: `${player.name} played ${played.join(", ")}`, type: "activity" });
              }
            } else if (data.type === "TAKE_CARD") {
              const taken: string[] = [];
              for (const cardId of cardIds) {
                const index = room.table.findIndex(t => t.cardId === cardId);
                if (index !== -1) {
                  room.table.splice(index, 1);
                  player.hand.push(cardId);
                  taken.push(cardId);
                }
              }
              if (taken.length > 0) {
                room.chat.push({ name: "System", message: `${player.name} took ${taken.join(", ")} from table`, type: "activity" });
              }
            } else if (data.type === "DISCARD_CARD") {
              const discarded: string[] = [];
              for (const cardId of cardIds) {
                let index = player.hand.indexOf(cardId);
                if (index !== -1) {
                  player.hand.splice(index, 1);
                  room.discard.push(cardId);
                  discarded.push(cardId);
                } else {
                  index = room.table.findIndex(t => t.cardId === cardId);
                  if (index !== -1) {
                    room.table.splice(index, 1);
                    room.discard.push(cardId);
                    discarded.push(cardId);
                  }
                }
              }
              if (discarded.length > 0) {
                room.chat.push({ name: "System", message: `${player.name} discarded ${discarded.join(", ")}`, type: "activity" });
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
      onClose: async (event, ws) => {
        if (currentRoomId && currentPlayerId) {
          RoomChannel.unsubscribe(currentRoomId, currentPlayerId);
          
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
app.get("/dashboard", async (c) => {
  return c.html(await Deno.readTextFile("./public/dashboard.html"));
});

app.get("/api/rooms", async (c) => {
  const rooms: any[] = [];
  const iter = kv.list({ prefix: ["rooms"] });
  for await (const res of iter) {
    const room = res.value as RoomData;
    const host = room.players.find(p => p.id === room.hostId);
    rooms.push({
      roomId: room.roomId,
      players: room.players.map(p => ({ 
        name: p.name, 
        id: p.id,
        online: RoomChannel.isOnline(room.roomId, p.id)
      })),
      hostName: host ? host.name : "Unknown",
      state: room.state
    });
  }
  return c.json({
    rooms,
    timestamp: Date.now()
  });
});

app.use("/*", serveStatic({ root: "./public" }));

Deno.serve({ port: 8000, hostname: "0.0.0.0" }, (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/ws") {
    console.log(`Incoming request to /ws: ${req.method} ${req.headers.get("upgrade")}`);
  }
  return app.fetch(req);
});
