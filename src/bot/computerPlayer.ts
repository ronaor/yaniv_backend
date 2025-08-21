import { Card, getCardValue, getHandValue } from "../cards";
import {
  canFormValidSequence,
  isCanPickupCard,
  isValidCardSet,
  sortCards,
} from "../gameRules";

export enum Difficulty {
  Easy = "Easy",
  Medium = "Medium",
  Hard = "Hard",
}
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

    const sequences =
      difficulty === Difficulty.Easy
        ? []
        : this.findAllValidSequences(hand, difficulty === Difficulty.Hard);
    const pairs = this.findAllPairsOrMore(hand);

    const extendedSequence = this.findSequenceExtendedByCard(sequences, top);

    // 🟢 אם top + שני קלפים מהיד יוצרים רצף 3+ – נשמור אותם
    const keepForRun = this.findTwoCardSequenceWithTop(hand, top, difficulty);
    if (keepForRun) {
      const safeThrow = this.chooseBestThrowWhileTaking(hand, keepForRun);
      if (safeThrow.length > 0) return safeThrow;
    }

    // ✅ אם זרקו ג׳וקר – תמיד לקחת (ואז לבחור זריקה בטוחה שלא תלויה בו)
    if (isJoker) {
      return this.chooseBestThrowWhileTaking(hand, []);
    }

    // 🔵 קדימות לרצפים (Medium ללא ג׳וקר, Hard מאפשר עד אחד)
    const goodSequences = sequences.filter(
      (seq) => seq.length >= 3 && seq.filter((c) => c.value === 0).length <= 1
    );

    if (goodSequences.length > 0) {
      // בחר את הרצף הכי "שווה": 1) הכי ארוך 2) סכום ערכים גבוה
      const bestSeq = [...goodSequences].sort((a, b) => {
        if (b.length !== a.length) return b.length - a.length;
        const sum = (s: Card[]) =>
          s.reduce((acc, c) => acc + (c.value || 0), 0);
        return sum(b) - sum(a);
      })[0];
      return bestSeq;
    }

    // ✅ אם הקלף מאריך רצף – זרוק משהו שלא פוגע ברצף
    if (extendedSequence) {
      const toThrow = this.chooseOtherThan(hand, extendedSequence, top);
      if (toThrow.length > 0) return toThrow;
    }

    // ✅ אם יש רצף ביד והוא לא מתארך – זרוק את הרצף
    if (sequences.length > 0) {
      const bestSeq = this.chooseBestSequenceToThrow(sequences);
      return bestSeq;
    }

    // ✅ אם הקלף משלים זוג – שמור את הזוג; אם יש זוג אחר – זרוק אותו; אחרת זרוק גבוה שלא מהזוג
    if (hand.some((c) => c.value === top.value)) {
      const setToKeep = hand.filter((c) => c.value === top.value);

      // חפש קבוצה אחרת לזרוק
      const valueCounts: Record<number, Card[]> = {};
      for (const card of hand) {
        if (setToKeep.includes(card)) continue;
        if (!valueCounts[card.value]) valueCounts[card.value] = [];
        valueCounts[card.value].push(card);
      }
      const otherSets = Object.values(valueCounts).filter(
        (group) => group.length >= 2
      );
      if (otherSets.length > 0) {
        otherSets.sort((a, b) => getCardValue(b[0]) - getCardValue(a[0]));
        return otherSets[0];
      }
      return this.chooseBestThrowWhileTaking(hand, setToKeep);
    }

    if (isLowCard) {
      return this.chooseBestThrowWhileTaking(hand, []);
    }

    // ✅ אם יש זוג/שלישייה/רביעייה – זרוק אותם (אלא אם יש רצף 3+ שנעדיף)
    if (pairs.length > 0) {
      const seq3plus = sequences.filter(
        (seq) => seq.length >= 3 && seq.filter((c) => c.value === 0).length <= 1
      );
      if (seq3plus.length > 0) {
        const bestSeq = this.chooseBestSequenceToThrow(sequences);
        return bestSeq;
      }

      // 🛡️ לא לשבור רצף מתוכנן (top+2 מהיד → רצף): שמור אותם
      const keepForRun2 = this.findTwoCardSequenceWithTop(
        hand,
        top,
        difficulty
      );
      let pairsToConsider = pairs;
      if (keepForRun2) {
        const keepIds = new Set(keepForRun2.map((c) => `${c.suit}:${c.value}`));
        pairsToConsider = pairs.filter((set) =>
          set.every((c) => !keepIds.has(`${c.suit}:${c.value}`))
        );
      }

      if (pairsToConsider.length > 0) {
        const bestSet = this.chooseBestSetToThrow(pairsToConsider);

        // 🔷 חוק AA: אם בחרנו לזרוק זוג אסים ויש בודד גבוה – זרוק את הבודד הגבוה במקום
        if (bestSet.length >= 2 && bestSet.every((c) => c.value === 1)) {
          const singleCandidates = hand.filter(
            (c) => c.value !== 0 && c.value !== 1
          );
          if (singleCandidates.length > 0) {
            singleCandidates.sort((a, b) => getCardValue(b) - getCardValue(a));
            return [singleCandidates[0]];
          }
        }
        return bestSet;
      }

      return this.chooseBestThrowWhileTaking(hand, keepForRun2 || []);
    }

    // ✅ Hard בלבד: לשמור 2+ג׳וקר ל־3
    if (
      difficulty === Difficulty.Hard &&
      this.canExtendTwoCardSequenceWithJoker(hand, top)
    ) {
      const keep = this.keepForTwoWithJoker(hand, top);
      const safeThrow = this.chooseBestThrowWhileTaking(hand, keep);
      if (safeThrow.length > 0) return safeThrow;
    }

    // ✅ אין כלום – זרוק את הגבוה
    const nonJokers = hand.filter((c) => c.value !== 0);
    const sorted = nonJokers.sort((a, b) => getCardValue(b) - getCardValue(a));
    return sorted.slice(0, 1);
  }

  static decidePickupIndex(
    hand: Card[],
    pickupPile: Card[],
    difficulty: Difficulty
  ): number | null {
    if (!pickupPile.length) return null;

    // מותר לקחת רק מהקצוות
    const candidates = pickupPile
      .map((c, idx) => ({ card: c, idx }))
      .filter(({ idx }) => isCanPickupCard(pickupPile.length, idx));

    // 🔴 אם יש ג׳וקר בקצה – תמיד לקחת
    const edgeJoker = candidates.find(({ card }) => card.value === 0);
    if (edgeJoker) return edgeJoker.idx;

    // סימולציית "לא לקחת"
    const noPick = this.simulateTurn(hand, pickupPile, difficulty, null);

    let bestIdx: number | null = null;
    let bestScore = noPick.score;

    for (const { card, idx } of candidates) {
      // סימולציה: לקחת את הקצה הזה
      const pickSim = this.simulateTurn(hand, pickupPile, difficulty, idx);

      // ⭐ בוסט גבוה אם הקצה משלים עכשיו רצף 3 עם שני קלפים ביד
      if (card.value !== 0) {
        const completesRunNow = this.findTwoCardSequenceWithTop(
          hand,
          card,
          difficulty
        );
        if (completesRunNow) {
          const wouldBreakRun = pickSim.discard.some((d) =>
            completesRunNow.some(
              (k) => k.suit === d.suit && k.value === d.value
            )
          );
          if (!wouldBreakRun) pickSim.score += 800;
          else pickSim.score -= 600;
        }
      }

      // אם הקצה משלים זוג אבל הזריקה בסימולציה כבר זורקת ערך זהה – אל תיקח
      const completesPair = pickSim.handAfter.some(
        (c) => c.value !== 0 && c.value === card.value
      );
      if (completesPair) {
        const discardContainsSameValue = pickSim.discard.some(
          (d) => d.value === card.value
        );
        if (discardContainsSameValue) pickSim.score -= 10000;
      }

      // העדפה לאסים/שתיים – אבל ב־Medium לא לספור ג׳וקר כבונה רצף עתידי
      if (card.value <= 2) {
        let lowScore = 600;
        const hasJoker =
          difficulty === Difficulty.Hard && hand.some((c) => c.value === 0);
        const hasAceSameSuit = hand.some(
          (c) => c.value === 1 && c.suit === card.suit
        );
        const hasTwoSameSuit = hand.some(
          (c) => c.value === 2 && c.suit === card.suit
        );
        const hasThreeSameSuit = hand.some(
          (c) => c.value === 3 && c.suit === card.suit
        );

        if (card.value === 2 && hasAceSameSuit) lowScore += 220;
        if (card.value === 1 && hasTwoSameSuit) lowScore += 220;

        if (card.value === 2 && hasThreeSameSuit) lowScore += 180;
        if (
          card.value === 1 &&
          hasThreeSameSuit &&
          (hasTwoSameSuit || hasJoker)
        ) {
          lowScore += 160;
        }

        const wouldDiscardPicked = pickSim.discard.some(
          (d) => d.suit === card.suit && d.value === card.value
        );
        if (!wouldDiscardPicked) pickSim.score += lowScore;
      }

      if (pickSim.score > bestScore) {
        bestScore = pickSim.score;
        bestIdx = idx;
      }
    }
    return bestIdx;
  }

  /**
   * סימולציה קצרה לתור
   */
  private static simulateTurn(
    hand: Card[],
    pickupPile: Card[],
    difficulty: Difficulty,
    pickIdx: number | null
  ): { discard: Card[]; handAfter: Card[]; score: number } {
    const handSim =
      pickIdx !== null ? [...hand, pickupPile[pickIdx]] : [...hand];
    const pileForThinking =
      pickIdx !== null ? [pickupPile[pickIdx]] : pickupPile;

    const discard = this.chooseCards(handSim, pileForThinking, difficulty);
    const handAfter = handSim.filter((c) => !discard.includes(c));

    const sumAfter = handAfter.reduce((s, c) => s + getCardValue(c), 0);
    let score = 1000 - sumAfter;

    const evalCard =
      pickIdx !== null
        ? pickupPile[pickIdx]
        : pileForThinking[pileForThinking.length - 1];
    if (evalCard && evalCard.value !== 0) {
      const keepsRunNext = this.findTwoCardSequenceWithTop(
        handAfter,
        evalCard,
        difficulty
      );
      if (keepsRunNext) score += 120;
    }

    if (evalCard && evalCard.value !== 0) {
      const planned = this.findTwoCardSequenceWithTop(
        handSim,
        evalCard,
        difficulty
      );
      if (
        planned &&
        discard.some((d) =>
          planned.some((k) => k.suit === d.suit && k.value === d.value)
        )
      ) {
        score -= 200;
      }
    }

    const counts: Record<number, number> = {};
    for (const c of handAfter)
      if (c.value !== 0) counts[c.value] = (counts[c.value] || 0) + 1;
    for (const cnt of Object.values(counts)) {
      if (cnt >= 3) score += 90;
      else if (cnt === 2) score += 40;
    }

    return { discard, handAfter, score };
  }

  private static seqKey(seq: Card[]): string {
    return seq
      .map((c) => `${String(c.suit)}:${c.value}`)
      .sort()
      .join("|");
  }

  private static findAllValidSequences(
    hand: Card[],
    allowJokerSequences: boolean = true
  ): Card[][] {
    let sequences: Card[][] = [];
    const sorted = sortCards(hand);

    // רצפים טבעיים
    for (let size = 3; size <= hand.length; size++) {
      for (let i = 0; i <= hand.length - size; i++) {
        const group = sorted.slice(i, i + size);
        if (this.isSequence(group)) sequences.push(group);
      }
    }

    // השלמת רצף 3 בעזרת ג׳וקר – רק אם מותר
    if (allowJokerSequences) {
      const jokers = hand.filter((c) => c.value === 0);
      if (jokers.length > 0) {
        const joker = jokers[0];

        const bySuit: Record<string, Card[]> = {};
        for (const c of hand) {
          if (c.value === 0) continue;
          const s = String(c.suit);
          if (!bySuit[s]) bySuit[s] = [];
          bySuit[s].push(c);
        }
        for (const s of Object.keys(bySuit)) {
          bySuit[s].sort((a, b) => a.value - b.value);
        }

        const haveKey = new Set<string>(
          sequences.map((seq) => this.seqKey(seq))
        );

        for (const s of Object.keys(bySuit)) {
          const cards = bySuit[s];
          for (let i = 0; i < cards.length; i++) {
            for (let j = i + 1; j < cards.length; j++) {
              const a = cards[i];
              const b = cards[j];
              const gap = b.value - a.value;

              if (gap === 1 || gap === 2) {
                const triple = gap === 2 ? [a, joker, b] : [a, b, joker];
                if (this.isSequence(triple)) {
                  const k = this.seqKey(triple);
                  if (!haveKey.has(k)) {
                    sequences.push(triple);
                    haveKey.add(k);
                  }
                }
              }
            }
          }
        }
      }
    }

    // אם אסור ג׳וקרים – ננקה כל רצף שיש בו ג׳וקר (סגירת פינות)
    if (!allowJokerSequences) {
      sequences = sequences.filter((seq) => seq.every((c) => c.value !== 0));
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
      if (group.length >= 2 && group[0].value !== 0) {
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
    const filtered = sequences.filter(
      (seq) => seq.filter((c) => c.value === 0).length <= 1
    );
    const base = filtered.length ? filtered : sequences;
    return base.sort((a, b) => getHandValue(b) - getHandValue(a))[0];
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

    if (candidates.length === 0) return nonJokers.slice(0, 1);

    // אם יש סט – עדיף לזרוק אותו
    const pairs = this.findAllPairsOrMore(hand);
    if (pairs.length > 0) {
      const otherSet = pairs.find((set) => !exclude.includes(set[0]));
      if (otherSet) return otherSet;
    }

    // זרוק מה שפחות תורם לרצפים עתידיים
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

  // 🆕 לשמור שכן (±1) וג׳וקר אחד
  private static keepForTwoWithJoker(hand: Card[], top: Card): Card[] {
    const jokers = hand.filter((c) => c.value === 0);
    if (jokers.length === 0) return [];

    const neighbor = hand.find(
      (c) =>
        c.value !== 0 &&
        c.suit === top.suit &&
        (c.value === top.value - 1 || c.value === top.value + 1)
    );
    if (!neighbor) return [];
    return [neighbor, jokers[0]];
  }

  private static isSequence = (cards: Card[]): boolean => {
    // ❌ לא יותר מג׳וקר אחד
    const jokerCountInGroup = cards.filter((card) => card.value === 0).length;
    if (jokerCountInGroup > 1) return false;

    const nonJokerCards = cards.filter((card) => card.value !== 0);

    // כל הלא־ג׳וקרים מאותו suit
    if (nonJokerCards.length > 1) {
      const firstSuit = nonJokerCards[0].suit;
      if (!nonJokerCards.every((card) => card.suit === firstSuit)) return false;
    }

    // אימות מול חוקי המשחק
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
    return maxSeq >= 3;
  }

  private static findTwoCardSequenceWithTop(
    hand: Card[],
    top: Card,
    difficulty: Difficulty
  ): Card[] | null {
    if (!top) return null;
    if (top.value === 0) return null; // ג׳וקר – מטופל אחרת

    const sameSuit = hand.filter((c) => c.suit === top.suit && c.value !== 0);
    const jokers = hand.filter((c) => c.value === 0);

    // שני קלפים טבעיים מאותה צורה
    if (sameSuit.length >= 2) {
      const byValue: Record<number, Card[]> = {};
      for (const c of sameSuit) {
        if (!byValue[c.value]) byValue[c.value] = [];
        byValue[c.value].push(c);
      }
      if (byValue[top.value - 1] && byValue[top.value + 1]) {
        return [byValue[top.value - 1][0], byValue[top.value + 1][0]];
      }
      if (byValue[top.value + 1] && byValue[top.value + 2]) {
        return [byValue[top.value + 1][0], byValue[top.value + 2][0]];
      }
      if (byValue[top.value - 2] && byValue[top.value - 1]) {
        return [byValue[top.value - 2][0], byValue[top.value - 1][0]];
      }
    }

    // צירוף ג׳וקר כרכיב רצף – מותר רק ב־Hard
    if (
      difficulty === Difficulty.Hard &&
      jokers.length > 0 &&
      sameSuit.length >= 1
    ) {
      const J = jokers[0];

      const nMinus1 = sameSuit.find((c) => c.value === top.value - 1);
      if (nMinus1) return [nMinus1, J];

      const nPlus1 = sameSuit.find((c) => c.value === top.value + 1);
      if (nPlus1) return [nPlus1, J];

      const nMinus2 = sameSuit.find((c) => c.value === top.value - 2);
      if (nMinus2) return [nMinus2, J];

      const nPlus2 = sameSuit.find((c) => c.value === top.value + 2);
      if (nPlus2) return [nPlus2, J];
    }

    return null;
  }
}
