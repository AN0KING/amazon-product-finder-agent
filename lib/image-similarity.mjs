import { createHash } from "node:crypto";

import sharp from "sharp";

export const MIN_IMAGE_SIMILARITY_SCORE = 0.5;
export const IMAGE_SIMILARITY_METHOD = "local-visual-fingerprint";
export const IMAGE_SIMILARITY_VERSION = "sharp-phash-dhash-ssim-color-v1";

const NORMALIZED_SIZE = 32;
const PHASH_SIZE = 8;
const DHASH_WIDTH = 17;
const DHASH_HEIGHT = 16;
const COLOR_BINS_PER_CHANNEL = 4;

export async function compareProductImages(sourceBuffer, candidateBuffer) {
  requireImageBuffer(sourceBuffer, "sourceBuffer");
  requireImageBuffer(candidateBuffer, "candidateBuffer");

  const reference = await createProductImageReference(sourceBuffer);
  return reference.compare(candidateBuffer);
}

export async function createProductImageReference(sourceBuffer) {
  requireImageBuffer(sourceBuffer, "sourceBuffer");
  const source = await createVisualFingerprint(sourceBuffer);
  const sourceImageSha256 = createHash("sha256").update(sourceBuffer).digest("hex");
  return Object.freeze({
    sourceImageSha256,
    compare: async (candidateBuffer) => {
      requireImageBuffer(candidateBuffer, "candidateBuffer");
      const candidate = await createVisualFingerprint(candidateBuffer);
      return compareFingerprints(source, candidate, sourceImageSha256, candidateBuffer);
    },
  });
}

function compareFingerprints(source, candidate, sourceImageSha256, candidateBuffer) {
  const components = {
    perceptualHash: bitSimilarity(source.perceptualHash, candidate.perceptualHash),
    differenceHash: bitSimilarity(source.differenceHash, candidate.differenceHash),
    structuralSimilarity: structuralSimilarity(source.grayscale, candidate.grayscale, NORMALIZED_SIZE),
    colorHistogram: cosineSimilarity(source.colorHistogram, candidate.colorHistogram),
  };
  const score = clampScore(
    (components.perceptualHash * 0.1)
      + (components.differenceHash * 0.25)
      + (components.structuralSimilarity * 0.5)
      + (components.colorHistogram * 0.15),
  );

  return {
    score,
    method: IMAGE_SIMILARITY_METHOD,
    version: IMAGE_SIMILARITY_VERSION,
    components,
    sourceImageSha256,
    candidateImageSha256: createHash("sha256").update(candidateBuffer).digest("hex"),
  };
}

async function createVisualFingerprint(buffer) {
  const normalized = normalizedPipeline(buffer);
  const [gray, differenceGray, rgb] = await Promise.all([
    normalized.clone().resize(NORMALIZED_SIZE, NORMALIZED_SIZE, containOptions()).grayscale().raw().toBuffer(),
    normalized.clone().resize(DHASH_WIDTH, DHASH_HEIGHT, containOptions()).grayscale().raw().toBuffer(),
    normalized.clone().resize(NORMALIZED_SIZE, NORMALIZED_SIZE, containOptions()).removeAlpha().raw().toBuffer(),
  ]);
  return {
    grayscale: gray,
    perceptualHash: perceptualHash(gray, NORMALIZED_SIZE, PHASH_SIZE),
    differenceHash: differenceHash(differenceGray, DHASH_WIDTH, DHASH_HEIGHT),
    colorHistogram: colorHistogram(rgb),
  };
}

function normalizedPipeline(buffer) {
  return sharp(buffer, { failOn: "error", limitInputPixels: 40_000_000 })
    .rotate()
    .flatten({ background: "#ffffff" })
    .trim({ background: "#ffffff", threshold: 24 });
}

function containOptions() {
  return {
    fit: "contain",
    position: "centre",
    background: "#ffffff",
    kernel: sharp.kernel.lanczos3,
  };
}

