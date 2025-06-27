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

app.get("/", (req, res) => {
  res.json({
    message: "Yaniv Server Running!",
    rooms: Object.keys(rooms).length,
  });
});

// Store active rooms
const rooms: { [roomId: string]: any } = {};
const playerRooms: { [socketId: string]: string } = {};

io.on("connection", (socket) => {
  socket.on("join_room", (data: { nickname: string }) => {
    const { nickname } = data;

    let roomId = findAvailableRoom();
    if (!roomId) {
      roomId = createNewRoom();
    }

    // Track which room this player joined
    playerRooms[socket.id] = roomId;

    rooms[roomId].players.push({
      id: socket.id,
      nickname: nickname,
    });

    socket.join(roomId);
    socket.emit("joined_room", { roomId, players: rooms[roomId].players });
    socket
      .to(roomId)
      .emit("player_joined", { nickname, players: rooms[roomId].players });
  });

  socket.on("disconnect", () => {
    const roomId = playerRooms[socket.id];

    if (roomId && rooms[roomId]) {
      // Remove player from room
      rooms[roomId].players = rooms[roomId].players.filter(
        (player: any) => player.id !== socket.id
      );

      // Notify other players
      socket.to(roomId).emit("player_left", {
        players: rooms[roomId].players,
      });

      // Clean up empty rooms
      if (rooms[roomId].players.length === 0) {
        delete rooms[roomId];
        console.log(`Room ${roomId} deleted - no players left`);
      }

      // Clean up player tracking
      delete playerRooms[socket.id];

      console.log(`Player ${socket.id} left room ${roomId}`);
    }
  });
});

function findAvailableRoom(): string | null {
  for (const [roomId, room] of Object.entries(rooms)) {
    if (room.players.length < 4) {
      // Max 4 players for Yaniv
      return roomId;
    }
  }
  return null;
}

function createNewRoom(): string {
  const roomId = "room_" + Date.now();
  rooms[roomId] = {
    players: [],
    gameState: "waiting",
    createdAt: new Date(),
  };
  console.log(`Created new room: ${roomId}`);
  return roomId;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Yaniv server running on port ${PORT}`);
});
