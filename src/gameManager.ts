import { isUndefined } from "lodash";
import { Server } from "socket.io";
import { RoomManager } from "./roomManager";
import { Card, getCardKey, TurnAction } from "./cards";
import { isValidCardSet } from "./gameRules";

type PlayerStatus = {
  score: number;
  lost: boolean;
};

export interface GameState {
  currentPlayer: number;
  deck: Card[];
  pickupCards: Card[]; // Track what was played last turn for pickup rules
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
  slapDownTimer?: NodeJS.Timeout;
  playersStats: Record<string, PlayerStatus>;
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
    this.shuffleDeck(deck);

    // Place first card on discard pile
    const firstCard = deck.pop();

    const gameState: GameState = {
      currentPlayer: 0,
      deck,
      pickupCards: firstCard ? [firstCard] : [],
      playerHands: {},
      gameStartTime: new Date(),
      turnStartTime: new Date(),
      playersStats: room.players.reduce<Record<string, PlayerStatus>>(
        (obj, user) => {
          obj[user.id] = { score: 0, lost: false };
          return obj;
        },
        {}
      ),
      gameEnded: false,
      turnTimer: undefined,
      timePerPlayer: room.config.timePerPlayer,
      canCallYaniv: room.config.canCallYaniv,
      maxMatchPoints: room.config.maxMatchPoints,
      slapDown: room.config.slapDown,
      slapDownActiveFor: undefined,
      slapDownTimer: undefined,
    };

    this.games[roomId] = gameState;

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
    this.shuffleDeck(deck);

    // Place first card on discard pile
    const firstCard = deck.pop();
    const firstPlayer =
      !isUndefined(winnerId) && room.players.length //&& !room.players[winnerId].isLose TODO when call asaf but the scores is over then maxmuchpoint
        ? room.players.findIndex(
            (player) =>
              winnerId === player.id && !game.playersStats[player.id].lost
          )
        : null;

    const gameState: GameState = {
      currentPlayer: firstPlayer ?? 0,
      deck,
      pickupCards: firstCard ? [firstCard] : [],
      playerHands: {},
      gameStartTime: new Date(),
      turnStartTime: new Date(),
      gameEnded: false,
      turnTimer: undefined,
      timePerPlayer: room.config.timePerPlayer,
      canCallYaniv: room.config.canCallYaniv,
      maxMatchPoints: room.config.maxMatchPoints,
      slapDown: room.config.slapDown,
      slapDownTimer: undefined,
      slapDownActiveFor: undefined,
      playersStats: game.playersStats,
    };

    this.games[roomId] = gameState;

