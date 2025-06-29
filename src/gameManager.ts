import { Socket } from "socket.io";
import { Server } from "socket.io";
import { RoomManager, Player, Room } from "./roomManager";

// Game-specific interfaces
export interface Card {
  suit: "hearts" | "diamonds" | "clubs" | "spades";
  value: number; // 1-13 (1=Ace, 11=Jack, 12=Queen, 13=King)
  isJoker?: boolean; // Mark jokers
}

export interface GameState {
  currentPlayer: number;
  deck: Card[];
  lastPlayedCards: Card[]; // Track what was played last turn for pickup rules
  playerHands: { [playerId: string]: Card[] };
  gameStartTime: Date;
  turnStartTime: Date;
  gameEnded: boolean;
  winner?: string;
  turnTimer?: NodeJS.Timeout;
  timePerPlayer: number;
  yanivCalleeId?: string;
  callValue?: number;
}

const TIME_FOR_SHOUT = 10; //seconds

function removeSelectedCards(cards: Card[], selectedCards: Card[]) {
  const remainingCards = [...cards]; // Create a copy to avoid mutating original

  selectedCards.forEach((selectedCard) => {
    // Find the first matching card in remainingCards
    const index = remainingCards.findIndex(
      (card) =>
        card.suit === selectedCard.suit && card.value === selectedCard.value
    );

    if (index !== -1) {
      remainingCards.splice(index, 1); // Remove exactly one card
    }
  });

  return remainingCards;
}

export class GameManager {
  private games: { [roomId: string]: GameState } = {};
  private io: Server;
  private roomManager: RoomManager;

  constructor(io: Server, roomManager: RoomManager) {
    this.io = io;
    this.roomManager = roomManager;
  }

  startGame(roomId: string): boolean {
    const room = this.roomManager.getRoomState(roomId);
    if (!room || room.gameState !== "started") {
      return false;
    }

    const deck = this.createDeck();
    // Place first card on discard pile
    const firstCard = deck.pop();

    const gameState: GameState = {
      currentPlayer: 0,
      deck,
      lastPlayedCards: firstCard ? [firstCard] : [],
      playerHands: {},
      gameStartTime: new Date(),
      turnStartTime: new Date(),
      gameEnded: false,
      turnTimer: undefined,
      timePerPlayer: room.config.timePerPlayer,
    };

    this.games[roomId] = gameState;

    this.shuffleDeck(gameState.deck);

    // Deal 5 cards to each player
    room.players.forEach((player) => {
      if (player) {
        gameState.playerHands[player.id] = [];
        for (let i = 0; i < 5; i++) {
          const card = gameState.deck.pop();
          if (card) {
            gameState.playerHands[player.id].push(card);
          }
        }
      }
    });

    this.io.to(roomId).emit("game_initialized", {
      gameState: this.getPublicGameState(roomId),
      playerHands: this.getPlayerHands(roomId),
      firstCard,
      users: room.players,
    });

    this.startPlayerTurn(roomId);
    return true;
  }

  // Create deck with 52 cards + 2 jokers
  private createDeck(): Card[] {
    const suits: Card["suit"][] = ["hearts", "diamonds", "clubs", "spades"];
    const deck: Card[] = [];

    // Regular cards
    suits.forEach((suit) => {
      for (let value = 1; value <= 13; value++) {
        deck.push({ suit, value });
      }
    });

    // Add 2 jokers (marked as special cards)
    deck.push({ suit: "hearts", value: 0, isJoker: true });
    deck.push({ suit: "spades", value: 0, isJoker: true });

    return deck;
  }

  // Calculate card value for scoring
  private getCardValue(card: Card): number {
    if (card.isJoker) return 0;
    if (card.value === 1) return 1; // Ace = 1
    if (card.value >= 11) return 10; // J, Q, K = 10
    return card.value; // 2-10 = face value
  }

  // Calculate hand total
  private getHandValue(hand: Card[]): number {
    return hand.reduce((sum, card) => sum + this.getCardValue(card), 0);
  }

  private shuffleDeck(deck: Card[]): void {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
  }

  private startPlayerTurn(roomId: string): void {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    if (!game || !room) return;

    if (game.turnTimer) {
      clearTimeout(game.turnTimer);
      game.turnTimer = undefined;
    }

    game.turnStartTime = new Date();
    const currentPlayer = room.players[game.currentPlayer];

    if (currentPlayer) {
      this.io.to(roomId).emit("turn_started", {
        currentPlayerId: currentPlayer.id,
        timeRemaining: game.timePerPlayer,
      });

      // Start turn timer
      game.turnTimer = setTimeout(() => {
        this.handleTurnTimeout(roomId);
      }, game.timePerPlayer * 1000);
    }
  }

  private handleTurnTimeout(roomId: string): void {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    if (!game || !room || game.gameEnded) return;

    game.turnTimer = undefined;
    const currentPlayer = room.players[game.currentPlayer];

    if (currentPlayer) {
      const pickedCard: Card[] = game.playerHands[currentPlayer.id].filter(
        (card) =>
          card.value >=
          Math.max(
            ...game.playerHands[currentPlayer.id].map((card) => card.value)
          )
      );
      this.completeTurn(roomId, currentPlayer.id, "deck", [pickedCard[0]]);
    }
  }

