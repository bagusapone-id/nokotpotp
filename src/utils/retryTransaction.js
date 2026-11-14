/**
 * retryTransaction - wraps a Firebase transaction function with retry logic.
 * @param {Function} transactionFn - async function to retry
 * @param {number} maxAttempts - max attempts (default 3)
 * @returns {Promise<any>}
 */
async function retryTransaction(transactionFn, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await transactionFn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
  }
  throw lastError;
}

module.exports = { retryTransaction };