    // Deal 5 cards to each player
    room.players.forEach((player) => {
      if (player && !game.playersStats[player.id].lost) {
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
      playersStats: game.playersStats,
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
      // game.turnTimer = setTimeout(() => {
      //   this.handleTurnTimeout(roomId);
      // }, game.timePerPlayer * 1000);
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

    let event;

    const { choice } = action;

    if (choice === "deck") {
      event = this.drawFromDeck(
        roomId,
        playerId,
        selectedCards,
        disableSlapDown
      );
    } else if (choice === "pickup") {
      const { pickupIndex } = action;
      event = this.pickupCard(roomId, playerId, pickupIndex, selectedCards);
    }

    if (event) {
      this.nextTurn(roomId);

      this.io.to(roomId).emit("player_drew", {
        ...event,
        currentPlayerId: room.players[game.currentPlayer].id,
      });
      this.startPlayerTurn(roomId);
    }

    return !!event;
  }

  // Draw from deck
  private drawFromDeck(
    roomId: string,
    playerId: string,
    selectedCards: Card[],
    disableSlapDown = false // case where it must disable the slap-down even if suppose to be
  ):
    | {
        playerId: string;
        source: "deck";
        hands: Card[];
        pickupCards: Card[];
        card: Card;
        selectedCardsPositions: number[];
        amountBefore: number;
        slapDownActiveFor?: string;
      }
    | undefined {
    const game = this.games[roomId];
    if (!game) {
      return;
    }

    if (game.deck.length === 0) {
      this.reshuffleDiscardPile(roomId);
    }

    const card = game.deck.pop();

    const { selectedCardsPositions, amountBefore } = this.getStateBeforeAction(
      selectedCards,
      game.playerHands[playerId]
    );

    game.playerHands[playerId] = removeSelectedCards(
      game.playerHands[playerId],
      selectedCards
    );
    game.pickupCards = selectedCards;

    if (card) {
      if (
        !disableSlapDown &&
        game.slapDown &&
        isValidCardSet([...selectedCards, card])
      ) {
        this.removeCurrentSlapDown(game);
        game.slapDownActiveFor = playerId;
        game.slapDownTimer = setTimeout(() => {
          this.removeCurrentSlapDown(game);
        }, 3000);
      } else {
        this.removeCurrentSlapDown(game);
      }
      game.playerHands[playerId].push(card);
      game.playerHands[playerId].sort((a, b) => a.value - b.value);
      this.games[roomId] = game;

      return {
        playerId,
        source: "deck",
        hands: game.playerHands[playerId],
        pickupCards: game.pickupCards,
        card,
        selectedCardsPositions,
        amountBefore,
        slapDownActiveFor: game.slapDownActiveFor,
      };
    }
    return;
  }

  private getStateBeforeAction(selectedCards: Card[], playerHands: Card[]) {
    const handsCardKeys = playerHands.map(getCardKey);
    const selectedCardsKeys = selectedCards.map(getCardKey);
    const selectedCardsPositions = selectedCardsKeys
      .map((cardKey) => handsCardKeys.indexOf(cardKey))
      .filter((i) => i >= 0);
    const amountBefore = handsCardKeys.length;
    return { selectedCardsPositions, amountBefore };
  }

  private removeCurrentSlapDown(game: GameState | undefined, reset = false) {
    if (game && game.slapDownTimer) {
      clearTimeout(game.slapDownTimer);
      game.slapDownTimer = undefined;
      game.slapDownActiveFor = undefined;
    }
  }

  // Pick up card from last played cards
  private pickupCard(
    roomId: string,
    playerId: string,
    cardIndex: number,
    selectedCards: Card[]
  ):
    | {
        playerId: string;
        source: "pickup";
        hands: Card[];
        pickupCards: Card[];
        card: Card;
        selectedCardsPositions: number[];
        amountBefore: number;
      }
    | undefined {
    const game = this.games[roomId];
    if (!game || game.pickupCards.length === 0) {
      return;
    }

    if (cardIndex < 0 || cardIndex >= game.pickupCards.length) {
      return;
    }

    const { selectedCardsPositions, amountBefore } = this.getStateBeforeAction(
      selectedCards,
      game.playerHands[playerId]
    );

    const cardToPick = game.pickupCards[cardIndex];

    game.playerHands[playerId] = [
      ...removeSelectedCards(game.playerHands[playerId], selectedCards),
      cardToPick,
    ];
    game.playerHands[playerId].sort((a, b) => a.value - b.value);

    game.pickupCards = selectedCards;

    return {
      playerId,
      source: "pickup",
      hands: game.playerHands[playerId],
      pickupCards: game.pickupCards,
      card: cardToPick,
      selectedCardsPositions,
      amountBefore,
    };
  }

  // Slap-Down
  onSlapDown(roomId: string, playerId: string, card: Card): boolean {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);
    if (
      !game ||
      !room ||
      game.gameEnded ||
      game.slapDownActiveFor !== playerId
    ) {
      return false;
    }

    const selectedCardsPositions = [
      game.playerHands[playerId].findIndex(
        (c) => getCardKey(c) === getCardKey(card)
      ),
    ];
    const amountBefore = game.playerHands[playerId].length;

    game.playerHands[playerId] = removeSelectedCards(
      game.playerHands[playerId],
      [card]
    );
    game.pickupCards = [card];

    this.io.to(roomId).emit("player_drew", {
      playerId,
      source: "slap",
      hands: game.playerHands[playerId],
      pickupCards: game.pickupCards,
      card,
      selectedCardsPositions,
      amountBefore,
      currentPlayerId: room.players[game.currentPlayer].id,
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

    this.removeTimers(game);

    const scores = room.players.map((player) =>
      player && !game.playersStats[player.id].lost
        ? this.getHandValue(game.playerHands[player.id])
        : Infinity
    );
    const minValue = Math.min(...scores);

    const yanivCall = playerId;

    if (handValue >= minValue) {
      const i = room.players.findIndex(
        (player) =>
          player &&
          !game.playersStats[player.id].lost &&
          player.id !== playerId &&
          this.getHandValue(game.playerHands[player.id]) === minValue
      );
      scores.findIndex((score) => score === minValue);
      const winnerId = room.players[i]?.id;
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

    this.removeTimers(game);

    const winnerId = assafCaller ?? yanivCaller;

    const playersStats: Record<string, PlayerStatus> = game.playersStats;

    for (const p of room.players) {
      if (!p || playersStats[p.id].lost) {
        continue;
      }

      let score: number = isUndefined(playersStats[p.id])
        ? 0
        : +playersStats[p.id].score;

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
        playersStats[p.id].lost = true;
      }
      playersStats[p.id].score = score;
    }

    game.playersStats = playersStats;
    this.io.to(roomId).emit("round_ended", {
      winnerId,
      playersStats,
      lowestValue: game.playerHands[winnerId],
      yanivCaller,
      assafCaller,
      playerHands: game.playerHands,
    });

    const startGameTimeout = setTimeout(() => {
      this.startNewRound(roomId, winnerId);
      clearTimeout(startGameTimeout);
    }, 3000 + (yanivCaller ? 3000 : 0) + (assafCaller ? 3000 : 0));

    console.log(`Round ended. winner: ${winnerId}`);
  }

  private reshuffleDiscardPile(roomId: string): void {
    const game = this.games[roomId];
    const topCard = game.pickupCards.pop();
    this.shuffleDeck(game.deck);
    game.pickupCards = topCard ? [topCard] : [];
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
      if (player && !game.playersStats[player.id].lost) {
        game.currentPlayer = nextIndex;
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

    this.removeTimers(game);

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
      playersStats: game.playersStats,
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
    if (game) {
      this.removeTimers(game);
      delete this.games[roomId];
    }
  }

  getGameState(roomId: string): GameState | null {
    return this.games[roomId] || null;
  }

  removeTimers(game: GameState) {
    if (game.turnTimer) {
      clearTimeout(game.turnTimer);
      game.turnTimer = undefined;
    }
    this.removeCurrentSlapDown(game);
  }
}
