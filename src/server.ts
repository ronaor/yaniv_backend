import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());

// Store active rooms
interface Player {
  id: string;
  nickname: string;
}

interface RoomConfig {
  numPlayers: number;
  timePerPlayer: number; // in seconds
}

interface Room {
  players: Player[];
  config: RoomConfig;
  gameState: "waiting" | "started";
  createdAt: Date;
}

const rooms: { [roomId: string]: Room } = {};
const playerRooms: { [socketId: string]: string } = {};

// Helper to generate a short alphanumeric room code
function generateRoomCode(length = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

app.get("/", (req, res) => {
  res.json({
    message: "Yaniv Server Running!",
    rooms: Object.keys(rooms).length,
  });
});

io.on("connection", (socket) => {
  // Create a new room with configs
  socket.on(
    "create_room",
    (data: { nickname: string; numPlayers: number; timePerPlayer: number }) => {
      const { nickname, numPlayers, timePerPlayer } = data;
      if (!nickname || !numPlayers || !timePerPlayer) {
        socket.emit("room_error", { message: "Missing required fields." });
        return;
      }
      const roomId = generateRoomCode();
      rooms[roomId] = {
        players: [{ id: socket.id, nickname }],
        config: { numPlayers, timePerPlayer },
        gameState: "waiting",
        createdAt: new Date(),
      };
      playerRooms[socket.id] = roomId;
      socket.join(roomId);
      socket.emit("room_created", {
        roomId,
        players: rooms[roomId].players,
        config: rooms[roomId].config,
      });
      console.log(`Room ${roomId} created by ${nickname}`);
    }
  );

  // Join an existing room by roomId
  socket.on("join_room", (data: { roomId: string; nickname: string }) => {
    const { roomId, nickname } = data;
    const room = rooms[roomId];
    if (!room) {
      socket.emit("room_error", { message: "Room not found." });
      return;
    }
    if (room.players.length >= room.config.numPlayers) {
      socket.emit("room_error", { message: "Room is full." });
      return;
    }
    if (room.gameState !== "waiting") {
      socket.emit("room_error", { message: "Game already started." });
      return;
    }
    room.players.push({ id: socket.id, nickname });
    playerRooms[socket.id] = roomId;
    socket.join(roomId);
    io.to(roomId).emit("player_joined", { players: room.players });
    // If room is now full, start the game
    if (room.players.length === room.config.numPlayers) {
      room.gameState = "started";
      io.to(roomId).emit("start_game", {
        roomId,
        config: room.config,
        players: room.players,
      });
      console.log(`Game started in room ${roomId}`);
    }
  });

  // Handle disconnects
  socket.on("disconnect", () => {
    const roomId = playerRooms[socket.id];
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    // Remove player
    room.players = room.players.filter((p) => p.id !== socket.id);
    io.to(roomId).emit("player_left", { players: room.players });
    // Clean up empty room
    if (room.players.length === 0) {
      delete rooms[roomId];
      console.log(`Room ${roomId} deleted - no players left`);
    }
    delete playerRooms[socket.id];
    console.log(`Player ${socket.id} left room ${roomId}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Yaniv server running on port ${PORT}`);
});
