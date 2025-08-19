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

    // 🟢 חדש (תיקון מינימלי): אם top + שני קלפים מהיד יוצרים רצף 3+ – אל תזרוק את שני הקלפים הללו
    const keepForRun = this.findTwoCardSequenceWithTop(hand, top);
    if (keepForRun) {
      const safeThrow = this.chooseBestThrowWhileTaking(hand, keepForRun);
      if (safeThrow.length > 0) return safeThrow;
    }
    // ✅ כלל 1: אם זרקו ג׳וקר – תמיד לקחת (בחירת זריקה "בטוחה" בלי תלות בו)
    if (isJoker) {
      return this.chooseBestThrowWhileTaking(hand, []);
    }

    // 🔵 קדימות לרצפים (עד ג'וקר אחד) לפני סטים
    const goodSequences = sequences.filter(
      (seq) => seq.length >= 3 && seq.filter((c) => c.value === 0).length <= 1
    );

    if (goodSequences.length > 0) {
      // בחר את הרצף "הכי טוב" לזריקה:
      // 1) הכי ארוך  2) אם יש שוויון – סכום ערכים גבוה יותר כדי להיפטר מכמה שיותר נקודות
      const bestSeq = [...goodSequences].sort((a, b) => {
        if (b.length !== a.length) return b.length - a.length;
        const sum = (s: Card[]) =>
          s.reduce((acc, c) => acc + (c.value || 0), 0);
        return sum(b) - sum(a);
      })[0];

      // זורקים את הרצף
      return bestSeq;
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

    if (isLowCard) {
      return this.chooseBestThrowWhileTaking(hand, []);
    }

    // ✅ כלל 4: אם יש זוג/שלישייה/רביעייה – זרוק אותם
    if (pairs.length > 0) {
      // ⛳ עדיפות לרצף קיים על פני זוג: אם יש לנו כבר רצף 3+ ביד – נעדיף לזרוק אותו במקום זוג
      const seq3plus = sequences.filter(
        (seq) => seq.length >= 3 && seq.filter((c) => c.value === 0).length <= 1
      );
      if (seq3plus.length > 0) {
        const bestSeq = this.chooseBestSequenceToThrow(sequences);
        return bestSeq;
      }
      // 🛡️ שמירה על רצף מתוכנן (אם top+2 קלפים יוצרים רצף 3+)
      const keepForRun2 = this.findTwoCardSequenceWithTop(hand, top);
      let pairsToConsider = pairs;
      if (keepForRun2) {
        const keepIds = new Set(keepForRun2.map((c) => `${c.suit}:${c.value}`));
        pairsToConsider = pairs.filter((set) =>
          set.every((c) => !keepIds.has(`${c.suit}:${c.value}`))
        );
      }

      if (pairsToConsider.length > 0) {
        const bestSet = this.chooseBestSetToThrow(pairsToConsider);

        // 🔷 חוק AA: אם הסט שנבחר הוא זוג/קבוצה של אסים (value===1),
        // ונמצא ביד קלף בודד שערכו > 2 (ושלא שייך לרצף שמתכננים) – נזרוק את הקלף הגבוה במקום את האסים.
        if (bestSet.length >= 2 && bestSet.every((c) => c.value === 1)) {
          const singleCandidates = hand.filter(
            (c) => c.value !== 0 && c.value !== 1 // לא ג'וקר, לא אס
          );

          if (singleCandidates.length > 0) {
            singleCandidates.sort((a, b) => getCardValue(b) - getCardValue(a));
            return [singleCandidates[0]]; // זורקים את הקלף הבודד הגבוה ביותר
          }
          // אם אין אפילו קלף בודד לא-אס – נזרוק את ה-AA כרגיל
        }

        return bestSet;
      }

      // אם כל הסטים פוגעים ברצף המתוכנן – נזרוק משהו אחר שלא הורס את הרצף
      return this.chooseBestThrowWhileTaking(hand, keepForRun2 || []);
    }

    // ✅ כלל 6: אם הקלף משלים רצף של 2 קלפים עם ג׳וקר – זרוק קלף אחר,
    // ונשמור ספציפית את השכן והג׳וקר (ולא את top שאינו ביד)
    if (this.canExtendTwoCardSequenceWithJoker(hand, top)) {
      const keep = this.keepForTwoWithJoker(hand, top);
      return this.chooseBestThrowWhileTaking(hand, keep);
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
    if (!pickupPile.length) return null;

    // מותר לקחת רק מהקצוות לפי הכלל שלך
    const candidates = pickupPile
      .map((c, idx) => ({ card: c, idx }))
      .filter(({ idx }) => isCanPickupCard(pickupPile.length, idx));

    // 🔴 חוק 0 (קיצור-דרך): אם יש ג׳וקר בקצה – תמיד לקחת
    const edgeJoker = candidates.find(({ card }) => card.value === 0);
    if (edgeJoker) {
      return edgeJoker.idx;
    }

    // סימולציית "לא לקחת"
    const noPick = this.simulateTurn(hand, pickupPile, difficulty, null);

    let bestIdx: number | null = null;
    let bestScore = noPick.score;

    for (const { card, idx } of candidates) {
      // סימולציית "לקחת את הקצה הזה"
      const pickSim = this.simulateTurn(hand, pickupPile, difficulty, idx);

      // ⭐ חדש A: עדיפות עליונה אם הקצה משלים רצף 3 עם שני קלפים ביד (כולל 2+ג׳וקר)
      if (card.value !== 0) {
        const completesRunNow = this.findTwoCardSequenceWithTop(hand, card);
        if (completesRunNow) {
          // אם הזריקה בסימולציה לא שוברת את הרצף המתוכנן — בוסט חזק
          const wouldBreakRun = pickSim.discard.some((d) =>
            completesRunNow.some(
              (k) => k.suit === d.suit && k.value === d.value
            )
          );
          if (!wouldBreakRun) {
            pickSim.score += 800; // בוסט גבוה מרצף/זוג רגיל
          } else {
            // אם הזריקה שוברת את הרצף שתכננו — עונש
            pickSim.score -= 600;
          }
        }
      }

      // ❗ כלל שביקשת: אם הקלף משלים זוג, אבל לפי הסימולציה זורקים עכשיו רצף
      // שמכיל את אותו ערך (למשל זרקתי 8♣-9♣-10♣ ואני בוחן לקחת 9♦) — אל תיקח.
      const completesPair = pickSim.handAfter.some(
        (c) => c.value !== 0 && c.value === card.value
      );
      if (completesPair) {
        const discardContainsSameValue = pickSim.discard.some(
          (d) => d.value === card.value
        );
        if (discardContainsSameValue) {
          pickSim.score -= 10000; // ⭐ חדש B: ענישה חזקה כדי לבטל לקיחה כזו
        }
      }

      if (card.value <= 2) {
        let lowScore = 600; // נמוך מ-800 של רצף 3, גבוה מזוטות

        const hasJoker = hand.some((c) => c.value === 0);
        const hasAceSameSuit = hand.some(
          (c) => c.value === 1 && c.suit === card.suit
        );
        const hasTwoSameSuit = hand.some(
          (c) => c.value === 2 && c.suit === card.suit
        );
        const hasThreeSameSuit = hand.some(
          (c) => c.value === 3 && c.suit === card.suit
        );

        // חיבור מיידי A–2 באותה צורה
        if (card.value === 2 && hasAceSameSuit) lowScore += 220;
        if (card.value === 1 && hasTwoSameSuit) lowScore += 220;

        // קרבה ל-3 (A-2-3 / 1-2-3)
        if (card.value === 2 && hasThreeSameSuit) lowScore += 180;
        if (
          card.value === 1 &&
          hasThreeSameSuit &&
          (hasTwoSameSuit || hasJoker)
        ) {
          lowScore += 160;
        }

        // לא להעניק אם בסימולציה זורקים מיד את הקלף שלקחנו
        const wouldDiscardPicked = pickSim.discard.some(
          (d) => d.suit === card.suit && d.value === card.value
        );
        if (!wouldDiscardPicked) {
          pickSim.score += lowScore;
        }
      }

      // בוחרים את האפשרות עם הניקוד הגבוה יותר
      if (pickSim.score > bestScore) {
        bestScore = pickSim.score;
        bestIdx = idx;
      }
    }

    // נחזור עם אינדקס לקצה שניקח, או null אם עדיף לא לקחת
    return bestIdx;
  }

  /**
   * סימולציה קצרה: אם לוקחים/לא לוקחים, מה נזרוק ומה איכות היד אחרי הזריקה.
   * - pickIdx: אינדקס בקצוות לקחת ממנו, או null אם לא לוקחים.
   * - מחזיר discard, handAfter, score (ככל שגבוה יותר – טוב יותר).
   */
  private static simulateTurn(
    hand: Card[],
    pickupPile: Card[],
    difficulty: Difficulty,
    pickIdx: number | null
  ): { discard: Card[]; handAfter: Card[]; score: number } {
    // יד לסימולציה – אם לוקחים, נוסיף את הקלף הנבחן
    const handSim =
      pickIdx !== null ? [...hand, pickupPile[pickIdx]] : [...hand];

    // כדי שהלוגיקה ב-chooseCards "תחשוב" על הקלף שאנחנו בוחנים,
    // נעביר לה מחסנית שבה ה-"top" הוא הקלף הנבחן; אחרת – כל הקופה הרגילה.
    const pileForThinking =
      pickIdx !== null ? [pickupPile[pickIdx]] : pickupPile;

    // מה היינו זורקים בסיטואציה הזו?
    const discard = this.chooseCards(handSim, pileForThinking, difficulty);

    // היד לאחר הזריקה
    const handAfter = handSim.filter((c) => !discard.includes(c));

    // ניקוד פשוט + תוספות חכמות קטנות:
    // 1) ככל שסכום הנקודות ביד קטן יותר – טוב יותר
    const sumAfter = handAfter.reduce((s, c) => s + getCardValue(c), 0);
    let score = 1000 - sumAfter;

    // 2) בונוס אם נשמר בסיס לרצף 3+ לתור הבא עם הקלף הנבחן
    const evalCard =
      pickIdx !== null
        ? pickupPile[pickIdx]
        : pileForThinking[pileForThinking.length - 1];
    if (evalCard && evalCard.value !== 0) {
      const keepsRunNext = this.findTwoCardSequenceWithTop(handAfter, evalCard);
      if (keepsRunNext) score += 120;
    }

    // ⭐ חדש C: אם תכננו רצף עם evalCard אבל הזריקה פוגעת באחד משני הקלפים שמרכיבים אותו – ענישה
    if (evalCard && evalCard.value !== 0) {
      const planned = this.findTwoCardSequenceWithTop(handSim, evalCard);
      if (
        planned &&
        discard.some((d) =>
          planned.some((k) => k.suit === d.suit && k.value === d.value)
        )
      ) {
        score -= 200;
      }
    }

    // 4) בונוס קטן על זוג/שלישייה שנשארים ביד אחרי הזריקה (שימושי לסטים עתידיים)
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
    // יוצר חתימה חד-משמעית לקבוצת קלפים ע"פ (suit,value), כולל ג׳וקר value=0
    return seq
      .map((c) => `${String(c.suit)}:${c.value}`)
      .sort()
      .join("|");
  }

  private static findAllValidSequences(hand: Card[]): Card[][] {
    const sequences: Card[][] = [];
    const sorted = sortCards(hand);

    // ===== סריקה קיימת: חתיכות רציפות בגודל 3..N =====
    for (let size = 3; size <= hand.length; size++) {
      for (let i = 0; i <= hand.length - size; i++) {
        const group = sorted.slice(i, i + size);
        if (this.isSequence(group)) {
          sequences.push(group);
        }
      }
    }

    // ===== תוספת מינימלית: השלמת רצף 3 בעזרת ג׳וקר =====
    // מטפלת במקרים כמו 3♦ + 5♦ + ג׳וקר => 3-4-5
    const jokers = hand.filter((c) => c.value === 0);
    if (jokers.length > 0) {
      const joker = jokers[0]; // מספיק ג׳וקר אחד לרצף 3

      // קיבוץ לפי צורה (ללא ג׳וקרים)
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

      // מפתח לדופליקטים
      const haveKey = new Set<string>(sequences.map((seq) => this.seqKey(seq)));

      // לכל צורה: עבור כל זוג קלפים מאותה צורה בהפרש 1 או 2 – נוסיף ג׳וקר להשלים לרצף 3
      for (const s of Object.keys(bySuit)) {
        const cards = bySuit[s];
        for (let i = 0; i < cards.length; i++) {
          for (let j = i + 1; j < cards.length; j++) {
            const a = cards[i];
            const b = cards[j];
            const gap = b.value - a.value;

            // gap==1: a,b וג׳וקר יוצרים רצף 3 (למשל 3,4 + ג׳וקר => 2-3-4 או 3-4-5)
            // gap==2: a,ג׳וקר,b יוצרים רצף 3 (למשל 3,5 + ג׳וקר => 3-4-5)
            if (gap === 1 || gap === 2) {
              const triple = gap === 2 ? [a, joker, b] : [a, b, joker];

              // ודא שזה באמת רצף לפי כללי המשחק (כולל canFormValidSequence)
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
        // (המיפוי הוא לפי value, אז מספיק לבדוק את האיבר הראשון)
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

  // 🆕 שומר את הקלף השכן (±1) ואת ג׳וקר אחד, כדי לא לפגוע בבניית 2+ג׳וקר→3
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
    // ❌ לא מאפשרים רצף עם יותר מג׳וקר אחד
    const jokerCountInGroup = cards.filter((card) => card.value === 0).length;
    if (jokerCountInGroup > 1) return false;

    const nonJokerCards = cards.filter((card) => card.value !== 0);

    // בדיקה: כל הקלפים שאינם ג'וקרים חייבים להיות מאותו suit
    if (nonJokerCards.length > 1) {
      const firstSuit = nonJokerCards[0].suit;
      if (!nonJokerCards.every((card) => card.suit === firstSuit)) {
        return false;
      }
    }

    // בדיקה: האם ניתן להשלים לרצף חוקי עם ג'וקרים (כאן כבר יש לכל היותר 1)
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

  // כבר קיימת אצלך – החלפה מלאה לפונקציה הזו בלבד
  private static findTwoCardSequenceWithTop(
    hand: Card[],
    top: Card
  ): Card[] | null {
    if (!top) return null;
    if (top.value === 0) return null; // ג'וקר – מטופל בכללים אחרים

    const sameSuit = hand.filter((c) => c.suit === top.suit && c.value !== 0);
    const jokers = hand.filter((c) => c.value === 0);

    // 🔹 מקרה 1: שני קלפים מאותה צורה (ללא ג׳וקר) – הלוגיקה שהייתה לך
    if (sameSuit.length >= 2) {
      const byValue: Record<number, Card[]> = {};
      for (const c of sameSuit) {
        if (!byValue[c.value]) byValue[c.value] = [];
        byValue[c.value].push(c);
      }

      // מילוי פער: [v-1, v+1] עם top=v
      if (byValue[top.value - 1] && byValue[top.value + 1]) {
        return [byValue[top.value - 1][0], byValue[top.value + 1][0]];
      }
      // הארכה מטה: [v+1, v+2]
      if (byValue[top.value + 1] && byValue[top.value + 2]) {
        return [byValue[top.value + 1][0], byValue[top.value + 2][0]];
      }
      // הארכה מעלה: [v-2, v-1]
      if (byValue[top.value - 2] && byValue[top.value - 1]) {
        return [byValue[top.value - 2][0], byValue[top.value - 1][0]];
      }
    }

    // 🔹 מקרה 2: קלף מאותה צורה + ג׳וקר (מותר רק ג׳וקר אחד)
    if (jokers.length > 0 && sameSuit.length >= 1) {
      const J = jokers[0];

      // שכנים צמודים (±1) – למשל 7♥ + ג׳וקר עם top=8♥  ⇒ 7–8–9 או 6–7–8
      const nMinus1 = sameSuit.find((c) => c.value === top.value - 1);
      if (nMinus1) return [nMinus1, J];

      const nPlus1 = sameSuit.find((c) => c.value === top.value + 1);
      if (nPlus1) return [nPlus1, J];

      // מרחק 2 (±2) – הג׳וקר מגשר את הפער (למשל 6♥ + ג׳וקר עם top=8♥)
      const nMinus2 = sameSuit.find((c) => c.value === top.value - 2);
      if (nMinus2) return [nMinus2, J];

      const nPlus2 = sameSuit.find((c) => c.value === top.value + 2);
      if (nPlus2) return [nPlus2, J];
    }

    return null;
  }
}
