import express, { Request, Response } from "express";
import { createServer } from "http";
import { Server, Socket } from "socket.io";
import cors from "cors";
import { RoomCallbacks, RoomConfig, RoomManager } from "./roomManager";
import { Card, GameManager } from "./gameManager";

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

  // create_room Room management events (unchanged)
  socket.on("create_room", (data: { nickName: string; config: RoomConfig }) => {
    const { nickName, config } = data;
    const roomId = roomManager.createRoom(socket, nickName, config);

    if (roomId) {
      console.log(`Room ${roomId} created by ${nickName}`);
    }
  });

  //quick_game
  socket.on("quick_game", (data: { nickName: string }) => {
    const { nickName } = data;
    const roomId = roomManager.quickGame(socket, nickName);

    if (roomId) {
      console.log(
        `Quick game: Player ${nickName} joined/created room ${roomId}`
      );
    }
  });

  //set_quick_game_config
  socket.on(
    "set_quick_game_config",
    (data: { roomId: string; nickName: string; config: RoomConfig }) => {
      const { roomId, nickName, config } = data;

      const success = roomManager.setQuickGameConfig(
        socket,
        roomId,
        nickName,
        config
      );

      if (success) {
        console.log(`Room config set successfully ${roomId}`);
      }
    }
  );

  //join_room
  socket.on("join_room", (data: { roomId: string; nickName: string }) => {
    const { roomId, nickName } = data;
    const success = roomManager.joinRoom(socket, roomId, nickName);

    if (success) {
      console.log(`Player ${nickName} joined room ${roomId}`);
    }
  });

  //get_room_state
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

  //leave_room
  socket.on("leave_room", (data: { nickName: string }) => {
    const roomId = roomManager.getPlayerRoom(socket.id);
    roomManager.leaveRoom(socket, data.nickName);

    if (roomId) {
      const room = roomManager.getRoomState(roomId);
      if (!room) {
        gameManager.cleanupGame(roomId);
      }
    }
  });

  // Complete turn by drawing (second part of turn)
  socket.on(
    "complete_turn",
    (data: {
      choice: "deck" | "pickup";
      selectedCards: Card[];
      pickupIndex?: number;
    }) => {
      const { choice, selectedCards, pickupIndex } = data;
      const roomId = roomManager.getPlayerRoom(socket.id);

      if (roomId) {
        const success = gameManager.completeTurn(
          roomId,
          socket.id,
          choice,
          selectedCards,
          pickupIndex
        );
        if (!success) {
          socket.emit("game_error", { message: "Cannot complete turn." });
        }
      }
    }
  );

  // Call Yaniv
  socket.on("call_yaniv", () => {
    const roomId = roomManager.getPlayerRoom(socket.id);
    if (roomId) {
      const success = gameManager.callYaniv(roomId, socket.id);
      if (!success) {
        socket.emit("game_error", {
          message: "Cannot call Yaniv at this time.",
        });
      }
    }
  });

  //disconnect Handle disconnects
  socket.on("disconnect", () => {
    console.log(`Player disconnected: ${socket.id}`);
    const roomId = roomManager.getPlayerRoom(socket.id);

    roomManager.handleDisconnect(socket, socket.id);

    if (roomId) {
      const room = roomManager.getRoomState(roomId);
      if (!room) {
        gameManager.cleanupGame(roomId);
      }
    }
  });

  //start_private_game
  socket.on("start_private_game", (data: { roomId: string }) => {
    const { roomId } = data;
    roomManager.startPrivateGame(socket, roomId);
  });

  //start_game
  socket.on("start_game", (data: { roomId: string }) => {
    console.log("Manual game start requested:", data);
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
