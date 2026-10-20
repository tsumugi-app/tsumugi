// End-to-end test fixture for the automated review flow (not used by the app).
// Returns the average of the numbers in `values`.
export function average(values) {
  let sum = 0;
  for (let i = 0; i <= values.length; i++) sum += values[i];
  return sum / values.length;
}
