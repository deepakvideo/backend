const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Enable CORS for cross-origin client connections (Render / Static Frontends)
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.send("Rummy Game Socket.IO Backend is Running!");
});

// Helper to generate unique 5-character room codes
function generateRoomCode() {
  let code = "";
  do {
    code = Math.random().toString(36).substring(2, 7).toUpperCase();
  } while (rooms[code]);
  return code;
}

// Helper to extract a clean, serializable room snapshot
function getCleanRoomState(room) {
  return {
    id: room.id,
    started: room.started,
    timerVal: room.timerVal,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      hand: (p.hand || []).map((card) => ({
        id: card.id,
        suitId: card.suitId,
        suitName: card.suitName,
        suitIcon: card.suitIcon,
        suitOrder: card.suitOrder,
        rankKey: card.rankKey,
        rankLabel: card.rankLabel,
        order: card.order,
        value: card.value,
      })),
    })),
  };
}

const rooms = {};

const MIN_PLAYERS_PER_ROOM = 2;
const MAX_PLAYERS_PER_ROOM = 5;
const COUNTDOWN_SECONDS = 20;

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on("joinGame", (data) => {
    let requestedRoom = "";
    let playerName = "";

    // Safely parse incoming data whether passed as an object or empty
    if (typeof data === "object" && data !== null) {
      requestedRoom = data.requestedRoom || "";
      playerName = data.playerName || data.name || "";
    }

    let targetRoomCode = requestedRoom ? requestedRoom.toUpperCase() : "";

    // If no specific room requested, find ANY existing open room with space (< 5 players) and not started
    if (!targetRoomCode) {
      let openRoom = Object.values(rooms).find(
        (r) => !r.started && r.players.length < MAX_PLAYERS_PER_ROOM
      );

      if (openRoom) {
        targetRoomCode = openRoom.id;
      } else {
        targetRoomCode = generateRoomCode();
      }
    }

    let currentRoom = rooms[targetRoomCode];

    // If requested room is already full or started, redirect to a new room or find another open one
    if (currentRoom && (currentRoom.players.length >= MAX_PLAYERS_PER_ROOM || currentRoom.started)) {
      socket.emit("errorMsg", "Requested room is full or in progress. Redirecting to a new room.");
      let openRoom = Object.values(rooms).find(
        (r) => !r.started && r.players.length < MAX_PLAYERS_PER_ROOM
      );
      targetRoomCode = openRoom ? openRoom.id : generateRoomCode();
      currentRoom = rooms[targetRoomCode];
    }

    // Initialize room if it doesn't exist
    if (!currentRoom) {
      rooms[targetRoomCode] = {
        id: targetRoomCode,
        players: [],
        started: false,
        countdown: null,
        timerVal: COUNTDOWN_SECONDS,
      };
      currentRoom = rooms[targetRoomCode];
    }

    socket.join(targetRoomCode);
    socket.roomCode = targetRoomCode;

    const player = {
      id: socket.id,
      name: playerName || `Player ${currentRoom.players.length + 1}`,
      hand: [],
      isHost: currentRoom.players.length === 0,
    };

    currentRoom.players.push(player);

    // Explicitly emit assigned room to joining client
    socket.emit("assignedRoom", targetRoomCode);

    // Start 20-second countdown as soon as the FIRST player joins the room (if not already started)
    if (currentRoom.players.length >= 1 && !currentRoom.countdown && !currentRoom.started) {
      currentRoom.timerVal = COUNTDOWN_SECONDS;

      currentRoom.countdown = setInterval(() => {
        currentRoom.timerVal -= 1;
        io.to(targetRoomCode).emit("countdownUpdate", currentRoom.timerVal);

        // When timer expires
        if (currentRoom.timerVal <= 0) {
          clearInterval(currentRoom.countdown);
          currentRoom.countdown = null;

          // Check if we have enough players (min 2)
          if (currentRoom.players.length >= MIN_PLAYERS_PER_ROOM) {
            currentRoom.started = true; // Lock room
            io.to(targetRoomCode).emit("gameStartSignal", getCleanRoomState(currentRoom));
          } else {
            // Not enough players yet, reset timer to keep waiting for more players
            currentRoom.timerVal = COUNTDOWN_SECONDS;
            io.to(targetRoomCode).emit("countdownUpdate", currentRoom.timerVal);
          }
        }
      }, 1000);
    }

    // If room hits MAXIMUM capacity (5 players) before timer runs out, start immediately!
    if (currentRoom.players.length >= MAX_PLAYERS_PER_ROOM && !currentRoom.started) {
      if (currentRoom.countdown) {
        clearInterval(currentRoom.countdown);
        currentRoom.countdown = null;
      }
      currentRoom.started = true;
      io.to(targetRoomCode).emit("gameStartSignal", getCleanRoomState(currentRoom));
    }

    // Broadcast room update to all room members
    io.to(targetRoomCode).emit("roomUpdate", getCleanRoomState(currentRoom));
  });

  socket.on("syncGameState", (gameState) => {
    const roomCode = socket.roomCode;
    if (roomCode) {
      socket.to(roomCode).emit("gameStateUpdated", gameState);
    }
  });

  socket.on("disconnect", () => {
    const roomCode = socket.roomCode;
    if (roomCode && rooms[roomCode]) {
      const room = rooms[roomCode];

      // Remove player
      room.players = room.players.filter((p) => p.id !== socket.id);

      // Cleanup empty rooms
      if (room.players.length === 0) {
        if (room.countdown) clearInterval(room.countdown);
        delete rooms[roomCode];
      } else {
        // Reassign host status if old host disconnected
        if (!room.players.some((p) => p.isHost)) {
          room.players[0].isHost = true;
        }
        io.to(roomCode).emit("roomUpdate", getCleanRoomState(room));
      }
    }
  });
});

// Dynamic PORT for Render deployment
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Multiplayer server running on port ${PORT}`);
});