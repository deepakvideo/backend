const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Helper function to generate a random 5-character room code
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7);
}

// Helper to extract a clean, serializable room snapshot (prevents Socket.IO RangeError)
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

// Global active room variable for auto-matching
let activeMatchRoom = null;
const rooms = {};

const MAX_PLAYERS_PER_ROOM = 2; // Maximum capacity per room
const COUNTDOWN_SECONDS = 20;

io.on("connection", (socket) => {
  socket.on("joinGame", ({ requestedRoom, playerName }) => {
    let targetRoomCode = requestedRoom;

    // IF NO DIRECT LINK PROVIDED: Find or create an auto-match room
    if (!targetRoomCode) {
      if (
        !activeMatchRoom ||
        !rooms[activeMatchRoom] ||
        rooms[activeMatchRoom].players.length >= MAX_PLAYERS_PER_ROOM ||
        rooms[activeMatchRoom].started
      ) {
        activeMatchRoom = generateRoomCode();
      }
      targetRoomCode = activeMatchRoom;
    }

    // Initialize room object if it doesn't exist
    if (!rooms[targetRoomCode]) {
      rooms[targetRoomCode] = {
        id: targetRoomCode,
        players: [],
        started: false,
        countdown: null,
        timerVal: COUNTDOWN_SECONDS,
      };
    }

    const room = rooms[targetRoomCode];

    // Check capacity override
    if (room.players.length >= MAX_PLAYERS_PER_ROOM || room.started) {
      // Create a fresh room if requested room was locked or full
      targetRoomCode = generateRoomCode();
      rooms[targetRoomCode] = {
        id: targetRoomCode,
        players: [],
        started: false,
        countdown: null,
        timerVal: COUNTDOWN_SECONDS,
      };
    }

    const currentRoom = rooms[targetRoomCode];
    socket.join(targetRoomCode);
    socket.roomCode = targetRoomCode;

    const player = {
      id: socket.id,
      name: playerName || `Player ${currentRoom.players.length + 1}`,
      hand: [],
      isHost: currentRoom.players.length === 0,
    };

    currentRoom.players.push(player);

    // Notify user of their assigned room code
    socket.emit("assignedRoom", targetRoomCode);

    // If 2 or more players have joined, initiate the 20-second match start countdown
    if (currentRoom.players.length >= 2 && !currentRoom.countdown && !currentRoom.started) {
      currentRoom.timerVal = COUNTDOWN_SECONDS;

      currentRoom.countdown = setInterval(() => {
        currentRoom.timerVal -= 1;

        io.to(targetRoomCode).emit("countdownUpdate", currentRoom.timerVal);

        if (currentRoom.timerVal <= 0) {
          clearInterval(currentRoom.countdown);
          currentRoom.countdown = null;
          currentRoom.started = true; // LOCK ROOM
          io.to(targetRoomCode).emit("gameStartSignal", getCleanRoomState(currentRoom));
        }
      }, 1000);
    }

    // Broadcast clean room update to all players inside this specific room
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
      room.players = room.players.filter((p) => p.id !== socket.id);

      if (room.players.length === 0) {
        if (room.countdown) clearInterval(room.countdown);
        delete rooms[roomCode];
        if (activeMatchRoom === roomCode) {
          activeMatchRoom = null;
        }
      } else {
        io.to(roomCode).emit("roomUpdate", getCleanRoomState(room));
      }
    }
  });
});

server.listen(3000, () => {
  console.log("Multiplayer server running on port 3000");
});
