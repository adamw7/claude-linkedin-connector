import type { Response } from 'express';
import { escapeHtml, page } from '../html.js';
import type { OAuthClient } from './clients.js';

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  // Not `no-referrer`: browsers then send `Origin: null` on the consent form's POST.
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export function sendPage(res: Response, status: number, title: string, body: string): void {
  res.status(status).set(SECURITY_HEADERS).type('html').send(page(title, body));
}

export function sendErrorPage(res: Response, status: number, title: string, detail: string): void {
  sendPage(res, status, title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`);
}

export interface ConsentPageInput {
  client: OAuthClient;
  redirectUri: string;
  consent: string;
  csrf: string;
  capabilities: string[];
}

export function sendConsentPage(res: Response, input: ConsentPageInput): void {
  const redirect = new URL(input.redirectUri);
  const clientHost = input.client.kind === 'metadata-document' ? new URL(input.client.clientId).host : undefined;
  const name = input.client.clientName ?? clientHost ?? 'An application';
  const loopback = redirect.protocol === 'http:';
  const body = `
<h1>Connect LinkedIn to ${escapeHtml(name)}</h1>
<p><strong>${escapeHtml(name)}</strong>${clientHost && input.client.clientName ? ` (${escapeHtml(clientHost)})` : ''} wants to use your LinkedIn account through this connector. It will be able to:</p>
<ul>${input.capabilities.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
<p>LinkedIn will ask you to sign in and approve access, then send you back to <strong>${escapeHtml(redirect.host)}</strong>.</p>
${
  loopback
    ? '<p class="warning">This application receives the result on your own computer (localhost). Only continue if you started this connection yourself just now.</p>'
    : ''
}
<form method="post" action="/authorize">
  <input type="hidden" name="consent" value="${escapeHtml(input.consent)}">
  <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
  <div class="actions">
    <button type="submit" name="decision" value="deny">Cancel</button>
    <button class="primary" type="submit" name="decision" value="approve" autofocus>Continue to LinkedIn</button>
  </div>
</form>`;
  sendPage(res, 200, `Connect LinkedIn to ${name}`, body);
}
