import { isEmpty } from "lodash";
import { Server, Socket } from "socket.io";

export interface Player {
  id: string;
  nickName: string;
  isLose: boolean;
}

export interface RoomConfig {
  slapDown: boolean;
  timePerPlayer: number; // in seconds
  canCallYaniv: number; // 0 or 1
  maxMatchPoints: number; // max points for a match
}

export interface Room {
  players: Player[];
  config: RoomConfig;
  votes: Record<string, RoomConfig>;
  gameState: "waiting" | "started";
  createdAt: Date;
  canStartTheGameIn10Sec?: Date; // Optional, used to start the game when room is private
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

  private calculateMajorityConfig(votes: Record<string, Record<string, any>>) {
    // ערכים דיפולטים במקרה של תיקו
    const defaultConfig = {
      slapDown: true,
      timePerPlayer: 15,
      canCallYaniv: 7,
      maxMatchPoints: 100,
    };

    if (isEmpty(votes)) {
      return defaultConfig;
    }

    const players = Object.keys(votes);
    const totalPlayers = players.length;

    // פונקציה לחישוב רוב קולות לשדה מסוים
    function getMajorityValue(fieldName: string, defaultValue: any) {
      const valueCount: Record<string, number> = {};

      // ספירת כל הערכים
      players.forEach((player) => {
        const value = votes[player][fieldName];

        if (value !== undefined && value !== null) {
          const key = String(value); // המרה לסטרינג כדי לטפל גם במספרים וגם בבוליאנים
          valueCount[key] = (valueCount[key] || 0) + 1;
        }
      });
      // מציאת הערך עם הכי הרבה קולות

      // מציאת הערך עם הכי הרבה קולות
      let maxCount = 0;
      let majorityValue = defaultValue;

      for (const [value, count] of Object.entries(valueCount)) {
        const countValue = count as number; // Type assertion
        if (countValue > maxCount) {
          maxCount = countValue;
          // המרה חזרה לטיפוס המקורי
          if (fieldName === "slapDown") {
            majorityValue = value === "true";
          } else {
            majorityValue = +value;
          }
        }
      }
      // אם יש תיקו (אף ערך לא קיבל רוב), נחזיר את הערך הדיפולטי
      if (maxCount <= totalPlayers / 2) {
        return defaultValue;
      }

      return majorityValue;
    }

    // חישוב רוב קולות לכל שדה
    const majorityConfig = {
      slapDown: getMajorityValue("slapDown", defaultConfig.slapDown),
      timePerPlayer: getMajorityValue(
        "timePerPlayer",
        defaultConfig.timePerPlayer
      ),
      canCallYaniv: getMajorityValue(
        "canCallYaniv",
        defaultConfig.canCallYaniv
      ),
      maxMatchPoints: getMajorityValue(
        "maxMatchPoints",
        defaultConfig.maxMatchPoints
      ),
    };

    return majorityConfig;
  }

  private startGameTimers: Record<string, NodeJS.Timeout> = {};

  private handleGameStartCountdown(roomId: string): void {
    const room = this.rooms[roomId];
    if (!room || room.gameState !== "waiting") {
      return;
    }

    const playerCount = room.players.length;

    // Cancel timer if room is empty or has only 1 player
    if (playerCount < 2) {
      if (this.startGameTimers[roomId]) {
        clearTimeout(this.startGameTimers[roomId]);
        delete this.startGameTimers[roomId];
        console.log(
          `Countdown canceled for room ${roomId} (not enough players)`
        );
      }
      return;
    }

    let delay = 0;
    if (playerCount === 2) {
      delay = 3000;
    } else if (playerCount === 3) {
      delay = 10000;
    } else if (playerCount >= 4) {
      delay = 7000;
    }

    // Restart existing timer
    if (this.startGameTimers[roomId]) {
      clearTimeout(this.startGameTimers[roomId]);
      delete this.startGameTimers[roomId];
      console.log(`Restarting countdown for room ${roomId}`);
    }

    this.startGameTimers[roomId] = setTimeout(() => {
      if (!isEmpty(room.votes)) {
        room.config = this.calculateMajorityConfig(room.votes);
        console.log("room.config", room.config);
      }
      room.gameState = "started";
      this.io.to(roomId).emit("start_game", {
        roomId,
        config: room.config,
        players: room.players,
      });

      this.callbacks.roomFullCallback(roomId);
      console.log(`Game started in room ${roomId}`);
      delete this.startGameTimers[roomId];
    }, delay);

    console.log(
      `Countdown started for room ${roomId} with ${playerCount} players (${
        delay / 1000
      }s)`
    );
  }

