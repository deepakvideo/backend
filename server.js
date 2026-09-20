const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.send("Rummy Game Socket.IO Backend is Running!");
});

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// Helper to mask opponent cards while keeping recipient's cards visible
function getCleanRoomState(room, recipientSocketId = null) {
  return {
    id: room.id,
    started: room.started,
    timerVal: room.timerVal,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      // Only attach actual hand cards to the player who owns them
      hand: recipientSocketId && p.id === recipientSocketId ? (p.hand || []) : [],
      handSize: (p.hand || []).length,
    })),
  };
}

let activeMatchRoom = null;
const rooms = {};

const MAX_PLAYERS_PER_ROOM = 2;
const COUNTDOWN_SECONDS = 20;

io.on("connection", (socket) => {
  socket.on("joinGame", ({ requestedRoom, playerName }) => {
    // 1. Sanitize and trim the requested room code
    let targetRoomCode = requestedRoom ? String(requestedRoom).trim().toUpperCase() : null;

    // 2. Find or create auto-match room if no room code was specified
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

    // 3. Initialize target room if it doesn't exist
    if (!rooms[targetRoomCode]) {
      rooms[targetRoomCode] = {
        id: targetRoomCode,
        players: [],
        started: false,
        countdown: null,
        timerVal: COUNTDOWN_SECONDS,
      };
    }

    // 4. Redirect to a fresh room if the target room is already full or running
    if (
      rooms[targetRoomCode].players.length >= MAX_PLAYERS_PER_ROOM ||
      rooms[targetRoomCode].started
    ) {
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

    // 5. Start match countdown when room reaches 2 players
    if (
      currentRoom.players.length >= 2 &&
      !currentRoom.countdown &&
      !currentRoom.started
    ) {
      currentRoom.timerVal = COUNTDOWN_SECONDS;

      currentRoom.countdown = setInterval(() => {
        currentRoom.timerVal -= 1;
        io.to(targetRoomCode).emit("countdownUpdate", currentRoom.timerVal);

        if (currentRoom.timerVal <= 0) {
          clearInterval(currentRoom.countdown);
          currentRoom.countdown = null;
          currentRoom.started = true;

          // Broadcast masked game start state to each individual socket
          currentRoom.players.forEach((p) => {
            io.to(p.id).emit("gameStartSignal", getCleanRoomState(currentRoom, p.id));
          });
        }
      }, 1000);
    }

    // 6. Broadcast updated room state to all players in the room
    currentRoom.players.forEach((p) => {
      io.to(p.id).emit("roomUpdate", getCleanRoomState(currentRoom, p.id));
    });
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

      // Reset countdown if players drop below minimum threshold
      if (room.players.length < 2 && room.countdown) {
        clearInterval(room.countdown);
        room.countdown = null;
        room.timerVal = COUNTDOWN_SECONDS;
      }

      if (room.players.length === 0) {
        delete rooms[roomCode];
        if (activeMatchRoom === roomCode) {
          activeMatchRoom = null;
        }
      } else {
        // Reassign host
        room.players[0].isHost = true;

        room.players.forEach((p) => {
          io.to(p.id).emit("roomUpdate", getCleanRoomState(room, p.id));
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Multiplayer server running on port ${PORT}`);
});
