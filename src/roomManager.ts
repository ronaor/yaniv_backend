import { Socket } from "socket.io";
import { Server } from "socket.io";
import { isUndefined } from "lodash";

export interface Player {
  id: string;
  nickname: string;
}

export interface RoomConfig {
  slapDown: boolean;
  timePerPlayer: number; // in seconds
  canCallYaniv: number; // 0 or 1
  maxMatchPoints: number; // max points for a match
  startMutch?: boolean; // Optional, used to start the game when room is private
}

export interface Room {
  players: (Player | undefined)[];
  config: RoomConfig;
  gameState: "waiting" | "started";
  createdAt: Date;
  canStartTheGameIn7Sec?: Date; // Optional, used to start the game when room is private
}

export interface RoomCallbacks {
  roomFullCallback: (roomId: string) => void;
}

export class RoomManager {
  private rooms: { [roomId: string]: Room } = {};
  private playerRooms: { [socketId: string]: string } = {};
  private io: Server;
  private callbacks: RoomCallbacks;

  constructor(io: Server, callbacks: RoomCallbacks) {
    this.io = io;
    this.callbacks = callbacks;
  }

  // Helper to generate a short alphanumeric room code
  private generateRoomCode(length = 6): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = "";
    for (let i = 0; i < length; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  // Helper to find an open room for quick game
  private findOpenRoom(): string | null {
    for (const [roomId, room] of Object.entries(this.rooms)) {
      if (
        room.gameState === "waiting" &&
        room.players.length < 4 // Assuming max 4 players for quick game //TODO
      ) {
        return roomId;
      }
    }
    return null;
  }

  // Create a new room
  createRoom(
    socket: Socket,
    nickname: string,
    slapDown: boolean,
    timePerPlayer: string,
    canCallYaniv: string,
    maxMatchPoints: string
  ): string | null {
    if (
      !nickname ||
      !slapDown ||
      !timePerPlayer ||
      !canCallYaniv ||
      !maxMatchPoints
    ) {
      socket.emit("room_error", { message: "Missing required fields." });
      return null;
    }

    // Remove from previous room if exists
    const prevRoomId = this.playerRooms[socket.id];
    if (prevRoomId) {
      this.removePlayerFromRoom(socket, prevRoomId);
      delete this.playerRooms[socket.id];
    }

    const roomId = this.generateRoomCode();
    this.rooms[roomId] = {
      players: [{ id: socket.id, nickname }],
      config: {
        slapDown,
        timePerPlayer: parseInt(timePerPlayer),
        canCallYaniv: parseInt(canCallYaniv),
        maxMatchPoints: parseInt(maxMatchPoints),
      },
      gameState: "waiting",
      createdAt: new Date(),
    };

    this.playerRooms[socket.id] = roomId;
    socket.join(roomId);

    socket.emit("room_created", {
      roomId,
      players: this.rooms[roomId].players,
      config: this.rooms[roomId].config,
    });

    console.log(`Room ${roomId} created by ${nickname}`);
    return roomId;
  }

  // Quick game matchmaking
  quickGame(socket: Socket, nickname: string): string | null {
    if (!nickname) {
      socket.emit("room_error", { message: "Missing nickname." });
      return null;
    }

    // Try to find an open room
    let roomId = this.findOpenRoom();
    if (roomId) {
      console.log("DDDDD################ ", new Date());
      // Join existing open room
      this.addPlayerToRoom(socket, roomId, nickname);
      socket.emit("room_created", {
        roomId,
        players: this.rooms[roomId].players,
        config: this.rooms[roomId].config,
        canStartTheGameIn7Sec: new Date(),
      });
      return roomId;
    }

    // No open room, create a new one
    const slapDown = true; // Default for quick game
    const timePerPlayer = 15;
    const canCallYaniv = 7; // Default for quick game
    const maxMatchPoints = 100; // Default for quick game

    roomId = this.generateRoomCode();

    this.rooms[roomId] = {
      players: [{ id: socket.id, nickname }],
      config: { slapDown, timePerPlayer, canCallYaniv, maxMatchPoints },
      gameState: "waiting",
      createdAt: new Date(),
    };

    this.playerRooms[socket.id] = roomId;
    socket.join(roomId);

    socket.emit("room_created", {
      roomId,
      players: this.rooms[roomId].players,
      config: this.rooms[roomId].config,
    });

    console.log(`Quick game: Room ${roomId} created by ${nickname}`);
    return roomId;
  }

  // Join an existing room by roomId
  joinRoom(socket: Socket, roomId: string, nickname: string): boolean {
    const room = this.rooms[roomId];
    console.log("🚀 ~ RoomManager ~ joinRoom ~ room:", room);
    if (!room) {
      socket.emit("room_error", { message: "Room not found." });
      return false;
    }
    if (room.players.length >= 2) {
      socket.emit("room_error", { message: "Room is full." });
      return false;
    }
    if (room.gameState !== "waiting") {
      socket.emit("room_error", { message: "Game already started." });
      return false;
    }

    return this.addPlayerToRoom(socket, roomId, nickname);
  }

  // Start a private game when the admin requests it
  startPrivateGame(socket: Socket, roomId: string): void {
    const room = this.rooms[roomId];
    if (!room) {
      socket.emit("room_error", { message: "Room not found." });
      return;
    }
    if (room.gameState !== "waiting") {
      socket.emit("room_error", { message: "Game already started." });
      return;
    }

    // Start the game
    room.gameState = "started";
    this.io.to(roomId).emit("start_game", {
      roomId,
      config: room.config,
      players: room.players,
    });

    this.callbacks.roomFullCallback(roomId);
    console.log(`Game started in room ${roomId}`);
  }

  // Helper to add player to a room (used by join_room and quick_game)
  addPlayerToRoom(socket: Socket, roomId: string, nickname: string): boolean {
    const room = this.rooms[roomId];
    console.log("🚀  addPlayerToRoom ~ room:", room);
    if (!room) return false;

    // Remove from previous room if exists
    const prevRoomId = this.playerRooms[socket.id];
    if (prevRoomId && prevRoomId !== roomId) {
      this.removePlayerFromRoom(socket, prevRoomId);
      delete this.playerRooms[socket.id];
    }

    // Prevent duplicate join
    if (!room.players.some((p) => p?.id === socket.id)) {
      room.players.push({ id: socket.id, nickname });
    }

    this.playerRooms[socket.id] = roomId;
    socket.join(roomId);

    this.io.to(roomId).emit("player_joined", {
      players: room.players,
      config: room.config,
    });

    console.log(`Player ${nickname} joined room ${roomId}`);
    // If room is now full, start the game
    if (room.players.length === 4) {
      // Assuming max 4 players
      console.log(`Room ${roomId} is full, starting game...`);
      room.gameState = "started";
      this.io.to(roomId).emit("start_game", {
        roomId,
        config: room.config,
        players: room.players,
      });
      this.callbacks.roomFullCallback(roomId);
      console.log(`Game started in room ${roomId}`);
    }

    return true;
  }

  // Remove player from room
  removePlayerFromRoom(socket: Socket, roomId: string): void {
    const room = this.rooms[roomId];
    if (!room) return;

    room.players = room.players.filter((p) => p?.id !== socket.id);
    this.io.to(roomId).emit("player_left", { players: room.players });
    socket.leave(roomId);

    if (room.players.length === 0) {
      delete this.rooms[roomId];
      console.log(`Room ${roomId} deleted - no players left`);
    }
  }

  // Leave room explicitly
  leaveRoom(socket: Socket): void {
    const roomId = this.playerRooms[socket.id];
    if (!roomId) return;

    this.removePlayerFromRoom(socket, roomId);
    delete this.playerRooms[socket.id];
    console.log(`Player ${socket.id} left room ${roomId} (explicit leave)`);
  }

  // Handle disconnect
  handleDisconnect(socket: Socket): void {
    const roomId = this.playerRooms[socket.id];
    if (!roomId) return;

    this.removePlayerFromRoom(socket, roomId);
    delete this.playerRooms[socket.id];
    console.log(`Player ${socket.id} left room ${roomId} (disconnect)`);
  }

  // Get room state
  getRoomState(roomId: string): Room | null {
    return this.rooms[roomId] || null;
  }

  // Get all rooms count (for status endpoint)
  getRoomsCount(): number {
    return Object.keys(this.rooms).length;
  }

  // Get player's current room
  getPlayerRoom(socketId: string): string | undefined {
    return this.playerRooms[socketId];
  }
}
