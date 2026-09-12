// Explicit test-only R2 binding. Production code never imports this module.
const objects = new Map();
export const getMockStore = () => objects;
export const clearMockStore = () => objects.clear();
export function testR2Binding() {
  return {
    async head(key) {
      const row = objects.get(key);
      return row ? { ...row, size: row.data.byteLength } : null;
    },
    async get(key) {
      const row = await this.head(key);
      return row ? { ...row, body: row.data } : null;
    },
    async put(key, body, options = {}) {
      const data = await new Response(body).arrayBuffer();
      if (options.sha256) {
        const actual = Buffer.from(await crypto.subtle.digest('SHA-256', data)).toString('hex');
        if (actual !== options.sha256.toLowerCase()) throw new Error('sha256 checksum mismatch');
      }
      if (options.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
      objects.set(key, { data, ...options });
      return this.head(key);
    },
    async delete(key) {
      if (objects.get(key)?._locked) {
        const error = new Error('bucket retention lock');
        error.code = 10069;
        throw error;
      }
      objects.delete(key);
    },
  };
}
