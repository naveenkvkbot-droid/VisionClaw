const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const rooms = new Map(); // roomCode -> { creator: ws, viewer: ws, destroyTimer: timeout|null }

// Grace period (ms) before destroying a room when creator disconnects.
// Allows the iOS user to switch apps (e.g. copy room code, send via WhatsApp) and come back.
const ROOM_GRACE_PERIOD_MS = 60_000;

// TURN: static credentials from free relay services (no API calls needed)
// Open Relay Project (metered.ca) - 20GB free/month, ports 80/443 for firewall bypass
// Freestun.net - additional free TURN fallback
function getTurnCredentials() {
  return {
    iceServers: [
      {
        urls: [
          "stun:openrelay.metered.ca:80",
          "turn:openrelay.metered.ca:80",
          "turn:openrelay.metered.ca:80?transport=tcp",
          "turn:openrelay.metered.ca:443",
          "turns:openrelay.metered.ca:443?transport=tcp",
        ],
        username: "openrelayproject",
        credential: "openrelayproject",
      },
      {
        urls: ["turn:freestun.net:3478"],
        username: "free",
        credential: "free",
      },
    ],
  };
}

// HTTP server for serving the web viewer
const httpServer = http.createServer((req, res) => {
  // TURN credentials API endpoint
  if (req.url === "/api/turn") {
    const creds = getTurnCredentials();
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(creds));
    return;
  }

  let filePath = path.join(
    __dirname,
    "public",
    req.url === "/" ? "index.html" : req.url
  );

  const ext = path.extname(filePath);
  const contentTypes = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "text/plain",
    });
    res.end(data);
  });
});

// WebSocket signaling server
const wss = new WebSocketServer({ server: httpServer });

function generateRoomCode() {
  // No ambiguous chars (0/O, 1/I/L)
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

wss.on("connection", (ws, req) => {
  let currentRoom = null;
  let role = null; // 'creator' or 'viewer'
  const clientIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[WS] New connection from ${clientIP}`);

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "create": {
        const code = generateRoomCode();
        rooms.set(code, { creator: ws, viewer: null, destroyTimer: null });
        currentRoom = code;
        role = "creator";
        ws.send(JSON.stringify({ type: "room_created", room: code }));
        console.log(`[Room] Created: ${code}`);
        break;
      }

      case "rejoin": {
        // Creator reconnects to an existing room (after app backgrounding)
        const room = rooms.get(msg.room);
        if (!room) {
          ws.send(
            JSON.stringify({ type: "error", message: "Room not found" })
          );
          return;
        }
        // Cancel the destroy timer since creator is back
        if (room.destroyTimer) {
          clearTimeout(room.destroyTimer);
          room.destroyTimer = null;
          console.log(`[Room] Creator rejoined, cancelled destroy timer: ${msg.room}`);
        }
        room.creator = ws;
        currentRoom = msg.room;
        role = "creator";
        ws.send(JSON.stringify({ type: "room_rejoined", room: msg.room }));
        // If viewer is already waiting, trigger a new offer
        if (room.viewer && room.viewer.readyState === 1) {
          ws.send(JSON.stringify({ type: "peer_joined" }));
          console.log(`[Room] Viewer already present, notifying rejoined creator: ${msg.room}`);
        }
        console.log(`[Room] Creator rejoined: ${msg.room}`);
        break;
      }

      case "join": {
        const room = rooms.get(msg.room);
        if (!room) {
          ws.send(
            JSON.stringify({ type: "error", message: "Room not found" })
          );
          return;
        }
        if (room.viewer) {
          ws.send(JSON.stringify({ type: "error", message: "Room is full" }));
          return;
        }
        room.viewer = ws;
        currentRoom = msg.room;
        role = "viewer";
        ws.send(JSON.stringify({ type: "room_joined" }));
        // Notify creator that viewer joined (only if creator is connected)
        if (room.creator && room.creator.readyState === 1) {
          room.creator.send(JSON.stringify({ type: "peer_joined" }));
        }
        console.log(`[Room] Viewer joined: ${msg.room}`);
        break;
      }

      // Relay SDP and ICE candidates to the other peer
      case "offer":
      case "answer":
      case "candidate": {
        const room = rooms.get(currentRoom);
        if (!room) {
          console.log(`[Relay] ${msg.type} from ${role} but room ${currentRoom} not found`);
          return;
        }
        const target = role === "creator" ? room.viewer : room.creator;
        if (target && target.readyState === 1) {
          target.send(JSON.stringify(msg));
          console.log(`[Relay] ${msg.type} from ${role} -> ${role === "creator" ? "viewer" : "creator"} (room ${currentRoom})`);
        } else {
          console.log(`[Relay] ${msg.type} from ${role} but target not ready (room ${currentRoom})`);
        }
        break;
      }
    }
  });

  ws.on("error", (err) => {
    console.log(`[WS] Error for ${role} in room ${currentRoom}: ${err.message}`);
  });

  ws.on("close", (code, reason) => {
    console.log(`[WS] Closed: ${role} in room ${currentRoom} (code=${code}, reason=${reason || "none"})`);

    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      const otherPeer = role === "creator" ? room.viewer : room.creator;
      if (otherPeer && otherPeer.readyState === 1) {
        otherPeer.send(JSON.stringify({ type: "peer_left" }));
      }
      if (role === "creator") {
        // Don't destroy immediately -- give the creator a grace period to reconnect
        // (e.g. switching to WhatsApp to share the room code)
        room.creator = null;
        room.destroyTimer = setTimeout(() => {
          if (rooms.has(currentRoom)) {
            const r = rooms.get(currentRoom);
            // Only destroy if creator never came back
            if (!r.creator || r.creator.readyState !== 1) {
              if (r.viewer && r.viewer.readyState === 1) {
                r.viewer.send(JSON.stringify({ type: "error", message: "Stream ended" }));
              }
              rooms.delete(currentRoom);
              console.log(`[Room] Destroyed after grace period: ${currentRoom}`);
            }
          }
        }, ROOM_GRACE_PERIOD_MS);
        console.log(`[Room] Creator disconnected, grace period started (${ROOM_GRACE_PERIOD_MS / 1000}s): ${currentRoom}`);
      } else {
        room.viewer = null;
      }
    }
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Signaling server running on http://0.0.0.0:${PORT}`);
  console.log(`Web viewer available at http://localhost:${PORT}`);
});