function perceptualHash(pixels, size, hashSize) {
  const coefficients = [];
  for (let yFrequency = 0; yFrequency < hashSize; yFrequency += 1) {
    for (let xFrequency = 0; xFrequency < hashSize; xFrequency += 1) {
      let sum = 0;
      for (let y = 0; y < size; y += 1) {
        const yCosine = Math.cos(((2 * y + 1) * yFrequency * Math.PI) / (2 * size));
        for (let x = 0; x < size; x += 1) {
          const xCosine = Math.cos(((2 * x + 1) * xFrequency * Math.PI) / (2 * size));
          sum += pixels[(y * size) + x] * xCosine * yCosine;
        }
      }
      coefficients.push(sum);
    }
  }
  const values = coefficients.slice(1);
  const median = numericMedian(values);
  return values.map((value) => value >= median);
}

function differenceHash(pixels, width, height) {
  const bits = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const offset = (y * width) + x;
      bits.push(pixels[offset] > pixels[offset + 1]);
    }
  }
  return bits;
}

function colorHistogram(pixels) {
  const histogram = new Array(COLOR_BINS_PER_CHANNEL ** 3).fill(0);
  for (let offset = 0; offset + 2 < pixels.length; offset += 3) {
    const red = Math.min(COLOR_BINS_PER_CHANNEL - 1, Math.floor(pixels[offset] / (256 / COLOR_BINS_PER_CHANNEL)));
    const green = Math.min(COLOR_BINS_PER_CHANNEL - 1, Math.floor(pixels[offset + 1] / (256 / COLOR_BINS_PER_CHANNEL)));
    const blue = Math.min(COLOR_BINS_PER_CHANNEL - 1, Math.floor(pixels[offset + 2] / (256 / COLOR_BINS_PER_CHANNEL)));
    histogram[(red * COLOR_BINS_PER_CHANNEL * COLOR_BINS_PER_CHANNEL) + (green * COLOR_BINS_PER_CHANNEL) + blue] += 1;
  }
  return histogram;
}

function bitSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return 0;
  let matching = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) matching += 1;
  }
  return matching / left.length;
}

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftLength = 0;
  let rightLength = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftLength += left[index] ** 2;
    rightLength += right[index] ** 2;
  }
  if (!leftLength || !rightLength) return 0;
  return clampScore(dot / Math.sqrt(leftLength * rightLength));
}

function structuralSimilarity(left, right, width) {
  if (left.length !== right.length || left.length !== width * width) return 0;
  const windowSize = 8;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let total = 0;
  let windows = 0;
  for (let startY = 0; startY < width; startY += windowSize) {
    for (let startX = 0; startX < width; startX += windowSize) {
      const leftValues = [];
      const rightValues = [];
      for (let y = startY; y < Math.min(width, startY + windowSize); y += 1) {
        for (let x = startX; x < Math.min(width, startX + windowSize); x += 1) {
          const offset = (y * width) + x;
          leftValues.push(left[offset]);
          rightValues.push(right[offset]);
        }
      }
      const leftMean = average(leftValues);
      const rightMean = average(rightValues);
      let leftVariance = 0;
      let rightVariance = 0;
      let covariance = 0;
      for (let index = 0; index < leftValues.length; index += 1) {
        const leftDelta = leftValues[index] - leftMean;
        const rightDelta = rightValues[index] - rightMean;
        leftVariance += leftDelta ** 2;
        rightVariance += rightDelta ** 2;
        covariance += leftDelta * rightDelta;
      }
      const denominator = Math.max(1, leftValues.length - 1);
      leftVariance /= denominator;
      rightVariance /= denominator;
      covariance /= denominator;
      const numerator = ((2 * leftMean * rightMean) + c1) * ((2 * covariance) + c2);
      const divisor = ((leftMean ** 2) + (rightMean ** 2) + c1) * (leftVariance + rightVariance + c2);
      total += divisor ? clampScore(numerator / divisor) : 0;
      windows += 1;
    }
  }
  return windows ? total / windows : 0;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function numericMedian(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function clampScore(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function requireImageBuffer(value, name) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a Buffer or Uint8Array.`);
  }
  if (value.length === 0) throw new TypeError(`${name} must not be empty.`);
}
