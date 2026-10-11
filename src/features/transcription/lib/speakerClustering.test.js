import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/sherpaClustering.fixture.json";
import { decodeFloat32 } from "./__fixtures__/decodeFixture.js";
import { clusterSpeakerEmbeddings } from "./speakerClustering.js";

describe("clusterSpeakerEmbeddings", () => {
  for (const [index, testCase] of fixture.cases.entries()) {
    const points = decodeFloat32(testCase.points);

    it(`matches sherpa-onnx with a fixed cluster count (case ${index})`, () => {
      const labels = clusterSpeakerEmbeddings(points, testCase.rows, {
        numClusters: testCase.clusters,
      });
      expect(Array.from(labels)).toEqual(testCase.labelsByCount);
    });

    it(`matches sherpa-onnx with a distance threshold (case ${index})`, () => {
      const labels = clusterSpeakerEmbeddings(points, testCase.rows, {
        threshold: 0.5,
      });
      expect(Array.from(labels)).toEqual(testCase.labelsByThreshold);
    });
  }

  it("never returns more clusters than embeddings", () => {
    const points = new Float32Array([1, 0, 0, 1]);
    const labels = clusterSpeakerEmbeddings(points, 2, { numClusters: 5 });
    expect(Array.from(labels)).toEqual([0, 1]);
  });

  it("handles zero and one embedding", () => {
    expect(
      Array.from(clusterSpeakerEmbeddings(new Float32Array(0), 0, {})),
    ).toEqual([]);
    expect(
      Array.from(
        clusterSpeakerEmbeddings(new Float32Array([0.3, 0.4]), 1, {
          numClusters: 3,
        }),
      ),
    ).toEqual([0]);
  });
});