  // Create a new room
  createRoom(
    socket: Socket,
    nickName: string,
    config: RoomConfig
  ): string | null {
    const { slapDown, timePerPlayer, canCallYaniv, maxMatchPoints } = config;

    if (!nickName || !timePerPlayer || !canCallYaniv || !maxMatchPoints) {
      socket.emit("room_error", {
        message: "Missing required fields.",
        nickName,
        timePerPlayer,
        canCallYaniv,
        maxMatchPoints,
      });
      return null;
    }

    // Remove from previous room if exists
    const prevRoomId = this.playerRooms[socket.id];
    if (prevRoomId) {
      this.removePlayerFromRoom(socket, prevRoomId, nickName);
      delete this.playerRooms[socket.id];
    }

    const roomId = this.generateRoomCode();
    this.rooms[roomId] = {
      players: [{ id: socket.id, nickName, isLose: false }],
      config: {
        slapDown,
        timePerPlayer: timePerPlayer,
        canCallYaniv: canCallYaniv,
        maxMatchPoints: maxMatchPoints,
      },
      gameState: "waiting",
      votes: {},
      createdAt: new Date(),
    };

    this.playerRooms[socket.id] = roomId;
    socket.join(roomId);

    socket.emit("room_created", {
      roomId,
      players: this.rooms[roomId].players,
      config: this.rooms[roomId].config,
    });

    console.log(`Room ${roomId} created by ${nickName}`);
    return roomId;
  }

  //setQuickGameConfig
  setQuickGameConfig(
    socket: Socket,
    roomId: string,
    nickName: string,
    config: RoomConfig
  ): boolean {
    const room = this.rooms[roomId];

    room.votes[nickName] = config;

    this.io.to(roomId).emit("votes_config", {
      roomId,
      players: room.players,
      config: room.config,
      votes: room.votes,
    });
    return true;
  }

  // Quick game matchmaking
  quickGame(
    socket: Socket,
    nickName: string,
    slapDown = true,
    timePerPlayer = 15,
    canCallYaniv = 7,
    maxMatchPoints = 100
  ): string | null {
    if (!nickName) {
      socket.emit("room_error", { message: "Missing nickName." });
      return null;
    }

    // Try to find an open room
    let roomId = this.findOpenRoom();
    if (roomId) {
      // Join existing open room
      this.addPlayerToPublicRoom(socket, roomId, nickName);
      return roomId;
    }

    // No open room, create a new one
    roomId = this.generateRoomCode();

    this.rooms[roomId] = {
      players: [{ id: socket.id, nickName, isLose: false }],
      config: {
        slapDown,
        timePerPlayer,
        canCallYaniv,
        maxMatchPoints,
      },
      gameState: "waiting",
      createdAt: new Date(),
      votes: {},
    };

    this.playerRooms[socket.id] = roomId;
    socket.join(roomId);

    socket.emit("room_created", {
      roomId,
      players: this.rooms[roomId].players,
      config: this.rooms[roomId].config,
    });

    console.log(`Quick game: Room ${roomId} created by ${nickName}`);
    return roomId;
  }

  addPlayerToPublicRoom(
    socket: Socket,
    roomId: string,
    nickName: string
  ): boolean {
    const room = this.rooms[roomId];
    if (!room) {
      return false;
    }

    // Remove from previous room if exists
    const prevRoomId = this.playerRooms[socket.id];
    if (prevRoomId && prevRoomId !== roomId) {
      this.removePlayerFromRoom(socket, prevRoomId, nickName);
      delete this.playerRooms[socket.id];
    }

    // Prevent duplicate join
    if (!room.players.some((p) => p?.id === socket.id)) {
      room.players.push({ id: socket.id, nickName, isLose: false });
    }

    this.playerRooms[socket.id] = roomId;
    socket.join(roomId);

    this.io.to(roomId).emit("player_joined", {
      roomId,
      players: room.players,
      config: room.config,
    });

    console.log(`Player ${nickName} joined room ${roomId}`);

    this.handleGameStartCountdown(roomId); // NEW: Use shared timer logic

    return true;
  }

