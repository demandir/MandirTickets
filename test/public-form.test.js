import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let viteServer;
let App;
let TicketForm;
let TicketReceipt;
const originalLocation = globalThis.location;

test.before(async () => {
  globalThis.location = { hostname: 'localhost', pathname: '/' };
  viteServer = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  ({ default: App, TicketForm, TicketReceipt } = await viteServer.ssrLoadModule('/src/App.jsx'));
});

test.after(async () => {
  if (viteServer) await viteServer.close();
  globalThis.location = originalLocation;
});

function renderWithHooks(component) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const originalDispatcher = internals.H;
  internals.H = {
    useEffect: () => {},
    useRef: value => ({ current: value }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
  };
  try {
    return renderToStaticMarkup(component());
  } finally {
    internals.H = originalDispatcher;
  }
}

function renderTicketForm(machine) {
  return renderWithHooks(() => TicketForm({ machine, onChangeMachine() {}, onTicket() {} }));
}

test('poster and foam customer forms do not ask for a needed-by date', () => {
  for (const machine of ['printer', 'foam']) {
    const html = renderTicketForm(machine);
    assert.doesNotMatch(html, /Needed by/i);
    assert.doesNotMatch(html, /name="neededBy"/i);
    assert.doesNotMatch(html, /type="date"/i);
  }
});

test('customer forms omit phone and make finished size optional', () => {
  for (const machine of ['printer', 'foam']) {
    const html = renderTicketForm(machine);
    assert.doesNotMatch(html, /name="phone"/i);
    for (const field of ['width', 'length']) {
      const input = html.match(new RegExp(`<input[^>]*name="${field}"[^>]*>`))?.[0];
      assert.ok(input, `${field} input should be rendered`);
      assert.doesNotMatch(input, /\srequired(?:=|\s|>)/i, `${field} should be optional`);
    }
  }
});

test('every customer ticket requires at least one artwork file', () => {
  for (const machine of ['printer', 'foam']) {
    const html = renderTicketForm(machine);
    assert.match(html, /Artwork files <span>Required<\/span>/i);
    const input = html.match(/<input[^>]*name="files"[^>]*>/i)?.[0];
    assert.ok(input, 'artwork file input should be rendered');
    assert.match(input, /\srequired(?:=|\s|>)/i);
  }
});

test('customer forms require Telegram linking before the live queue', () => {
  for (const machine of ['printer', 'foam']) {
    const html = renderTicketForm(machine);
    const telegram = html.indexOf('Telegram is required for every ticket');
    const submit = html.indexOf('Submit and link Telegram');
    assert.ok(telegram > -1, 'Telegram requirement should be rendered in the request form');
    assert.ok(telegram < submit, 'Telegram requirement should appear before submission');
    assert.match(html, /Telegram <span>Required<\/span>/);
    assert.doesNotMatch(html, /type="checkbox"/);
    assert.match(html, /confirm pickup/i);
  }
});

test('public site uses the live queue without a private tracking form', () => {
  const html = renderWithHooks(() => React.createElement(App));
  assert.doesNotMatch(html, /Private ticket tracking|Check your request/i);
  assert.doesNotMatch(html, /name="code"/i);
  assert.match(html, /Live workshop queue/i);
});

test('ticket receipt requires the Telegram handoff before another submission', () => {
  const telegramLink = 'https://t.me/DelMandirDesignbot?start=00112233445566778899aabbccddeeff';
  const html = renderToStaticMarkup(React.createElement(TicketReceipt, {
    ticket: { ticketNumber: 'P-0042', machine: 'printer', department: 'Events', telegramLink },
    onStartAnother() {},
  }));
  assert.match(html, /class="telegram-opt-in telegram-opt-in-requested"/);
  assert.match(html, /Required: finish linking Telegram/);
  assert.match(html, /class="button telegram-button"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Open another ticket/);
  assert.match(html, new RegExp(`href="${telegramLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
});

test('the page header offers a dark mode switch', () => {
  assert.match(renderToStaticMarkup(React.createElement(App)), /aria-label="Switch to dark mode"/);
});

test('a ticket auto-linked from this browser needs no Telegram step', () => {
  const html = renderToStaticMarkup(React.createElement(TicketReceipt, {
    ticket: { ticketNumber: 'P-0044', machine: 'printer', department: 'Events', telegramLinked: true },
    onStartAnother() {},
  }));
  assert.match(html, /Telegram is connected/);
  assert.doesNotMatch(html, /telegram-button|telegram-qr/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Open another ticket/);
});

test('a Telegram form selection becomes the first-class receipt handoff', () => {
  const html = renderToStaticMarkup(React.createElement(TicketReceipt, {
    ticket: {
      ticketNumber: 'F-0043',
      machine: 'foam',
      department: 'Decorations',
      telegramLink: 'https://t.me/DelMandirDesignbot?start=ffeeddccbbaa99887766554433221100',
    },
    onStartAnother() {},
  }));
  assert.match(html, /telegram-opt-in-requested/);
  assert.match(html, /Required: finish linking Telegram/);
  assert.match(html, /class="telegram-qr"/);
  assert.match(html, /Continue to Telegram/);
});
