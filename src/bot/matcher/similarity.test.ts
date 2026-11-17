import { describe, expect, test } from 'bun:test';
import { cosineSimilarity } from './similarity';

describe('cosineSimilarity', () => {
  test('identical direction is 1, orthogonal is 0, opposite is -1', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(-1);
  });

  test('ignores vector length', () => {
    expect(cosineSimilarity(new Float32Array([3, 4]), new Float32Array([6, 8]))).toBeCloseTo(1);
  });

  test('a zero vector is similar to nothing', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 0]))).toBe(0);
  });

  test('vectors of different length throw', () => {
    expect(() => cosineSimilarity(new Float32Array([1]), new Float32Array([1, 0]))).toThrow(
      /length/
    );
  });
});
