import { isNull, isUndefined } from "lodash";
import { Server } from "socket.io";
import { Card, getCardKey, getCardValue, TurnAction } from "./cards";
import {
  findSequenceArrangement,
  isValidCardSet,
  sortCards,
} from "./gameRules";
import { RoomManager } from "./roomManager";

type PlayerStatusType = "active" | "lost" | "winner" | "playAgain" | "leave";
type PlayerStatus = {
  score: number;
  playerStatus: PlayerStatusType;
  playerName: string;
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
  round: number;
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
          obj[user.id] = {
            score: 0,
            playerStatus: "active",
            playerName: user.nickName,
          };
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
      round: 0,
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
      currentPlayerId: room.players[0].id,
      round: 0,
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
              winnerId === player.id &&
              game.playersStats[player.id].playerStatus !== "lost" &&
              game.playersStats[player.id].playerStatus !== "leave"
          )
        : null;

    game.round += 1;

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
      round: game.round,
    };

    this.games[roomId] = gameState;

    // Deal 5 cards to each player
    room.players.forEach((player) => {
      if (
        player &&
        game.playersStats[player.id].playerStatus !== "lost" &&
        game.playersStats[player.id].playerStatus !== "leave"
      ) {
        gameState.playerHands[player.id] = [];
        for (let i = 0; i < 5; i++) {
          const card = gameState.deck.pop();
          if (card) {
            gameState.playerHands[player.id].push(card);
          }
        }
      }
    });
    game.currentPlayer = winnerId
      ? room.players.findIndex((player) => player.id === winnerId)
      : game.currentPlayer;

    this.io.to(roomId).emit("new_round", {
      playersStats: game.playersStats,
      gameState: this.getPublicGameState(roomId),
      playerHands: this.getPlayerHands(roomId),
      firstCard,
      users: room.players,
      currentPlayerId: room.players[game.currentPlayer]?.id,
      round: game.round,
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
    deck.push({ suit: "hearts", value: 0 });
    deck.push({ suit: "spades", value: 0 });

    return deck;
  }

  // Calculate hand total
  private getHandValue(hand: Card[]): number {
    return hand.reduce((sum, card) => sum + getCardValue(card), 0);
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

    let event;

    const { choice } = action;

    const sortedSelectedCards = findSequenceArrangement(selectedCards);

    if (isNull(sortedSelectedCards)) {
      return false;
    }

    if (choice === "deck") {
      event = this.drawFromDeck(
        roomId,
        playerId,
        sortedSelectedCards,
        disableSlapDown
      );
    } else if (choice === "pickup") {
      const { pickupIndex } = action;
      event = this.pickupCard(
        roomId,
        playerId,
        pickupIndex,
        sortedSelectedCards
      );
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

    game.playerHands[playerId] = sortCards(game.playerHands[playerId]);

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
        isValidCardSet([...selectedCards, card]) &&
        card.value !== 0
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
      game.playerHands[playerId] = sortCards(game.playerHands[playerId]);
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

    game.playerHands[playerId] = sortCards(game.playerHands[playerId]);

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
      player &&
      game.playersStats[player.id].playerStatus !== "lost" &&
      game.playersStats[player.id].playerStatus !== "leave"
        ? this.getHandValue(game.playerHands[player.id])
        : Infinity
    );
    const minValue = Math.min(...scores);

    const yanivCall = playerId;

    if (handValue >= minValue) {
      const i = room.players.findIndex(
        (player) =>
          player &&
          game.playersStats[player.id].playerStatus !== "lost" &&
          game.playersStats[player.id].playerStatus !== "leave" &&
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

  playAgain(roomId: string, playerId: string): boolean {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);
    if (!game || !room) {
      return false;
    }

    if (!game.gameEnded) {
      return false;
    }

    game.playersStats[playerId].playerStatus = "playAgain";
    this.io.to(roomId).emit("set_playersStats_data", {
      roomId,
      playerId,
      playersStats: game.playersStats,
    });

    const thereAllVotes = Object.values(game.playersStats).every(
      (status) =>
        status.playerStatus === "playAgain" || status.playerStatus === "leave"
    );

    const playAgainVotes = Object.values(game.playersStats).filter(
      (status) => status.playerStatus === "playAgain"
    );
    if (thereAllVotes && playAgainVotes.length > 1) {
      setTimeout(() => {
        this.startGame(roomId);
      }, 6000);
      return true;
    }

    return false;
  }

  leaveGame(roomId: string, playerId: string): boolean {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);
    console.log("LEAVE GAME");
    if (!game || !room) {
      return false;
    }

    game.playersStats[playerId].playerStatus = "leave";
    console.log("LEAVE GAME", game.playersStats[playerId]);

    const activePlayers = Object.entries(game.playersStats).filter(
      ([, player]) =>
        player.playerStatus !== "lost" && player.playerStatus !== "leave"
    );

    if (activePlayers.length === 1 && !game.gameEnded) {
      this.endGame(roomId, activePlayers[0][0]);
    } else {
      this.io.to(roomId).emit("set_playersStats_data", {
        roomId,
        playerId,
        playersStats: game.playersStats,
      });
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
      if (
        !p ||
        game.playersStats[p.id].playerStatus === "lost" ||
        game.playersStats[p.id].playerStatus === "leave"
      ) {
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
        playersStats[p.id].playerStatus = "lost";
      }
      playersStats[p.id].score = score;
    }

    game.playersStats = playersStats;
    this.games[roomId].playersStats = playersStats;

    const activePlayers = Object.entries(playersStats).filter(
      ([, player]) =>
        player.playerStatus !== "lost" && player.playerStatus !== "leave"
    );

    this.io.to(roomId).emit("round_ended", {
      winnerId,
      playersStats,
      lowestValue: game.playerHands[winnerId],
      yanivCaller,
      assafCaller,
      playerHands: game.playerHands,
    });
    if (activePlayers.length === 1) {
      this.endGame(roomId, activePlayers[0][0]);
    } else {
      const startGameTimeout = setTimeout(() => {
        this.startNewRound(roomId, winnerId);
        clearTimeout(startGameTimeout);
      }, 3000 + (yanivCaller ? 3000 : 0) + (assafCaller ? 3000 : 0));

      console.log(`Round ended. winner: ${winnerId}`);
    }
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
      if (
        player &&
        game.playersStats[player.id].playerStatus !== "leave" &&
        game.playersStats[player.id].playerStatus !== "lost"
      ) {
        game.currentPlayer = nextIndex;
        return;
      }
    }

    // אם לא נמצא אף שחקן פעיל — כל השחקנים הפסידו (מקרה קצה נדיר)
    console.warn("No active players remaining in game", roomId);
  }

  private endGame(roomId: string, winnerId: string): void {
    console.log("End Game ");
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
      playersStats: game.playersStats,
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
      const sortedHand = sortCards([...hand]);
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