  // Complete turn by drawing (second part of turn)
  completeTurn(
    roomId: string,
    playerId: string,
    choice: "deck" | "pickup",
    selectedCards: Card[],
    pickupIndex?: number
  ): boolean {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    if (!game || !room) return false;
    if (room.players[game.currentPlayer]?.id !== playerId) return false;

    let success = false;

    if (choice === "deck") {
      success = this.drawFromDeck(roomId, playerId, selectedCards);
    } else if (choice === "pickup" && pickupIndex !== undefined) {
      success = this.pickupCard(roomId, playerId, pickupIndex, selectedCards);
    }

    if (success) {
      this.nextTurn(roomId);
    }

    return success;
  }

  // Draw from deck
  private drawFromDeck(
    roomId: string,
    playerId: string,
    selectedCards: Card[]
  ): boolean {
    const game = this.games[roomId];
    if (!game) return false;

    if (game.deck.length === 0) {
      this.reshuffleDiscardPile(roomId);
    }

    const card = game.deck.pop();

    game.playerHands[playerId] = removeSelectedCards(
      game.playerHands[playerId],
      selectedCards
    );
    game.lastPlayedCards = selectedCards;

    if (card) {
      game.playerHands[playerId].push(card);
      this.io.to(roomId).emit("player_drew", {
        playerId,
        source: "deck",
        cardsInDeck: game.deck.length,
        hands: game.playerHands[playerId],
        lastPlayedCards: game.lastPlayedCards,
      });

      return true;
    }
    return false;
  }

  // Pick up card from last played cards
  private pickupCard(
    roomId: string,
    playerId: string,
    cardIndex: number,
    selectedCards: Card[]
  ): boolean {
    const game = this.games[roomId];
    if (!game) return false;

    const pickupOptions = this.getPickupOptions(roomId);

    if (cardIndex < 0 || cardIndex >= pickupOptions.length) return false;

    const cardToPick = pickupOptions[cardIndex];

    game.playerHands[playerId] = [
      ...removeSelectedCards(game.playerHands[playerId], selectedCards),
      cardToPick,
    ];

    game.lastPlayedCards = selectedCards;
    this.io.to(roomId).emit("player_drew", {
      playerId,
      source: "pickup",
      card: cardToPick,
      hands: game.playerHands[playerId],
      lastPlayedCards: game.lastPlayedCards,
    });

    return true;
  }

  // Get cards available for pickup based on last play
  private getPickupOptions(roomId: string): Card[] {
    const game = this.games[roomId];
    if (!game || game.lastPlayedCards.length === 0) return [];

    const lastPlay = game.lastPlayedCards;

    // Single card - can pick it up
    if (lastPlay.length === 1) {
      return [lastPlay[0]];
    }

    // Check if it's a set or sequence
    if (this.isValidSet(lastPlay)) {
      // Set - can pick any card
      return [...lastPlay];
    }

    if (this.isValidSequence(lastPlay)) {
      // Sequence - can only pick first or last card
      return [lastPlay[0], lastPlay[lastPlay.length - 1]];
    }

    return [];
  }

  // Call Yaniv
  callYaniv(roomId: string, playerId: string): boolean {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    if (!game || !room || game.gameEnded) return false;
    if (room.players[game.currentPlayer]?.id !== playerId) return false;

    const playerHand = game.playerHands[playerId];
    const handValue = this.getHandValue(playerHand);

    // Can only call Yaniv with 7 points or less
    if (handValue > 7) {
      this.io.to(playerId).emit("game_error", {
        message: `Cannot call Yaniv with ${handValue} points. Maximum is 7.`,
      });
      return false;
    }

    this.games[roomId].callValue = handValue;
    if (game.turnTimer) {
      clearTimeout(game.turnTimer);
      game.turnTimer = undefined;
    }
    game.turnStartTime = new Date();
    game.turnTimer = setTimeout(() => {
      this.endRound(roomId, playerId);
    }, TIME_FOR_SHOUT * 1000);

    this.io.to(roomId).emit("yaniv", {
      playerId,
      handValue,
    });

    return true;
  }

  // Call Assaf
  callAssaf(roomId: string, playerId: string): boolean {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    console.log("assaf!!", game.callValue);

    if (!game || !room || game.gameEnded || !game.callValue) return false;

    const playerHand = game.playerHands[playerId];
    const handValue = this.getHandValue(playerHand);

    console.log("assaf called", game.callValue);

    // Can only call Yaniv with 7 points or less
    if (handValue >= game.callValue) {
      this.io.to(playerId).emit("game_error", {
        message: `Cannot call Assaf with ${handValue} points. Maximum is ${game.callValue}.`,
      });
      return false;
    }

    if (game.turnTimer) {
      clearTimeout(game.turnTimer);
      game.turnTimer = undefined;
    }

    this.games[roomId].callValue = handValue;
    game.turnStartTime = new Date();
    game.turnTimer = setTimeout(() => {
      this.endRound(roomId, playerId);
    }, TIME_FOR_SHOUT * 1000);

    this.io.to(roomId).emit("assaf", {
      playerId,
      handValue,
    });

    return true;
  }

