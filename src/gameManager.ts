import { isNull, isUndefined } from "lodash";
import { Server } from "socket.io";
import { ComputerPlayer, Difficulty } from "./bot/computerPlayer";
import { Card, getCardKey, getHandValue, TurnAction } from "./cards";
import { findSequenceArrangement, sortCards } from "./gameRules";
import { RoomManager } from "./roomManager";

type PlayerStatusType = "active" | "lost" | "winner" | "playAgain" | "leave";
type PlayerStatus = {
  score: number;
  playerStatus: PlayerStatusType;
  playerName: string;
  avatarIndex: number;
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
  slapDownCard?: Card;
  playersLoserOrder: string[];
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
            avatarIndex: user.avatarIndex,
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
      playersLoserOrder: [],
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

    const totalDelay = 2100 + room.players.length * 500;

    this.io.to(roomId).emit("game_initialized", {
      gameState: this.getPublicGameState(roomId),
      playerHands: this.getPlayerHands(roomId),
      firstCard,
      currentPlayerId: room.players[0].id,
      round: 0,
      startDelay: totalDelay,
    });

    this.games[roomId].turnTimer = setTimeout(() => {
      this.startPlayerTurn(roomId);
    }, totalDelay);
    return true;
  }

  startNewRound(roomId: string, winnerId: string): boolean {
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
      playersLoserOrder: game.playersLoserOrder,
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

    const playersActiveLength = Object.values(gameState.playerHands).filter(
      (hands) => hands.length > 0
    ).length;

    const totalDelay = 2600 + playersActiveLength * 700;

    this.io.to(roomId).emit("new_round", {
      playersStats: game.playersStats,
      gameState: this.getPublicGameState(roomId),
      playerHands: this.getPlayerHands(roomId),
      firstCard,
      users: room.players,
      currentPlayerId: room.players[game.currentPlayer]?.id,
      round: game.round,
      startDelay: totalDelay,
    });

    game.turnTimer = setTimeout(() => {
      this.startPlayerTurn(roomId);
    }, totalDelay);

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

    const currentPlayerIndex = game.currentPlayer;
    const currentPlayer = room.players[currentPlayerIndex];

    if (currentPlayer && game.playerHands[currentPlayer.id]?.length === 0) {
      // no cards call yaniv auto
      this.callYaniv(roomId, currentPlayer.id);
      return;
    }

    // 🤖 תור של בוט
    if (currentPlayer?.isBot && currentPlayer.difficulty) {
      const playerId = currentPlayer.id;
      const hand = game.playerHands[playerId];
      const pickupPile = game.pickupCards;
      const difficulty = currentPlayer.difficulty;
      const lastDiscarded = [...pickupPile];

      // בדיקה אם יש הכרזת יניב לפני הכול
      const handValue = getHandValue(hand);
      if (handValue <= game.canCallYaniv) {
        game.turnTimer = setTimeout(() => {
          this.callYaniv(roomId, playerId);
        }, 1000);
        return;
      }

      // בדיקה האם כדאי לקחת קלף מהקופה
      const pickupIndex = ComputerPlayer.decidePickupIndex(
        hand,
        pickupPile,
        difficulty
      );

      const shouldPickup = pickupIndex !== null;
      const pickupCard = shouldPickup ? pickupPile[pickupIndex!] : null;
      const reservedValues = pickupCard ? [pickupCard.value] : [];

      const selectedCards = ComputerPlayer.chooseCards(
        hand,
        pickupIndex !== null ? [pickupPile[pickupIndex]] : pickupPile,
        difficulty
      );
      ComputerPlayer.rememberDiscarded(selectedCards);

      const action: TurnAction = shouldPickup
        ? { choice: "pickup", pickupIndex: pickupIndex! }
        : { choice: "deck" };

      game.turnTimer = setTimeout(() => {
        const result = this.completeTurn(
          roomId,
          playerId,
          action,
          selectedCards,
          difficulty === Difficulty.Easy
        );

        const gameState = this.games[roomId];

        if (
          gameState &&
          gameState.slapDown &&
          gameState.slapDownActiveFor === playerId
        ) {
          const slapCard = gameState.slapDownCard;
          if (slapCard) {
            setTimeout(() => {
              this.onSlapDown(roomId, playerId, slapCard);
            }, 2000);
          }
        }
      }, 2000);

      return;
    }

    // 👤 שחקן רגיל
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
        !!this.slapDownValidFrom(selectedCards, card)
      ) {
        this.removeCurrentSlapDown(game);
        game.slapDownActiveFor = playerId;
        game.slapDownCard = card;
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
      game.slapDownCard = undefined;
    }
    if (game) game.slapDownCard = undefined;
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

    game.playerHands[playerId] = sortCards([
      ...removeSelectedCards(game.playerHands[playerId], selectedCards),
      cardToPick,
    ]);

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

    const slapDownFrom = this.slapDownValidFrom(game.pickupCards, card);
    switch (slapDownFrom) {
      case "left": {
        game.pickupCards = [card, ...game.pickupCards];
        break;
      }
      case "right": {
        game.pickupCards.push(card);
        break;
      }
      default:
        return false;
    }

    // this is the relative indexes of the pickup cards to player hands,
    const { selectedCardsPositions, amountBefore } = this.getStateBeforeAction(
      game.pickupCards,
      game.playerHands[playerId]
    );

    game.playerHands[playerId] = removeSelectedCards(
      game.playerHands[playerId],
      [card]
    );

    this.removeCurrentSlapDown(game);

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

    const handValue = getHandValue(game.playerHands[playerId]);

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
        ? getHandValue(game.playerHands[player.id])
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
          getHandValue(game.playerHands[player.id]) === minValue
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

    this.updateVotesAndEvaluate(roomId, playerId);

    return true;
  }

  private updateVotesAndEvaluate(roomId: string, playerId: string): boolean {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);

    if (!game || !room) {
      return false;
    }

    if (!game.gameEnded) {
      return false;
    }

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
    }

    return true;
  }

  leaveGame(roomId: string, playerId: string): boolean {
    const game = this.games[roomId];
    const room = this.roomManager.getRoomState(roomId);
    if (!game || !room) {
      return false;
    }

    game.playersStats[playerId].playerStatus = "leave";

    const lastActivePlayers = Object.entries(game.playersStats)
      .filter(
        ([, player]) =>
          player.playerStatus !== "lost" && player.playerStatus !== "leave"
      )
      .map(([playerId]) => playerId);

    if (lastActivePlayers.length === 1 && !game.gameEnded) {
      this.endGame(roomId, lastActivePlayers[0]);
    } else if (game.gameEnded) {
      this.updateVotesAndEvaluate(roomId, playerId);
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

    if (!game || !room) return;

    this.removeTimers(game);

    const winnerId = assafCaller ?? yanivCaller;

    const playersStats: Record<string, PlayerStatus> = game.playersStats;
    const playersRoundScore: Record<string, number[]> = {};

    const roundPlayers = Object.entries(game.playersStats)
      .filter(([_, pS]) => pS.playerStatus === "active")
      .map(([playerId]) => playerId);

    const roundLosers: string[] = [];

    for (const p of room.players) {
      if (
        !p ||
        game.playersStats[p.id].playerStatus === "lost" ||
        game.playersStats[p.id].playerStatus === "leave"
      )
        continue;

      let score = 0;
      if (p.id === yanivCaller) {
        if (p.id !== winnerId) {
          score += 30 + getHandValue(game.playerHands[p.id]);
        }
      } else {
        score += getHandValue(game.playerHands[p.id]);
      }

      playersStats[p.id].score += score;
      playersRoundScore[p.id] = [score];

      if (
        playersStats[p.id].score % 50 === 0 &&
        playersStats[p.id].score !== 0
      ) {
        playersRoundScore[p.id] = playersRoundScore[p.id].concat([-50]);
        playersStats[p.id].score -= 50;
      }

      if (playersStats[p.id].score > game.maxMatchPoints) {
        playersStats[p.id].playerStatus = "lost";
        roundLosers.push(p.id);
      }
    }

    game.playersLoserOrder = [
      ...game.playersLoserOrder,
      ...roundLosers.sort().reverse(),
    ];

    const LOOK_MOMENT = 2000;
    const totalDelay =
      LOOK_MOMENT *
        room.players.filter(
          (p) => game.playersStats[p.id]?.playerStatus === "active"
        ).length -
      1 +
      (roundLosers.length > 0 ? LOOK_MOMENT + 1250 : 0);

    game.playersStats = playersStats;
    this.games[roomId] = game;

    const lastActivePlayers = Object.entries(playersStats)
      .filter(
        ([, player]) =>
          player.playerStatus !== "lost" && player.playerStatus !== "leave"
      )
      .map(([playerId]) => playerId);

    const pickWinnerByScore = (preferAssaf?: string): string => {
      const candidates = room.players.filter(
        (p) => p && playersStats[p.id].playerStatus !== "leave"
      );
      let minScore = Infinity;
      for (const p of candidates) {
        const s = playersStats[p.id].score;
        if (s < minScore) minScore = s;
      }
      const minCandidates = candidates.filter(
        (p) => playersStats[p.id].score === minScore
      );

      // שובר שוויון: מי שאמר אסף (אם קיים והוא בין המועמדים)
      if (preferAssaf) {
        const found = minCandidates.find((p) => p.id === preferAssaf);
        if (found) return found.id;
      }
      return minCandidates[0].id;
    };
    const activeHumans = room.players.filter(
      (p) =>
        p && game.playersStats[p.id]?.playerStatus === "active" && !p.difficulty
    ).length;

    if (activeHumans === 0 && !game.gameEnded) {
      this.io.to(roomId).emit("human_lost");
    }

    this.io.to(roomId).emit("round_ended", {
      winnerId,
      playersStats,
      lowestValue: game.playerHands[winnerId],
      yanivCaller,
      assafCaller,
      playerHands: game.playerHands,
      roundPlayers,
      playersRoundScore,
      losers: roundLosers,
    });

    const finishTimeout = setTimeout(() => {
      if (lastActivePlayers.length < 2) {
        if (lastActivePlayers.length === 1) {
          // נשאר רק אחד פעיל
          this.endGame(roomId, lastActivePlayers[0]);
        } else {
          // ✅ נשארו 0 פעילים → בחר מנצח לפי ניקוד; בשוויון – מי שאמר אסף
          const winnerIdFallback = pickWinnerByScore(assafCaller);
          this.endGame(roomId, winnerIdFallback);
        }
        console.log(`Round ended. winner: ${winnerId}`);
      } else {
        this.startNewRound(roomId, winnerId);
      }
      clearTimeout(finishTimeout);
    }, LOOK_MOMENT + totalDelay);
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
    const game = this.games[roomId];
    if (!game) {
      return;
    }

    this.removeTimers(game);

    game.gameEnded = true;
    game.winner = winnerId;

    const places = game.playersLoserOrder.reverse();
    if (!places.includes(winnerId)) {
      places.unshift(winnerId);
    }

    // Players that left the game (they are not losers)
    Object.entries(game.playersStats).forEach(([id, _]) => {
      if (!places.includes(id)) {
        places.push(id);
      }
    });

    this.games[roomId] = game;
    this.io.to(roomId).emit("game_ended", {
      winner: winnerId,
      finalScores: this.calculateFinalScores(roomId),
      playersStats: game.playersStats,
      places,
    });
  }

  private calculateFinalScores(roomId: string): { [playerId: string]: number } {
    const game = this.games[roomId];
    if (!game) {
      return {};
    }

    const scores: { [playerId: string]: number } = {};
    Object.entries(game.playerHands).forEach(([playerId, hand]) => {
      scores[playerId] = getHandValue(hand);
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

  private slapDownValidFrom(
    selectedCards: Card[],
    drawn: Card
  ): undefined | "left" | "right" {
    if (!drawn) return undefined;

    // (1) קלף בודד — רק אותו דרג בדיוק. ג'וקר → רק אם גם שנמשך ג'וקר.
    if (selectedCards.length === 1) {
      const c = selectedCards[0];
      if (c.value === 0) return drawn.value === 0 ? "right" : undefined; // Joker→Joker בלבד
      return drawn.value === c.value ? "right" : undefined; // 10≠K
    }

    // (2) רצף נקי באותה צורה — drawn מאריך בקצה
    if (selectedCards.length >= 3 && drawn.value !== 0) {
      // ללא ג'וקרים
      if (!selectedCards.every((c) => c.value !== 0)) return undefined;
      const suit = selectedCards[0].suit;
      if (!selectedCards.every((c) => c.suit === suit)) return undefined;

      const values = selectedCards.map((c) => c.value).sort((a, b) => a - b);
      for (let i = 1; i < values.length; i++) {
        if (values[i] !== values[i - 1] + 1) return undefined;
      }

      if (drawn.suit !== suit) return undefined;
      const min = values[0],
        max = values[values.length - 1];

      // Check position: left for lower value, right for higher value
      if (drawn.value === min - 1 && drawn.value >= 1) return "left";
      if (drawn.value === max + 1 && drawn.value <= 13) return "right";

      return undefined;
    }

    // (3) סט (זוג/שלישייה) נקי — מותר רק אם drawn הוא מאותה הדרגה בדיוק
    const sameRankNoJokers =
      selectedCards.length >= 2 &&
      selectedCards.every((c) => c.value !== 0) &&
      selectedCards.every((c) => c.value === selectedCards[0].value);

    if (sameRankNoJokers) {
      return drawn.value === selectedCards[0].value ? "right" : undefined;
    }

    return undefined;
  }
}
