import { Card } from "./cards";

export const isValidCardSet = (
  cards: Card[],
  beforePickup?: boolean
): boolean => {
  // חוק ראשון: קלף אחד תמיד חוקי
  if (cards.length === 1) {
    return true;
  }

  // חוק שני: קלפים זהים (או ג'וקרים)
  if (isIdenticalCards(cards)) {
    return true;
  }

  if (beforePickup && cards.length === 2) {
    return false;
  }

  // חוק שלישי: רצף של קלפים (מינימום 2)
  if (cards.length >= 2 && isSequence(cards)) {
    return true;
  }

  return false;
};

// בדיקה אם כל הקלפים זהים או ג'וקרים
const isIdenticalCards = (cards: Card[]): boolean => {
  // מצא את הערך הראשון שאינו ג'וקר
  const nonJokerCard = cards.find((card) => !card.isJoker);

  // אם כל הקלפים הם ג'וקרים - זה חוקי
  if (!nonJokerCard) {
    return true;
  }

  // בדוק שכל הקלפים הלא-ג'וקרים הם עם אותו ערך
  return cards.every(
    (card) => card.isJoker || card.value === nonJokerCard.value
  );
};

// בדיקה אם הקלפים יוצרים רצף
const isSequence = (cards: Card[]): boolean => {
  // בדוק אם כל הקלפים הלא-ג'וקרים מאותו צבע
  const nonJokerCards = cards
    .sort((a, b) => a.value - b.value)
    .filter((card) => !card.isJoker);
  if (nonJokerCards.length > 1) {
    const firstSuit = nonJokerCards[0].suit;
    if (!nonJokerCards.every((card) => card.suit === firstSuit)) {
      return false;
    }
  }

  // נסה לבדוק רצף בשני כיוונים - עולה ויורד
  return (
    isValidSequenceDirection(cards, true) ||
    isValidSequenceDirection(cards, false)
  );
};

const isValidSequenceDirection = (
  cards: Card[],
  ascending: boolean
): boolean => {
  // נבנה מערך של הערכים הצפויים לפי הסדר
  const expectedValues: number[] = [];

  // נמצא את כל הערכים הידועים (לא ג'וקרים)
  const knownPositions: { index: number; value: number }[] = [];

  for (let i = 0; i < cards.length; i++) {
    if (!cards[i].isJoker) {
      knownPositions.push({ index: i, value: cards[i].value });
    }
  }

  // אם אין קלפים ידועים, רק ג'וקרים - זה תמיד חוקי
  if (knownPositions.length === 0) {
    return true;
  }

  // אם יש קלף ידוע אחד, נבנה סביבו
  if (knownPositions.length === 1) {
    return true;
  } else {
    // יש יותר מקלף ידוע אחד - נבדוק אם הם עקביים
    // ניקח את שני הקלפים הידועים הראשונים כדי לקבוע את הכיוון
    const first = knownPositions[0];
    const second = knownPositions[1];

    const positionDiff = second.index - first.index;
    const valueDiff = second.value - first.value;

    // בדוק אם הכיוון מתאים
    if (ascending && valueDiff !== positionDiff) {
      return false;
    }
    if (!ascending && valueDiff !== -positionDiff) {
      return false;
    }

    // בנה את כל הערכים הצפויים
    const startValue = ascending
      ? first.value - first.index
      : first.value + first.index;

    for (let i = 0; i < cards.length; i++) {
      const expectedValue = ascending ? startValue + i : startValue - i;
      if (expectedValue < 1 || expectedValue > 13) {
        return false;
      }
      expectedValues[i] = expectedValue;
    }
  }

  // בדוק שכל הקלפים הידועים מתאימים לערכים הצפויים
  for (const { index, value } of knownPositions) {
    if (expectedValues[index] !== value) {
      return false;
    }
  }

  return true;
};

export const isCanPickupCard = (cardsLength: number, index: number) => {
  if (cardsLength === 0) {
    return false;
  }
  if (cardsLength === 1) {
    return true;
  }
  if (index === 0 || index === cardsLength - 1) {
    return true;
  }
  return false;
};