  // End round due to Yaniv call
  private endRound(roomId: string, winnerId: string): void {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    if (!game || !room || !game.yanivCalleeId) return;

    if (game.turnTimer) {
      clearTimeout(game.turnTimer);
      game.turnTimer = undefined;
    }

    const lowestValue = game.playerHands[winnerId];
    game.playerHands[winnerId] = [];

    const playersScores = room.players.map((p, i) =>
      p ? this.getHandValue(game.playerHands[p.id]) : Infinity
    );

    let yanivCalleDelayedScore: number | undefined = undefined;

    if (game.yanivCalleeId !== winnerId) {
      playersScores[game.yanivCalleeId] += 30;
      if (
        playersScores[game.yanivCalleeId] % 50 === 0 &&
        playersScores[game.yanivCalleeId] > 50
      ) {
        yanivCalleDelayedScore = playersScores[game.yanivCalleeId] - 50;
      }
    }

    this.io.to(roomId).emit("round_ended", {
      winnerId,
      playersScores,
      lowestValue,
      yanivCalle:
        yanivCalleDelayedScore && game.yanivCalleeId
          ? {
              realScore: yanivCalleDelayedScore,
              id: game.yanivCalleeId,
            }
          : null,
    });

    console.log(`Round ended. winner: ${winnerId}`);
  }

  // Check if cards form a valid set (same value)
  private isValidSet(cards: Card[]): boolean {
    if (cards.length < 2) return false;

    const nonJokers = cards.filter((c) => !c.isJoker);
    if (nonJokers.length === 0) return false;

    const targetValue = nonJokers[0].value;
    return nonJokers.every((card) => card.value === targetValue);
  }

  // Check if cards form a valid sequence (consecutive same suit)
  private isValidSequence(cards: Card[]): boolean {
    if (cards.length < 3) return false;

    const realCards = cards.filter((c) => !c.isJoker);
    const jokerCount = cards.length - realCards.length;

    if (realCards.length === 0) return false;

    // All real cards must be same suit
    const suit = realCards[0].suit;
    if (!realCards.every((card) => card.suit === suit)) return false;

    // Sort real cards by value
    const sortedValues = realCards.map((c) => c.value).sort((a, b) => a - b);

    // Check if sequence is possible with jokers
    let gapsNeeded = 0;
    for (let i = 0; i < sortedValues.length - 1; i++) {
      gapsNeeded += sortedValues[i + 1] - sortedValues[i] - 1;
    }

    return gapsNeeded <= jokerCount;
  }

  private reshuffleDiscardPile(roomId: string): void {
    const game = this.games[roomId];
    const topCard = game.lastPlayedCards.pop();
    this.shuffleDeck(game.deck);
    game.lastPlayedCards = topCard ? [topCard] : [];
    this.io.to(roomId).emit("deck_reshuffled");
  }

  private nextTurn(roomId: string): void {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    if (!game || !room || game.gameEnded) return;

    if (game.turnTimer) {
      clearTimeout(game.turnTimer);
      game.turnTimer = undefined;
    }

    game.currentPlayer = (game.currentPlayer + 1) % room.players.length;

    this.startPlayerTurn(roomId);
  }

  private endGame(roomId: string, winnerId: string): void {
    const game = this.games[roomId];
    if (!game) return;

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
  }

  private calculateFinalScores(roomId: string): { [playerId: string]: number } {
    const game = this.games[roomId];
    if (!game) return {};

    const scores: { [playerId: string]: number } = {};
    Object.entries(game.playerHands).forEach(([playerId, hand]) => {
      scores[playerId] = this.getHandValue(hand);
    });

    return scores;
  }

  private getPublicGameState(roomId: string) {
    const game = this.games[roomId];
    if (!game) return null;

    return {
      currentPlayer: game.currentPlayer,
      cardsInDeck: game.deck.length,
      gameStartTime: game.gameStartTime,
      turnStartTime: game.turnStartTime,
      gameEnded: game.gameEnded,
      winner: game.winner,
      timePerPlayer: game.timePerPlayer,
    };
  }

  private getPlayerHands(roomId: string) {
    const game = this.games[roomId];
    if (!game) return {};

    const playerHands: { [playerId: string]: Card[] } = {};
    Object.entries(game.playerHands).forEach(([playerId, hand]) => {
      playerHands[playerId] = hand;
    });

    return playerHands;
  }

  cleanupGame(roomId: string): void {
    const game = this.games[roomId];
    if (game?.turnTimer) {
      clearTimeout(game.turnTimer);
    }
    delete this.games[roomId];
  }

  getGameState(roomId: string): GameState | null {
    return this.games[roomId] || null;
  }
}
