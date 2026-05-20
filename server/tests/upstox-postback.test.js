/**
 * Unit tests for the Upstox postback webhook routing.
 *
 * Tests that order and gtt_order update_type payloads are routed and
 * processed correctly.
 *
 * Run: node --test server/tests/upstox-postback.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ─── Sample payloads from Upstox v3 Webhook docs ─────────────────────────────

const ORDER_PAYLOAD = {
  update_type: 'order',
  user_id: 'RONO1234',
  exchange: 'NSE',
  instrument_token: 'NSE_EQ|INE848E01016',
  instrument_key: 'NSE_EQ|INE848E01016',
  trading_symbol: 'NHPC-EQ',
  product: 'D',
  order_type: 'MARKET',
  average_price: 85.50,
  price: 0,
  trigger_price: 0,
  quantity: 10,
  disclosed_quantity: 0,
  pending_quantity: 0,
  transaction_type: 'BUY',
  order_ref_id: '57744821658411',
  exchange_order_id: '1100000000080962',
  parent_order_id: null,
  validity: 'DAY',
  status: 'complete',
  is_amo: false,
  variety: 'SIMPLE',
  tag: null,
  exchange_timestamp: '2024-02-21 14:42:11',
  status_message: '',
  order_id: '240221025997024',
  order_request_id: '1',
  order_timestamp: '2024-02-21 14:40:02',
  filled_quantity: 10,
  guid: null,
  placed_by: 'RONO1234',
  status_message_raw: null,
};

const GTT_ORDER_PAYLOAD = {
  update_type: 'gtt_order',
  type: 'MULTIPLE',
  exchange: 'NSE_EQ',
  instrument_token: 'NSE_EQ|INE806A01020',
  quantity: 1,
  product: 'D',
  gtt_order_id: 'GTT-CU25270200024002',
  expires_at: 1772216999000000,
  created_at: 1740641185000000,
  rules: [
    { strategy: 'ENTRY',    status: 'FAILED',    trigger_type: 'IMMEDIATE', trigger_price: 7.7,  transaction_type: 'BUY',  message: '', order_id: null },
    { strategy: 'STOPLOSS', status: 'CANCELLED', trigger_type: 'IMMEDIATE', trigger_price: 6.0,  transaction_type: 'SELL', message: '', order_id: null },
    { strategy: 'TARGET',   status: 'CANCELLED', trigger_type: 'IMMEDIATE', trigger_price: 10.0, transaction_type: 'SELL', message: '', order_id: '250228010168535' },
  ],
};

// ─── Routing logic (replicated from the route handler) ───────────────────────

function routePostback(payload) {
  const updateType = payload?.update_type;
  if (!updateType) return { routed: false, reason: 'missing update_type' };
  if (updateType === 'order') return { routed: true, type: 'order' };
  if (updateType === 'gtt_order') return { routed: true, type: 'gtt_order' };
  return { routed: false, reason: `unknown update_type: ${updateType}` };
}

function extractOrderFields(data) {
  return {
    orderId: data.order_id,
    status: data.status,
    filledQuantity: data.filled_quantity,
    averagePrice: data.average_price,
    tradingSymbol: data.trading_symbol,         // snake_case — per spec
    transactionType: data.transaction_type,     // snake_case — per spec
    userId: data.user_id,                       // snake_case — per spec
  };
}

function extractGttRules(data) {
  return (data.rules || []).map(r => ({
    strategy: r.strategy,
    status: r.status,
    orderId: r.order_id,
    triggerPrice: r.trigger_price,
    transactionType: r.transaction_type,
  }));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Upstox postback webhook — routing', () => {
  test('routes order payload to order handler', () => {
    const result = routePostback(ORDER_PAYLOAD);
    assert.equal(result.routed, true);
    assert.equal(result.type, 'order');
  });

  test('routes gtt_order payload to gtt handler', () => {
    const result = routePostback(GTT_ORDER_PAYLOAD);
    assert.equal(result.routed, true);
    assert.equal(result.type, 'gtt_order');
  });

  test('rejects missing update_type', () => {
    const result = routePostback({ order_id: '123' });
    assert.equal(result.routed, false);
    assert.ok(result.reason.includes('missing update_type'));
  });

  test('rejects unknown update_type', () => {
    const result = routePostback({ update_type: 'portfolio_update' });
    assert.equal(result.routed, false);
    assert.ok(result.reason.includes('unknown update_type'));
  });
});

describe('Upstox postback webhook — order field extraction', () => {
  test('extracts snake_case fields from order payload', () => {
    const fields = extractOrderFields(ORDER_PAYLOAD);

    assert.equal(fields.orderId, '240221025997024');
    assert.equal(fields.status, 'complete');
    assert.equal(fields.filledQuantity, 10);
    assert.equal(fields.averagePrice, 85.50);
    assert.equal(fields.tradingSymbol, 'NHPC-EQ');
    assert.equal(fields.transactionType, 'BUY');
    assert.equal(fields.userId, 'RONO1234');
  });

  test('deprecated tradingsymbol field is NOT used', () => {
    const payloadWithDeprecated = { ...ORDER_PAYLOAD, tradingsymbol: 'DEPRECATED' };
    const fields = extractOrderFields(payloadWithDeprecated);
    // trading_symbol (snake_case) must win, not the deprecated tradingsymbol field
    assert.equal(fields.tradingSymbol, 'NHPC-EQ');
  });
});

describe('Upstox postback webhook — GTT order field extraction', () => {
  test('extracts all rules from gtt_order payload', () => {
    const rules = extractGttRules(GTT_ORDER_PAYLOAD);

    assert.equal(rules.length, 3);
    assert.equal(rules[0].strategy, 'ENTRY');
    assert.equal(rules[0].status, 'FAILED');
    assert.equal(rules[2].orderId, '250228010168535');
    assert.equal(rules[2].strategy, 'TARGET');
  });

  test('handles gtt_order with empty rules array', () => {
    const rules = extractGttRules({ ...GTT_ORDER_PAYLOAD, rules: [] });
    assert.equal(rules.length, 0);
  });

  test('handles gtt_order with missing rules field', () => {
    const { rules: _r, ...noRules } = GTT_ORDER_PAYLOAD;
    const rules = extractGttRules(noRules);
    assert.equal(rules.length, 0);
  });
});
