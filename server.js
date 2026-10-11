const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Enable CORS for cross-origin client connections
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

// Generates a double deck (108 cards including 4 jokers) formatted with 3-digit zero-padded IDs
function createRummyDeck() {
  const deck = [];
  const NUM_SUITS = 4; // 1: Hearts, 2: Spades, 3: Diamonds, 4: Clubs
  const NUM_RANKS = 13; // 1 to 13 (Ace through King)

  // Double deck (2 sets of 52 cards)
  for (let d = 0; d < 2; d++) {
    for (let suit = 1; suit <= NUM_SUITS; suit++) {
      for (let rank = 1; rank <= NUM_RANKS; rank++) {
        // Card ID = suit * 100 + rank (e.g., 201 = Ace of Spades)
        const id = suit * 100 + rank;
        deck.push(String(id).padStart(3, "0"));
      }
    }
  }

  // 4 Printed Jokers (Suit 5, Rank 0 = ID 500)
  for (let j = 0; j < 4; j++) {
    deck.push("500");
  }

  // Fisher-Yates Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

/**
 * Builds the exact data byte string needed by Android's RummyGame.loadData():
 * Delimited by \n without trailing empty entries.
 */
function buildInitialRummyGameData(numPlayers) {
  const version = 1;
  const round = 1;
  const startedRound = 0;
  const STARTING_HAND_SIZE = 13;

  const deck = createRummyDeck();

  // Deal 13 cards to each player
  const playerHands = [];
  for (let p = 0; p < numPlayers; p++) {
    let handStr = "";
    for (let c = 0; c < STARTING_HAND_SIZE; c++) {
      handStr += deck.pop();
    }
    playerHands.push(handStr);
  }

  // Draw 1 card for the play deck (open discard pile)
  const playDeckStr = deck.pop();

  // Remaining deck forms draw deck
  const drawDeckStr = deck.join("");

  // Initial scores (0 for all players)
  const scores = new Array(numPlayers).fill(0);

  // Construct clean \n separated items
  const payloadParts = [
    version,
    round,
    startedRound,
    drawDeckStr,
    playDeckStr,
    ...playerHands,
    ...scores,
  ];

  return payloadParts.join("\n");
}

// Helper to extract a clean, serializable room snapshot
function getCleanRoomState(room) {
  return {
    id: room.id,
    started: room.started,
    timerVal: room.timerVal,
    gameData: room.gameData || null, // Contains serialized Rummy byte string
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
    })),
  };
}

let activeMatchRoom = null;
const rooms = {};

const MAX_PLAYERS_PER_ROOM = 2;
const COUNTDOWN_SECONDS = 5;

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on("joinGame", (data) => {
    // Handle both payload formats: string/object or direct fields
    const requestedRoom = data && data.requestedRoom ? data.requestedRoom : "";
    const playerName = data && data.name ? data.name : "Player";

    let targetRoomCode = requestedRoom ? requestedRoom.toUpperCase() : "";

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

    let currentRoom = rooms[targetRoomCode];

    if (currentRoom && (currentRoom.players.length >= MAX_PLAYERS_PER_ROOM || currentRoom.started)) {
      socket.emit("errorMsg", "Requested room is full or in progress. Redirecting to a new room.");
      targetRoomCode = generateRoomCode();
      currentRoom = null;
    }

    if (!currentRoom) {
      rooms[targetRoomCode] = {
        id: targetRoomCode,
        players: [],
        started: false,
        countdown: null,
        timerVal: COUNTDOWN_SECONDS,
        gameData: null,
      };
      currentRoom = rooms[targetRoomCode];
    }

    socket.join(targetRoomCode);
    socket.roomCode = targetRoomCode;

    const player = {
      id: socket.id,
      name: playerName || `Player ${currentRoom.players.length + 1}`,
      isHost: currentRoom.players.length === 0,
    };

    currentRoom.players.push(player);

    socket.emit("assignedRoom", targetRoomCode);

    // Trigger match countdown when room reaches capacity
    if (currentRoom.players.length >= MAX_PLAYERS_PER_ROOM && !currentRoom.countdown && !currentRoom.started) {
      currentRoom.timerVal = COUNTDOWN_SECONDS;

      currentRoom.countdown = setInterval(() => {
        currentRoom.timerVal -= 1;

        io.to(targetRoomCode).emit("countdownUpdate", currentRoom.timerVal);

        if (currentRoom.timerVal <= 0) {
          clearInterval(currentRoom.countdown);
          currentRoom.countdown = null;
          currentRoom.started = true; // Lock room

          // Build initial Rummy game state
          currentRoom.gameData = buildInitialRummyGameData(currentRoom.players.length);

          // Emit gameStartSignal along with serialized gameData
          io.to(targetRoomCode).emit("gameStartSignal", getCleanRoomState(currentRoom));
        }
      }, 1000);
    }

    io.to(targetRoomCode).emit("roomUpdate", getCleanRoomState(currentRoom));
  });

  socket.on("syncGameState", (gameState) => {
    const roomCode = socket.roomCode;
    if (roomCode) {
      socket.to(roomCode).emit("gameStateUpdated", gameState);
    }
  });

socket.on("playerDropped", data => {

    io.to(socket.roomCode)
      .emit(
            "opponentWon",
            data
      );
});

  socket.on("disconnect", () => {
    const roomCode = socket.roomCode;
    if (roomCode && rooms[roomCode]) {
      const room = rooms[roomCode];

      room.players = room.players.filter((p) => p.id !== socket.id);

      if (room.players.length < MAX_PLAYERS_PER_ROOM && room.countdown) {
        clearInterval(room.countdown);
        room.countdown = null;
        room.timerVal = COUNTDOWN_SECONDS;
        io.to(roomCode).emit("countdownUpdate", COUNTDOWN_SECONDS);
      }

      if (room.players.length === 0) {
        if (room.countdown) clearInterval(room.countdown);
        delete rooms[roomCode];
        if (activeMatchRoom === roomCode) {
          activeMatchRoom = null;
        }
      } else {
        if (!room.players.some((p) => p.isHost)) {
          room.players[0].isHost = true;
        }
        io.to(roomCode).emit("roomUpdate", getCleanRoomState(room));
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Multiplayer Rummy server running on port ${PORT}`);
});