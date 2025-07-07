export interface Card {
  suit: "hearts" | "diamonds" | "clubs" | "spades";
  value: number; // 1-13 (1=Ace, 11=Jack, 12=Queen, 13=King)
  isJoker?: boolean;
}

export const getCardValue = (card: Card) => {
  if (card.isJoker) return 0;
  if (card.value === 1) return 1; // Ace = 1
  if (card.value >= 11) return 10; // J, Q, K = 10
  return card.value; // 2-10 = face value
};

export type TurnAction =
  | {
      choice: "deck";
    }
  | { choice: "pickup"; pickupIndex: number };
