import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const kv = await Deno.openKv();

interface Player {
  id: string;
  name: string;
  hand: string[];
  ws?: WebSocket; // ws is not stored in KV
}

interface RoomData {
  roomId: string;
  hostId: string;
  players: Omit<Player, "ws">[];
  table: string[];
  discard: string[];
  chat: { name: string; message: string; type: "chat" | "activity" }[];
  state: "WAITING" | "PLAYING";
}

// Keep active WebSockets in memory
const activeConnections = new Map<string, Map<string, WebSocket>>(); // roomId -> playerId -> WebSocket

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
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length
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

async function handleWebSocket(ws: WebSocket) {
  let currentPlayerId: string | null = null;
  let currentRoomId: string | null = null;

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case "CREATE_ROOM": {
        const roomId = generateRoomId();
        const playerId = crypto.randomUUID().substring(0, 8);
        const roomData: RoomData = {
          roomId,
          hostId: playerId,
          players: [{ id: playerId, name: data.name, hand: [] }],
          table: [],
          discard: [],
          chat: [{ name: "System", message: `${data.name} created the room`, type: "activity" }],
          state: "WAITING"
        };
        
        await kv.set(["rooms", roomId], roomData);
        
        currentPlayerId = playerId;
        currentRoomId = roomId;
        
        if (!activeConnections.has(roomId)) activeConnections.set(roomId, new Map());
        activeConnections.get(roomId)!.set(playerId, ws);
        
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
        if (room.players.length >= 10) {
          ws.send(JSON.stringify({ type: "ERROR", message: "Room full" }));
          return;
        }
        
        const playerId = crypto.randomUUID().substring(0, 8);
        room.players.push({ id: playerId, name: data.name, hand: [] });
        room.chat.push({ name: "System", message: `${data.name} joined the room`, type: "activity" });
        
        await kv.set(["rooms", data.roomId], room);
        
        currentPlayerId = playerId;
        currentRoomId = data.roomId;
        
        if (!activeConnections.has(data.roomId)) activeConnections.set(data.roomId, new Map());
        activeConnections.get(data.roomId)!.set(playerId, ws);
        
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

      case "PLAY_CARD":
      case "TAKE_CARD":
      case "DISCARD_CARD":
      case "SEND_CHAT":
      case "END_TURN": {
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
              room.table.push(cardId);
              room.chat.push({ name: "System", message: `${player.name} played ${cardId}`, type: "activity" });
            }
          }
        } else if (data.type === "TAKE_CARD") {
          for (const cardId of cardIds) {
            const index = room.table.indexOf(cardId);
            if (index !== -1) {
              room.table.splice(index, 1);
              player.hand.push(cardId);
              room.chat.push({ name: "System", message: `${player.name} took ${cardId} from table`, type: "activity" });
            }
          }
        } else if (data.type === "DISCARD_CARD") {
          for (const cardId of cardIds) {
            // Check hand first
            let index = player.hand.indexOf(cardId);
            if (index !== -1) {
              player.hand.splice(index, 1);
              room.discard.push(cardId);
              room.chat.push({ name: "System", message: `${player.name} discarded ${cardId} from hand`, type: "activity" });
            } else {
              // Check table
              index = room.table.indexOf(cardId);
              if (index !== -1) {
                room.table.splice(index, 1);
                room.discard.push(cardId);
                room.chat.push({ name: "System", message: `${player.name} discarded ${cardId} from table`, type: "activity" });
              }
            }
          }
        } else if (data.type === "SEND_CHAT") {
          room.chat.push({ name: player.name, message: data.message, type: "chat" });
        } else if (data.type === "END_TURN") {
          room.chat.push({ name: "System", message: `${player.name} ended their turn`, type: "activity" });
        }

        await kv.set(["rooms", currentRoomId], room);
        broadcast(currentRoomId);
        break;
      }
    }
  };

  ws.onclose = async () => {
    if (currentRoomId && currentPlayerId) {
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
    }
  };
}

serve(async (req) => {
  if (req.headers.get("upgrade") === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleWebSocket(socket);
    return response;
  }

  const url = new URL(req.url);
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  
  try {
    const file = await Deno.readFile(`./public${filePath}`);
    const contentType = filePath.endsWith(".html") ? "text/html" : 
                        filePath.endsWith(".js") ? "application/javascript" :
                        filePath.endsWith(".css") ? "text/css" :
                        filePath.endsWith(".png") ? "image/png" : "text/plain";
    
    return new Response(file, {
      headers: { "content-type": contentType },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}, { port: 8000 });

console.log("Server running on http://localhost:8000");
