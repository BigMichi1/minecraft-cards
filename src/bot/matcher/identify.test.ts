import { describe, expect, test } from 'bun:test';
import { cid } from '../../test/cardIds';
import { DECISION_GAP, identifyPicture, TWIN_SIMILARITY, type ReferenceVector } from './identify';

/** A unit vector at `deg` degrees in the plane: the cosine of two of them is cos(Δdeg). */
function at(deg: number): Float32Array {
  const rad = (deg * Math.PI) / 180;
  return new Float32Array([Math.cos(rad), Math.sin(rad)]);
}
/** The angle (degrees) whose cosine is `similarity`. */
const angle = (similarity: number) => (Math.acos(similarity) * 180) / Math.PI;

function ref(id: string, deg: number, puzzle = false): ReferenceVector {
  return { cardId: cid(id), vector: at(deg), puzzle };
}

describe('identifyPicture', () => {
  test('the gap is 0.02, as measured on 2026-11-18', () => {
    expect(DECISION_GAP).toBe(0.02);
  });

  test('decides when the best reference reaches the threshold and leads by the gap', () => {
    // 45 on the other side, so the two references are far apart (no twins).
    const result = identifyPicture(at(0), [ref('12', angle(0.9)), ref('45', -angle(0.7))], 0.78);
    expect(result).toEqual({
      cardId: cid('12'),
      similarity: expect.closeTo(0.9, 5),
      runnerUp: expect.closeTo(0.7, 5),
      puzzle: false,
      twin: false,
      decided: true,
    });
  });

  test('a best match below the threshold is not decided', () => {
    const result = identifyPicture(at(0), [ref('12', angle(0.77)), ref('45', angle(0.2))], 0.78);
    expect(result).toMatchObject({ cardId: '12', decided: false });
  });

  test('a lead below the gap is not decided; a lead just above it is', () => {
    const close = identifyPicture(at(0), [ref('12', angle(0.9)), ref('45', angle(0.885))], 0.78);
    expect(close).toMatchObject({ cardId: '12', decided: false });
    // 0.80 vs 0.775: lead 0.025, best above 0.79.
    const edge = identifyPicture(at(0), [ref('12', angle(0.8)), ref('45', angle(0.775))], 0.79);
    expect(edge).toMatchObject({ cardId: '12', decided: true });
  });

  test('the order of the references does not matter', () => {
    const result = identifyPicture(
      at(0),
      [ref('45', angle(0.6)), ref('7', angle(0.7)), ref('12', angle(0.95))],
      0.78
    );
    expect(result).toMatchObject({ cardId: '12', runnerUp: expect.closeTo(0.7, 5) });
  });

  test('reports a puzzle best match as such, the caller applies the puzzle rule', () => {
    const result = identifyPicture(
      at(0),
      [ref('160', angle(0.9), true), ref('45', angle(0.5))],
      0.78
    );
    expect(result).toMatchObject({ cardId: '160', puzzle: true, decided: true });
  });

  test('one reference has no runner-up and decides on the threshold alone', () => {
    expect(identifyPicture(at(0), [ref('12', angle(0.9))], 0.78)).toMatchObject({
      cardId: '12',
      runnerUp: null,
      decided: true,
    });
  });

  test('no references gives null', () => {
    expect(identifyPicture(at(0), [], 0.78)).toBeNull();
  });
  test("a best card whose reference looks like another card's is a twin", () => {
    // Measured 2026-11-18: #59 and XXL1 Charged Creeper 0.945, two placeholder pictures 1.0;
    // the next most alike pair 0.866.
    expect(TWIN_SIMILARITY).toBe(0.9);
    const twins = [ref('59', 0), ref('XXL1', angle(0.95)), ref('45', 90)];
    expect(identifyPicture(at(-2), twins, 0.78)).toMatchObject({ cardId: '59', twin: true });
    const apart = [ref('59', 0), ref('XXL1', angle(0.85)), ref('45', 90)];
    expect(identifyPicture(at(-2), apart, 0.78)).toMatchObject({ cardId: '59', twin: false });
  });
});
