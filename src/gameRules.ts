import { Card } from "./cards";

export const isValidCardSet = (
  cards: Card[],
  beforePickup?: boolean
): boolean => {
  if (cards.length === 0) return false;

  // חוק ראשון: קלף אחד תמיד חוקי
  if (cards.length === 1) {
    return true;
  }

  // חוק שני: קלפים זהים (או ג'וקרים)
  if (isIdenticalCards(cards)) {
    return true;
  }

  // לפני איסוף: רק קלפים זהים מותרים לזוגות
  if (beforePickup && cards.length === 2) {
    return false;
  }

  // חוק שלישי: רצף של קלפים (מינימום 2)
  if (cards.length >= 3 && isSequence(cards)) {
    return true;
  }

  return false;
};

// בדיקה אם כל הקלפים זהים או ג'וקרים
const isIdenticalCards = (cards: Card[]): boolean => {
  const nonJokerValues = cards
    .filter((card) => card.value !== 0)
    .map((card) => card.value);

  // כל הקלפים הם ג'וקרים או כל הלא-ג'וקרים עם אותו ערך
  return (
    nonJokerValues.length === 0 ||
    nonJokerValues.every((value) => value === nonJokerValues[0])
  );
};

// בדיקה אם הקלפים יוצרים רצף
const isSequence = (cards: Card[]): boolean => {
  const nonJokerCards = cards.filter((card) => card.value !== 0);

  // בדוק אם כל הקלפים הלא-ג'וקרים מאותו צבע
  if (nonJokerCards.length > 1) {
    const firstSuit = nonJokerCards[0].suit;
    if (!nonJokerCards.every((card) => card.suit === firstSuit)) {
      return false;
    }
  }

  return canFormValidSequence(cards);
};

const canFormValidSequence = (cards: Card[]): boolean => {
  const nonJokerCards = cards.filter((card) => card.value !== 0);
  const jokerCount = cards.length - nonJokerCards.length;

  // כל הקלפים הם ג'וקרים - תמיד חוקי
  if (nonJokerCards.length === 0) return true;

  // קבל ערכים ייחודיים וסדר אותם
  const uniqueValues = [
    ...new Set(nonJokerCards.map((card) => card.value)),
  ].sort((a, b) => a - b);

  // בדוק אם יש ערכים כפולים (לא חוקי לרצפים)
  if (uniqueValues.length !== nonJokerCards.length) {
    return false;
  }

  // נסה למצוא רצף שמכיל את כל הקלפים הידועים
  // הטווח המינימלי הנדרש
  const minRange = uniqueValues[uniqueValues.length - 1] - uniqueValues[0] + 1;

  // אם הטווח גדול מכמות הקלפים - בלתי אפשרי
  if (minRange > cards.length) return false;

  // נסה כל נקודת התחלה אפשרית
  const minStart = Math.max(1, uniqueValues[0] - jokerCount);
  const maxStart = Math.min(
    14 - cards.length,
    uniqueValues[uniqueValues.length - 1]
  );

  for (let start = minStart; start <= maxStart; start++) {
    if (
      canFormSequenceStartingAt(start, cards.length, uniqueValues, jokerCount)
    ) {
      return true;
    }
  }

  return false;
};

const canFormSequenceStartingAt = (
  start: number,
  sequenceLength: number,
  knownValues: number[],
  availableJokers: number
): boolean => {
  // בדוק אם הרצף נכנס בטווח החוקי
  if (start < 1 || start + sequenceLength - 1 > 13) {
    return false;
  }

  // בנה את הרצף הצפוי
  const expectedSequence = Array.from(
    { length: sequenceLength },
    (_, i) => start + i
  );

  // ספור כמה ג'וקרים אנחנו צריכים
  let jokersNeeded = 0;
  let knownIndex = 0;

  for (const expectedValue of expectedSequence) {
    if (
      knownIndex < knownValues.length &&
      knownValues[knownIndex] === expectedValue
    ) {
      knownIndex++; // המיקום הזה מלא על ידי קלף ידוע
    } else {
      jokersNeeded++; // המיקום הזה צריך ג'וקר
    }
  }

  // בדוק אם כל הערכים הידועים נוצלו ויש לנו מספיק ג'וקרים
  return knownIndex === knownValues.length && jokersNeeded <= availableJokers;
};

export const isCanPickupCard = (
  cardsLength: number,
  index: number
): boolean => {
  if (cardsLength === 0) return false;
  if (cardsLength === 1) return true;

  // ניתן לקחת רק את הקלף הראשון או האחרון
  return index === 0 || index === cardsLength - 1;
};

export function sortCards(cards: Card[]) {
  const suitOrder = { spades: 0, hearts: 1, diamonds: 2, clubs: 3 };

  return cards.sort((a, b) => {
    if (a.value !== b.value) {
      return a.value - b.value;
    }
    return suitOrder[a.suit] - suitOrder[b.suit];
  });
}

export function findSequenceArrangement(cards: Card[]): Card[] | null {
  if (!isValidCardSet(cards)) {
    return null; // Invalid set
  }

  // If it's a valid sequence, arrange it properly
  if (isSequence(cards)) {
    return arrangeCardsInSequence(cards);
  }

  // If it's valid but not a sequence (identical cards or single card), just sort normally
  return sortCards(cards.slice());
}

function arrangeCardsInSequence(cards: Card[]): Card[] {
  const nonJokers = cards.filter((card) => card.value !== 0);
  const jokers = cards.filter((card) => card.value === 0);

  if (nonJokers.length === 0) {
    return sortCards(cards.slice()); // All jokers, just sort normally
  }

  // Sort non-jokers by value
  nonJokers.sort((a, b) => a.value - b.value);

  const sequenceLength = cards.length;
  const minKnownValue = nonJokers[0].value;
  const maxKnownValue = nonJokers[nonJokers.length - 1].value;

  // Try different starting positions for the sequence
  const minStart = Math.max(1, maxKnownValue - sequenceLength + 1);
  const maxStart = Math.min(14 - sequenceLength, minKnownValue);

  for (let start = minStart; start <= maxStart; start++) {
    const arrangement = tryArrangement(
      cards,
      nonJokers,
      jokers,
      start,
      sequenceLength
    );
    if (arrangement) {
      return arrangement;
    }
  }

  // Fallback (shouldn't happen if isSequence was correct)
  return sortCards(cards.slice());
}

function tryArrangement(
  allCards: Card[],
  nonJokers: Card[],
  jokers: Card[],
  start: number,
  length: number
): Card[] | null {
  const sequence: (Card | null)[] = new Array(length).fill(null);

  // Place non-jokers in their positions
  for (const card of nonJokers) {
    const pos = card.value - start;
    if (pos < 0 || pos >= length || sequence[pos] !== null) {
      return null; // Invalid position or conflict
    }
    sequence[pos] = card;
  }

  // Fill gaps with jokers
  let jokerIndex = 0;
  const result: Card[] = [];

  for (let i = 0; i < length; i++) {
    if (sequence[i] !== null) {
      result.push(sequence[i]!);
    } else if (jokerIndex < jokers.length) {
      result.push(jokers[jokerIndex++]);
    } else {
      return null; // Not enough jokers
    }
  }

  return jokerIndex === jokers.length ? result : null;
}
