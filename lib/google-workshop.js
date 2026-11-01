// The shared secret stays on this server; never ship it in a browser bundle.
export function createGoogleWorkshop({ url, secret, fetcher = fetch }) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url) || !secret || secret.length < 32) throw new Error('Google workshop requires a deployment /exec URL and a secret of at least 32 characters.');
  async function call(action, body = {}) {
    let response;
    try { response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, action, secret }), signal: AbortSignal.timeout(25000) }); }
    catch { throw Object.assign(new Error('Google Sheets is unavailable. No local replacement queue was created. Refresh and retry.'), { status: 503 }); }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) throw Object.assign(new Error(data?.error || 'Google did not confirm this operation. Check the Apps Script deployment.'), { status: [400,401,404,409,503].includes(data?.status) ? data.status : 502 });
    return data;
  }
  return {
    review: async (id, input, expectedRevision) => (await call('adminReview', { id, input, expectedRevision })).ticket,
    list: async () => (await call('staffList')).tickets,
    queue: async () => await call('publicQueue'),
    update: async (id, status, expectedRevision, reason, operator) => (await call('staffUpdate', { id, status, expectedRevision, reason, operator })).ticket,
    recordUsage: async (id, input, expectedRevision) => (await call('staffUsage', { id, input, expectedRevision })).ticket,
  };
}
