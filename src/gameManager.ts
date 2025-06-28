import { Socket } from "socket.io";
import { Server } from "socket.io";
import { RoomManager, Player, Room } from "./roomManager";

// Game-specific interfaces
export interface Card {
  suit: "hearts" | "diamonds" | "clubs" | "spades";
  value: number; // 1-13 (1=Ace, 11=Jack, 12=Queen, 13=King)
}

export interface GameState {
  currentPlayer: number; // Index in players array
  deck: Card[];
  discardPile: Card[];
  playerHands: { [playerId: string]: Card[] };
  gameStartTime: Date;
  turnStartTime: Date;
  gameEnded: boolean;
  winner?: string;
  turnTimer?: NodeJS.Timeout; // ADD THIS - לשמירת ה-timer
}

export class GameManager {
  private games: { [roomId: string]: GameState } = {};
  private io: Server;
  private roomManager: RoomManager;

  constructor(io: Server, roomManager: RoomManager) {
    this.io = io;
    this.roomManager = roomManager;
  }

  // Initialize a new game when room becomes full
  startGame(roomId: string): boolean {
    const room = this.roomManager.getRoomState(roomId);
    console.log("0", room);
    if (!room || room.gameState !== "started") {
      return false;
    }

    console.log("1");
    // Create initial game state
    const gameState: GameState = {
      currentPlayer: 0,
      deck: this.createDeck(),
      discardPile: [],
      playerHands: {},
      gameStartTime: new Date(),
      turnStartTime: new Date(),
      gameEnded: false,
      turnTimer: undefined, // Initialize timer
    };

    // Shuffle deck
    this.shuffleDeck(gameState.deck);

    // Deal initial cards to players (7 cards each for Yaniv)
    const cardsPerPlayer = 7;
    room.players.forEach((player) => {
      gameState.playerHands[player.id] = [];
      for (let i = 0; i < cardsPerPlayer; i++) {
        const card = gameState.deck.pop();
        if (card) {
          gameState.playerHands[player.id].push(card);
        }
      }
    });

    // Place first card on discard pile
    const firstCard = gameState.deck.pop();
    if (firstCard) {
      gameState.discardPile.push(firstCard);
    }

    this.games[roomId] = gameState;

    // Notify all players that game has started with initial state
    this.io.to(roomId).emit("game_initialized", {
      gameState: this.getPublicGameState(roomId),
      playerHands: this.getPlayerHands(roomId),
    });

    // Start first player's turn
    this.startPlayerTurn(roomId);

    console.log(`Game initialized in room ${roomId}`);
    return true;
  }

  // Create a standard 52-card deck
  private createDeck(): Card[] {
    const suits: Card["suit"][] = ["hearts", "diamonds", "clubs", "spades"];
    const deck: Card[] = [];

    suits.forEach((suit) => {
      for (let value = 1; value <= 13; value++) {
        deck.push({ suit, value });
      }
    });

    return deck;
  }

  // Shuffle deck using Fisher-Yates algorithm
  private shuffleDeck(deck: Card[]): void {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
  }

  // Start a player's turn
  private startPlayerTurn(roomId: string): void {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    if (!game || !room) return;

    // CLEAR EXISTING TIMER FIRST!
    if (game.turnTimer) {
      clearTimeout(game.turnTimer);
      game.turnTimer = undefined;
    }

    game.turnStartTime = new Date();
    const currentPlayer = room.players[game.currentPlayer];

    this.io.to(roomId).emit("turn_started", {
      currentPlayerId: currentPlayer.id,
      timeRemaining: room.config.timePerPlayer,
    });

    // Set NEW timeout for turn and SAVE IT
    game.turnTimer = setTimeout(() => {
      this.handleTurnTimeout(roomId);
    }, room.config.timePerPlayer * 1000);
  }

  // Handle turn timeout
  private handleTurnTimeout(roomId: string): void {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    if (!game || !room || game.gameEnded) return;

    // Clear the timer since it fired
    game.turnTimer = undefined;

    // Force draw a card and end turn
    this.drawCard(roomId, room.players[game.currentPlayer].id, true);
    this.nextTurn(roomId);
  }

  // Move to next player's turn
  private nextTurn(roomId: string): void {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    if (!game || !room || game.gameEnded) return;

    // CLEAR TIMER when manually moving to next turn
    if (game.turnTimer) {
      clearTimeout(game.turnTimer);
      game.turnTimer = undefined;
    }

    game.currentPlayer = (game.currentPlayer + 1) % room.players.length;
    this.startPlayerTurn(roomId);
  }

  // Handle player drawing a card
  drawCard(roomId: string, playerId: string, forced = false): boolean {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    if (!game || !room || game.gameEnded) return false;

    // Check if it's player's turn (unless forced)
    if (!forced && room.players[game.currentPlayer].id !== playerId) {
      return false;
    }

    // Draw from deck or reshuffle discard pile if deck is empty
    if (game.deck.length === 0) {
      this.reshuffleDiscardPile(roomId);
    }

    const card = game.deck.pop();
    if (card) {
      game.playerHands[playerId].push(card);

      // Notify player of new card
      this.io.to(playerId).emit("card_drawn", { card });

      // Notify others that player drew a card
      this.io.to(roomId).emit("player_drew_card", {
        playerId,
        cardsRemaining: game.deck.length,
      });

      // If not forced (player chose to draw), end turn
      if (!forced) {
        this.nextTurn(roomId);
      }

      return true;
    }

    return false;
  }