  // Join an existing room by roomId
  joinRoom(socket: Socket, roomId: string, nickName: string): boolean {
    const room = this.rooms[roomId];
    console.log("🚀 ~ RoomManager ~ joinRoom ~ room:", room);
    if (!room) {
      socket.emit("room_error", { message: "Room not found." });
      return false;
    }
    if (room.players.length >= 4) {
      socket.emit("room_error", { message: "Room is full." });
      return false;
    }
    if (room.gameState !== "waiting") {
      socket.emit("room_error", { message: "Game already started." });
      return false;
    }

    return this.addPlayerToRoom(socket, roomId, nickName);
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
  addPlayerToRoom(socket: Socket, roomId: string, nickName: string): boolean {
    const room = this.rooms[roomId];
    if (!room) {
      return false;
    }

    // Remove from previous room if exists
    const prevRoomId = this.playerRooms[socket.id];
    if (prevRoomId && prevRoomId !== roomId) {
      this.removePlayerFromRoom(socket, prevRoomId, nickName);
      delete this.playerRooms[socket.id];
    }

    // Prevent duplicate join
    if (!room.players.some((p) => p?.id === socket.id)) {
      room.players.push({ id: socket.id, nickName, isLose: false });
    }

    this.playerRooms[socket.id] = roomId;
    socket.join(roomId);

    this.io.to(roomId).emit("player_joined", {
      roomId,
      players: room.players,
      config: room.config,
      canStartTheGameIn10Sec: new Date(), //TODO
    });

    console.log(`Player ${nickName} joined room ${roomId}`);
    // If room is now full, start the game
    if (room.players.length === 3) {
      // Assuming max 4 players
      setTimeout(() => {
        if (!isEmpty(room.votes)) {
          room.config = this.calculateMajorityConfig(room.votes);
          console.log("room.config", room.config);
        }
        console.log(`Room ${roomId} is full, starting game in 10 seconds...`);

        room.gameState = "started";
        this.io.to(roomId).emit("start_game", {
          roomId,
          config: room.config,
          players: room.players,
        });
        this.callbacks.roomFullCallback(roomId);
        console.log(`Game started in room ${roomId}`);
      }, 10000); // 10 seconds delay
    }

    return true;
  }

  // Remove player from room
  removePlayerFromRoom(socket: Socket, roomId: string, nickName: string): void {
    const room = this.rooms[roomId];
    if (!room) {
      return;
    }

    room.players = room.players.filter((p) => p?.id !== socket.id);
    console.log("room.votes", room.votes);
    if (room.votes[nickName]) {
      delete room.votes[nickName];
    }
    console.log("2", room.votes);

    this.io
      .to(roomId)
      .emit("player_left", { players: room.players, votes: room.votes });
    socket.leave(roomId);

    if (room.players.length === 0) {
      delete this.rooms[roomId];
      console.log(`Room ${roomId} deleted - no players left`);
    }
  }

  // Leave room explicitly
  leaveRoom(socket: Socket, nickName: string): void {
    const roomId = this.playerRooms[socket.id];
    console.log("🚀 ~ RoomManager ~ leaveRoom ~ socket.id:", socket.id);
    if (!roomId) {
      return;
    }
    // const room = this.rooms[roomId];

    this.removePlayerFromRoom(socket, roomId, nickName);
    delete this.playerRooms[socket.id];
    console.log(`Player ${socket.id} left room ${roomId} (explicit leave)`);

    // Remove vote
    // if (nickName && room.votes[nickName]) {
    //   delete room.votes[nickName];
    //   console.log(`Vote from ${nickName} removed from room ${roomId}`);
    // }

    this.handleGameStartCountdown(roomId); // Re-evaluate timer
  }

  // Handle disconnect
  handleDisconnect(socket: Socket, nickName: string): void {
    const roomId = this.playerRooms[socket.id];
    if (!roomId) {
      return;
    }

    this.removePlayerFromRoom(socket, roomId, nickName);
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
