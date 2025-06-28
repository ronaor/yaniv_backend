import express, { Request, Response } from "express";
import { createServer } from "http";
import { Server, Socket } from "socket.io";
import cors from "cors";
import { RoomCallbacks, RoomManager } from "./roomManager";
import { GameManager } from "./gameManager";

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());

const callbacks: RoomCallbacks = {
  roomFullCallback: function (roomId: string): void {
    gameManager.startGame(roomId);
  },
};

// Initialize managers
const roomManager = new RoomManager(io, callbacks);
const gameManager = new GameManager(io, roomManager);

// Status endpoint
app.get("/", (req: Request, res: Response) => {
  res.json({
    message: "Yaniv Server Running!",
    rooms: roomManager.getRoomsCount(),
  });
});

io.on("connection", (socket: Socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Room management events
  socket.on(
    "create_room",
    (data: { nickname: string; numPlayers: number; timePerPlayer: number }) => {
      const { nickname, numPlayers, timePerPlayer } = data;
      const roomId = roomManager.createRoom(
        socket,
        nickname,
        numPlayers,
        timePerPlayer
      );

      if (roomId) {
        // Room created successfully
        console.log(`Room ${roomId} created by ${nickname}`);
      }
    }
  );

  socket.on("quick_game", (data: { nickname: string }) => {
    const { nickname } = data;
    const roomId = roomManager.quickGame(socket, nickname);

    if (roomId) {
      console.log(
        `Quick game: Player ${nickname} joined/created room ${roomId}`
      );
    }
  });

  socket.on("join_room", (data: { roomId: string; nickname: string }) => {
    const { roomId, nickname } = data;
    const success = roomManager.joinRoom(socket, roomId, nickname);

    if (success) {
      console.log(`Player ${nickname} joined room ${roomId}`);
    }
  });

  socket.on(
    "get_room_state",
    (data: { roomId: string }, callback: (result: any) => void) => {
      const { roomId } = data;
      const room = roomManager.getRoomState(roomId);

      if (!room) {
        callback({ error: "Room not found." });
        return;
      }

      callback({
        roomId,
        players: room.players,
        config: room.config,
        gameState: room.gameState,
      });
    }
  );

  socket.on("leave_room", () => {
    const roomId = roomManager.getPlayerRoom(socket.id);
    roomManager.leaveRoom(socket);

    if (roomId) {
      // Clean up game if room becomes empty
      const room = roomManager.getRoomState(roomId);
      if (!room) {
        gameManager.cleanupGame(roomId);
      }
    }
  });

  // Game events
  socket.on("draw_card", () => {
    const roomId = roomManager.getPlayerRoom(socket.id);
    if (roomId) {
      const success = gameManager.drawCard(roomId, socket.id);
      if (!success) {
        socket.emit("game_error", {
          message: "Cannot draw card at this time.",
        });
      }
    }
  });

  socket.on("play_cards", (data: { cardIndices: number[] }) => {
    const { cardIndices } = data;
    const roomId = roomManager.getPlayerRoom(socket.id);

    if (roomId) {
      const success = gameManager.playCards(roomId, socket.id, cardIndices);
      if (!success) {
        socket.emit("game_error", { message: "Invalid play." });
      }
    }
  });

  socket.on("call_yaniv", () => {
    const roomId = roomManager.getPlayerRoom(socket.id);
    if (roomId) {
      // TODO: Implement Yaniv calling logic
      console.log(`Player ${socket.id} called Yaniv in room ${roomId}`);
    }
  });

  // Handle disconnects
  socket.on("disconnect", () => {
    console.log(`Player disconnected: ${socket.id}`);
    const roomId = roomManager.getPlayerRoom(socket.id);

    roomManager.handleDisconnect(socket);

    if (roomId) {
      // Clean up game if room becomes empty
      const room = roomManager.getRoomState(roomId);
      if (!room) {
        gameManager.cleanupGame(roomId);
      }
    }
  });

  socket.on("start_game", (data: { roomId: string }) => {
    console.log("hello", data);
    const { roomId } = data;
    const room = roomManager.getRoomState(roomId);

    if (room && room.gameState === "started") {
      gameManager.startGame(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Yaniv server running on port ${PORT}`);
});
