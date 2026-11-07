import type { ReceivedDistribution } from "../../src/lib/received";
// A synthetic server snapshot with no presentation offsets.
export function receivedDisplayFixture(received: ReceivedDistribution) {
  const deducted = {
    special: Array(49).fill(0),
    zodiac: Array(12).fill(0),
    tail: Array(10).fill(0),
  };
  return { received, deducted, display: received, revision: 0 };
}
