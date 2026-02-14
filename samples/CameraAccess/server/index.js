const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const rooms = new Map(); // roomCode -> { creator: ws, viewer: ws }

// TURN: fetch from Cloudflare (caches for 20 min)
let turnCache = { data: null, expires: 0 };

async function fetchTurnCredentials() {
  if (turnCache.data && Date.now() < turnCache.expires) {
    return turnCache.data;
  }
  try {
    const resp = await fetch("https://speed.cloudflare.com/turn-creds");
    const creds = await resp.json();
    turnCache = { data: creds, expires: Date.now() + 20 * 60 * 1000 };
    console.log("[TURN] Fetched Cloudflare credentials:", JSON.stringify(creds.urls));
    return creds;
  } catch (err) {
    console.log("[TURN] Failed to fetch:", err.message);
    return null;
  }
}

// HTTP server for serving the web viewer
const httpServer = http.createServer(async (req, res) => {
  // TURN credentials API endpoint
  if (req.url === "/api/turn") {
    const creds = await fetchTurnCredentials();
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(creds || {}));
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
        rooms.set(code, { creator: ws, viewer: null });
        currentRoom = code;
        role = "creator";
        ws.send(JSON.stringify({ type: "room_created", room: code }));
        console.log(`[Room] Created: ${code}`);
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
        // Notify creator that viewer joined
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
        rooms.delete(currentRoom);
        console.log(`[Room] Destroyed: ${currentRoom}`);
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
