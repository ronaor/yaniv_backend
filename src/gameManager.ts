import { isUndefined } from "lodash";
import { Server } from "socket.io";
import { RoomManager } from "./roomManager";
import { Card, TurnAction } from "./cards";
import { isValidCardSet } from "./gameRules";

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
  canCallYaniv: number;
  maxMatchPoints: number;
  slapDown: boolean;
  slapDownActiveFor?: string;
  playersScores: Record<string, string>;
}

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
      playersScores: {},
      gameEnded: false,
      turnTimer: undefined,
      timePerPlayer: room.config.timePerPlayer,
      canCallYaniv: room.config.canCallYaniv,
      maxMatchPoints: room.config.maxMatchPoints,
      slapDown: room.config.slapDown,
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

  startNewRound(roomId: string, winnerId: string): boolean {
    // console.log(" winnerId:", winnerId);
    const room = this.roomManager.getRoomState(roomId);
    const game = this.games[roomId];
    if (!room || room.gameState !== "started") {
      return false;
    }

    const deck = this.createDeck();
    // Place first card on discard pile
    const firstCard = deck.pop();
    const firstPlayer =
      !isUndefined(winnerId) && room.players.length //&& !room.players[winnerId].isLose TODO when call asaf but the scores is over then maxmuchpoint
        ? room.players.findIndex(
            (player) => winnerId === player.id && !player.isLose
          )
        : null;

    const gameState: GameState = {
      currentPlayer: firstPlayer ?? 0,
      deck,
      lastPlayedCards: firstCard ? [firstCard] : [],
      playerHands: {},
      gameStartTime: new Date(),
      turnStartTime: new Date(),
      gameEnded: false,
      turnTimer: undefined,
      timePerPlayer: room.config.timePerPlayer,
      canCallYaniv: room.config.canCallYaniv,
      maxMatchPoints: room.config.maxMatchPoints,
      slapDown: room.config.slapDown,
      playersScores: game.playersScores,
    };

    this.games[roomId] = gameState;

    this.shuffleDeck(gameState.deck);

    // Deal 5 cards to each player
    room.players.forEach((player) => {
      if (player && !player.isLose) {
        gameState.playerHands[player.id] = [];
        for (let i = 0; i < 5; i++) {
          const card = gameState.deck.pop();
          if (card) {
            gameState.playerHands[player.id].push(card);
          }
        }
      }
    });
    this.io.to(roomId).emit("new_round", {
      playersScores: game.playersScores,
      gameState: this.getPublicGameState(roomId),
      playerHands: this.getPlayerHands(roomId),
      firstCard,
      users: room.players,
    });

    game.currentPlayer = winnerId
      ? room.players.findIndex((player) => player.id === winnerId)
      : game.currentPlayer;
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
    if (card.isJoker) {
      return 0;
    }
    if (card.value === 1) {
      return 1;
    } // Ace = 1
    if (card.value >= 11) {
      return 10;
    } // J, Q, K = 10
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

    if (!game || !room) {
      return;
    }

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

    if (!game || !room || game.gameEnded) {
      return;
    }

    game.turnTimer = undefined;
    const currentPlayer = room.players[game.currentPlayer];

    if (currentPlayer) {
      const pickedCard: Card[] = game.playerHands[currentPlayer.id].filter(
        (card) =>
          card.value >=
          Math.max(...game.playerHands[currentPlayer.id].map((c) => c.value))
      );
      this.completeTurn(
        roomId,
        currentPlayer.id,
        {
          choice: "deck",
        },
        [pickedCard[0]],
        true
      );
    }
  }

  // Complete turn by drawing (second part of turn)
  completeTurn(
    roomId: string,
    playerId: string,
    action: TurnAction,
    selectedCards: Card[],
    disableSlapDown = false
  ): boolean {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    if (!game || !room) {
      return false;
    }
    if (room.players[game.currentPlayer]?.id !== playerId) {
      return false;
    }

    let success = false;

    const { choice } = action;

    if (choice === "deck") {
      success = this.drawFromDeck(
        roomId,
        playerId,
        selectedCards,
        disableSlapDown
      );
    } else if (choice === "pickup") {
      const { pickupIndex } = action;
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
    selectedCards: Card[],
    disableSlapDown = false
  ): boolean {
    const game = this.games[roomId];
    if (!game) {
      return false;
    }

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
      if (
        !disableSlapDown &&
        game.slapDown &&
        isValidCardSet([...selectedCards, card])
      ) {
        game.slapDownActiveFor = playerId;
      }
      game.playerHands[playerId].push(card);
      game.playerHands[playerId].sort((a, b) => a.value - b.value);
      this.io.to(roomId).emit("player_drew", {
        playerId,
        source: "deck",
        hands: game.playerHands[playerId],
        lastPlayedCards: game.lastPlayedCards,
        slapDownActiveFor: game.slapDownActiveFor,
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
    if (!game || game.lastPlayedCards.length === 0) {
      return false;
    }
    const lastPlay = game.lastPlayedCards;

    const pickupOptions = lastPlay;

    if (cardIndex < 0 || cardIndex >= pickupOptions.length) {
      return false;
    }

    const cardToPick = pickupOptions[cardIndex];

    game.playerHands[playerId] = [
      ...removeSelectedCards(game.playerHands[playerId], selectedCards),
      cardToPick,
    ];
    game.playerHands[playerId].sort((a, b) => a.value - b.value);

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

  // Call Yaniv
  callYaniv(roomId: string, playerId: string): boolean {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    if (
      !game ||
      !room ||
      game.gameEnded ||
      room.players[game.currentPlayer]?.id !== playerId
    ) {
      return false;
    }

    const handValue = this.getHandValue(game.playerHands[playerId]);

    // Can only call Yaniv with 7 points or less
    if (handValue > 7) {
      this.io.to(playerId).emit("game_error", {
        message: `Cannot call Yaniv with ${handValue} points. Maximum is 7.`,
      });
      return false;
    }

    if (game.turnTimer) {
      clearTimeout(game.turnTimer);
      game.turnTimer = undefined;
    }

    const scores = room.players.map((player) =>
      player && !player.isLose
        ? this.getHandValue(game.playerHands[player.id])
        : Infinity
    );
    const minValue = Math.min(...scores);

    const yanivCall = playerId;
    if (handValue >= minValue) {
      const i = room.players.findIndex(
        (player) =>
          player &&
          !player.isLose &&
          player.id !== playerId &&
          this.getHandValue(game.playerHands[player.id]) === minValue
      );
      scores.findIndex((score) => score === minValue);
      const winnerId = room.players[i]?.id ?? yanivCall;
      this.endRound(roomId, yanivCall, winnerId);
    } else {
      this.endRound(roomId, playerId);
    }

    return true;
  }

  // End round due to Yaniv call
  private endRound(
    roomId: string,
    yanivCaller: string,
    assafCaller?: string
  ): void {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    if (!game || !room) {
      return;
    }

    if (game.turnTimer) {
      clearTimeout(game.turnTimer);
      game.turnTimer = undefined;
    }

    const winnerId = assafCaller ?? yanivCaller;

    const playersScores: Record<string, string> = game.playersScores;

    for (const p of room.players) {
      if (!p || p.isLose) {
        continue;
      }

      let score: number = isUndefined(playersScores[p.id])
        ? 0
        : +playersScores[p.id];

      if (p.id === yanivCaller && yanivCaller === winnerId) {
        score += 0;
      } else {
        score += this.getHandValue(game.playerHands[p.id]);
      }

      if (p.id === yanivCaller && yanivCaller !== winnerId) {
        score += 30;
      }
      if (score % 50 === 0 && score !== 0) {
        score -= 50;
      }
      if (score > 25) {
        p.isLose = true;
      }
      playersScores[p.id] = String(score);
    }

    game.playersScores = playersScores;
    this.io.to(roomId).emit("round_ended", {
      winnerId,
      playersScores,
      lowestValue: game.playerHands[winnerId],
      yanivCaller,
      assafCaller,
      playerHands: game.playerHands,
    });

    this.startNewRound(roomId, assafCaller ?? yanivCaller);

    console.log(`Round ended. winner: ${winnerId}`);
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

    if (!game || !room || game.gameEnded) {
      return;
    }

    if (game.turnTimer) {
      clearTimeout(game.turnTimer);
      game.turnTimer = undefined;
    }

    const totalPlayers = room.players.length;
    let nextIndex = game.currentPlayer;

    for (let i = 0; i < totalPlayers; i++) {
      nextIndex = (nextIndex + 1) % totalPlayers;
      const player = room.players[nextIndex];
      if (player && !player.isLose) {
        game.currentPlayer = nextIndex;
        this.startPlayerTurn(roomId);
        return;
      }
    }

    // אם לא נמצא אף שחקן פעיל — כל השחקנים הפסידו (מקרה קצה נדיר)
    console.warn("No active players remaining in game", roomId);
  }

  private endGame(roomId: string, winnerId: string): void {
    const game = this.games[roomId];
    if (!game) {
      return;
    }

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
    if (!game) {
      return {};
    }

    const scores: { [playerId: string]: number } = {};
    Object.entries(game.playerHands).forEach(([playerId, hand]) => {
      scores[playerId] = this.getHandValue(hand);
    });

    return scores;
  }

  private getPublicGameState(roomId: string) {
    const game = this.games[roomId];
    if (!game) {
      return null;
    }

    return {
      currentPlayer: game.currentPlayer,
      gameStartTime: game.gameStartTime,
      turnStartTime: game.turnStartTime,
      gameEnded: game.gameEnded,
      winner: game.winner,
      timePerPlayer: game.timePerPlayer,
      canCallYaniv: game.canCallYaniv,
      maxMatchPoints: game.maxMatchPoints,
      slapDown: game.slapDown,
    };
  }

  private getPlayerHands(roomId: string) {
    const game = this.games[roomId];
    if (!game) {
      return {};
    }

    const playerHands: { [playerId: string]: Card[] } = {};
    Object.entries(game.playerHands).forEach(([playerId, hand]) => {
      // Sort cards by value ascending
      const sortedHand = hand.slice().sort((a, b) => a.value - b.value);
      playerHands[playerId] = sortedHand;
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
