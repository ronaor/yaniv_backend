import { Card, getCardValue, getHandValue } from "../cards";
import {
  canFormValidSequence,
  isCanPickupCard,
  isValidCardSet,
  sortCards,
} from "../gameRules";

export type Difficulty = "easy" | "medium" | "hard";

export class ComputerPlayer {
  static lastDiscardedSet: Card[] = [];

  static rememberDiscarded(cards: Card[]): void {
    this.lastDiscardedSet = cards;
  }
  static chooseCards(
    hand: Card[],
    pickupPile: Card[],
    difficulty: Difficulty
  ): Card[] {
    const top = pickupPile[pickupPile.length - 1];
    const isJoker = top.value === 0;
    const isLowCard = top.value <= 2;

    const sequences = this.findAllValidSequences(hand);
    const pairs = this.findAllPairsOrMore(hand);

    const extendedSequence = this.findSequenceExtendedByCard(sequences, top);

    // ✅ כלל 1: אם זרקו ג׳וקר או קלף קטן מ־3 – תמיד לקחת
    if (isJoker || isLowCard) {
      return this.chooseBestThrowWhileTaking(hand, []);
    }

    // ✅ כלל 2: אם הקלף יכול להאריך רצף – שמור רצף, זרוק משהו אחר
    if (extendedSequence) {
      const toThrow = this.chooseOtherThan(hand, extendedSequence, top);
      if (toThrow.length > 0) return toThrow;
    }

    // ✅ כלל 3: אם יש רצף ביד והוא לא מתארך ע״י הקלף – זרוק את הרצף
    if (sequences.length > 0) {
      const bestSeq = this.chooseBestSequenceToThrow(sequences);
      return bestSeq;
    }

    // ✅ כלל 5: אם הקלף בקופה משלים זוג – שמור את הזוג הזה,
    // ואם יש זוג אחר ביד – זרוק אותו, אחרת זרוק את הקלף הגבוה ביותר שאינו מהזוג שנשמר
    if (hand.some((c) => c.value === top.value)) {
      const setToKeep = hand.filter((c) => c.value === top.value);

      // חפש זוג/שלישייה/רביעייה אחרת לזרוק
      const valueCounts: Record<number, Card[]> = {};
      for (const card of hand) {
        if (setToKeep.includes(card)) continue; // דלג על הקלפים ששומרים
        if (!valueCounts[card.value]) valueCounts[card.value] = [];
        valueCounts[card.value].push(card);
      }

      // חפש קבוצה אחרת שאפשר לזרוק
      const otherSets = Object.values(valueCounts).filter(
        (group) => group.length >= 2
      );
      if (otherSets.length > 0) {
        // זרוק את הקבוצה עם הערך הגבוה ביותר
        otherSets.sort((a, b) => getCardValue(b[0]) - getCardValue(a[0]));
        return otherSets[0];
      }

      // אין זוג אחר – זרוק את הקלף הכי גבוה שלא מהזוג ששומרים
      return this.chooseBestThrowWhileTaking(hand, setToKeep);
    }

    // ✅ כלל 4: אם יש זוג/שלישייה/רביעייה – זרוק אותם
    if (pairs.length > 0) {
      const bestSet = this.chooseBestSetToThrow(pairs);
      return bestSet;
    }

    // ✅ כלל 6: אם הקלף משלים רצף של 2 קלפים עם ג׳וקר – זרוק קלף אחר
    if (this.canExtendTwoCardSequenceWithJoker(hand, top)) {
      return this.chooseBestThrowWhileTaking(hand, [top]);
    }

    // ✅ כלל 7: אין כלום – זרוק את הקלף הגבוה ביותר
    const nonJokers = hand.filter((c) => c.value !== 0);
    const sorted = nonJokers.sort((a, b) => getCardValue(b) - getCardValue(a));
    return sorted.slice(0, 1);
  }