  // Reshuffle discard pile back into deck
  private reshuffleDiscardPile(roomId: string): void {
    const game = this.games[roomId];
    if (!game || game.discardPile.length <= 1) return;

    // Keep top card on discard pile
    const topCard = game.discardPile.pop();

    // Move rest to deck and shuffle
    game.deck = [...game.discardPile];
    this.shuffleDeck(game.deck);

    // Reset discard pile with top card
    game.discardPile = topCard ? [topCard] : [];

    this.io.to(roomId).emit("deck_reshuffled", {
      cardsInDeck: game.deck.length,
    });
  }

  // Handle player playing cards
  playCards(roomId: string, playerId: string, cardIndices: number[]): boolean {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    if (!game || !room || game.gameEnded) return false;

    // Check if it's player's turn
    if (room.players[game.currentPlayer].id !== playerId) {
      return false;
    }

    const playerHand = game.playerHands[playerId];
    if (!playerHand || cardIndices.some((i) => i >= playerHand.length)) {
      return false;
    }

    // Get cards to play
    const cardsToPlay = cardIndices.map((i) => playerHand[i]);

    // Validate play (implement Yaniv rules here)
    if (!this.isValidPlay(cardsToPlay, game.discardPile)) {
      return false;
    }

    // Remove cards from hand
    cardIndices.sort((a, b) => b - a); // Sort descending to remove from end first
    cardIndices.forEach((i) => playerHand.splice(i, 1));

    // Add cards to discard pile
    game.discardPile.push(...cardsToPlay);

    // Notify all players
    this.io.to(roomId).emit("cards_played", {
      playerId,
      cards: cardsToPlay,
      remainingCards: playerHand.length,
    });

    // Check if player won
    if (playerHand.length === 0) {
      this.endGame(roomId, playerId);
      return true;
    }

    // Move to next turn
    this.nextTurn(roomId);
    return true;
  }

  // Validate if a play is legal according to Yaniv rules
  private isValidPlay(cards: Card[], discardPile: Card[]): boolean {
    if (cards.length === 0) return false;

    // Single card is always valid
    if (cards.length === 1) return true;

    // Multiple cards must be same value or sequential same suit
    const firstCard = cards[0];

    // Same value check
    if (cards.every((card) => card.value === firstCard.value)) {
      return true;
    }

    // Sequential same suit check
    if (cards.every((card) => card.suit === firstCard.suit)) {
      const sortedValues = cards.map((c) => c.value).sort((a, b) => a - b);
      for (let i = 1; i < sortedValues.length; i++) {
        if (sortedValues[i] !== sortedValues[i - 1] + 1) {
          return false;
        }
      }
      return true;
    }

    return false;
  }

  // End the game
  private endGame(roomId: string, winnerId: string): void {
    const game = this.games[roomId];
    if (!game) return;

    // CLEAR TIMER when game ends
    if (game.turnTimer) {
      clearTimeout(game.turnTimer);
      game.turnTimer = undefined;
    }

    game.gameEnded = true;
    game.winner = winnerId;

    this.io.to(roomId).emit("game_ended", {
      winner: winnerId,
      finalScores: this.calculateFinalScores(roomId),
    });

    console.log(`Game ended in room ${roomId}, winner: ${winnerId}`);
  }

  // Calculate final scores
  private calculateFinalScores(roomId: string): { [playerId: string]: number } {
    const game = this.games[roomId];
    if (!game) return {};

    const scores: { [playerId: string]: number } = {};

    Object.entries(game.playerHands).forEach(([playerId, hand]) => {
      scores[playerId] = hand.reduce((sum, card) => {
        // Aces = 1, Face cards = 10, others = face value
        const value = card.value === 1 ? 1 : card.value > 10 ? 10 : card.value;
        return sum + value;
      }, 0);
    });

    return scores;
  }

  // Get public game state (without private information)
  private getPublicGameState(roomId: string) {
    const game = this.games[roomId];
    if (!game) return null;

    return {
      currentPlayer: game.currentPlayer,
      discardPile: game.discardPile,
      cardsInDeck: game.deck.length,
      gameStartTime: game.gameStartTime,
      turnStartTime: game.turnStartTime,
      gameEnded: game.gameEnded,
      winner: game.winner,
    };
  }

  // Get player hands for private distribution
  private getPlayerHands(roomId: string) {
    const game = this.games[roomId];
    if (!game) return {};

    const playerHands: { [playerId: string]: Card[] } = {};
    Object.entries(game.playerHands).forEach(([playerId, hand]) => {
      playerHands[playerId] = hand;
    });

    return playerHands;
  }

  // Clean up game when room is deleted
  cleanupGame(roomId: string): void {
    const game = this.games[roomId];

    // CLEAR TIMER when cleaning up
    if (game?.turnTimer) {
      clearTimeout(game.turnTimer);
    }

    delete this.games[roomId];
    console.log(`Game cleanup completed for room ${roomId}`);
  }

  // Get game state for a room
  getGameState(roomId: string): GameState | null {
    return this.games[roomId] || null;
  }
}
