import { handleApi } from './api.mjs';
const UI_ROUTE = /^\/(?:pools|methods|rooms\/\d{6})?\/?$/;
export function createWorker({ html, historyHtml = '' }) {
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return handleApi(request, env);
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method Not Allowed', { status: 405 });
      if (/^\/draft-history\/?$/.test(url.pathname)) return new Response(request.method === 'HEAD' ? null : historyHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow' }
      });
      if (UI_ROUTE.test(url.pathname)) return new Response(request.method === 'HEAD' ? null : html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff' }
      });
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not Found', { status: 404 });
    }
  };
}