  static decidePickupIndex(
    hand: Card[],
    pickupPile: Card[],
    difficulty: Difficulty
  ): number | null {
    if (pickupPile.length === 0) return null;

    const validIndexes = pickupPile
      .map((_, idx) => idx)
      .filter((i) => isCanPickupCard(pickupPile.length, i));

    // ✅ שלב ראשון: תמיד לקחת ג׳וקר אם יש

    for (const i of validIndexes) {
      const candidate = pickupPile[i];
      const sameValue = hand.filter(
        (c) => c.value === candidate.value && c.value !== 0
      );
      if (candidate.value === 0) return i;

      const hasJoker = hand.some((c) => c.value === 0);
      const suits = hand.filter(
        (c) => c.suit === candidate.suit && c.value !== 0
      );
      const values = suits.map((c) => c.value);

      const sameSuitCards = hand.filter(
        (c) => c.suit === candidate.suit && c.value !== 0
      );
      const jokerCount = hand.filter((c) => c.value === 0).length;

      const suitValues = sameSuitCards.map((c) => c.value);
      suitValues.push(candidate.value);
      suitValues.sort((a, b) => a - b);

      // חישוב רצף מקסימלי כולל השלמה עם ג׳וקרים
      let maxSeq = 1;
      let currentSeq = 1;
      let jokersLeft = jokerCount;

      for (let i = 1; i < suitValues.length; i++) {
        const gap = suitValues[i] - suitValues[i - 1];
        if (gap === 1) {
          currentSeq++;
        } else if (gap > 1 && jokersLeft >= gap - 1) {
          jokersLeft -= gap - 1;
          currentSeq += gap; // כאילו יש רצף
        } else {
          currentSeq = 1;
          jokersLeft = jokerCount;
        }
        maxSeq = Math.max(maxSeq, currentSeq);
      }

      // קח רק אם נוצר רצף של 3 ומעלה
      if (maxSeq >= 3 && hand.length > 2) {
        return i;
      }

      // ✅ 2: השלמה לשלישייה אם יש כבר זוג
      if (sameValue.length >= 2) return i;

      // ✅ 3: התנהגות רגילה – אם יש כבר אחד כזה ביד
      if (sameValue.length === 1) return i;
      // ✅ תמיד לקחת אס או 2
    }
    // ✅ 4: אם לא מצאנו כלום – קח אס או 2
    for (const i of validIndexes) {
      const candidate = pickupPile[i];
      if (candidate.value <= 2) {
        return i;
      }
    }
    return null;
  }

  private static findAllValidSequences(hand: Card[]): Card[][] {
    const sequences: Card[][] = [];
    const sorted = sortCards(hand);

    for (let size = 3; size <= hand.length; size++) {
      for (let i = 0; i <= hand.length - size; i++) {
        const group = sorted.slice(i, i + size);
        if (this.isSequence(group)) {
          sequences.push(group);
        }
      }
    }

    return sequences;
  }

  private static findAllPairsOrMore(hand: Card[]): Card[][] {
    const result: Card[][] = [];
    const valueMap: Record<number, Card[]> = {};

    for (const card of hand) {
      if (!valueMap[card.value]) valueMap[card.value] = [];
      valueMap[card.value].push(card);
    }

    for (const group of Object.values(valueMap)) {
      if (group.length >= 2) {
        result.push(group);
      }
    }

    return result;
  }

  private static findSequenceExtendedByCard(
    sequences: Card[][],
    top: Card
  ): Card[] | null {
    for (const seq of sequences) {
      const values = seq
        .map((c) => c.value)
        .filter((v) => v !== 0)
        .sort((a, b) => a - b);
      const suit = seq.find((c) => c.value !== 0)?.suit;
      const min = values[0];
      const max = values[values.length - 1];

      if (
        top.suit === suit &&
        (top.value === min - 1 || top.value === max + 1)
      ) {
        return seq;
      }
    }

    return null;
  }

  private static chooseOtherThan(
    hand: Card[],
    exclude: Card[],
    exceptCard: Card
  ): Card[] {
    const toThrow = hand.find(
      (c) =>
        !exclude.includes(c) && c.value !== exceptCard.value && c.value !== 0
    );
    return toThrow ? [toThrow] : [];
  }

  private static isLikelyToBePartOfSequence(card: Card, hand: Card[]): boolean {
    const suitGroup = hand.filter(
      (c) => c.suit === card.suit && c.value !== 0 && c !== card
    );
    return suitGroup.some((c) => Math.abs(c.value - card.value) === 1);
  }

  private static chooseBestSequenceToThrow(sequences: Card[][]): Card[] {
    return sequences.sort((a, b) => getHandValue(b) - getHandValue(a))[0];
  }

  private static chooseBestSetToThrow(sets: Card[][]): Card[] {
    return sets.sort((a, b) => getHandValue(b) - getHandValue(a))[0];
  }

  private static chooseBestThrowWhileTaking(
    hand: Card[],
    exclude: Card[]
  ): Card[] {
    const nonJokers = hand.filter((c) => c.value !== 0);
    const candidates = nonJokers.filter((c) => !exclude.includes(c));

    // אם אין מועמדים חוקיים – זרוק כל קלף שהוא לא ג'וקר
    if (candidates.length === 0) {
      return nonJokers.slice(0, 1);
    }

    // אם יש זוג/רצף אחר ביד – זרוק קודם אותו
    const pairs = this.findAllPairsOrMore(hand);
    if (pairs.length > 0) {
      const otherSet = pairs.find((set) => !exclude.includes(set[0]));
      if (otherSet) return otherSet;
    }

    // ניתוח פוטנציאל רצף – זרוק קלפים שלא תורמים לרצף
    const usefulCards = candidates.filter((card) =>
      this.isPotentialSequence(card, hand)
    );

    const uselessCards = candidates.filter(
      (card) => !this.isPotentialSequence(card, hand)
    );

    const sorted = (uselessCards.length > 0 ? uselessCards : candidates).sort(
      (a, b) => getCardValue(b) - getCardValue(a)
    );

    return [sorted[0]];
  }

  private static canExtendTwoCardSequenceWithJoker(
    hand: Card[],
    top: Card
  ): boolean {
    const jokers = hand.filter((c) => c.value === 0);
    if (jokers.length === 0) return false;

    const nonJokers = hand.filter((c) => c.value !== 0 && c.suit === top.suit);
    const values = nonJokers.map((c) => c.value);

    return values.some(
      (v) => Math.abs(v - top.value) === 1 || Math.abs(v - top.value) === 2
    );
  }

  private static isSequence = (cards: Card[]): boolean => {
    const nonJokerCards = cards.filter((card) => card.value !== 0);

    // בדיקה: כל הקלפים שאינם ג'וקרים חייבים להיות מאותו suit
    if (nonJokerCards.length > 1) {
      const firstSuit = nonJokerCards[0].suit;
      if (!nonJokerCards.every((card) => card.suit === firstSuit)) {
        return false;
      }
    }

    // בדיקה: האם ניתן להשלים לרצף חוקי עם ג'וקרים
    return canFormValidSequence(cards);
  };
  private static isPotentialSequence(card: Card, hand: Card[]): boolean {
    if (card.value === 0) return false; // ג׳וקר

    const sameSuit = hand.filter(
      (c) => c.suit === card.suit && c.value !== 0 && c !== card
    );
    const values = sameSuit
      .map((c) => c.value)
      .concat(card.value)
      .sort((a, b) => a - b);

    let seq = 1;
    let maxSeq = 1;

    for (let i = 1; i < values.length; i++) {
      if (values[i] === values[i - 1] + 1) {
        seq++;
        maxSeq = Math.max(maxSeq, seq);
      } else if (values[i] !== values[i - 1]) {
        seq = 1;
      }
    }

    return maxSeq >= 3; // רק אם באמת יש רצף
  }
}
